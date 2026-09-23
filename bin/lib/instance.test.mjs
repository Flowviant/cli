/**
 * STOPPING ONE CREDENTIAL'S DAEMON (0.95.0) — `flowviant machines`'s
 * disconnect, which names ONE project and must touch exactly that project's
 * lock.
 *
 * `flowviant stop` sweeps every lock on the box because its asker does not
 * know what is running; the disconnect's asker has just picked a row. What is
 * worth pinning is that the two share ONE per-lock ritual (two hand-copies of
 * a SIGTERM-then-SIGKILL are two places to get the grace period wrong — the
 * argument `standDown` already makes) and that a lock naming a dead pid is
 * "already gone", counted as nothing, never a failure.
 *
 * Run: node --test bin/lib/instance.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const source = () =>
  readFileSync(new URL('./instance.mjs', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .join('\n');

test('stopAllDaemons and stopDaemonFor share one per-lock stop', () => {
  const src = source();
  // Exactly two callers of the shared function, and no second SIGTERM site.
  assert.equal(src.split('stopLock(').length - 1, 3, 'the definition and its two callers');
  assert.ok(src.includes('stopLock(instanceLockPath(fleetToken), log, tally);'), 'the named credential, no sweep');
  assert.ok(src.includes('for (const path of lockFiles()) stopLock(path, log, tally);'), 'the sweep');
  assert.equal(src.split("process.kill(holder.pid, 'SIGTERM')").length - 1, 1, 'one place signals');
});

/**
 * A lock naming a pid that is gone is the common shape after a crash or a
 * reboot. It is reported as "already gone", nothing is signalled, and the
 * tally says no daemon was running — which is what lets the disconnect carry
 * on to the leave and the forget instead of aborting on a corpse.
 */
test('a lock naming a dead pid is "already gone" — not running, not a failure', async () => {
  const before = process.env.HOME;
  const home = mkdtempSync(join(tmpdir(), 'fv-stopfor-'));
  try {
    process.env.HOME = home;
    mkdirSync(join(home, '.flowviant'), { recursive: true });
    const inst = await import(`./instance.mjs?stopfor=${Date.now()}`);
    // A pid no live process holds: spawn-and-reap would be exact, but a pid
    // beyond pid_max on any Linux is never allocated and `kill(pid, 0)` says
    // ESRCH; the same holds for every platform this runs on.
    const dead = 2 ** 22 + 7;
    writeFileSync(
      inst.instanceLockPath('fva_test'),
      JSON.stringify({ pid: dead, repoRoot: '/repo', startedAt: new Date().toISOString(), entry: 'cli.mjs', version: '0.95.0' })
    );
    const lines = [];
    const tally = inst.stopDaemonFor('fva_test', { log: (m) => lines.push(m) });
    assert.deepEqual(tally, { stopped: 0, unconfirmed: 0, failed: 0, running: 0 });
    assert.match(lines[0], new RegExp(`pid ${dead} in /repo is already gone`));
    // No lock at all is silence, not an error: a project connected here but not
    // running is the ordinary disconnect.
    const quiet = [];
    assert.deepEqual(inst.stopDaemonFor('fva_never', { log: (m) => quiet.push(m) }), { stopped: 0, unconfirmed: 0, failed: 0, running: 0 });
    assert.deepEqual(quiet, []);
  } finally {
    if (before === undefined) delete process.env.HOME;
    else process.env.HOME = before;
  }
});
