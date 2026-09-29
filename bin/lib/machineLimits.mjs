/**
 * WHAT THIS MACHINE CAN ACTUALLY BE GIVEN, read from the machine (2026-09-26,
 * SOLID F059).
 *
 * Split out of config.mjs, which computed this inline at import from the real
 * `/sys/fs/cgroup` files and the os module — so the rule could not be driven
 * under any cgroup but the one the suite happened to run in. The RULE is now
 * `deriveMachineLimits`, pure over supplied cgroup contents and host totals;
 * `measureMachineLimits` is the thin reader that hands it this box's.
 * config.mjs still exports the measured `MACHINE`, and `deriveMaxConcurrent`
 * keeps its (memBytes, cores) contract.
 *
 * `os.totalmem()` and `cpus().length` report the HOST inside a container: a
 * 4GB container on a 256GB box reads 256GB and cheerfully oversubscribes until
 * the OOM killer picks a victim — which, because it picks by resident size, is
 * frequently not the task that caused it. cgroup v2 publishes the real limits,
 * so read those first and treat the os module as the fallback it is.
 */

import { readFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';

/**
 * The limits from what was read. `memMax` / `cpuMax` are the raw cgroup v2
 * file contents (trimmed), or null when there is no such file; anything
 * unparseable is ignored and the host figure stands.
 */
export function deriveMachineLimits({ memMax = null, cpuMax = null, hostMemBytes, hostCores } = {}) {
  let memBytes = hostMemBytes;
  if (memMax && memMax !== 'max') {
    const n = Number(memMax);
    if (Number.isFinite(n) && n > 0) memBytes = Math.min(memBytes, n);
  }
  let cores = hostCores || 2;
  // "<quota> <period>" in microseconds, or "max <period>" for unlimited.
  if (cpuMax && !cpuMax.startsWith('max')) {
    const [q, p] = cpuMax.split(/\s+/).map(Number);
    if (Number.isFinite(q) && Number.isFinite(p) && p > 0) {
      cores = Math.max(1, Math.min(cores, Math.floor(q / p)));
    }
  }
  return { memBytes, cores };
}

const readCgroup = (f) => {
  try {
    return readFileSync(`/sys/fs/cgroup/${f}`, 'utf8').trim();
  } catch {
    return null;
  }
};

/** This box's limits: its cgroup files and its os module, handed to the rule. */
export function measureMachineLimits(read = readCgroup) {
  return deriveMachineLimits({
    memMax: read('memory.max'),
    cpuMax: read('cpu.max'),
    hostMemBytes: totalmem(),
    hostCores: cpus().length,
  });
}
