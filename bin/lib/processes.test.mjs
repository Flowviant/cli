import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { processesInGroups, liveGroups, processesSupported, MAX_PROCS } from './processes.mjs';

/** A detached `sh` that outlives its parent's attention, with a child of its
 *  own — the shape the feature exists for: a backgrounded watcher. */
function group() {
  const child = spawn('sh', ['-c', 'sleep 30 & sleep 30'], {
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  return child;
}
const settle = () => new Promise((r) => setTimeout(r, 250));

test('reports what the group is running, and never the leader itself', async (t) => {
  if (!processesSupported()) return t.skip('no /proc and no ps');
  const leader = group();
  await settle();
  const rows = processesInGroups([leader.pid]);
  assert.ok(Array.isArray(rows));
  assert.ok(rows.length >= 1, 'the group should have members');
  // THE LEADER IS THE CLI, whose argv is `-p <prompt> --append-system-prompt
  // <system>` — several kilobytes of the driver's message and the operating
  // contract. Reporting it would push all of that into a browser every sweep.
  assert.ok(
    rows.every((r) => r.pid !== leader.pid),
    'the group leader must never be reported'
  );
  try {
    process.kill(-leader.pid, 'SIGKILL');
  } catch {
    /* already gone */
  }
});

test('an unrelated process is not attributed to the group', async (t) => {
  if (!processesSupported()) return t.skip('no /proc and no ps');
  const mine = group();
  const other = group();
  await settle();
  const rows = processesInGroups([mine.pid]);
  assert.ok(
    rows.every((r) => r.pid !== other.pid),
    'another group is somebody else’s work'
  );
  for (const g of [mine, other]) {
    try {
      process.kill(-g.pid, 'SIGKILL');
    } catch {
      /* gone */
    }
  }
});

test('a command line is scrubbed before it leaves the machine', async (t) => {
  if (!processesSupported()) return t.skip('no /proc and no ps');
  const leader = spawn('sh', ['-c', 'sleep 30 --token hunter2supersecret'], {
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  await settle();
  const rows = processesInGroups([leader.pid], {
    scrub: (t2) => t2.split('hunter2supersecret').join('[REDACTED:TOKEN]'),
  });
  const joined = rows.map((r) => r.cmd).join(' ');
  assert.ok(!joined.includes('hunter2supersecret'), 'the secret must not survive');
  try {
    process.kill(-leader.pid, 'SIGKILL');
  } catch {
    /* gone */
  }
});

test('an empty ask is "found none", never a scan', () => {
  assert.deepEqual(processesInGroups([]), []);
  assert.deepEqual([...liveGroups([])], []);
});

test('a dead group is pruned, so the remembered set cannot grow forever', async (t) => {
  if (!processesSupported()) return t.skip('no /proc and no ps');
  const leader = group();
  await settle();
  assert.ok(liveGroups([leader.pid]).has(leader.pid), 'alive while it runs');
  try {
    process.kill(-leader.pid, 'SIGKILL');
  } catch {
    /* gone */
  }
  await settle();
  // Unpruned, a recycled pgid would eventually hand a stranger's process to a
  // tab that has been closed for a week.
  assert.equal(liveGroups([leader.pid]).has(leader.pid), false, 'gone once killed');
});

test('the row cap is a real bound', () => {
  assert.ok(MAX_PROCS > 0 && MAX_PROCS <= 32);
});
