import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitNet, gitNetAsync, gitNetEnv, NET_SSH_COMMAND } from './git.mjs';

/**
 * A NETWORK GIT CALL MUST NOT BE ABLE TO HANG THE DAEMON.
 *
 * The daemon runs `git fetch` every three minutes, unattended, and pushes and
 * fetches on the ship and merge paths. They used `git()` — `execFileSync` with
 * no timeout and an environment that let git open /dev/tty for a username —
 * so a remote that prompted or a connection gone half-open blocked the event
 * loop until somebody typed at the terminal. The remote here is an `ext::`
 * transport that simply never answers, which is the half-open case exactly.
 */
function repo(t) {
  const dir = mkdtempSync(join(tmpdir(), 'fv-gitnet-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const g = (args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  g(['init', '-q', '-b', 'main']);
  g(['config', 'user.email', 't@t.t']);
  g(['config', 'user.name', 'T']);
  writeFileSync(join(dir, 'a.txt'), 'one');
  g(['add', '-A']);
  g(['commit', '-qm', 'base']);
  // ext's own escaping: `% ` is a literal space inside one argument.
  g(['remote', 'add', 'origin', 'ext::sh -c sleep% 30']);
  return dir;
}

const HANG = ['-c', 'protocol.ext.allow=always', 'fetch', 'origin', '--quiet'];

test('a fetch against a remote that never answers throws at the timeout, not when the remote gives up', (t) => {
  const dir = repo(t);
  const t0 = Date.now();
  assert.throws(() => gitNet(HANG, dir, 800), (e) => e.code === 'ETIMEDOUT');
  const took = Date.now() - t0;
  assert.ok(took >= 700 && took < 10_000, `the call must return at its bound (${took}ms)`);
});

test('the async fetch rejects at the timeout and never blocks the event loop meanwhile', async (t) => {
  const dir = repo(t);
  let ticks = 0;
  const iv = setInterval(() => ticks++, 20);
  t.after(() => clearInterval(iv));
  const t0 = Date.now();
  await assert.rejects(gitNetAsync(HANG, dir, 800), (e) => e.code === 'ETIMEDOUT');
  clearInterval(iv);
  assert.ok(Date.now() - t0 < 10_000);
  assert.ok(ticks >= 10, 'timers must keep firing while the fetch is out');
});

test('the async call resolves stdout on success and rejects a non-zero exit with its stderr', async (t) => {
  const dir = repo(t);
  const out = await gitNetAsync(['rev-parse', 'HEAD'], dir);
  assert.match(out.trim(), /^[0-9a-f]{40}$/);
  await assert.rejects(gitNetAsync(['rev-parse', 'no-such-ref-x'], dir), (e) => e.status !== 0 && typeof e.stderr === 'string');
});

test('a network call never prompts: terminal prompts off, and batch-mode ssh unless the operator chose one', (t) => {
  const dir = repo(t);
  const env = gitNetEnv(dir, { PATH: process.env.PATH });
  assert.equal(env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(env.GCM_INTERACTIVE, 'never');
  assert.equal(env.GIT_SSH_COMMAND, NET_SSH_COMMAND);
  assert.match(NET_SSH_COMMAND, /BatchMode=yes/);
});

test("an operator's own ssh command is never overridden — env or core.sshCommand", (t) => {
  const dir = repo(t);
  const mine = 'ssh -i ~/.ssh/deploy_key';
  assert.equal(gitNetEnv(dir, { PATH: process.env.PATH, GIT_SSH_COMMAND: mine }).GIT_SSH_COMMAND, mine);
  assert.equal(gitNetEnv(dir, { PATH: process.env.PATH, GIT_SSH: '/usr/bin/myssh' }).GIT_SSH_COMMAND, undefined);
  execFileSync('git', ['config', 'core.sshCommand', mine], { cwd: dir });
  const env = gitNetEnv(dir, { PATH: process.env.PATH });
  assert.equal(env.GIT_SSH_COMMAND, undefined, 'the config key must be left to win');
  assert.equal(env.GIT_TERMINAL_PROMPT, '0');
});
