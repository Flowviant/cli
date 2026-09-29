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
import { credentialRejected, isCredentialRejection } from './authReject.mjs';

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
// fetchRoster (fleetRoster.mjs) runs only inside the daemon's loop, so the
// routing is pinned in its source — both anchors asserted before slicing, and
// `e.auth` must sit behind the envelope check, never beside the bare status.
test('the roster poll exits only through the envelope check', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('./fleetRoster.mjs', import.meta.url), 'utf8');
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

test('the rule on a body already read answers as the response rule does', () => {
  const env = { success: false, error: { message: 'Token revoked' } };
  assert.equal(isCredentialRejection(401, 'application/json', env), true);
  assert.equal(isCredentialRejection(403, 'application/json; charset=UTF-8', env), true);
  assert.equal(isCredentialRejection(403, 'text/html', env), false, 'not labelled JSON');
  assert.equal(isCredentialRejection(403, 'application/json', { error_code: 1020 }), false, 'not the envelope');
  assert.equal(isCredentialRejection(401, 'application/json', {}), false, 'a body that did not parse');
  assert.equal(isCredentialRejection(500, 'application/json', env), false);
  assert.equal(isCredentialRejection(401, null, env), false);
});

// ONE HOME for "is this the API's own refusal": the deploy lane's wire asks
// the rule above and the lease reads only its answer — never the bare status,
// which is how an edge 403 once dropped a deploy's outcome.
test('the deploy lane asks the one rule, never the bare status', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const strip = (raw) =>
    raw
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*)/.test(l))
      .join('\n');
  const dir = new URL('./', import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs'));
  assert.ok(files.length > 40 && files.includes('deployWire.mjs'), 'the walk found the daemon (canary)');
  const src = Object.fromEntries(files.map((f) => [f, strip(readFileSync(new URL(f, dir), 'utf8'))]));
  const holding = (needle) => files.filter((f) => src[f].includes(needle));
  assert.deepEqual(holding('application\\/json\\b'), ['authReject.mjs'], 'the envelope rule is written once');
  assert.ok(src['deployWire.mjs'].includes('e.credentialRejected = isCredentialRejection('), 'the wire asks the rule');
  assert.ok(src['deploy.mjs'].includes('if (e?.credentialRejected) {'), 'the lease reads its answer');
  assert.ok(!/status === 40[13]/.test(src['deploy.mjs']), 'and never the bare status');
});
