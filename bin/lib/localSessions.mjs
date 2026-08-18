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
 * (the LAST one wins — titles get rewritten as a session evolves), falling
 * back to the first real user message. Those records sit anywhere in the
 * file (measured: line 81 to line 4457), so this reads the WHOLE transcript
 * — behind an mtime cache, because the scan runs every minute and a title
 * only changes when the file does: steady state is a stat, not a read.
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
      let firstUser = null;
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (line.includes('"type":"ai-title"')) {
          try {
            const t = JSON.parse(line)?.aiTitle;
            if (typeof t === 'string' && t.trim()) title = t.trim(); // last wins
          } catch {
            /* torn line */
          }
        } else if (!firstUser && !title && line.includes('"type":"user"') && !line.includes('"isMeta":true')) {
          try {
            const content = JSON.parse(line)?.message?.content;
            const text =
              typeof content === 'string'
                ? content
                : Array.isArray(content)
                  ? (content.find((b) => typeof b?.text === 'string')?.text ?? '')
                  : '';
            if (text.trim() && !text.startsWith('<')) firstUser = text.trim();
          } catch {
            /* torn line */
          }
        }
      }
      if (!title && firstUser) title = firstUser;
      if (title) title = title.replace(/\s+/g, ' ').slice(0, 120);
    }
  } catch {
    title = null;
  }
  if (titleCache.size > 400) titleCache.clear(); // a bound, not an LRU — refills in one scan
  titleCache.set(file, { mtimeMs, title });
  return title;
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
 *  60s cadence, and the only liveness signal agy leaves (locks are inert). */
function agyProcessAlive() {
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
    /* no /proc — call nothing live rather than everything */
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
    if (!agyProcessAlive()) return false;
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
        live: processUp && Date.now() - lastMs < AGY_LIVE_WINDOW_MS,
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
