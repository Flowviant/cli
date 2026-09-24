/**
 * ONE EDGE 403 MUST NOT KILL THE MACHINE.
 *
 * The daemon exits for good (exit 0, nothing restarts it) when its credential
 * is rejected. It used to take ANY 401/403 as that rejection, and Cloudflare in
 * front of the API answers this client class with HTML 403s of its own — so a
 * transient bot challenge took an unattended machine offline over a credential
 * that was still valid. Only the API's JSON envelope is a rejection.
 *
 * Run: node --test bin/lib/authReject.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { credentialRejected } from './authReject.mjs';

const answer = (status, body, type) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': type },
  });

test('the API’s own refusal is a credential rejection', async () => {
  const env = { success: false, error: { code: 'UNAUTHORIZED', message: 'Token revoked' } };
  assert.equal(await credentialRejected(answer(401, env, 'application/json')), true);
  assert.equal(
    await credentialRejected(answer(403, { ...env, error: { message: 'Not a machine credential' } }, 'application/json; charset=UTF-8')),
    true
  );
});

test('an edge page wearing the same status is retried, never an exit', async () => {
  const html = '<!DOCTYPE html><title>Attention Required! | Cloudflare</title>';
  assert.equal(await credentialRejected(answer(403, html, 'text/html; charset=UTF-8')), false);
  // JSON, but not the API's envelope (Cloudflare's own JSON error shape).
  assert.equal(await credentialRejected(answer(403, { error_code: 1020 }, 'application/json')), false);
  // Mislabelled: says JSON, is not.
  assert.equal(await credentialRejected(answer(401, html, 'application/json')), false);
  // Not an auth status at all.
  assert.equal(await credentialRejected(answer(500, { success: false }, 'application/json')), false);
});

// The daemon's own poll is the caller that matters: it EXITS on a rejection.
// fetchRoster is module-private and runs only inside the daemon's loop, so the
// routing is pinned in its source — both anchors asserted before slicing, and
// `e.auth` must sit behind the envelope check, never beside the bare status.
test('the roster poll exits only through the envelope check', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('./fleet.mjs', import.meta.url), 'utf8');
  const start = src.indexOf('async function fetchRoster(');
  const end = src.indexOf('THE ASK IS SPENT HERE', start);
  assert.ok(start > 0 && end > start, 'fetchRoster anchors');
  const body = src.slice(start, end);
  const gate = body.indexOf('if (await credentialRejected(res))');
  const auth = body.indexOf('e.auth = true');
  assert.ok(gate > 0, 'the envelope gate');
  assert.ok(auth > gate, 'the exit flag is set only past the gate');
  assert.equal(body.split('e.auth = true').length - 1, 1, 'one exit site');
});
