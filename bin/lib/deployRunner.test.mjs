/**
 * `run` — how the deploy lane executes one command. The job lease
 * (deploy.mjs) heartbeats for as long as this promise is pending and the
 * machine will not self-update while a deploy is in flight, so a command that
 * never settles holds the job, the claim and the machine for ever.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { run } from './deployRunner.mjs';

const cwd = mkdtempSync(join(tmpdir(), 'fv-deploy-run-'));
const env = { PATH: process.env.PATH };
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test('a finished command resolves with its exit status and output', async () => {
  const good = await run('echo built && echo warned >&2', { cwd, env });
  assert.equal(good.ok, true);
  assert.equal(good.code, 0);
  assert.match(good.out, /built/);
  assert.match(good.out, /warned/);
  const bad = await run('exit 3', { cwd, env });
  assert.deepEqual([bad.ok, bad.code], [false, 3]);
});

test('a timed-out command and its descendants cannot hold a deploy job open', async () => {
  // The shell backgrounds a child that inherits stdout and outlives it. Killing
  // only the shell leaves that child holding the pipe, so 'close' never fires
  // and the promise — and with it the lease — waits on the grandchild.
  const started = Date.now();
  let guard;
  const res = await Promise.race([
    run('sleep 30 & echo "pid:$!"; wait', { cwd, env, timeoutMs: 300 }),
    new Promise((r) => {
      guard = setTimeout(() => r('held open'), 5000);
    }),
  ]);
  clearTimeout(guard);
  assert.notEqual(res, 'held open', 'the timeout must settle the command');
  assert.ok(Date.now() - started < 5000);
  assert.equal(res.ok, false);
  assert.match(res.out, /stopped/);
  const pid = Number(res.out.match(/pid:(\d+)/)?.[1]);
  assert.ok(pid > 0, 'the grandchild reported its pid');
  for (let i = 0; i < 40 && alive(pid); i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(alive(pid), false, 'and the grandchild went with it');
});

test("the daemon's exit leaves a running command alone — a stand-down never stops a deploy (ruling 2026-09-26), and run() adds no exit hook", async () => {
  // Owner ruling 2026-09-26: a stand-down lets an in-flight deploy finish and
  // report. The report half is standDownExit.test.mjs's (the process waits);
  // this pins the other half at the runner: nothing here kills the command
  // when the process that called run() exits — only the timeout does — so
  // even a daemon that leaves early (a second Ctrl+C) leaves the command
  // running. A private exit listener here would break the ruling.
  const runner = pathToFileURL(join(import.meta.dirname, 'deployRunner.mjs')).href;
  const pidFile = join(cwd, 'grandchild.pid');
  const script = `
    const { run } = await import(${JSON.stringify(runner)});
    void run('sleep 30 & echo $! > grandchild.pid; wait', { cwd: ${JSON.stringify(cwd)}, env: { PATH: process.env.PATH } });
    const { existsSync } = await import('node:fs');
    const t = setInterval(() => { if (existsSync(${JSON.stringify(pidFile)})) { clearInterval(t); process.exit(0); } }, 20);
  `;
  const daemon = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  daemon.stderr.on('data', (d) => (err += d));
  const code = await new Promise((r) => daemon.on('close', r));
  assert.equal(code, 0, err);
  let pid = 0;
  for (let i = 0; i < 40 && !(pid > 0); i++) {
    pid = Number(readFileSync(pidFile, 'utf8').trim());
    if (!(pid > 0)) await new Promise((r) => setTimeout(r, 25));
  }
  assert.ok(pid > 0, 'the grandchild wrote its pid');
  await new Promise((r) => setTimeout(r, 200));
  const survived = alive(pid);
  if (survived) process.kill(pid, 'SIGKILL'); // clean up what the test started
  assert.equal(survived, true, "the command outlived the daemon's exit");
});
