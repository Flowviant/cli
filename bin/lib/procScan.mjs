/**
 * WALKING /proc — the one bounded enumeration every process scan shares, and
 * the one "which processes stand in this directory, holding which sockets"
 * attribution the listener measurements share.
 *
 * ── WHY IT IS ONE FILE (SOLID audit 2026-09-26, F007) ──
 *
 * Three scans spelled the runaway bound three ways. `processes.mjs` had
 * already been fixed to bound the WORK — stop after 4000 matching rows — after
 * it lost a tab's watcher: readdir answers in STRING order, so cutting the pid
 * LIST kept '1', '10', '100'… and dropped pid 912345. `listeners.mjs` still
 * cut the list, twice (the inventory and the dial-address check), so on a busy
 * box a dev server at a high pid was reported ABSENT by both — "nothing is
 * listening" about a socket the kernel's own table held. The rule now has one
 * home: EVERY pid is looked at, and the bound is on the rows a scan collects.
 *
 * WHAT THAT COSTS, said plainly (review 2026-09-26). The old slice bounded the
 * WALK at 4000 pids; the bound here counts MATCHED rows (for the listener
 * scans, processes standing in the worktree), so on a box of N processes one
 * scan does N cwd readlinks, and a reconcile runs two per worktree (inventory
 * and dial check). That is the price of never measuring a high pid as absent,
 * and it is a readlink each — the fd walk, the expensive part, is paid only
 * by processes inside the directory. A bound on pids VISITED would bring the
 * dropped-listener bug straight back, so there is none.
 *
 * ── AND A CUT IS SAID ──
 *
 * `scanProcs` answers `complete: false` when it stopped with pids unread, so a
 * caller can refuse to turn "not looked at" into "not there" — the three-state
 * rule the rest of this product keeps. A /proc that cannot be listed at all is
 * `null` from `procPids`, which is "cannot look", a third answer again.
 *
 * Linux only by construction; callers keep their own macOS paths.
 */

import { readdirSync, readlinkSync, realpathSync } from 'node:fs';
import { sep } from 'node:path';

/** Rows collected per scan before the walk stops early — a bound on the ROWS
 *  held (and the per-row work: an fd walk, a stat read) for one pathological
 *  box, never on which part of /proc is looked at. Every pid still costs one
 *  cheap filter read (see the header). The runaway bound, not a capacity
 *  statement. */
export const SCAN_MATCH_BOUND = 4000;

/** Every numeric entry of /proc, or null when /proc cannot be listed. */
export function procPids(list = () => readdirSync('/proc')) {
  try {
    return list().filter((d) => /^\d+$/.test(d));
  } catch {
    return null;
  }
}

/**
 * Walk `pids` in order; `match(raw)` returns a row or null. Stops once `bound`
 * rows are held AND a pid is still unread, answering `complete: false`.
 */
export function scanProcs(pids, match, bound = SCAN_MATCH_BOUND) {
  const rows = [];
  for (const raw of pids) {
    if (rows.length >= bound) return { rows, complete: false };
    const row = match(raw);
    if (row != null) rows.push(row);
  }
  return { rows, complete: true };
}

/** A predicate for "this path is `dir` or inside it", on the RESOLVED path —
 *  or null when `dir` is gone (retired under us). */
export function insideDir(dir) {
  let root;
  try {
    root = realpathSync(dir);
  } catch {
    return null;
  }
  const prefix = root.endsWith(sep) ? root : root + sep;
  return (p) => p === root || p.startsWith(prefix);
}

function cwdOf(raw) {
  try {
    return readlinkSync(`/proc/${raw}/cwd`);
  } catch {
    return null; // not ours to read, or gone
  }
}

/** The socket inodes one process holds open, or null when its fd table is
 *  unreadable. */
function socketInodesOf(raw) {
  let fds;
  try {
    fds = readdirSync(`/proc/${raw}/fd`);
  } catch {
    return null;
  }
  const out = [];
  for (const fd of fds) {
    let link;
    try {
      link = readlinkSync(`/proc/${raw}/fd/${fd}`);
    } catch {
      continue;
    }
    const m = /^socket:\[(\d+)\]$/.exec(link);
    if (m) out.push(m[1]);
  }
  return out;
}

/**
 * EVERY PROCESS STANDING IN `dir`, with the socket inodes it holds —
 * `{ holders: [{ pid, inodes }], complete }` in /proc order.
 *
 * Attribution is by the CWD of the process, the rule `listeners.mjs` argues
 * for. The cheap filter runs first — one readlink rejects almost every process
 * on the box, and only processes inside `dir` pay for a walk of their fd
 * table — and those are the rows the bound counts. `skip(pid)` drops a process
 * that is Flowviant itself (the daemon, its tunnels) before its fds are read.
 *
 * `{ holders: [], complete: true }` when `dir` is gone; null when /proc cannot
 * be listed. `io` exists ONLY so a test can hand in a pid list (and a bound)
 * without a box that runs four thousand processes; nothing in the daemon
 * passes it.
 */
export function socketHoldersIn(dir, { skip = () => false, io = {} } = {}) {
  const inside = insideDir(dir);
  if (!inside) return { holders: [], complete: true };
  const pids = procPids(io.list);
  if (pids === null) return null;
  const { rows, complete } = scanProcs(
    pids,
    (raw) => {
      const cwd = cwdOf(raw);
      if (cwd === null || !inside(cwd)) return null;
      const pid = Number(raw);
      if (skip(pid)) return null;
      const inodes = socketInodesOf(raw);
      return inodes === null ? null : { pid, inodes };
    },
    io.bound
  );
  return { holders: rows, complete };
}
