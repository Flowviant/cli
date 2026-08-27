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
  existsSync,
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
import { execFileSync } from 'node:child_process';

const REPORT_CAP = 30;
// ENDED sessions are the adoptable inventory, and the useful ones are FRESH:
// "closed my laptop terminal, picking it up here". Claude Code prunes its own
// history anyway, so a week-old row was a soon-to-be-dead offer — 48 hours,
// newest per directory, few. (The first ship reported 7 days of everything
// and the strip read as session history instead of presence.)
const ENDED_WINDOW_MS = 48 * 60 * 60 * 1000;
const ENDED_CAP = 5;

/**
 * The conversation's own title, off the transcript's `ai-title` records
 * (the LAST one wins — titles get rewritten as a session evolves), and ONLY
 * those records: this wire is presence METADATA, and the first user message
 * — the fallback this used to relay — is transcript CONTENT wearing a
 * title's clothes. An untitled row is honest presence; a quoted message is
 * a leak. Those records sit anywhere in the file (measured: line 81 to line
 * 4457), so this reads the WHOLE transcript — behind an mtime cache, because
 * the scan runs every minute and a title only changes when the file does:
 * steady state is a stat, not a read.
 */
const titleCache = new Map(); // file → { mtimeMs, title }
function transcriptTitle(file, mtimeMs) {
  const hit = titleCache.get(file);
  if (hit && hit.mtimeMs === mtimeMs) return hit.title;
  let title = null;
  try {
    const stat = statSync(file);
    // A transcript past this is not worth a read per minute of drift.
    if (stat.size <= 64 * 1024 * 1024) {
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (!line.includes('"type":"ai-title"')) continue;
        try {
          const t = JSON.parse(line)?.aiTitle;
          if (typeof t === 'string' && t.trim()) title = t.trim(); // last wins
        } catch {
          /* torn line */
        }
      }
      if (title) title = title.replace(/\s+/g, ' ').slice(0, 120);
    }
  } catch {
    title = null;
  }
  if (titleCache.size > 400) titleCache.clear(); // a bound, not an LRU — refills in one scan
  titleCache.set(file, { mtimeMs, title });
  return title;
}

/**
 * THE TITLE CLAUDE GAVE ITS OWN CONVERSATION, for one session we already know
 * the id of.
 *
 * `scanLocalSessions` finds transcripts the hard way — walk every project
 * directory, read each file's own `cwd` — because it is answering "what is in
 * this repo" and knows no ids. This asks the same store a narrower question:
 * the tab pinned the id the CLI reported at `system.init`, and the directory is
 * the place the turn was spawned in, so the file is one munge away (Claude Code
 * names the directory after the cwd with `/` and `.` replaced by `-`).
 *
 * The realpath fallback is not defensive padding: a place under a symlinked
 * home munges to a DIFFERENT directory name depending on which form the CLI was
 * handed, and the daemon does not control which that was.
 *
 * Returns null for anything it cannot read. A missing title is honest silence —
 * the tab keeps whatever name it has.
 */
export function titleForSession(cwd, sessionId) {
  if (!cwd || typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(sessionId)) {
    return null;
  }
  const projects = join(homedir(), '.claude', 'projects');
  const dirs = [String(cwd)];
  try {
    const real = realpathSync(String(cwd));
    if (real !== String(cwd)) dirs.push(real);
  } catch {
    /* the place is gone — nothing to read */
  }
  for (const dir of dirs) {
    const file = join(projects, dir.replace(/[/.]/g, '-'), `${sessionId}.jsonl`);
    try {
      return transcriptTitle(file, statSync(file).mtimeMs);
    } catch {
      /* not this munge — try the other */
    }
  }
  return null;
}

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
    // No /proc ENTRY means the process is gone — but only where /proc exists
    // at all. On macOS there is no /proc, so this read fails for EVERY pid,
    // every session scans as dead, and live sessions become adoptable — the
    // exact two-drivers-on-one-conversation outcome liveness exists to
    // prevent. Probe by name instead: `ps -o comm=` on the pid, alive only if
    // the surviving process still LOOKS like a coding-CLI process. A bare
    // signal-0 probe was tried first and reads a RECYCLED pid as alive
    // forever — a crashed session whose pid a launchd service inherited would
    // report live for weeks, refuse adoption, and suppress its own ended row.
    // The name check keeps the conservative direction (a transient race still
    // errs live) without the permanent false-live.
    if (!existsSync('/proc')) {
      try {
        const comm = execFileSync('ps', ['-o', 'comm=', '-p', String(pid)], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
          timeout: 5_000,
        })
          .trim()
          .toLowerCase();
        return /\b(claude|node|bun|codex|agy)\b|\/(claude|node|bun|codex|agy)$/.test(comm);
      } catch {
        return false; // ps errored or the pid is gone — the process is dead
      }
    }
    return false; // /proc is real and has no entry — the process is gone
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
      // A live session's title, off its own transcript (the registry `name`
      // is a machine-y fallback like "flowviant-35").
      let liveTitle = null;
      try {
        const liveFile = join(
          homedir(),
          '.claude',
          'projects',
          cwd.replace(/[/.]/g, '-'),
          `${rec.sessionId}.jsonl`
        );
        liveTitle = transcriptTitle(liveFile, statSync(liveFile).mtimeMs);
      } catch {
        /* no transcript yet */
      }
      if (!liveTitle && typeof rec.name === 'string' && rec.name.trim()) liveTitle = rec.name.trim();
      live.push({
        id: rec.sessionId,
        cwd,
        live: true,
        lastActiveAt: nowIso,
        ...(typeof rec.gitBranch === 'string' && rec.gitBranch ? { branch: rec.gitBranch } : {}),
        ...(liveTitle ? { title: liveTitle } : {}),
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
    const cutoff = Date.now() - ENDED_WINDOW_MS;
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
        if (mtimeMs < cutoff) continue; // an aged session is history, not presence
        candidates.push({ id, file, mtimeMs });
      }
    }
    // Newest first, then verify only as many as the cap still has room for —
    // the verification read is the expensive step, so it is not spent on
    // sessions the report would drop anyway.
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.id < b.id ? -1 : 1));
    // ONE row per DIRECTORY, newest first, few: twenty sessions in the repo
    // root are one offer — the newest is the one `--resume`'s picker would
    // reach for and the only one worth importing 95% of the time. The rest
    // are scrollback, and the product's own law says scrollback doesn't
    // matter.
    const room = Math.min(ENDED_CAP, Math.max(0, REPORT_CAP - Math.min(live.length, REPORT_CAP)));
    const endedIds = new Set();
    const seenCwds = new Set(live.map((s) => s.cwd));
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
      if (seenCwds.has(cwd)) continue; // newest per directory; a live one owns its cwd
      seenCwds.add(cwd);
      const title = transcriptTitle(cand.file, cand.mtimeMs);
      ended.push({
        id: cand.id,
        cwd,
        live: false,
        lastActiveAt: new Date(cand.mtimeMs).toISOString(),
        ...(typeof rec.gitBranch === 'string' && rec.gitBranch ? { branch: rec.gitBranch } : {}),
        ...(title ? { title } : {}),
      });
    }
  } catch {
    /* presence must never throw into the poll loop — report what was gathered */
  }
  const claude = [...live.slice(0, REPORT_CAP), ...ended];
  // agy rides in whatever room the cap leaves — Claude sessions first, they
  // are the ones adoption serves best (fork, never move).
  const agy = scanAgyConversations({ repoRoot, excludeDirs }).slice(
    0,
    Math.max(0, REPORT_CAP - claude.length)
  );
  return [...claude, ...agy];
}

// ── Antigravity (agy) ──────────────────────────────────────────────────────
//
// agy's store is nothing like Claude's: one SQLite db per conversation at
// ~/.gemini/antigravity-cli/conversations/<uuid>.db (global, not cwd-keyed),
// no per-pid liveness registry that survives contact (the presence/*.lock
// files sit untouched by real runs — measured), and the only cwd mapping is
// cache/last_conversations.json: {cwd → the LAST conversation run there}.
// So the honest agy report is a SUBSET — the last conversation per directory
// inside this repo — and that is exactly the one `agy --continue` would give
// the person at that keyboard, i.e. the one worth offering to adopt.

const AGY_DIR = () => join(homedir(), '.gemini', 'antigravity-cli');
const AGY_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Newest write to the conversation's store — the wal carries recent turns,
 *  so its mtime (not the db's) is the real "last active" (measured: a resume
 *  touched db+wal, and never the presence lock). 0 = no such conversation. */
function agyLastWriteMs(id) {
  if (!AGY_UUID_RE.test(id)) return 0;
  let newest = 0;
  for (const suffix of ['.db', '.db-wal']) {
    try {
      const t = statSync(join(AGY_DIR(), 'conversations', `${id}${suffix}`)).mtimeMs;
      if (t > newest) newest = t;
    } catch {
      /* absent half is fine — the db alone still answers */
    }
  }
  return newest;
}

/** Any agy process on the machine right now? /proc comm scan — cheap at the
 *  60s cadence, and the only liveness signal agy leaves (locks are inert).
 *  Tri-state on purpose: true (an agy process exists), false (scanned /proc
 *  and found none), null (no /proc to scan — macOS — so the question is
 *  UNANSWERABLE here, which is a different fact from "no", and the adoption
 *  path below treats it differently: unknowable refuses, absent permits). */
function agyProcessAlive() {
  if (!existsSync('/proc')) {
    // No /proc (macOS): ask pgrep the same question. A MEASURED "none" here
    // matters — answering null instead made every agy conversation on such a
    // machine read live forever, which both invented a state ("live" when the
    // truth was "unmeasured") and permanently killed agy adoption there.
    try {
      execFileSync('pgrep', ['-x', 'agy'], {
        stdio: ['ignore', 'ignore', 'ignore'],
        timeout: 5_000,
      });
      return true; // exit 0 — at least one agy process
    } catch (e) {
      if (e?.status === 1) return false; // pgrep ran and found none
      return null; // pgrep itself unavailable/errored — genuinely unknowable
    }
  }
  try {
    for (const name of readdirSync('/proc')) {
      if (!/^\d+$/.test(name)) continue;
      try {
        if (readFileSync(`/proc/${name}/comm`, 'utf8').trim() === 'agy') return true;
      } catch {
        /* raced exit — keep scanning */
      }
    }
  } catch {
    return null; // /proc exists but won't read — still unknowable
  }
  return false;
}

/**
 * Is this agy conversation being driven RIGHT NOW? agy cannot answer
 * per-conversation, so this is the conservative composite: an agy process
 * exists AND this conversation's store was written in the last 10 minutes.
 * Adoption is a MOVE for agy (no fork exists — measured, "trajectory not
 * found" on a renamed copy), so refusing a maybe-live conversation for a few
 * minutes costs a retry; adopting an actually-live one puts two drivers on
 * one store.
 */
const AGY_LIVE_WINDOW_MS = 10 * 60 * 1000;
export function isAgyConversationLive(id) {
  try {
    const up = agyProcessAlive();
    // Unknowable is NOT "ended". Without /proc the process half of the
    // composite cannot be measured, and calling that "no process" would make
    // every agy conversation on such a machine adoptable — the move-adoption
    // then puts a second driver on a store someone may still be writing.
    // "Live" here means "refuse adoption", and refusing what we cannot verify
    // is the same conservatism as the composite itself.
    if (up === null) return true;
    if (!up) return false;
    const t = agyLastWriteMs(id);
    return t > 0 && Date.now() - t < AGY_LIVE_WINDOW_MS;
  } catch {
    return false;
  }
}

/** The repo's agy conversations, via the cwd registry — see the section
 *  comment for why this is deliberately a subset. */
function scanAgyConversations({ repoRoot, excludeDirs = [] }) {
  const out = [];
  try {
    let realRoot;
    try {
      realRoot = realpathSync(repoRoot);
    } catch {
      return out;
    }
    const excludes = [];
    for (const d of excludeDirs) {
      if (!d) continue;
      try {
        excludes.push(realpathSync(d));
      } catch {
        excludes.push(String(d));
      }
    }
    const ours = (p) => inside(p, realRoot) && !excludes.some((e) => inside(p, e));
    const raw = readFileSync(join(AGY_DIR(), 'cache', 'last_conversations.json'), 'utf8');
    const map = JSON.parse(raw);
    if (!map || typeof map !== 'object') return out;
    const cutoff = Date.now() - ENDED_WINDOW_MS;
    const processUp = agyProcessAlive();
    for (const [cwd, id] of Object.entries(map)) {
      if (typeof id !== 'string' || !AGY_UUID_RE.test(id)) continue;
      let real;
      try {
        real = realpathSync(cwd);
      } catch {
        continue; // the directory is gone — nothing to point a tab at
      }
      if (!ours(real)) continue;
      const lastMs = agyLastWriteMs(id);
      if (!lastMs || lastMs < cutoff) continue;
      out.push({
        id,
        cwd: real,
        // Mirrors isAgyConversationLive exactly, unknowable (null) included:
        // the report must never offer as adoptable a conversation the adopt
        // path will then refuse — an offer wired to a refusal is the dead
        // control this product keeps deleting.
        live: processUp === null ? true : processUp && Date.now() - lastMs < AGY_LIVE_WINDOW_MS,
        lastActiveAt: new Date(lastMs).toISOString(),
        runtime: 'antigravity',
      });
    }
    out.sort(
      (a, b) =>
        (b.lastActiveAt < a.lastActiveAt ? -1 : b.lastActiveAt > a.lastActiveAt ? 1 : 0) ||
        (a.id < b.id ? -1 : 1)
    );
  } catch {
    /* no agy on this machine, or an unreadable registry — nothing to report */
  }
  return out;
}
