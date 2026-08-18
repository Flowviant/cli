/**
 * Terminal-session presence — which Claude Code sessions exist in THIS repo,
 * read off Claude's own on-disk state. Nothing here is inference: the liveness
 * registry (~/.claude/sessions/<pid>.json) says what is open right now, and the
 * transcript store (~/.claude/projects/<munged-cwd>/<id>.jsonl) says what was.
 * The daemon RELAYS both to the server so the Workbench can offer "adopt this
 * terminal session as a tab" — activity, never capacity, and only ever facts
 * the user could see by looking at their own machine.
 *
 * The one contract that matters to callers: NOTHING in this file throws. A
 * presence scan runs inside the poll loop's best-effort tail, and a torn
 * registry file or a vanished cwd is a session to skip, not an error to raise.
 */

import {
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  openSync,
  readSync,
  closeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const REPORT_CAP = 30;

/** Path-prefix containment on already-realpath'd absolute paths. */
const inside = (p, root) => p === root || p.startsWith(root.endsWith('/') ? root : `${root}/`);

/**
 * Is this pid the SAME process the registry entry recorded?
 *
 * Registry entries go stale — Claude exits, the pid is recycled by something
 * else, the file stays. `/proc/<pid>` existing only proves A process; the
 * starttime (field 22 of /proc/<pid>/stat) proves it is THAT process. The comm
 * field (parenthesised, may itself contain spaces and parens) makes naive
 * whitespace-splitting wrong, so fields are counted from after the LAST ')':
 * the first post-comm field is field 3, which puts starttime at index 19.
 */
function pidAlive(pid, procStart) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  let stat;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch {
    return false; // no /proc entry — the process is gone
  }
  if (procStart == null) return true; // nothing recorded to compare against
  const close = stat.lastIndexOf(')');
  if (close === -1) return false;
  const fields = stat.slice(close + 1).trim().split(/\s+/);
  return fields[19] === String(procStart);
}

/**
 * Is a terminal Claude session with this id open on the machine RIGHT NOW?
 *
 * The adoption path asks this at the moment of adopting: forking a session
 * while its terminal is still typing into it would put two Claudes on one
 * conversation, which is the exact incoherence the Workbench's own locks
 * exist to prevent.
 */
export function isTerminalSessionLive(sessionId) {
  try {
    const dir = join(homedir(), '.claude', 'sessions');
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      let rec;
      try {
        rec = JSON.parse(readFileSync(join(dir, name), 'utf8'));
      } catch {
        continue; // torn write / not JSON — not evidence of anything
      }
      if (rec?.sessionId !== sessionId) continue;
      if (pidAlive(rec.pid, rec.procStart)) return true;
    }
  } catch {
    /* registry unreadable — no proof of life is "not live" */
  }
  return false;
}

/**
 * First transcript record that carries a cwd, from the file's head only.
 *
 * A transcript can be megabytes; the cwd/gitBranch identity rides on every
 * record, so ~16KB from the front is enough to verify WHOSE session this is
 * without paying to read the conversation. A file whose first cwd-bearing
 * line does not parse (truncated at the window edge) is skipped, not retried
 * deeper — this is presence, not forensics.
 */
function firstCwdRecord(file) {
  let fd;
  try {
    fd = openSync(file, 'r');
    const buf = Buffer.alloc(16384);
    const n = readSync(fd, buf, 0, buf.length, 0);
    for (const line of buf.subarray(0, n).toString('utf8').split('\n')) {
      if (!line.includes('"cwd":"')) continue;
      try {
        const rec = JSON.parse(line);
        if (rec && typeof rec.cwd === 'string' && rec.cwd) return rec;
      } catch {
        /* an incomplete line at the window edge — try the next candidate */
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* best-effort */
      }
    }
  }
}

/**
 * Every Claude terminal session belonging to this repo: LIVE ones from the
 * liveness registry, ENDED ones from the transcript store. Returns
 * [{ id, cwd, live, lastActiveAt, branch? }], live first, then newest ended,
 * capped at 30, deterministically ordered (so a stringified report only
 * changes when the facts do).
 *
 * `excludeDirs` carves out the daemon's own worktrees: sessions the daemon
 * itself spawned are tabs already, and offering to adopt one would be the
 * product offering the user their own reflection.
 */
export function scanLocalSessions({ repoRoot, excludeDirs = [] }) {
  const live = [];
  const ended = [];
  try {
    let realRoot;
    try {
      realRoot = realpathSync(repoRoot);
    } catch {
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

    // ── LIVE: the registry, validated pid by pid ─────────────────────────
    const nowIso = new Date().toISOString();
    const liveIds = new Set();
    let regNames = [];
    try {
      regNames = readdirSync(join(homedir(), '.claude', 'sessions'));
    } catch {
      /* no registry — no live sessions */
    }
    for (const name of regNames) {
      if (!name.endsWith('.json')) continue; // .key files ride alongside
      let rec;
      try {
        rec = JSON.parse(readFileSync(join(homedir(), '.claude', 'sessions', name), 'utf8'));
      } catch {
        continue;
      }
      if (!rec || typeof rec.sessionId !== 'string' || typeof rec.cwd !== 'string') continue;
      if (liveIds.has(rec.sessionId)) continue;
      if (!pidAlive(rec.pid, rec.procStart)) continue;
      let cwd;
      try {
        cwd = realpathSync(rec.cwd);
      } catch {
        continue; // the directory is gone — nothing to point a tab at
      }
      if (!ours(cwd)) continue;
      liveIds.add(rec.sessionId);
      live.push({
        id: rec.sessionId,
        cwd,
        live: true,
        lastActiveAt: nowIso,
        ...(typeof rec.gitBranch === 'string' && rec.gitBranch ? { branch: rec.gitBranch } : {}),
      });
    }
    live.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    // ── ENDED: the transcript store, verified file by file ───────────────
    //
    // The munged directory name is a PREFIX match on purpose: a session run in
    // a SUBDIRECTORY of the repo munges to a longer name sharing the root's.
    // But so does a sibling repo ('flowviant-two' shares 'flowviant' + '-'),
    // which is why every candidate is verified against the cwd its own records
    // embed rather than trusted on its directory name.
    const munged = realRoot.replace(/[/.]/g, '-');
    const projectsDir = join(homedir(), '.claude', 'projects');
    let projDirs = [];
    try {
      projDirs = readdirSync(projectsDir);
    } catch {
      /* no transcript store — live sessions still report */
    }
    const cutoff = Date.now() - SEVEN_DAYS_MS;
    const candidates = [];
    for (const dirName of projDirs) {
      if (dirName !== munged && !dirName.startsWith(`${munged}-`)) continue;
      let entries = [];
      try {
        entries = readdirSync(join(projectsDir, dirName), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const ent of entries) {
        if (!ent.isFile() || !ent.name.endsWith('.jsonl')) continue; // top-level only
        const id = ent.name.slice(0, -'.jsonl'.length);
        if (!id || liveIds.has(id)) continue; // a live session outranks its own transcript
        const file = join(projectsDir, dirName, ent.name);
        let mtimeMs;
        try {
          mtimeMs = statSync(file).mtimeMs;
        } catch {
          continue;
        }
        if (mtimeMs < cutoff) continue; // week-old sessions are history, not presence
        candidates.push({ id, file, mtimeMs });
      }
    }
    // Newest first, then verify only as many as the cap still has room for —
    // the verification read is the expensive step, so it is not spent on
    // sessions the report would drop anyway.
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.id < b.id ? -1 : 1));
    const room = Math.max(0, REPORT_CAP - Math.min(live.length, REPORT_CAP));
    const endedIds = new Set();
    for (const cand of candidates) {
      if (ended.length >= room) break;
      if (endedIds.has(cand.id)) continue; // one row per session, whatever dir names it
      endedIds.add(cand.id);
      const rec = firstCwdRecord(cand.file);
      if (!rec) continue;
      let cwd;
      try {
        cwd = realpathSync(rec.cwd);
      } catch {
        continue;
      }
      if (!ours(cwd)) continue;
      ended.push({
        id: cand.id,
        cwd,
        live: false,
        lastActiveAt: new Date(cand.mtimeMs).toISOString(),
        ...(typeof rec.gitBranch === 'string' && rec.gitBranch ? { branch: rec.gitBranch } : {}),
      });
    }
  } catch {
    /* presence must never throw into the poll loop — report what was gathered */
  }
  return [...live.slice(0, REPORT_CAP), ...ended];
}
