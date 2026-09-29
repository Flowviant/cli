import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { desktopStatus } from './desktopContract.mjs';
import { readClaudeAuthStatus } from './runtimeAuth.mjs';

function fixture(output, { sleep = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'fv-claude-status-'));
  const bin = join(root, 'claude');
  const calls = join(root, 'calls');
  const script = sleep ? '#!/bin/sh\nsleep 1\n' : `#!/bin/sh\nif [ "$1" = '--version' ]; then echo '2.1.0 (Claude Code)'; exit 0; fi\nprintf x >> '${calls}'\ncat <<'JSON'\n${output}\nJSON\n`;
  writeFileSync(bin, script, { mode: 0o700 });
  return { root, bin, calls, cache: join(root, 'auth-cache.json') };
}

test('status relays Claude subscription, signed out, Console billing and unknown', () => {
  const cases = [
    [{ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max' }, { signedIn: true, billing: 'subscription', subscriptionType: 'max' }],
    [{ loggedIn: false, authMethod: 'none' }, { signedIn: false, billing: null, subscriptionType: null }],
    [{ loggedIn: true, authMethod: 'console', subscriptionType: 'max' }, { signedIn: true, billing: 'api', subscriptionType: null }],
  ];
  for (const [answer, expected] of cases) {
    const fake = fixture(JSON.stringify(answer));
    assert.deepEqual(readClaudeAuthStatus({ bin: fake.bin, cachePath: fake.cache }), expected);
  }
  const garbage = fixture('not JSON');
  assert.deepEqual(readClaudeAuthStatus({ bin: garbage.bin, cachePath: garbage.cache }), { signedIn: null, billing: null, subscriptionType: null });
  const timed = fixture('', { sleep: true });
  assert.deepEqual(readClaudeAuthStatus({ bin: timed.bin, cachePath: timed.cache, timeoutMs: 20 }), { signedIn: null, billing: null, subscriptionType: null });
});

test('the probe cache crosses status processes and a refresh re-measures after login', () => {
  const fake = fixture(JSON.stringify({ loggedIn: false, authMethod: 'none' }));
  assert.equal(readClaudeAuthStatus({ bin: fake.bin, cachePath: fake.cache }).signedIn, false);
  assert.equal(readClaudeAuthStatus({ bin: fake.bin, cachePath: fake.cache }).signedIn, false);
  assert.equal(readFileSync(fake.calls, 'utf8'), 'x');
  assert.equal(readClaudeAuthStatus({ bin: fake.bin, cachePath: fake.cache, refresh: true }).signedIn, false);
  assert.equal(readFileSync(fake.calls, 'utf8'), 'xx');
});

test('both per-project and machine runtime rows carry the auth fact', () => {
  const fake = fixture(JSON.stringify({ loggedIn: false, authMethod: 'none' }));
  const status = desktopStatus({
    entries: [{ projectId: 'p1', fleetToken: 'secret' }],
    runtimes: [{ id: 'claude', installed: true, version: '2.1.0', dispatchable: true }],
    authFor: () => readClaudeAuthStatus({ bin: fake.bin, cachePath: fake.cache }),
    runningFor: () => false,
    stateFor: () => ({}),
  });
  assert.equal(status.runtimes[0].signedIn, false);
  assert.equal(status.projects[0].runtimes[0].signedIn, false);
});

test('flowviant status --json uses the fake Claude binary, including signed-out JSON', (t) => {
  const fake = fixture(JSON.stringify({ loggedIn: false, authMethod: 'none' }));
  const cli = new URL('../cli.mjs', import.meta.url).pathname;
  const result = spawnSync(process.execPath, [cli, 'status', '--json', '--refresh-auth'], {
    env: { ...process.env, HOME: fake.root, CLAUDE_CONFIG_DIR: fake.root, PATH: `${fake.root}:/usr/bin:/bin` },
    encoding: 'utf8', timeout: 10_000,
  });
  if (result.error?.code === 'EPERM') return t.skip('this sandbox blocks a Node child process');
  assert.equal(result.status, 0, result.stderr);
  const status = JSON.parse(result.stdout);
  assert.equal(status.runtimes.find((runtime) => runtime.id === 'claude').signedIn, false);
  assert.equal(readFileSync(fake.calls, 'utf8'), 'x');
});
