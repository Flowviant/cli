import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorkSessionTokens } from './workSessionTokens.mjs';
import { DAEMON_INSTANCE } from './config.mjs';

/** The per-session work credential, driven directly (split out of work.mjs
 *  2026-09-26, SOLID F037) against a stubbed mint. */
function mint(t, answer) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), body: JSON.parse(opts.body) });
    return answer(calls.length);
  };
  t.after(() => {
    globalThis.fetch = real;
  });
  return calls;
}
const token = (v) => ({ ok: true, status: 200, json: async () => ({ data: { token: v } }) });

test('a token is minted per session, claims the lease for this instance, and is reused while fresh', async (t) => {
  const calls = mint(t, (n) => token(`tok-${n}`));
  const { mintWorkToken, workTokens } = createWorkSessionTokens({ getLeaseTtl: () => 24 * 3600 });
  assert.deepEqual(await mintWorkToken('s1'), { token: 'tok-1' });
  assert.deepEqual(calls[0].body, { sessionId: 's1', instance: DAEMON_INSTANCE });
  assert.ok(calls[0].url.endsWith('/work-token'));
  assert.deepEqual(await mintWorkToken('s1'), { token: 'tok-1' }, 'cached');
  assert.equal(calls.length, 1);
  assert.deepEqual(await mintWorkToken('s1', true), { token: 'tok-2' }, 'force re-mints');
  assert.deepEqual(await mintWorkToken('s2'), { token: 'tok-3' }, 'one credential per session');
  workTokens.delete('s2'); // what retirement does for a peer-held session
  assert.deepEqual(await mintWorkToken('s2'), { token: 'tok-4' });
});

test('the mint answers gone, held elsewhere, or nothing — and none is cached', async (t) => {
  const statuses = [404, 409, 500];
  mint(t, (n) => ({ ok: false, status: statuses[n - 1], json: async () => ({}) }));
  const { mintWorkToken, workTokens } = createWorkSessionTokens({ getLeaseTtl: () => 3600 });
  assert.deepEqual(await mintWorkToken('s1'), { gone: true });
  assert.deepEqual(await mintWorkToken('s1'), { heldElsewhere: true });
  assert.equal(await mintWorkToken('s1'), null);
  assert.equal(workTokens.size, 0);
});

test('a lease shorter than the refresh margin re-mints every time', async (t) => {
  const calls = mint(t, (n) => token(`tok-${n}`));
  const { mintWorkToken } = createWorkSessionTokens({ getLeaseTtl: () => 0 });
  await mintWorkToken('s1');
  await mintWorkToken('s1');
  assert.equal(calls.length, 2);
});
