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
 *
 * ── AND SINCE 2026-09-14 THERE IS A SECOND READER, WHICH IS NOT TELEMETRY ──
 *
 * The paragraph above is about the SNAPSHOT and stands unchanged. What is added
 * below — `memAvailableBytes` and `pressureVerdict` — is read at the moment
 * this machine is about to spawn one more CLI, and it exists because it froze
 * somebody's computer: `MAX_CONCURRENT` had been enforced nowhere since
 * dispatch was deleted, the session-turn lane had no slice at all, and nothing
 * anywhere looked at memory before starting a process that routinely holds
 * gigabytes.
 *
 * It is a RUNAWAY BOUND ON A MACHINE, in the same family as the open-tab
 * ceiling and the card-write budget, and the distinction from a headroom meter
 * is exact and worth stating because the two look alike from a distance:
 *
 *   · a HEADROOM METER is read AHEAD of the decision, by the person making it,
 *     and pre-declares what they may do ("room for 2 more"). That is the
 *     capacity dial, and it is dead.
 *   · a RUNAWAY BOUND is read AT the spawn, by the machine, and produces
 *     nothing at all until it actually fires — at which point what surfaces is
 *     the machine's own measured sentence AT THE THING THAT IS WAITING ("low
 *     memory — 612 MB of 16.0 GB available"), which is the same shape as a CLI
 *     relaying that it hit its own limit.
 *
 * So: no number is ever published in advance, nothing is killed (this module
 * signals nothing, ever), nothing is parked (a park needs a human gesture to
 * lift; pressure clears on its own), and a machine that cannot MEASURE refuses
 * nothing — an unreadable /proc is ignorance, and ignorance never withholds.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statfsSync } from 'node:fs';
import { freemem, loadavg, platform } from 'node:os';
import { MACHINE } from './config.mjs';

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

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

/**
 * HOW MUCH MEMORY A NEW PROCESS COULD ACTUALLY HAVE.
 *
 * Deliberately NOT `freemem()`, which reports pages nobody is using — on any
 * box that has been up a while that is a small number next to a large page
 * cache, so a machine with 12 GB of reclaimable cache reads as nearly full and
 * a guard built on it would refuse everything forever. Linux publishes the
 * honest figure itself (`MemAvailable`, which accounts for what the kernel
 * would reclaim under pressure); macOS does not, so free + inactive + purgeable
 * pages is the nearest thing it will say out loud.
 *
 * The cgroup is asked SECOND and narrows rather than replaces, for the reason
 * `machineLimits` gives in config.mjs: a 4GB container on a 256GB box reads the
 * host through the os module, and oversubscribing there ends with the OOM
 * killer picking a victim by resident size — frequently not the offender.
 *
 * Returns null ONLY where nothing could be read at all, and the caller treats
 * that as ignorance. Everything downstream must keep that distinction: a
 * machine that cannot look must not refuse work.
 *
 * AND FOR ONE RELEASE IT COULD NOT RETURN NULL, which made the sentence above a
 * promise the code did not keep. Every branch ended in `freemem()` — the figure
 * the first paragraph rejects by name — so an unreadable `/proc` (a masked or
 * restricted container), a `MemAvailable:` line this kernel does not publish, or
 * a `vm_stat` that will not run all substituted the ONE number this module says
 * a guard built on it would refuse everything forever. The caller's ignorance
 * arms were dead code, and what shipped instead was a machine deferring every
 * agent turn, Deploy press and wiki sweep indefinitely while relaying "low
 * memory — 612 MB of 16.0 GB available" as if it had measured something. A
 * Flowviant-invented refusal standing on a number this file already calls
 * unusable is worse than no guard.
 *
 * WINDOWS IS THE ONE PLACE `freemem()` IS THE RIGHT FIGURE, and it is kept
 * there deliberately rather than by omission: Node reads it from
 * `GlobalMemoryStatusEx().ullAvailPhys`, which is an AVAILABLE number in the
 * same sense `MemAvailable` is, not a count of untouched pages. Every other
 * platform this does not name reports free pages, so it says nothing at all.
 *
 * `read` is a PARAMETER, and only so the null contract can be pinned: the
 * ignorance case cannot be reached from a test that has a working `/proc`, and
 * an unreachable branch is how the fallback above survived review in the first
 * place. Nothing in the daemon passes it.
 */
export function memAvailableBytes(read = readFile) {
  if (platform() === 'linux') {
    let avail = null;
    const mi = read('/proc/meminfo');
    const m = mi && mi.match(/^MemAvailable:\s+(\d+)\s+kB/m);
    if (m) avail = Number(m[1]) * 1024;
    const max = read('/sys/fs/cgroup/memory.max');
    if (max && max !== 'max') {
      const limit = Number(max);
      const cur = Number(read('/sys/fs/cgroup/memory.current'));
      if (Number.isFinite(limit) && limit > 0 && Number.isFinite(cur)) {
        const room = Math.max(0, limit - cur);
        avail = avail === null ? room : Math.min(avail, room);
      }
    }
    return avail !== null && Number.isFinite(avail) ? avail : null;
  }
  if (platform() === 'darwin') return darwinAvailableBytes();
  if (platform() === 'win32') {
    const f = freemem();
    return Number.isFinite(f) && f > 0 ? f : null;
  }
  return null;
}

/**
 * `vm_stat`'s page counts, in the units it states in its own header.
 *
 * The page size is READ rather than assumed for exactly the reason
 * `processes.mjs` reads VmRSS's unit instead of multiplying statm by 4096:
 * Apple Silicon runs 16K pages, and a memory readout that is silently four
 * times wrong on somebody's machine is worse than no readout at all.
 */
function darwinAvailableBytes() {
  let text;
  try {
    text = execFileSync('vm_stat', [], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    });
  } catch {
    return null; // no vm_stat, or it took too long — say nothing
  }
  const pm = text.match(/page size of (\d+) bytes/);
  const page = pm ? Number(pm[1]) : 4096;
  const pagesOf = (label) => {
    const m = text.match(new RegExp(`^${label}:\\s+(\\d+)\\.`, 'm'));
    return m ? Number(m[1]) : 0;
  };
  const pages = pagesOf('Pages free') + pagesOf('Pages inactive') + pagesOf('Pages purgeable');
  return pages > 0 ? pages * page : null;
}

/** The guard off entirely — an escape hatch for a box whose operator knows
 *  better than the thresholds. Read per call, not captured at import, so it is
 *  true of the environment the daemon is in RIGHT NOW rather than the one it
 *  booted in. `absence` and `'0'` both mean the guard is on. */
export function pressureGuardOff() {
  return process.env.FLOWVIANT_NO_PRESSURE_GUARD === '1';
}

/** An operator's override, or the default. Positive finite numbers only: a
 *  typo'd `FLOWVIANT_MIN_FREE_MB=lots` must fall back to the default rather
 *  than turning every comparison into NaN, which compares false and would
 *  silently disable the guard it was trying to tune. */
const envNum = (name, fallback) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

const sizeWord = (n) =>
  n >= GiB ? `${(n / GiB).toFixed(1)} GB` : `${Math.round(n / MiB)} MB`;

/** How long one measurement stands. The reconcile loop asks several times a
 *  tick (one per admission point) and every answer would otherwise be a fresh
 *  /proc read — or, on macOS, a fresh `vm_stat` spawn, which is a process per
 *  question about whether to start a process. */
const PRESSURE_CACHE_MS = 2_000;
let lastMeasure = { at: 0, m: null };

/** What the box says about itself, cached briefly. Exported so a caller can
 *  hold one reading across several verdicts — and so tests can pass their own
 *  instead of depending on the machine they run on. */
export function measurePressure() {
  const now = Date.now();
  if (lastMeasure.m && now - lastMeasure.at < PRESSURE_CACHE_MS) return lastMeasure.m;
  const m = {
    memAvailable: memAvailableBytes(),
    memTotal: MACHINE.memBytes,
    // Unix only; Windows reports zeroes, which are sent as null rather than as
    // a very calm-looking 0.00 — the same rule the snapshot keeps.
    load1: loadavg()[0] || null,
    cores: MACHINE.cores,
  };
  lastMeasure = { at: now, m };
  return m;
}

/**
 * IS THIS A MOMENT TO START ANOTHER CLI? — null when there is nothing to say.
 *
 * TWO LEVELS, because the two lanes are not the same promise. `churn` is the
 * unattended work — agent turns, a Deploy press's planner, the wiki
 * cartographer — which nobody is sitting in front of and which the server will
 * cheerfully re-offer next poll, so it yields early and generously. A session
 * turn is `interactive`: somebody is watching a composer they just pressed
 * enter in, and deferring that is a visible stall, so it holds out until the
 * box is genuinely about to fall over.
 *
 * THE REASON IS MEASURED WORDS AND NOTHING ELSE. No adjectives about the
 * machine, no advice, no "try again in a few minutes" — a sentence naming the
 * number that fired, which is the only thing this side actually knows.
 *
 * An unreadable measurement contributes NO verdict: memory that could not be
 * read cannot refuse, and a load average this platform does not publish cannot
 * either. Ignorance never withholds.
 */
export function pressureVerdict(level, measured) {
  if (pressureGuardOff()) return null;
  const m = measured ?? measurePressure();
  const avail = Number.isFinite(m?.memAvailable) ? m.memAvailable : null;
  if (level === 'interactive') {
    const floor = envNum('FLOWVIANT_CRITICAL_FREE_MB', 400) * MiB;
    if (avail !== null && avail < floor)
      return { reason: `nearly out of memory — ${sizeWord(avail)} available` };
    return null;
  }
  const total = Number.isFinite(m?.memTotal) && m.memTotal > 0 ? m.memTotal : 0;
  // A fixed floor AND a proportional one, whichever is larger: 1 GB is the
  // right reserve on a laptop and is nothing on a 256 GB box, where six per
  // cent is the honest "the page cache is already being squeezed" line.
  const floor = Math.max(envNum('FLOWVIANT_MIN_FREE_MB', 1024) * MiB, Math.round(total * 0.06));
  if (avail !== null && avail < floor)
    return { reason: `low memory — ${sizeWord(avail)} of ${sizeWord(total)} available` };
  const cores = Number.isFinite(m?.cores) && m.cores > 0 ? m.cores : null;
  const load = Number.isFinite(m?.load1) ? m.load1 : null;
  if (load !== null && cores !== null && load > cores * envNum('FLOWVIANT_MAX_LOAD_PER_CORE', 4))
    return {
      reason: `cpu overloaded — load ${load.toFixed(1)} on ${cores} core${cores === 1 ? '' : 's'}`,
    };
  return null;
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
    //
    // BOUNDED BEFORE THE WALK, not after: each row costs a /proc tree walk, and
    // the cap exists so a caller that hands over a long list cannot turn a
    // telemetry post into a scan of the whole process table. Sixteen is more
    // live turns than any machine this guard admits will ever hold.
    tasks: tasks
      .slice(0, 16)
      .map((t) => ({ taskId: t.intentId, rss: processTreeRssBytes(t.pid) }))
      .filter((t) => t.taskId && t.rss),
  };
}
