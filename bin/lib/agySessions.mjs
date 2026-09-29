/**
 * ANTIGRAVITY (agy) SESSION PRESENCE (split out of localSessions.mjs
 * 2026-09-26, SOLID F062). agy's SQLite store, its cwd cache and its
 * process-name liveness change for reasons of their own, apart from Claude's
 * transcript format (claudeSessions.mjs); the shared fence and report cap are
 * the coordinator's (localSessions.mjs).
 *
 * NOTHING in this file throws.
 */

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { procPids, scanProcs } from './procScan.mjs';

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
  // The /proc walk is procScan's (every pid looked at; a bound of ONE row,
  // because the first agy answers the question).
  const pids = procPids();
  if (pids === null) return null; // /proc exists but won't read — still unknowable
  const isAgy = (name) => {
    try {
      return readFileSync(`/proc/${name}/comm`, 'utf8').trim() === 'agy' ? true : null;
    } catch {
      return null; // raced exit — keep scanning
    }
  };
  return scanProcs(pids, isAgy, 1).rows.length > 0;
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
export function isAgyConversationLive(id, { processAlive = agyProcessAlive } = {}) {
  try {
    const up = processAlive();
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
 *  comment for why this is deliberately a subset. The coordinator hands over
 *  the fence (`ours`, `mine`) and the ended-session `cutoff`; `processAlive`
 *  measures liveness (true / false / null = unknowable), asked once and only
 *  when there is a registry to read. */
export function scanAgyConversations({ ours, mine, cutoff, processAlive = agyProcessAlive }) {
  const out = [];
  try {
    const raw = readFileSync(join(AGY_DIR(), 'cache', 'last_conversations.json'), 'utf8');
    const map = JSON.parse(raw);
    if (!map || typeof map !== 'object') return out;
    const processUp = processAlive();
    for (const [cwd, id] of Object.entries(map)) {
      if (typeof id !== 'string' || !AGY_UUID_RE.test(id)) continue;
      // The operator's own agy TAB, whose conversation is registered against
      // the checkout exactly as a terminal one would be.
      if (mine.has(id)) continue;
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
