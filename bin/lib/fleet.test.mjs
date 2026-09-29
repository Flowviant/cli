/**
 * ONE RECONCILE TICK, DRIVEN END TO END (2026-09-26, SOLID F038).
 *
 * The split moved the wiki runner and the machine report out of fleet.mjs, and
 * the loop's promise about them — a wiki sweep never holds the machine's own
 * report hostage, because the loop hands the runner its roster and reports on
 * the SAME tick without awaiting either — was left proved by source slices and
 * a smoke run nobody kept. This is that smoke run, kept.
 *
 * The real daemon (`bin/cli.mjs`) starts in a scratch checkout with a scratch
 * HOME, against a `node:http` server standing in for the API, with a fake
 * `claude` on PATH that records its pid and then sits still: a turn held open
 * for as long as the test likes, spending no model. The server offers one
 * wiki Regenerate on the first poll and a commanded stop only once it has seen
 * the machine report arrive while that turn is still running.
 *
 * Run: node --test bin/lib/fleet.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test('one tick hands the wiki its roster AND reports the machine; the report keeps coming while the sweep runs', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'fv-tick-home-'));
  const bin = join(home, 'bin');
  const marks = join(home, 'turns');
  mkdirSync(bin);
  mkdirSync(marks);
  writeFileSync(
    join(bin, 'claude'),
    '#!/bin/sh\n' +
      'if [ "$1" = "--version" ]; then echo "2.1.0 (Claude Code)"; exit 0; fi\n' +
      // The one-shot `/` probe (`-p x`) is not a turn: answer nothing, at once.
      'if [ "$1" = "-p" ] && [ "$2" = "x" ]; then exit 0; fi\n' +
      `echo "$@" > "${marks}/$$"\nexec sleep 30\n`
  );
  chmodSync(join(bin, 'claude'), 0o755);
  const turnPids = () => readdirSync(marks).map(Number);

  const repo = mkdtempSync(join(tmpdir(), 'fv-tick-repo-'));
  const git = (args) => execFileSync('git', args, { cwd: repo });
  git(['init', '-q']);
  git(['config', 'user.email', 't@example.com']);
  git(['config', 'user.name', 'T']);
  writeFileSync(join(repo, 'app.js'), 'export const x = 1;\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'first']);

  /** Every request, in arrival order, with the poll count and the live wiki turns at that moment. */
  const log = [];
  let polls = 0;
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const path = req.url.split('?')[0];
      const turnsNow = turnPids().filter(alive);
      log.push({ path, afterPoll: polls, turnsNow });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (path !== '/api/fleet/agents') return res.end(JSON.stringify({ success: true, data: {} }));
      polls++;
      const data = { agents: [], project: { id: 'proj-tick', name: 'Tick' } };
      if (polls === 1) data.codeMapJob = { requestedAt: 'r1' };
      // The stop waits for the thing under test: a machine report that arrived
      // while the wiki turn was alive. A daemon that never sends one is
      // never stopped, and the test fails on its timeout instead.
      if (log.some((r) => r.path === '/api/fleet/machine' && r.turnsNow.length > 0))
        data.daemon = { stop: { reason: 'test over' } };
      res.end(JSON.stringify({ success: true, data }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());

  const cli = fileURLToPath(new URL('../cli.mjs', import.meta.url));
  const child = spawn(process.execPath, [cli], {
    cwd: repo,
    env: {
      HOME: home,
      PATH: [bin, dirname(process.execPath), '/usr/bin', '/bin'].join(':'),
      FLOWVIANT_FLEET: 'fva_tick_test',
      FLOWVIANT_FLEET_URL: `http://127.0.0.1:${server.address().port}/api/fleet/agents`,
      RECONCILE_SECONDS: '1',
      FLOWVIANT_NO_UPDATE: '1',
      // The memory/load half of admission reads THIS box, which a shared test
      // machine can fail; the concurrency half still applies.
      FLOWVIANT_NO_PRESSURE_GUARD: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  t.after(() => {
    if (child.exitCode === null) child.kill('SIGKILL');
    for (const pid of turnPids()) if (alive(pid)) process.kill(pid, 'SIGKILL');
  });
  let timer;
  const code = await Promise.race([
    new Promise((r) => child.on('exit', r)),
    new Promise((r) => (timer = setTimeout(() => r('timeout'), 45_000))),
  ]);
  clearTimeout(timer);
  assert.equal(code, 0, `the daemon exits 0 on a commanded stop\n${out.slice(-2000)}`);

  // The first tick: after the roster that offered the sweep, and before the
  // next poll, the loop reported the machine.
  const firstTick = log.filter((r) => r.afterPoll === 1);
  assert.ok(
    firstTick.some((r) => r.path === '/api/fleet/machine'),
    `the tick that took the wiki job reported the machine: ${JSON.stringify(log)}`
  );
  // The sweep ran as a real CLI turn under the wiki runner…
  assert.equal(turnPids().length, 1, 'one cartographer turn');
  assert.ok(log.some((r) => r.path === '/api/fleet/wiki-progress'), 'the sweep said it started');
  // …and the machine kept reporting WHILE it was held open.
  assert.ok(
    log.some((r) => r.path === '/api/fleet/machine' && r.turnsNow.length === 1),
    'a machine report arrived while the wiki turn was running'
  );
  // The stop's teardown takes the cartographer with it.
  for (let i = 0; i < 100 && turnPids().some(alive); i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(turnPids().filter(alive).length, 0, 'no orphaned wiki CLI');
});

// ── A STAND-DOWN MID-DEPLOY, ON THE REAL LOOP (ruling 2026-09-26) ────────────
//
// standDownExit.test.mjs drives `leave` and the signal handlers in harnesses;
// what only the real daemon can show is the LOOP: once a stand-down begins,
// nothing more is taken — no poll, no job — and only the deploy already
// claimed runs on to its report. The daemon starts in a clone whose base
// declares one slow target, against a node:http API that hands that deploy
// out on the first poll and keeps offering MORE work (a second deploy, a wiki
// sweep) on every poll after the stand-down began.

function drainScene(tag, seconds, { turnMarks = null } = {}) {
  const home = mkdtempSync(join(tmpdir(), `fv-drain-${tag}-home-`));
  const bin = join(home, 'bin');
  mkdirSync(bin);
  // With `turnMarks`, a turn records its pid there and sits still until it
  // is killed (a CLI mid-turn); without, every turn answers nothing at once.
  writeFileSync(
    join(bin, 'claude'),
    '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "2.1.0 (Claude Code)"; exit 0; fi\n' +
      (turnMarks
        ? 'if [ "$1" = "-p" ] && [ "$2" = "x" ]; then exit 0; fi\n' + `echo "$@" > "${turnMarks}/$$"\nexec sleep 30\n`
        : 'exit 0\n')
  );
  chmodSync(join(bin, 'claude'), 0o755);
  const root = mkdtempSync(join(tmpdir(), `fv-drain-${tag}-`));
  const origin = join(root, 'origin.git');
  const seed = join(root, 'seed');
  const mark = join(root, 'finished.txt');
  const sh = (args, cwd) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  sh(['init', '-q', '--bare', '-b', 'main', origin], root);
  sh(['clone', '-q', origin, seed], root);
  for (const [k, v] of [['user.email', 't@t'], ['user.name', 't'], ['commit.gpgsign', 'false']]) sh(['config', k, v], seed);
  mkdirSync(join(seed, '.flowviant'));
  writeFileSync(
    join(seed, '.flowviant', 'deploy.json'),
    JSON.stringify({ targets: [{ id: 'web', command: `sleep ${seconds} && echo ran > ${JSON.stringify(mark)}` }] })
  );
  sh(['add', '-A'], seed);
  sh(['commit', '-q', '-m', 'base'], seed);
  sh(['push', '-q', 'origin', 'main'], seed);
  const repo = join(root, 'repo');
  sh(['clone', '-q', origin, repo], root);
  return { home, bin, repo, mark };
}

const API_REFUSAL = JSON.stringify({ success: false, error: { code: 'UNAUTHORIZED', message: 'Token revoked' } });

/** The API stand-in. `answer(path, body, t)` may return `{ status, body }`
 *  to override the ordinary 200; every request is logged with its time. */
async function drainServer(t, answer) {
  const log = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      const path = req.url.split('?')[0];
      let body = null;
      try {
        body = JSON.parse(raw);
      } catch {
        /* a GET */
      }
      const entry = { path, body, at: Date.now() };
      log.push(entry);
      const over = answer(path, body, entry);
      res.writeHead(over?.status ?? 200, { 'Content-Type': 'application/json' });
      res.end(over?.body ?? JSON.stringify({ success: true, data: over?.data ?? {} }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  return { log, url: `http://127.0.0.1:${server.address().port}/api/fleet/agents` };
}

function startDaemon(t, sc, url) {
  const cli = fileURLToPath(new URL('../cli.mjs', import.meta.url));
  const child = spawn(process.execPath, [cli], {
    cwd: sc.repo,
    env: {
      HOME: sc.home,
      PATH: [sc.bin, dirname(process.execPath), '/usr/bin', '/bin'].join(':'),
      FLOWVIANT_FLEET: 'fva_drain_test',
      FLOWVIANT_FLEET_URL: url,
      RECONCILE_SECONDS: '1',
      FLOWVIANT_NO_UPDATE: '1',
      FLOWVIANT_NO_PRESSURE_GUARD: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const d = { child, out: '' };
  child.stdout.on('data', (x) => (d.out += x));
  child.stderr.on('data', (x) => (d.out += x));
  d.exited = new Promise((r) => child.on('exit', (code) => r(code)));
  t.after(() => {
    if (child.exitCode === null) child.kill('SIGKILL');
  });
  return d;
}

const waitFor = async (cond, ms = 30_000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 25));
  }
};

const JOB = { id: 'job-drain-1', kind: 'deploy', targetId: 'web', env: 'prod' };
const MORE_WORK = { id: 'job-drain-2', kind: 'deploy', targetId: 'web', env: 'dev' };

test('SIGTERM mid-deploy: the loop takes nothing more, the deploy reports, then the daemon exits 143', async (t) => {
  const sc = drainScene('sigterm', 3);
  let sigAt = Infinity;
  const { log, url } = await drainServer(t, (path, _body, entry) => {
    if (path === '/api/fleet/deploy-claim') return { data: { claimed: true } };
    if (path !== '/api/fleet/agents') return null;
    const data = { agents: [], project: { id: 'proj-drain', name: 'Drain' }, deployAllowed: true };
    // Before the signal: the one deploy. After it: more of everything.
    if (entry.at < sigAt) data.deployJobs = [JOB];
    else Object.assign(data, { deployJobs: [JOB, MORE_WORK], codeMapJob: { requestedAt: 'r1' } });
    return { data };
  });
  const d = startDaemon(t, sc, url);
  await waitFor(() => log.some((r) => r.path === '/api/fleet/deploy-claim'));
  await new Promise((r) => setTimeout(r, 200)); // the claim's answer is in; the command is running
  sigAt = Date.now();
  d.child.kill('SIGTERM');

  // Hold the drain open past three reconcile periods before the command ends.
  await new Promise((r) => setTimeout(r, 2000));
  assert.equal(d.child.exitCode, null, `still draining\n${d.out.slice(-1500)}`);
  const code = await Promise.race([d.exited, new Promise((r) => setTimeout(() => r('timeout'), 30_000))]);
  assert.equal(code, 143, `exits with the signal's code once the deploy has reported\n${d.out.slice(-2000)}`);

  const after = log.filter((r) => r.at >= sigAt);
  // A poll already on the wire when the signal landed may arrive; nothing is
  // taken from it, and no further poll follows.
  assert.ok(after.filter((r) => r.path === '/api/fleet/agents').length <= 1, `no poll after the stand-down: ${JSON.stringify(after.map((r) => r.path))}`);
  assert.ok(!after.some((r) => r.path === '/api/fleet/deploy-claim'), 'no new deploy claimed');
  assert.ok(!after.some((r) => r.path === '/api/fleet/wiki-progress'), 'no wiki sweep started');
  // And after that straggler only the deploy lane speaks: nothing from its
  // roster was taken.
  const straggler = after.findIndex((r) => r.path === '/api/fleet/agents');
  const tail = straggler === -1 ? after : after.slice(straggler + 1);
  assert.deepEqual(
    [...new Set(tail.map((r) => r.path))].filter((p) => !/^\/api\/fleet\/deploy-(heartbeat|report)$/.test(p)),
    [],
    `only the deploy lane after the straggler: ${JSON.stringify(tail.map((r) => r.path))}`
  );
  const reports = log.filter((r) => r.path === '/api/fleet/deploy-report');
  assert.equal(reports.length, 1);
  assert.equal(reports[0].body.jobId, JOB.id);
  assert.equal(reports[0].body.ok, true, 'the command ran to its end and its outcome was posted');
  assert.equal(readFileSync(sc.mark, 'utf8').trim(), 'ran');
  assert.equal(d.out.split('shutting down (SIGTERM)').length - 1, 1, 'the teardown ran once');
  assert.doesNotMatch(d.out, /Ctrl\+C/, 'no Ctrl+C hint on a SIGTERM');
});

test('a credential revoked mid-deploy: the deploy finishes, its refused report is said, the daemon exits 0 once', async (t) => {
  const sc = drainScene('revoked', 2);
  let claimed = false;
  const { log, url } = await drainServer(t, (path) => {
    if (path === '/api/fleet/deploy-claim') {
      claimed = true;
      return { data: { claimed: true } };
    }
    // A Disconnect rotated the credential: the API's own refusal, everywhere.
    if (path === '/api/fleet/deploy-report') return { status: 401, body: API_REFUSAL };
    if (path !== '/api/fleet/agents') return null;
    if (claimed) return { status: 401, body: API_REFUSAL };
    return { data: { agents: [], project: { id: 'proj-drain', name: 'Drain' }, deployAllowed: true, deployJobs: [JOB] } };
  });
  const d = startDaemon(t, sc, url);
  const code = await Promise.race([d.exited, new Promise((r) => setTimeout(() => r('timeout'), 45_000))]);
  assert.equal(code, 0, `a revoked credential exits 0\n${d.out.slice(-2000)}`);
  assert.equal(readFileSync(sc.mark, 'utf8').trim(), 'ran', 'the deploy ran to its end');
  assert.equal(log.filter((r) => r.path === '/api/fleet/deploy-report').length, 1, 'the refused report is not retried');
  assert.match(d.out, /could not be reported — the app refused this machine's credential \(HTTP 401\)/);
  assert.equal(d.out.split('credential revoked or invalid. Shutting down.').length - 1, 1, 'shut down once');
  assert.equal(d.out.split('the deploy is done — stopping.').length - 1, 1, 'and left once');
  const refusedPolls = log.filter((r) => r.path === '/api/fleet/agents').length - 1;
  assert.equal(refusedPolls, 1, 'no poll after the refusal');
});

// ── A STAND-DOWN KILLS THE TURNS AND DRAINS ONLY THE DEPLOY (second review,
// ruling 2026-09-26). Before the drain, `process.exit` followed the teardown
// on the same tick, so a turn the teardown killed never settled and nothing
// retried it. The drain keeps the process up for the deploy, and the killed
// turn's lane must stay exactly where the exit used to leave it: no settle,
// no sync, no fresh spawn (standDownGate.mjs). The turn here is the wiki's —
// the CLI turn a loop hands out with no session to fake — whose continuation
// would otherwise say the sweep ended without WIKI_DONE, sync the vault and
// offer a retry.

test('SIGTERM with a CLI turn AND a deploy in flight: the turn is killed and answers nothing, only the deploy runs on', async (t) => {
  const marks = mkdtempSync(join(tmpdir(), 'fv-drain-turn-marks-'));
  const sc = drainScene('turn', 3, { turnMarks: marks });
  const turnPids = () => readdirSync(marks).map(Number);
  t.after(() => {
    for (const pid of turnPids()) if (alive(pid)) process.kill(pid, 'SIGKILL');
  });
  let sigAt = Infinity;
  const { log, url } = await drainServer(t, (path, _body, entry) => {
    if (path === '/api/fleet/deploy-claim') return { data: { claimed: true } };
    if (path !== '/api/fleet/agents') return null;
    const data = { agents: [], project: { id: 'proj-drain', name: 'Drain' }, deployAllowed: true };
    if (entry.at < sigAt) Object.assign(data, { deployJobs: [JOB], codeMapJob: { requestedAt: 'r1' } });
    else Object.assign(data, { deployJobs: [JOB, MORE_WORK], codeMapJob: { requestedAt: 'r2' } });
    return { data };
  });
  const d = startDaemon(t, sc, url);
  await waitFor(() => log.some((r) => r.path === '/api/fleet/deploy-claim') && turnPids().some(alive));
  await new Promise((r) => setTimeout(r, 200)); // the claim's answer is in; the command and the turn are running
  sigAt = Date.now();
  d.child.kill('SIGTERM');

  await waitFor(() => turnPids().every((pid) => !alive(pid)), 10_000);
  // Hold the drain open well past the killed turn's continuation and the
  // wiki's retry offer, then let the deploy end.
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(d.child.exitCode, null, `still draining\n${d.out.slice(-1500)}`);
  const code = await Promise.race([d.exited, new Promise((r) => setTimeout(() => r('timeout'), 30_000))]);
  assert.equal(code, 143, `exits once the deploy has reported\n${d.out.slice(-2000)}`);

  assert.equal(turnPids().length, 1, 'no CLI spawned after the signal: no fresh retry of the killed turn');
  assert.doesNotMatch(d.out, /ended without WIKI_DONE|wiki sweep failed/, 'the killed turn handed its lane nothing');
  const after = log.filter((r) => r.at >= sigAt);
  assert.ok(!after.some((r) => /wiki-(vault|progress|abandoned)|reground/.test(r.path)), `no wiki post after the signal: ${JSON.stringify(after.map((r) => r.path))}`);
  // After at most one straggler poll already on the wire, only the deploy lane
  // speaks: nothing from that roster was taken.
  const straggler = after.findIndex((r) => r.path === '/api/fleet/agents');
  const tail = straggler === -1 ? after : after.slice(straggler + 1);
  assert.deepEqual(
    [...new Set(tail.map((r) => r.path))].filter((p) => !/^\/api\/fleet\/deploy-(heartbeat|report)$/.test(p)),
    [],
    `only the deploy lane after the straggler: ${JSON.stringify(tail.map((r) => r.path))}`
  );
  const reports = log.filter((r) => r.path === '/api/fleet/deploy-report');
  assert.equal(reports.length, 1);
  assert.equal(reports[0].body.ok, true, 'the deploy ran to its end and reported');
  assert.equal(readFileSync(sc.mark, 'utf8').trim(), 'ran');
});
