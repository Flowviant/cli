import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { turnLockedByLivePid } from './work.mjs';
import { processStartTime } from './procRegistry.mjs';

/**
 * THE TURN LOCK NEVER BELIEVES A STRANGER.
 *
 * The lock outlives a reboot or a daemon killed mid-turn, and pids are
 * recycled. EPERM was read as "alive, just not ours", so a lock whose pid a
 * boot service had inherited wedged every turn and ship in that place forever
 * — but the lock only ever holds a CLI this daemon spawned under its own uid,
 * so a pid it may not signal cannot be one.
 */
function lockFile(t, content) {
  const dir = mkdtempSync(join(tmpdir(), 'fv-lock-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const p = join(dir, 'flowviant-turn.lock');
  writeFileSync(p, content);
  return p;
}

const pidOneIsOtherUid = process.getuid?.() !== undefined && (() => {
  try { return statSync('/proc/1').uid !== process.getuid(); } catch { return false; }
})();
test("a lock naming another uid's live process is stale and cleared", { skip: !pidOneIsOtherUid && 'pid 1 belongs to this uid or its owner is unknown' }, (t) => {
  // pid 1 is init — alive, and not signalable by an ordinary user (EPERM).
  const p = lockFile(t, '1');
  assert.equal(turnLockedByLivePid(p), false);
  assert.equal(existsSync(p), false);
});

test('a lock naming a dead pid is stale and cleared', (t) => {
  const p = lockFile(t, '2147483646');
  assert.equal(turnLockedByLivePid(p), false);
  assert.equal(existsSync(p), false);
});

test('a live CLI of ours holds the lock, and a recycled pid (a different start time) does not', async (t) => {
  const child = spawn('sleep', ['30'], { stdio: 'ignore' });
  t.after(() => child.kill('SIGKILL'));
  await new Promise((r) => child.once('spawn', r));
  const start = processStartTime(child.pid);
  const held = lockFile(t, start ? `${child.pid}:${start}` : String(child.pid));
  assert.equal(turnLockedByLivePid(held), true);
  assert.equal(existsSync(held), true);
  // A legacy lock (no start time) keeps the plain signal-0 reading.
  assert.equal(turnLockedByLivePid(lockFile(t, String(child.pid))), true);
  if (!start) return; // this platform cannot read a start time — nothing more to say
  const recycled = lockFile(t, `${child.pid}:${start}-not-this-one`);
  assert.equal(turnLockedByLivePid(recycled), false);
  assert.equal(existsSync(recycled), false);
});
