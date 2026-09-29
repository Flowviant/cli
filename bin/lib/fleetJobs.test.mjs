/**
 * THE CHECKOUT JOB LANES AND THE SETTLE THEY SEND (2026-09-26, SOLID F038).
 *
 * `createPatchRevertLane`, `createCleanupLane` and `postToFleet` were closures
 * inside `runFleetDaemon` until the split, with no test at all. Driven here
 * against a real git checkout and a real `node:http` server: every job is
 * reported done whatever happened to it (the roster re-serves a job until it
 * is), and a server value that would reach git unchecked is refused in words.
 *
 * Run: node --test bin/lib/fleetJobs.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.HOME = mkdtempSync(join(tmpdir(), 'fv-jobs-home-'));

let nextStatus = 200;
const received = [];
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => {
    body += c;
  });
  req.on('end', () => {
    received.push({ url: req.url, auth: req.headers.authorization, body });
    res.writeHead(nextStatus, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/api/fleet`;
process.env.FLOWVIANT_FLEET_URL = `${base}/agents`;
process.env.FLOWVIANT_FLEET = 'fva_test_credential';
test.after(() => server.close());

const { createCleanupLane, createPatchRevertLane } = await import('./fleetJobs.mjs');
const { postToFleet } = await import('./fleetPost.mjs');

const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
function checkout() {
  const dir = mkdtempSync(join(tmpdir(), 'fv-jobs-repo-'));
  git(['init', '-q'], dir);
  git(['config', 'user.email', 't@example.com'], dir);
  git(['config', 'user.name', 'T'], dir);
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  git(['add', '-A'], dir);
  git(['commit', '-q', '-m', 'one'], dir);
  writeFileSync(join(dir, 'a.txt'), 'two\n');
  git(['commit', '-q', '-am', 'two'], dir);
  return { dir, head: git(['rev-parse', 'HEAD'], dir) };
}
const until = async (cond, what) => {
  for (let i = 0; i < 300; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail(`timed out waiting for ${what}`);
};
const posts = (path) => received.filter((r) => r.url === `/api/fleet/${path}`).map((r) => JSON.parse(r.body));

test('postToFleet answers only "accepted", and never throws', async () => {
  nextStatus = 200;
  assert.equal(await postToFleet(`${base}/machine`, { a: 1 }), true);
  assert.equal(received.at(-1).auth, 'Bearer fva_test_credential');
  assert.deepEqual(JSON.parse(received.at(-1).body), { a: 1 });
  nextStatus = 503;
  assert.equal(await postToFleet(`${base}/machine`, {}), false);
  nextStatus = 200;
  assert.equal(await postToFleet('http://127.0.0.1:1/api/fleet/machine', {}), false, 'a dead wire is false, not a throw');
});

test('a patch revert reverses the commits here and reports done', async () => {
  const repo = checkout();
  received.length = 0;
  const revert = createPatchRevertLane({ repoRoot: repo.dir });
  const job = { id: 'job-1', title: 'Two', shas: [repo.head] };
  revert([job, job, null, { id: 3 }]);
  await until(() => posts('patch-revert-done').length > 0, 'the revert report');
  assert.equal(readFileSync(join(repo.dir, 'a.txt'), 'utf8'), 'one\n', 'a revert commit, never a reset');
  assert.deepEqual(posts('patch-revert-done'), [{ taskId: 'job-1', ok: true }], 'one report for one job id');
});

test('a revert git refuses is still reported, with its words', async () => {
  const repo = checkout();
  received.length = 0;
  createPatchRevertLane({ repoRoot: repo.dir })([{ id: 'job-2', title: 'Range', shas: ['HEAD~1..HEAD'] }]);
  await until(() => posts('patch-revert-done').length > 0, 'the refused revert report');
  const [report] = posts('patch-revert-done');
  assert.equal(report.ok, false);
  assert.match(report.error, /refused/);
});

test('a cleanup that would delete the base branch is refused and still reported', async () => {
  const repo = checkout();
  received.length = 0;
  let baseRef = 'origin/main';
  const cleanup = createCleanupLane({ repoRoot: repo.dir, getBaseRef: () => baseRef });
  cleanup([{ id: 'task-9', title: 'Restarted', branch: 'main' }]);
  await until(() => posts('cleanup-done').length > 0, 'the cleanup report');
  assert.deepEqual(posts('cleanup-done'), [{ taskId: 'task-9' }]);
  // The base ref is read at CALL time: the roster can move it mid-run.
  baseRef = 'origin/trunk';
  received.length = 0;
  cleanup([{ id: 'task-10', title: 'Restarted', prUrl: 'https://github.com/someone-else/repo/pull/1' }]);
  await until(() => posts('cleanup-done').length > 0, 'the second cleanup report');
  assert.deepEqual(posts('cleanup-done'), [{ taskId: 'task-10' }]);
});

/**
 * THE LOOP SPEAKS TO THE SERVER THROUGH ITS MODULES, NEVER DIRECTLY. The poll's
 * query string is fleetRoster.mjs's, every report is fleetReports.mjs's, and
 * the settle POST is fleetPost.mjs's — so a copy of any of them coming back
 * into fleet.mjs fails here.
 */
test('the settle POST has one home and fleet.mjs builds no request of its own', () => {
  const dirs = [new URL('./', import.meta.url), new URL('../', import.meta.url)];
  const code = (src) =>
    src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((l) => !/^\s*\/\//.test(l))
      .join('\n');
  const files = dirs.flatMap((d) =>
    readdirSync(d)
      .filter((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs'))
      .map((f) => ({ f, src: code(readFileSync(new URL(f, d), 'utf8')) }))
  );
  assert.ok(files.length > 40 && files.some((x) => x.f === 'fleet.mjs'), 'the walk found the daemon (canary)');
  // THE SHAPE, not the name: a fleet-credential POST whose whole answer is
  // `res.ok` (no retry, no refusal reading). A renamed copy is still this.
  const settleShape = (src) =>
    [...src.matchAll(/return (\w+)\.ok;/g)].some((m) => {
      const before = src.slice(Math.max(0, m.index - 700), m.index);
      return before.includes('fetch(') && before.includes("'POST'") && before.includes('Bearer ${FLEET_TOKEN}');
    });
  const homes = files.filter((x) => settleShape(x.src)).map((x) => x.f);
  assert.deepEqual(homes, ['fleetPost.mjs'], 'one settle POST (the home matching is the shape canary)');
  assert.deepEqual(files.filter((x) => x.src.includes('reportMergeOutcome')).map((x) => x.f), []);
  const fleet = files.find((x) => x.f === 'fleet.mjs').src;
  for (const copy of ['fetch(', 'searchParams.set(', 'fleetEndpoint('])
    assert.ok(!fleet.includes(copy), `fleet.mjs builds a request itself (${copy})`);
});
