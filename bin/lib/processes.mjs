/**
 * WHAT YOUR CLAUDE IS ACTUALLY RUNNING — the processes it started, still alive.
 *
 * The Workbench could say what a tab had CHANGED (the diffstat) and what was
 * LISTENING in it (`listeners.mjs`), and nothing about what it was RUNNING. A
 * backgrounded watcher — `rbxtsc -w`, `tsc --watch`, `cargo watch` — holds no
 * socket and touches no file for minutes at a time, so it was invisible from a
 * browser in a way it never is in a terminal, where you can just look.
 *
 * ATTRIBUTED BY PROCESS GROUP, not by working directory, and that choice is the
 * whole design. Two candidates were weighed:
 *
 *   · BY CWD, the rule `listeners.mjs` uses. It answers "what is running in
 *     this directory", which is the wrong question here — under a shared place
 *     it sweeps in a teammate's processes and their command lines, and this
 *     product's standing rule is that a teammate's activity is never surfaced.
 *   · BY DESCENDANCY, walking ppid. It answers the right question and then
 *     loses exactly the processes worth showing: `nohup` and `setsid` reparent
 *     to init, so the long-running watcher drops off the chain the moment it
 *     becomes long-running.
 *
 * A process GROUP survives reparenting. The daemon spawns each turn's CLI
 * `detached`, which makes it a group leader, and every process the agent starts
 * inherits that pgid however it is backgrounded. So the group IS "started by
 * the AI instructed through Flowviant", precisely, and it keeps being that
 * after the turn ends and the CLI exits — which is when it matters.
 *
 * THE GROUP LEADER IS NEVER REPORTED, and this is not tidiness. The CLI is
 * spawned as `-p <prompt> --append-system-prompt <system>`, so its own argv
 * holds the driver's entire message and the whole operating contract. Reporting
 * it would push several kilobytes of prompt through the wire and into a browser
 * on every sweep. The leader is also not something the agent STARTED — it is
 * the agent. `pid === pgid` identifies it for free.
 *
 * Command lines are SCRUBBED with the project's own secret values before they
 * leave, the same treatment the activity line and the command audit get, and
 * capped. Scrubbing catches materialized env secrets; it cannot catch a token
 * somebody types inline, and nothing here pretends otherwise.
 *
 * Linux (including WSL2) reads /proc. macOS shells out to `ps`. Windows reports
 * NOTHING and says so by returning null — the same three-state rule the rest of
 * this product keeps, where "looked and found none" is `[]` and "cannot look"
 * is not the same answer.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { platform } from 'node:os';

/** A box with more processes than this is not one we walk per sweep. */
const MAX_PIDS = 4000;
/** Rows reported per session. A watcher, a dev server and its child is three;
 *  twenty is somebody's compose stack and the extra rows say nothing. */
export const MAX_PROCS = 12;
/** Longest command line relayed. Long enough for `node x.js --flag value`,
 *  short enough that a pathological argv cannot become the report. */
const MAX_CMD = 200;

export function processesSupported() {
  return platform() === 'linux' || platform() === 'darwin';
}

/**
 * `pid (comm) state ppid pgrp …` — comm is arbitrary text and CAN contain a
 * `)`, so the fields are read after the LAST one rather than by splitting the
 * whole line. A process named `foo) bar` is not hypothetical; it is what
 * anything that sets its own title can produce.
 */
function pgrpOf(pid) {
  let stat;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch {
    return null; // gone between readdir and read — ordinary
  }
  const close = stat.lastIndexOf(')');
  if (close < 0) return null;
  const rest = stat.slice(close + 1).trim().split(/\s+/);
  const pgrp = Number(rest[2]);
  return Number.isInteger(pgrp) && pgrp > 0 ? pgrp : null;
}

function cmdlineOf(pid) {
  try {
    const raw = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    const parts = raw.split('\0').filter(Boolean);
    if (!parts.length) return null; // a kernel thread — no argv at all
    return parts.join(' ');
  } catch {
    return null;
  }
}

function scanLinux(pgids) {
  let pids;
  try {
    pids = readdirSync('/proc').filter((d) => /^\d+$/.test(d));
  } catch {
    return [];
  }
  if (pids.length > MAX_PIDS) pids = pids.slice(0, MAX_PIDS);

  const out = [];
  for (const raw of pids) {
    const pid = Number(raw);
    const pgrp = pgrpOf(raw);
    if (pgrp === null || !pgids.has(pgrp)) continue;
    // The CLI itself — its argv is the prompt. See the header.
    if (pid === pgrp) continue;
    const cmd = cmdlineOf(raw);
    if (!cmd) continue;
    out.push({ pid, pgid: pgrp, cmd });
  }
  return out;
}

function scanDarwin(pgids) {
  let text;
  try {
    text = execFileSync('ps', ['-axo', 'pid=,pgid=,command='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    const pgid = Number(m[2]);
    if (!pgids.has(pgid) || pid === pgid) continue;
    const cmd = m[3].trim();
    if (cmd) out.push({ pid, pgid, cmd });
  }
  return out;
}

/**
 * Live processes in any of `pgids`.
 *
 * Returns null where the platform cannot answer — never `[]`, which means
 * "looked, found none" and is a different fact a surface renders differently.
 */
export function processesInGroups(pgids, { scrub } = {}) {
  if (!processesSupported()) return null;
  const want = pgids instanceof Set ? pgids : new Set(pgids ?? []);
  if (want.size === 0) return [];
  const rows = platform() === 'darwin' ? scanDarwin(want) : scanLinux(want);
  // Oldest first: a pid is monotonic, so the long-running watcher you started
  // an hour ago sorts above the `sh -c` spawned two seconds ago. Cutting from
  // the END keeps the durable processes and drops the churn.
  rows.sort((a, b) => a.pid - b.pid);
  return rows.slice(0, MAX_PROCS).map((r) => ({
    pid: r.pid,
    cmd: String(scrub ? scrub(r.cmd) : r.cmd).slice(0, MAX_CMD),
  }));
}

/**
 * Which of `pgids` still has anything alive in it.
 *
 * The caller remembers a pgid per session so a backgrounded process outlives
 * the turn that started it. That set must be pruned or it grows for the life of
 * the daemon — and a recycled pgid would eventually attribute a stranger's
 * process to a tab.
 */
export function liveGroups(pgids) {
  if (!processesSupported()) return new Set(pgids ?? []);
  const want = pgids instanceof Set ? pgids : new Set(pgids ?? []);
  if (want.size === 0) return new Set();
  const alive = new Set();
  if (platform() === 'darwin') {
    for (const r of scanDarwin(want)) alive.add(r.pgid);
    // A group whose only member is its leader is still alive; scanDarwin drops
    // leaders, so ask the kernel directly for the rest.
    for (const g of want) {
      if (alive.has(g)) continue;
      try {
        process.kill(g, 0);
        alive.add(g);
      } catch {
        /* gone */
      }
    }
    return alive;
  }
  let pids;
  try {
    pids = readdirSync('/proc').filter((d) => /^\d+$/.test(d));
  } catch {
    return want; // cannot tell — keep what we had rather than forget a live tab
  }
  for (const raw of pids) {
    const pgrp = pgrpOf(raw);
    if (pgrp !== null && want.has(pgrp)) alive.add(pgrp);
  }
  return alive;
}
