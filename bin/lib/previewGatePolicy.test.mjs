/**
 * Who gets through the preview gate, asked directly — no sockets. The proxy's
 * own test (`authproxy.test.mjs`) proves both transports ASK these rules; this
 * file pins what the rules answer, including the thresholds that are too slow
 * or too wide to walk through a real server (the source-map eviction).
 *
 * Run: node --test bin/lib/previewGatePolicy.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  MAX_FAILED,
  MAX_FAILED_TOTAL,
  MAX_SOURCES,
  createGatePolicy,
  crossSiteAbuse,
  isBasic,
  isBrowserNav,
  sourceOf,
} from './previewGatePolicy.mjs';
import { GRANT_COOKIE } from './grant.mjs';

const SECRET = 'k'.repeat(43);
const SHARE = 'sh-test';
const b64url = (b) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function mint(over = {}) {
  const now = Math.floor(Date.now() / 1000);
  const payload = { v: 1, s: SHARE, k: 'm', u: 'u1', r: null, iat: now, exp: now + 3600, ...over };
  const body = b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  return `${body}.${b64url(createHmac('sha256', SECRET).update('fvgrant.v1.' + body).digest())}`;
}

const EXPECTED = 'Basic ' + Buffer.from('preview:right').toString('base64');
const WRONG = 'Basic ' + Buffer.from('preview:wrong').toString('base64');

const req = ({ method = 'GET', ip = '203.0.113.1', ...headers } = {}) => ({
  method,
  headers: { 'cf-connecting-ip': ip, ...headers },
  socket: { remoteAddress: '127.0.0.1' },
});

const gate = (over = {}) =>
  createGatePolicy({ grants: true, grantSecret: SECRET, shareId: SHARE, expected: EXPECTED, ...over });

test('only a Basic header is a password attempt', () => {
  assert.equal(isBasic(WRONG), true);
  assert.equal(isBasic('  basic x'), true);
  assert.equal(isBasic('Bearer abc'), false);
  assert.equal(isBasic(undefined), false);
});

test('the source is the forwarded client address, else the socket', () => {
  assert.equal(sourceOf(req({ ip: '198.51.100.9' })), '198.51.100.9');
  assert.equal(sourceOf({ headers: {}, socket: { remoteAddress: '::1' } }), '::1');
  assert.equal(sourceOf({ headers: {} }), 'unknown');
});

test('a browser navigation is a GET/HEAD asking for HTML, and nothing else', () => {
  assert.equal(isBrowserNav(req({ accept: 'text/html,*/*' })), true);
  assert.equal(isBrowserNav(req({ method: 'HEAD', accept: 'text/html' })), true);
  assert.equal(isBrowserNav(req({ method: 'POST', accept: 'text/html' })), false);
  assert.equal(isBrowserNav(req({ accept: 'application/json' })), false);
  assert.equal(isBrowserNav(req()), false);
});

test('the cross-site backstop refuses every cross-site shape but a GET/HEAD navigation', () => {
  const x = (method, mode) => req({ method, 'sec-fetch-site': 'cross-site', ...(mode ? { 'sec-fetch-mode': mode } : {}) });
  assert.equal(crossSiteAbuse(x('GET', 'cors')), true);
  assert.equal(crossSiteAbuse(x('GET', 'websocket')), true);
  assert.equal(crossSiteAbuse(x('POST', 'navigate')), true);
  assert.equal(crossSiteAbuse(x('POST')), true);
  assert.equal(crossSiteAbuse(x('GET', 'navigate')), false);
  assert.equal(crossSiteAbuse(x('HEAD', 'navigate')), false);
  // Same-origin, or no Fetch Metadata at all, is never refused.
  assert.equal(crossSiteAbuse(req({ method: 'POST', 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' })), false);
  assert.equal(crossSiteAbuse(req({ method: 'POST' })), false);
});

test('credential verdicts: grant, password, bearer, forged, expired, none', () => {
  const g = gate();
  assert.equal(g.admit(req({ cookie: `${GRANT_COOKIE}=${mint()}` })), 'ok');
  assert.equal(g.admit(req({ authorization: EXPECTED })), 'ok');
  assert.equal(g.admit(req({ authorization: WRONG })), 'badpass');
  // A Bearer is the APP's credential — not graded, so not a failure.
  assert.equal(g.admit(req({ authorization: 'Bearer t' })), 'none');
  const [body] = mint().split('.');
  assert.equal(g.admit(req({ cookie: `${GRANT_COOKIE}=${body}.forged` })), 'forged');
  assert.equal(g.admit(req()), 'none');
  const stale = mint({ exp: Math.floor(Date.now() / 1000) - 60, k: 't', r: 'tok-9' });
  assert.equal(g.lastExpired(), null);
  assert.equal(g.admit(req({ cookie: `${GRANT_COOKIE}=${stale}` })), 'expired');
  assert.equal(g.lastExpired().r, 'tok-9');
});

test('a valid grant is asked FIRST — an app speaking Basic is not graded', () => {
  const g = gate();
  for (let i = 0; i < MAX_FAILED + 5; i++) {
    assert.equal(g.admit(req({ cookie: `${GRANT_COOKIE}=${mint()}`, authorization: WRONG })), 'ok');
  }
  // None of that counted against the source.
  assert.equal(g.admit(req({ authorization: EXPECTED })), 'ok');
});

test('a password-only gate ignores grant cookies entirely', () => {
  const g = gate({ grants: false });
  assert.equal(g.admit(req({ cookie: `${GRANT_COOKIE}=${mint()}` })), 'none');
  assert.equal(g.admit(req({ authorization: EXPECTED })), 'ok');
});

test('a source is blocked at MAX_FAILED, before the comparison; others are untouched', () => {
  const logs = [];
  const g = gate({ log: (l) => logs.push(l) });
  for (let i = 0; i < MAX_FAILED; i++) assert.equal(g.admit(req({ authorization: WRONG })), 'badpass');
  assert.equal(logs.length, 1);
  assert.match(logs[0], /25 failed attempts from 203\.0\.113\.1/);
  // Even the right password: a block that still graded would let a brute force run to a hit.
  assert.equal(g.admit(req({ authorization: EXPECTED })), 'blocked');
  assert.equal(g.admit(req({ authorization: EXPECTED, ip: '203.0.113.2' })), 'ok');
  // A blocked source's grant cookie still works — the block is on Basic only.
  assert.equal(g.admit(req({ cookie: `${GRANT_COOKIE}=${mint()}` })), 'ok');
});

test('a right password clears that source only', () => {
  const g = gate();
  for (let i = 0; i < MAX_FAILED - 1; i++) g.admit(req({ authorization: WRONG }));
  assert.equal(g.admit(req({ authorization: EXPECTED })), 'ok');
  // The count restarted: MAX_FAILED - 1 more wrongs do not block.
  for (let i = 0; i < MAX_FAILED - 1; i++) g.admit(req({ authorization: WRONG }));
  assert.equal(g.admit(req({ authorization: EXPECTED })), 'ok');
});

test('the global backstop fires once at MAX_FAILED_TOTAL, then refuses every password', () => {
  let closed = 0;
  const g = gate({ onAbuse: () => (closed += 1) });
  const sources = MAX_FAILED_TOTAL / MAX_FAILED;
  for (let s = 0; s < sources; s++) {
    for (let i = 0; i < MAX_FAILED; i++) g.admit(req({ authorization: WRONG, ip: `10.0.0.${s}` }));
    assert.equal(closed, s === sources - 1 ? 1 : 0);
  }
  assert.equal(g.admit(req({ authorization: EXPECTED, ip: '10.9.9.9' })), 'badpass');
  assert.equal(closed, 1, 'fires once');
});

test("a throwing onAbuse does not break the gate's answer", () => {
  const g = gate({ onAbuse: () => { throw new Error('teardown failed'); } });
  for (let s = 0; s < MAX_FAILED_TOTAL / MAX_FAILED; s++) {
    for (let i = 0; i < MAX_FAILED; i++) assert.equal(g.admit(req({ authorization: WRONG, ip: `10.1.0.${s}` })), 'badpass');
  }
});

test('evicting a blocked source costs more than the global backstop allows', () => {
  // The per-source map is bounded at MAX_SOURCES, oldest first, and eviction
  // CAN un-block a source — but pushing one out takes MAX_SOURCES fresh
  // counted failures, and the share closes long before that.
  assert.ok(MAX_FAILED + MAX_SOURCES > MAX_FAILED_TOTAL);
  let closed = 0;
  const g = gate({ onAbuse: () => (closed += 1) });
  for (let i = 0; i < MAX_FAILED; i++) g.admit(req({ authorization: WRONG, ip: 'old' }));
  assert.equal(g.admit(req({ authorization: EXPECTED, ip: 'old' })), 'blocked');
  for (let s = 0; s < MAX_SOURCES; s++) g.admit(req({ authorization: WRONG, ip: `r${s}` }));
  assert.equal(closed, 1);
  assert.equal(g.admit(req({ authorization: EXPECTED, ip: 'old' })), 'badpass', 'the share is closed');
});

test('admit: a credentialed cross-site request is refused, the password is exempt', () => {
  const g = gate();
  const xs = { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors' };
  assert.equal(g.admit(req({ ...xs, cookie: `${GRANT_COOKIE}=${mint()}` })), 'cross-site');
  assert.equal(g.admit(req({ ...xs, authorization: EXPECTED })), 'ok');
  // No credential → the credential verdict, never 'cross-site'.
  assert.equal(g.admit(req(xs)), 'none');
  // A password-only gate has no cookie to ride, so no backstop.
  const pw = gate({ grants: false });
  assert.equal(pw.admit(req({ ...xs, authorization: EXPECTED })), 'ok');
});

test('admit: a blocked source is blocked even when the request is also cross-site', () => {
  const g = gate();
  for (let i = 0; i < MAX_FAILED; i++) g.admit(req({ authorization: WRONG }));
  assert.equal(
    g.admit(req({ authorization: WRONG, 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors' })),
    'blocked'
  );
});

test('viaPassword is the gate credential exactly', () => {
  const g = gate();
  assert.equal(g.viaPassword(req({ authorization: EXPECTED })), true);
  assert.equal(g.viaPassword(req({ authorization: WRONG })), false);
  assert.equal(g.viaPassword(req({ authorization: 'Bearer x' })), false);
  assert.equal(g.viaPassword(req()), false);
});
