import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { platform } from 'node:os';
import { createWorkChildren } from './workChildren.mjs';

/** The machine's live children, driven directly (split out of work.mjs
 *  2026-09-26, SOLID F037). */
const fakeChild = (pid) => {
  const ch = { pid, signals: [], kill: (sig) => ch.signals.push(sig) };
  return ch;
};

test('the count is every child plus the lanes the caller reports, and the snapshot names whose each is', () => {
  let extra = 1;
  const { workChildren, liveTurnCount, liveTurns, admit } = createWorkChildren({ extraLiveTurns: () => extra });
  assert.equal(liveTurnCount(), 1, 'the wiki lane counts with nothing spawned here');
  workChildren.set(fakeChild(101), 'sess-1');
  workChildren.set(fakeChild(102), null);
  workChildren.set(fakeChild(undefined), 'a-1');
  assert.equal(liveTurnCount(), 4);
  assert.deepEqual(liveTurns(), [
    { id: 'sess-1', pid: 101 },
    { id: null, pid: 102 },
  ]);
  extra = Number.NaN;
  assert.equal(liveTurnCount(), 3, 'a garbage report counts nothing');
  assert.equal(typeof admit, 'function');
  assert.equal(typeof admit.reserve, 'function');
});

test('teardown SIGTERMs each child — never its group — and empties the registry', () => {
  const { workChildren, groupKillChildren, shutdownWork } = createWorkChildren({ extraLiveTurns: () => 0 });
  const a = fakeChild(undefined);
  workChildren.set(a, 'sess-1');
  shutdownWork();
  assert.deepEqual(a.signals, ['SIGTERM']);
  assert.equal(workChildren.size, 0);
  assert.equal(groupKillChildren.size, 0);
});

test('a check child takes its whole process group with it', { skip: platform() === 'win32' }, async () => {
  const { workChildren, groupKillChildren, shutdownWork } = createWorkChildren({ extraLiveTurns: () => 0 });
  // `sh -c 'sleep 30; :'` keeps the shell as the child and sleep beneath it —
  // the compound-command shape a SIGTERM to the child alone would orphan.
  const ch = spawn('sh', ['-c', 'sleep 30; :'], { detached: true, stdio: 'ignore' });
  await new Promise((r) => ch.once('spawn', r));
  workChildren.set(ch, 'a-1');
  groupKillChildren.add(ch);
  const exited = new Promise((r) => ch.once('exit', (code, sig) => r(sig)));
  shutdownWork();
  assert.equal(await exited, 'SIGTERM');
  // The group is gone, not just its leader (polled: the reaping is the kernel's).
  const groupAlive = () => {
    try {
      process.kill(-ch.pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  for (let i = 0; i < 100 && groupAlive(); i += 1) await new Promise((r) => setTimeout(r, 20));
  assert.equal(groupAlive(), false, 'the sleep under the shell went with it');
});
