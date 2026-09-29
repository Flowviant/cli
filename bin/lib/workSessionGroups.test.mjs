import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkSessionGroups } from './workSessionGroups.mjs';
import { readRegistry } from './procRegistry.mjs';
import { processesSupported } from './processes.mjs';

/**
 * WHICH PROCESS GROUPS EACH TAB STARTED, driven directly (split out of
 * work.mjs 2026-09-26, SOLID F037). groupRegistry.test.mjs holds the restart
 * and reboot cases through the manager; these pin the module's own surface.
 */
const skip = !processesSupported() && 'this platform cannot measure processes';

test('a noted group is persisted per repo, reported as the tab\'s, and forgotten when the tab closes', { skip }, async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'fv-sg-home-'));
  const realHome = process.env.HOME;
  process.env.HOME = home;
  const leader = spawn('sh', ['-c', 'sleep 30; true'], { detached: true, stdio: 'ignore' });
  t.after(() => {
    process.env.HOME = realHome;
    try {
      process.kill(-leader.pid, 'SIGKILL');
    } catch {
      /* gone */
    }
    rmSync(home, { recursive: true, force: true });
  });
  await new Promise((r) => leader.once('spawn', r));
  await new Promise((r) => setTimeout(r, 100));
  const repoRoot = '/repo/for/groups';
  const file = join(home, '.flowviant', `session-groups-${createHash('sha256').update(repoRoot).digest('hex').slice(0, 16)}.json`);
  const g = createWorkSessionGroups({ repoRoot });
  assert.deepEqual(g.sessionProcesses('s1'), { rows: [], total: 0 }, 'looked and found none — never "never looked"');
  g.noteSessionGroup('s1', leader.pid);
  g.noteSessionGroup('', leader.pid); // no id, nothing to charge it to
  assert.deepEqual(readRegistry(file).map((e) => [e.sessionId, e.pid]), [['s1', leader.pid]]);
  assert.ok(g.sessionGroups.get('s1').has(leader.pid));
  const seen = g.sessionProcesses('s1');
  assert.ok(seen.total >= 1, 'the watcher under the leader is the tab\'s');
  g.pruneSessionGroups(['s2']);
  assert.equal(g.sessionGroups.has('s1'), false);
  assert.deepEqual(readRegistry(file), []);
});
