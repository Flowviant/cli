/**
 * Terminal-session presence — which Claude Code sessions exist in THIS repo,
 * read off Claude's own on-disk state. Nothing here is inference: the liveness
 * registry (~/.claude/sessions/<pid>.json) says what is open right now, and the
 * transcript store (~/.claude/projects/<munged-cwd>/<id>.jsonl) says what was.
 * The daemon RELAYS both to the server so the Workbench can offer "adopt this
 * terminal session as a tab" — activity, never capacity, and only ever facts
 * the user could see by looking at their own machine.
 *
 * This module is the COORDINATOR (split 2026-09-26, SOLID F062): the fence
 * (repo containment, the daemon's own worktrees and conversation ids), the
 * ended-session window and the report cap. The readers are per CLI —
 * claudeSessions.mjs and agySessions.mjs — because Claude's transcript format
 * and agy's SQLite/cwd cache change for different reasons.
 *
 * The one contract that matters to callers: NOTHING in this file throws. A
 * presence scan runs inside the poll loop's best-effort tail, and a torn
 * registry file or a vanished cwd is a session to skip, not an error to raise.
 */

import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { scanClaudeSessions } from './claudeSessions.mjs';
import { scanAgyConversations } from './agySessions.mjs';

const REPORT_CAP = 30;
// ENDED sessions are the adoptable inventory, and the useful ones are FRESH:
// "closed my laptop terminal, picking it up here". Claude Code prunes its own
// history anyway, so a week-old row was a soon-to-be-dead offer — 48 hours,
// newest per directory, few. (The first ship reported 7 days of everything
// and the strip read as session history instead of presence.)
const ENDED_WINDOW_MS = 48 * 60 * 60 * 1000;

/** Path-prefix containment on already-realpath'd absolute paths. */
const inside = (p, root) => p === root || p.startsWith(root.endsWith('/') ? root : `${root}/`);

/**
 * THE MARKER NAMES THE DAEMON PINS A TAB'S CONVERSATION UNDER.
 *
 * One owner, because two things read them and a drift here is silent: `workSessionTurns.mjs`
 * WRITES them (`sessionMetaPath(wt, <name>, sessionId)`) and this file READS
 * them to know which conversations are its own.
 */
export const SESSION_MARKERS = [
  'flowviant-claude-session',
  'flowviant-codex-thread',
  'flowviant-agy-conversation',
];

/**
 * EVERY CONVERSATION THIS DAEMON STARTED, so the adopt strip never offers you
 * your own reflection.
 *
 * The machine OPERATOR's tabs work in the checkout itself (their place is
 * `'repo'`), so their CLI transcripts land in `~/.claude/projects/<munge(repoRoot)>/`
 * — the very directory this scan reads. The `excludeDirs` fence cannot help:
 * repoRoot is the scan ROOT, not something under it. So the daemon's own tabs
 * were reported as adoptable "terminal sessions", and two things followed:
 * the `+` menu offered to adopt a tab you already have open (accepting FORKS
 * that conversation and copies the checkout's uncommitted and untracked files
 * into a new worktree), and — because the ended walk keeps only the newest row
 * per directory, and a live tab's transcript is always the freshest thing in
 * the checkout — a REAL terminal session started in the repo root could never
 * be offered at all.
 *
 * Excluded by conversation ID rather than by directory, because the directory
 * is shared with exactly the sessions we want to keep offering.
 */
export function ourConversationIds(repoRoot, gitDirs = []) {
  const ids = new Set();
  const dirs = new Set(gitDirs.filter(Boolean));
  try {
    dirs.add(
      execFileSync('git', ['rev-parse', '--absolute-git-dir'], {
        cwd: repoRoot,
        encoding: 'utf8',
        timeout: 5_000,
      }).trim()
    );
  } catch {
    /* not a repo, or git unavailable — the fence is simply empty */
  }
  for (const dir of dirs) {
    let names = [];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const n of names) {
      if (!SESSION_MARKERS.some((m) => n === m || n.startsWith(`${m}-`))) continue;
      try {
        const v = readFileSync(join(dir, n), 'utf8').trim();
        if (v) ids.add(v);
      } catch {
        /* unreadable marker: nothing to fence */
      }
    }
  }
  return ids;
}

/**
 * Every terminal session belonging to this repo — Claude's first (live, then
 * newest ended), then agy's in whatever room the cap leaves — capped at 30.
 *
 * `excludeDirs` carves out the daemon's own worktrees: sessions the daemon
 * itself spawned are tabs already, and offering to adopt one would be the
 * product offering the user their own reflection.
 */
export function scanLocalSessions({ repoRoot, excludeDirs = [], excludeIds }) {
  // The fence setup is inside the catch-all too: presence must never throw
  // into the poll loop, whatever a caller hands in.
  try {
    /** Conversations this daemon started — never offered for adoption. See
     *  `ourConversationIds`: the operator's tabs share the checkout with real
     *  terminal sessions, so the fence has to be by id, not by directory. */
    const mine = excludeIds instanceof Set ? excludeIds : new Set(excludeIds ?? []);
    // Claude falls back to the literal root when it cannot be resolved; agy,
    // whose cwd registry is global, reports nothing for an unresolvable root.
    let realRoot;
    let resolved = true;
    try {
      realRoot = realpathSync(repoRoot);
    } catch {
      resolved = false;
      realRoot = String(repoRoot ?? '');
    }
    if (!realRoot) return [];
    const excludes = [];
    for (const d of excludeDirs) {
      if (!d) continue;
      try {
        excludes.push(realpathSync(d));
      } catch {
        excludes.push(String(d)); // not on disk yet — keep the literal fence
      }
    }
    const ours = (p) => inside(p, realRoot) && !excludes.some((e) => inside(p, e));
    const cutoff = Date.now() - ENDED_WINDOW_MS;
    const claude = scanClaudeSessions({ realRoot, ours, mine, cutoff, cap: REPORT_CAP });
    // agy rides in whatever room the cap leaves — Claude sessions first, they
    // are the ones adoption serves best (fork, never move).
    const agy = resolved
      ? scanAgyConversations({ ours, mine, cutoff }).slice(0, Math.max(0, REPORT_CAP - claude.length))
      : [];
    return [...claude, ...agy];
  } catch {
    return [];
  }
}
