/**
 * THE CREDENTIAL MUST NOT BE IN A SPAWNED COMMAND'S ENVIRONMENT.
 *
 * This file exists because the previous guarantee was a comment over a no-op:
 * `delete env.FLEET_TOKEN` removed a name that was never in the environment
 * (the variable is `FLOWVIANT_FLEET`), so the machine credential rode into
 * every deploy command and into `target.build`, a string the repo controls,
 * for as long as that line was there. Nothing failed. Nothing could fail —
 * there was no test, and a denylist has nothing to assert against.
 *
 * An allowlist can be tested, which is most of the argument for it.
 *
 * Run: node --test bin/lib/childEnv.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { childEnv, DROPPED_SAMPLE } from './childEnv.mjs';

test('the machine credential is absent — the exact bug this replaces', () => {
  process.env.FLOWVIANT_FLEET = 'fleet-secret-value';
  const env = childEnv({ cwd: '/w' });
  assert.equal(env.FLOWVIANT_FLEET, undefined);
  // And not under any other spelling: assert on the VALUE, because the failure
  // mode was a name mismatch and a name-only check is what missed it.
  assert.ok(
    !Object.values(env).includes('fleet-secret-value'),
    'the credential VALUE appears in the child environment under some key'
  );
  delete process.env.FLOWVIANT_FLEET;
});

test('a secret nobody thought of is absent too, because the list is a KEEP list', () => {
  // The whole point of an allowlist: this passes without anyone adding the name
  // anywhere. A denylist would need this exact string to have been foreseen.
  process.env.SOME_FUTURE_VENDOR_TOKEN = 'x';
  const env = childEnv({});
  assert.equal(env.SOME_FUTURE_VENDOR_TOKEN, undefined);
  delete process.env.SOME_FUTURE_VENDOR_TOKEN;
});

test('every name in the documented sample is dropped', () => {
  for (const k of DROPPED_SAMPLE) process.env[k] = 'sensitive';
  const env = childEnv({});
  for (const k of DROPPED_SAMPLE) assert.equal(env[k], undefined, `${k} survived`);
  for (const k of DROPPED_SAMPLE) delete process.env[k];
});

test('PATH and the toolchain shims survive — without them the command is ENOENT', () => {
  process.env.NVM_DIR = '/home/x/.nvm';
  process.env.VOLTA_HOME = '/home/x/.volta';
  const env = childEnv({});
  assert.ok(env.PATH, 'PATH must survive or nothing runs at all');
  assert.equal(env.NVM_DIR, '/home/x/.nvm');
  assert.equal(env.VOLTA_HOME, '/home/x/.volta');
  delete process.env.NVM_DIR;
  delete process.env.VOLTA_HOME;
});

test('TERM and BROWSER are SET by us, not inherited', () => {
  process.env.TERM = 'xterm-256color';
  const env = childEnv({});
  // A process that believes it owns a TTY draws progress bars into a pipe
  // forever — unreadable in a tail, and it pins a CPU on some tools.
  assert.equal(env.TERM, 'dumb');
  assert.equal(env.BROWSER, 'none');
  delete process.env.TERM;
});

test('NODE_ENV and PORT are never asserted', () => {
  process.env.NODE_ENV = 'production';
  process.env.PORT = '9999';
  const env = childEnv({ cwd: '/w' });
  // Asserting NODE_ENV would be Flowviant choosing what the framework decides.
  assert.equal(env.NODE_ENV, undefined);
  // And a HINTED port has no cwd attribution behind it, which is the one real
  // security control this feature family has.
  assert.equal(env.PORT, undefined);
  delete process.env.NODE_ENV;
  delete process.env.PORT;
});

test('cwd becomes PWD, and extra is layered last', () => {
  const env = childEnv({ cwd: '/w/session/abc', extra: { CLOUDFLARE_API_TOKEN: 'given' } });
  assert.equal(env.PWD, '/w/session/abc');
  // `extra` is the CALLER's own material — deploy credentials it fetched and
  // decrypted. It is never repo-supplied: the deleted preview feature let a
  // branch file contribute an env map layered last, which is how a branch got
  // to set PATH.
  assert.equal(env.CLOUDFLARE_API_TOKEN, 'given');
});

test('the deploy path actually calls it — a helper nobody uses fixes nothing', async () => {
  const { readFileSync } = await import('node:fs');
  const raw = readFileSync(new URL('./deploy.mjs', import.meta.url), 'utf8');
  // CODE ONLY. The obituary in deploy.mjs QUOTES the shape it replaced — that
  // is the most useful line in the file and it is also an exact match for what
  // this bans. Asserting over raw source fails on its own documentation, which
  // is a false alarm that trains people to weaken the test.
  const src = raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .join('\n');
  const i = src.indexOf('async function runDeploy');
  assert.ok(i > -1);
  const fn = src.slice(i, src.indexOf('\nasync function', i + 10));
  assert.ok(fn.includes('childEnv('), 'runDeploy must build its env through childEnv');
  // The old shape must not come back.
  assert.ok(!/\{\s*\.\.\.process\.env\s*,\s*\.\.\.deployCreds\(\)/.test(src));
});
