/**
 * THE CREDENTIAL CONTEXT — what it may say, and the two things it must never.
 *
 * This report exists because a turn failed with "OAuth session expired and
 * could not be refreshed" while `claude` in a shell on the SAME machine worked,
 * and nothing in the product could explain how. The facts that reconcile it are
 * measurable for free; the risk is that measuring them leaks a token or invents
 * a state, so both are pinned here.
 *
 * Run: node --test bin/lib/claudeAuth.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AUTH_ENV_VARS, claudeAuthContext } from './claudeAuth.mjs';

/** A HOME with a Claude credential store in it. `oauth: null` writes a file
 *  that is valid JSON but carries no session — the shape a partially-written
 *  or foreign file has. */
function homeWith(oauth) {
  const home = mkdtempSync(join(tmpdir(), 'fv-auth-'));
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(
    join(home, '.claude', '.credentials.json'),
    JSON.stringify(oauth === null ? { somethingElse: true } : { claudeAiOauth: oauth })
  );
  return home;
}

const DAY = 86_400_000;
const stamp = (msFromNow) => Date.now() + msFromNow;

test('a login with no auth variables reports the file and its 22-day clock', () => {
  const home = homeWith({
    accessToken: 'sk-ant-oat-SECRET',
    refreshToken: 'sk-ant-ort-SECRET',
    expiresAt: stamp(6 * 3600_000),
    refreshTokenExpiresAt: stamp(21 * DAY),
    subscriptionType: 'max',
  });
  const ctx = claudeAuthContext({ env: { HOME: home, USER: 'w' }, home });
  assert.equal(ctx.source, 'file');
  assert.deepEqual(ctx.envVars, []);
  assert.equal(ctx.envOverridesLogin, false);
  assert.equal(ctx.subscriptionType, 'max');
  assert.ok(ctx.refreshExpiresAt, 'the refresh clock is the one a warning is built from');
  assert.ok(new Date(ctx.refreshExpiresAt).getTime() > Date.now());
});

/**
 * THE SYMPTOM THIS WHOLE MODULE WAS WRITTEN FOR. A variable in the daemon's
 * environment sits alongside a perfectly good login, and the operator cannot
 * see it from a shell that never had it — `process.env` is snapshotted at
 * daemon start, so it outlives the export by weeks.
 */
test('a variable BESIDE a login is the confusing state, and is flagged as such', () => {
  const home = homeWith({ refreshTokenExpiresAt: stamp(20 * DAY) });
  const ctx = claudeAuthContext({
    env: { HOME: home, USER: 'w', ANTHROPIC_API_KEY: 'sk-ant-api03-SECRET' },
    home,
  });
  assert.equal(ctx.source, 'env');
  assert.deepEqual(ctx.envVars, ['ANTHROPIC_API_KEY']);
  assert.equal(ctx.envOverridesLogin, true, 'both exist — this is the divergence');
});

test('a variable with NO login is not flagged — there is nothing to be confused with', () => {
  const home = mkdtempSync(join(tmpdir(), 'fv-auth-'));
  const ctx = claudeAuthContext({
    env: { HOME: home, ANTHROPIC_AUTH_TOKEN: 'SECRET' },
    home,
  });
  assert.equal(ctx.source, 'env');
  assert.equal(ctx.envOverridesLogin, false, 'unambiguous: only one credential exists');
});

/**
 * THE THREE-STATE RULE. macOS keeps this in the Keychain, so a machine that is
 * working perfectly has no file at all. Calling that "signed out" would be the
 * product inventing a state about a machine it cannot see into — worse than
 * silence, because it is confidently wrong.
 */
test('no file and no variable is UNKNOWN, never "signed out"', () => {
  const home = mkdtempSync(join(tmpdir(), 'fv-auth-'));
  const ctx = claudeAuthContext({ env: { HOME: home }, home });
  assert.equal(ctx.source, 'unknown');
  assert.equal(ctx.refreshExpiresAt, null);
  assert.equal(ctx.envOverridesLogin, false);
});

test('a credentials file with no oauth block is unknown, not a login', () => {
  const home = homeWith(null);
  const ctx = claudeAuthContext({ env: { HOME: home }, home });
  assert.equal(ctx.source, 'unknown');
  assert.equal(ctx.refreshExpiresAt, null);
});

test('an unreadable HOME never throws — a readout must not break the poll', () => {
  const ctx = claudeAuthContext({ env: { HOME: '/nope/does/not/exist' }, home: '/nope/does/not/exist' });
  assert.equal(ctx.source, 'unknown');
});

test('no HOME at all is survivable', () => {
  const ctx = claudeAuthContext({ env: {}, home: null });
  assert.equal(ctx.home, null);
  assert.equal(ctx.source, 'unknown');
});

/**
 * AN EXPORTED-BUT-BLANK VARIABLE IS NOT SET. `export ANTHROPIC_API_KEY=` is how
 * people try to unset one; reporting it present sends somebody hunting a
 * variable that is doing nothing.
 */
test('a blank variable does not count as present', () => {
  const home = homeWith({ refreshTokenExpiresAt: stamp(5 * DAY) });
  const ctx = claudeAuthContext({ env: { HOME: home, ANTHROPIC_API_KEY: '   ' }, home });
  assert.equal(ctx.source, 'file');
  assert.equal(ctx.envOverridesLogin, false);
});

/** Seconds and milliseconds both appear in the wild; an unparsable stamp is
 *  ABSENT rather than 1970 — a date in the past would render as "expired" on a
 *  machine that is fine. */
test('stamps parse in either unit, and garbage is absent rather than 1970', () => {
  const secs = homeWith({ refreshTokenExpiresAt: Math.floor(stamp(10 * DAY) / 1000) });
  assert.ok(new Date(claudeAuthContext({ env: { HOME: secs }, home: secs }).refreshExpiresAt) > new Date());

  const junk = homeWith({ refreshTokenExpiresAt: 'soon' });
  assert.equal(claudeAuthContext({ env: { HOME: junk }, home: junk }).refreshExpiresAt, null);

  const zero = homeWith({ refreshTokenExpiresAt: 0 });
  assert.equal(claudeAuthContext({ env: { HOME: zero }, home: zero }).refreshExpiresAt, null);
});

/**
 * THE ONE THAT MATTERS MOST. Everything this returns is posted to the server
 * and rendered in a browser, so a token value appearing anywhere in it is a
 * credential leak. Asserted over the SERIALIZED form, because that is exactly
 * what leaves the machine — a nested field would slip past a key-by-key check.
 */
test('no token value appears anywhere in the report', () => {
  const home = homeWith({
    accessToken: 'sk-ant-oat01-ACCESSSECRET',
    refreshToken: 'sk-ant-ort01-REFRESHSECRET',
    refreshTokenExpiresAt: stamp(9 * DAY),
    subscriptionType: 'max',
  });
  const env = { HOME: home, USER: 'w' };
  for (const n of AUTH_ENV_VARS) env[n] = `VALUE-OF-${n}`;
  const wire = JSON.stringify(claudeAuthContext({ env, home }));

  for (const secret of ['ACCESSSECRET', 'REFRESHSECRET', 'sk-ant']) {
    assert.equal(wire.includes(secret), false, `store secret leaked: ${secret}`);
  }
  for (const n of AUTH_ENV_VARS) {
    assert.equal(wire.includes(`VALUE-OF-${n}`), false, `env value leaked: ${n}`);
    assert.equal(wire.includes(n), true, `the NAME must survive — it is what you grep for: ${n}`);
  }
});

/** A subscription name is relayed; anything unexpected in that slot is not. */
test('an implausible subscriptionType is dropped rather than relayed', () => {
  const home = homeWith({ subscriptionType: 'x'.repeat(500), refreshTokenExpiresAt: stamp(DAY) });
  assert.equal(claudeAuthContext({ env: { HOME: home }, home }).subscriptionType, null);
});
