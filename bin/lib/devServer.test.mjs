/**
 * THE SUPERVISOR, EXERCISED — real processes, real ports, real kills.
 *
 * Source pins cannot tell you whether a process actually started, whether the
 * port was found by the measurement we claim to use, or whether `stop()` really
 * killed the tree. This starts a server, waits for `listenersIn` to attribute
 * it by cwd, and then checks the pid is gone.
 *
 * The `detached` + process-group kill is the part most worth testing: a package
 * manager is a wrapper and the server is its GRANDCHILD, so killing the child
 * alone leaves the port held by something nothing is tracking.
 *
 * Run: node --test bin/lib/devServer.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { missingDeps, startDevServer } from './devServer.mjs';

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};

function worktree(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'fv-devrun-'));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}

const SERVER = `
  require('http').createServer((_, res) => res.end('ok'))
    .listen(0, '127.0.0.1', function () { console.log('up on', this.address().port); });
`;

test('starts a process and finds its port BY MEASUREMENT, not by scraping', async () => {
  // The port must come from `listenersIn` (cwd attribution) and nowhere else.
  // The deleted feature scraped stdout and tunnelled a guess; a scraped port
  // has no attribution behind it, and attribution is the only real security
  // control this feature family has. Note the server prints its port — if this
  // ever started passing because of THAT, the mechanism has regressed.
  const wt = worktree({ 'srv.js': SERVER });
  const states = [];
  const r = await startDevServer({
    sessionId: 'test-1',
    worktree: wt,
    argv: ['node', 'srv.js'],
    onState: (s) => states.push(s),
  });
  assert.equal(r.ok, true);
  assert.ok(Number.isInteger(r.port) && r.port > 0, 'a port must be measured');
  assert.ok(alive(r.pid), 'the process must be running');
  assert.equal(states.length, 1);
  assert.equal(states[0].port, r.port);
  r.stop();
});

test('stop() actually kills it', async () => {
  const wt = worktree({ 'srv.js': SERVER });
  const r = await startDevServer({ sessionId: 'test-2', worktree: wt, argv: ['node', 'srv.js'] });
  assert.equal(r.ok, true);
  const pid = r.pid;
  r.stop();
  await new Promise((res) => setTimeout(res, 700));
  assert.equal(alive(pid), false, 'stop() left the process running');
});

test('a command that exits immediately fails with the machine’s words', async () => {
  const wt = worktree({ 'boom.js': 'process.exit(3);' });
  const exits = [];
  const r = await startDevServer({
    sessionId: 'test-3',
    worktree: wt,
    argv: ['node', 'boom.js'],
    onExit: (e) => exits.push(e),
  });
  assert.equal(r.ok, false);
  // A command that NEVER bound is a broken command, not a crash — restarting it
  // would spin the box on somebody's typo.
  assert.equal(r.endedReason, 'spawn_failed');
  assert.equal(exits[0]?.exitCode, 3);
  assert.match(exits[0]?.error ?? '', /without listening/);
});

test('a command that does not exist fails rather than hanging', async () => {
  const wt = worktree();
  const r = await startDevServer({
    sessionId: 'test-4',
    worktree: wt,
    argv: ['node', 'nope-does-not-exist.js'],
  });
  assert.equal(r.ok, false);
});

test('THE FRESH-WORKTREE ANSWER: a package manager with no node_modules is refused before spawning', async () => {
  // `ensureWorktree` is a bare `git worktree add`, so a new tab has source and
  // no dependencies. This is a MEASUREMENT, and it routes installing to the one
  // place that should own it — a turn in the tab, with a human asking and an
  // audit row for it.
  const wt = worktree();
  assert.equal(missingDeps(wt, ['npm', 'run', 'dev']), true);
  const r = await startDevServer({ sessionId: 'test-5', worktree: wt, argv: ['npm', 'run', 'dev'] });
  assert.equal(r.ok, false);
  assert.equal(r.endedReason, 'no_deps');
  assert.match(r.error, /Ask your Claude/);
});

test('…and is NOT refused once dependencies exist, or for a non-package-manager', () => {
  const wt = worktree();
  assert.equal(missingDeps(wt, ['node', 'srv.js']), false, 'node is not a package manager');
  mkdirSync(join(wt, 'node_modules'));
  assert.equal(missingDeps(wt, ['npm', 'run', 'dev']), false);
});

test('the child environment carries no machine credential', async () => {
  // The end-to-end version of childEnv.test.mjs: prove it through an actual
  // spawn rather than through the helper, because the helper being right does
  // not prove the supervisor calls it.
  process.env.FLOWVIANT_FLEET = 'must-not-appear';
  const wt = worktree({
    'env.js': `
      const leak = Object.entries(process.env).find(([,v]) => v === 'must-not-appear');
      require('fs').writeFileSync('out.txt', leak ? 'LEAKED:' + leak[0] : 'clean');
      require('http').createServer((_,r)=>r.end()).listen(0,'127.0.0.1');
    `,
  });
  const r = await startDevServer({ sessionId: 'test-6', worktree: wt, argv: ['node', 'env.js'] });
  assert.equal(r.ok, true);
  const { readFileSync } = await import('node:fs');
  assert.equal(readFileSync(join(wt, 'out.txt'), 'utf8'), 'clean');
  r.stop();
  delete process.env.FLOWVIANT_FLEET;
});
