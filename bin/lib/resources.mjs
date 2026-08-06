/**
 * What this machine is actually doing with itself.
 *
 * Flowviant can tell you a task is building and nothing about why it is slow.
 * That gap is affordable when the machine is your own laptop — you can look at
 * it — and not when the machine is a box in a rack that four people share. The
 * whole argument for one central machine is that one machine is easier to
 * manage than N laptops, and that is only true if you can SEE the one machine.
 *
 * This is deliberately telemetry, never a budget. It reports pressure that
 * exists right now, which is the same category as "what is building" — a fact
 * about the world you would have known by sitting at the keyboard. It must
 * never become a headroom number in front of the person dispatching: "you may
 * run 2 more tasks" is the capacity dial wearing a lab coat, and that is dead.
 * The only surface for this is project settings, whose audience is whoever
 * administers the box.
 */

import { readFileSync, readdirSync, statfsSync } from 'node:fs';
import { freemem, loadavg } from 'node:os';
import { MACHINE } from './config.mjs';

const readFile = (p) => {
  try {
    return readFileSync(p, 'utf8').trim();
  } catch {
    return null;
  }
};

/**
 * Memory in use, from the cgroup when there is one.
 *
 * `freemem()` reports the HOST inside a container — the same trap that made
 * `cpus().length` lie about core count — so a container at 95% of its own
 * limit looks idle if you ask the os module. Prefer memory.current against
 * memory.max, and fall back only when there is no cgroup to read.
 */
function memoryUsed() {
  const cur = readFile('/sys/fs/cgroup/memory.current');
  if (cur !== null) {
    const n = Number(cur);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return Math.max(0, MACHINE.memBytes - freemem());
}

/**
 * Resident memory of a process AND everything it spawned.
 *
 * A task is never one process: it is Claude, plus a dev server, plus whatever
 * the test runner forked. Charging a task only its own RSS would report a few
 * hundred megabytes for something holding twelve gigabytes, which is worse than
 * reporting nothing — it would exonerate the exact task you are hunting.
 *
 * Linux only, and that is stated rather than hidden: /proc is how you read this
 * honestly, and a wrong number here sends someone to kill the wrong task.
 */
export function processTreeRssBytes(pid) {
  if (!pid) return null;
  const rssOf = (p) => {
    const roll = readFile(`/proc/${p}/smaps_rollup`);
    const src = roll ?? readFile(`/proc/${p}/status`);
    if (!src) return 0;
    const m = src.match(/^(?:Rss|VmRSS):\s+(\d+)\s+kB/m);
    return m ? Number(m[1]) * 1024 : 0;
  };
  const childrenOf = (p) => {
    const t = readFile(`/proc/${p}/task`);
    if (t === null && !readFile(`/proc/${p}/stat`)) return [];
    const out = [];
    try {
      for (const tid of readdirSync(`/proc/${p}/task`)) {
        const kids = readFile(`/proc/${p}/task/${tid}/children`);
        if (kids) out.push(...kids.split(/\s+/).filter(Boolean).map(Number));
      }
    } catch {
      /* no children file (not Linux, or the process just exited) */
    }
    return out;
  };
  let total = 0;
  const seen = new Set();
  const stack = [Number(pid)];
  while (stack.length) {
    const p = stack.pop();
    if (!Number.isFinite(p) || seen.has(p)) continue;
    seen.add(p);
    total += rssOf(p);
    stack.push(...childrenOf(p));
  }
  return total || null;
}

/** Free bytes on the volume holding the worktrees. */
export function diskFreeBytes(path) {
  try {
    // statfsSync landed in Node 18.15; the daemon's floor is well past that.
    const s = statfsSync(path);
    return { free: s.bavail * s.bsize, total: s.blocks * s.bsize };
  } catch {
    return null; // no statfs on this platform, or the path is gone
  }
}

/**
 * A snapshot for the roster poll. Small, flat, and all of it observed — nothing
 * here is a prediction or an allowance.
 */
export function machineSnapshot({ worktreeDir, tasks = [] } = {}) {
  const used = memoryUsed();
  const disk = worktreeDir ? diskFreeBytes(worktreeDir) : null;
  return {
    memTotal: MACHINE.memBytes,
    memUsed: used,
    cores: MACHINE.cores,
    // Unix only; Windows reports zeroes, which we send as null rather than as a
    // very calm-looking 0.00.
    load1: loadavg()[0] || null,
    diskFree: disk?.free ?? null,
    diskTotal: disk?.total ?? null,
    // Per-task, so "the box is full" can be traced to the task that filled it.
    tasks: tasks
      .map((t) => ({ intentId: t.intentId, rss: processTreeRssBytes(t.pid) }))
      .filter((t) => t.intentId && t.rss),
  };
}
