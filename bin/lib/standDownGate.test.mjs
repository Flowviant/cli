/**
 * THE WORK LANES STOP AT THE TEARDOWN, EVEN WHILE THE PROCESS LIVES ON
 * (standDownGate.mjs; second review of ruling 2026-09-26).
 *
 * A stand-down that drains a deploy keeps the daemon alive after its teardown
 * has killed every CLI. What `process.exit` used to guarantee on the same tick
 * must still hold: a turn the teardown killed never hands its output back (so
 * its lane settles nothing and retries nothing), no lane spawns a CLI again,
 * and a deploy claim answered after the stand-down began is not run.
 *
 * Its own file because the gate is process-wide and closes for good: every
 * other test file runs in a process where it stays open.
 *
 * Run: node --test bin/lib/standDownGate.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ── a fake `claude` that records its pid, then sits still until killed ──
const bin = mkdtempSync(join(tmpdir(), 'fv-gate-bin-'));
const marks = mkdtempSync(join(tmpdir(), 'fv-gate-turns-'));
writeFileSync(join(bin, 'claude'), `#!/bin/sh\necho x > "${marks}/$$"\nexec sleep 30\n`);
chmodSync(join(bin, 'claude'), 0o755);
process.env.PATH = `${bin}:${process.env.PATH}`;
const spawned = () => readdirSync(marks).length;

// ── the /fleet stand-in: the deploy claim is answered only when told to ──
const hits = [];
let grantClaim;
const claimAnswered = new Promise((r) => (grantClaim = r));
const server = createServer((req, res) => {
  req.resume();
  req.on('end', async () => {
    const tail = req.url.split('/').pop();
    hits.push(tail);
    res.setHeader('Content-Type', 'application/json');
    if (tail === 'deploy-claim') await claimAnswered;
    res.end(JSON.stringify({ success: true, data: tail === 'deploy-claim' ? { claimed: true } : {} }));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
process.env.FLOWVIANT_FLEET_URL = `http://127.0.0.1:${server.address().port}/fleet/agents`;
process.env.FLOWVIANT_FLEET = 'fva_gate_test';
test.after(() => server.close());

const { runTurn } = await import('./runTurn.mjs');
const { stopWorkLanes, workLanesStopped } = await import('./standDownGate.mjs');
const { processDeployJobs, deploysInFlight, whenDeploysSettle } = await import('./deploy.mjs');

const until = async (cond, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
};
const within = (p, ms) => Promise.race([p.then(() => 'answered'), new Promise((r) => setTimeout(() => r('pending'), ms))]);

test('after the teardown a killed turn never answers its lane, no turn spawns, and a late deploy claim is not run', async () => {
  // A turn in flight, as a tab's or an agent's would be.
  let child = null;
  const before = runTurn({ prompt: 'p', system: 's', cwd: tmpdir(), onSpawn: (ch) => (child = ch) });
  await until(() => child && spawned() === 1);

  // A deploy whose claim is still on the wire.
  const root = mkdtempSync(join(tmpdir(), 'fv-gate-deploy-'));
  const mark = join(root, 'ran.txt');
  const origin = join(root, 'origin.git');
  const seed = join(root, 'seed');
  const sh = (args, cwd) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  sh(['init', '-q', '--bare', '-b', 'main', origin], root);
  sh(['clone', '-q', origin, seed], root);
  for (const [k, v] of [['user.email', 't@t'], ['user.name', 't'], ['commit.gpgsign', 'false']]) sh(['config', k, v], seed);
  mkdirSync(join(seed, '.flowviant'));
  writeFileSync(join(seed, '.flowviant', 'deploy.json'), JSON.stringify({ targets: [{ id: 'web', command: `echo ran > ${JSON.stringify(mark)}` }] }));
  sh(['add', '-A'], seed);
  sh(['commit', '-q', '-m', 'base'], seed);
  sh(['push', '-q', 'origin', 'main'], seed);
  const repo = join(root, 'repo');
  sh(['clone', '-q', origin, repo], root);
  processDeployJobs([{ id: 'job-late', kind: 'deploy', targetId: 'web', env: 'prod' }], {
    repoRoot: repo,
    baseRef: 'origin/main',
    worktreeDir: join(root, 'wt'),
    myPubB64: () => 'pub',
  });
  await until(() => hits.includes('deploy-claim'));

  // THE TEARDOWN: the gate closes first, then the CLIs are killed.
  assert.equal(workLanesStopped(), false);
  stopWorkLanes();
  assert.equal(workLanesStopped(), true);
  child.kill('SIGTERM');
  await until(() => child.exitCode !== null || child.signalCode !== null);
  assert.equal(await within(before, 500), 'pending', 'the killed turn hands its lane nothing: no settle, no fresh retry');

  // A lane that gets as far as another spawn (a resume-fresh retry, the
  // wiki's second turn) starts nothing.
  let again = false;
  const after = runTurn({ prompt: 'p', system: 's', cwd: tmpdir(), onSpawn: () => (again = true) });
  assert.equal(await within(after, 300), 'pending');
  assert.equal(again, false, 'no CLI spawned after the teardown');
  assert.equal(spawned(), 1);

  // The claim comes back granted, after the stand-down began: not run.
  const printed = [];
  const log = console.log;
  console.log = (...a) => printed.push(a.join(' '));
  try {
    grantClaim();
    await whenDeploysSettle();
  } finally {
    console.log = log;
  }
  assert.equal(deploysInFlight(), 0, 'released, so the drain does not wait on it');
  assert.equal(existsSync(mark), false, 'the irreversible command never started');
  assert.deepEqual(hits.filter((h) => h.startsWith('deploy-')), ['deploy-claim'], 'no heartbeat, no report: the stale sweep hands it out again');
  assert.match(printed.join('\n'), /web → prod was claimed as this daemon began stopping; not run/);
});
