/**
 * The gate's grant verification, and the parsing helpers around it.
 *
 * THIS FILE IS HALF OF A CROSS-REPO WIRE CONTRACT. The other half is
 * `apps/api/src/lib/agent-runner/previewGrant.test.ts` in the Flowviant repo,
 * which tests the same vectors against the minting side. A change to either
 * implementation that the other does not follow must turn one of the two red —
 * because the failure it prevents (a preview literally nobody can open) is
 * invisible until somebody clicks a link.
 *
 * The daemon had ZERO tests before this. The proxy is the only thing standing
 * between a public hostname and a worktree holding the team's decrypted dev
 * secrets, so its new surface gets covered even though the old one is not.
 *
 * Run: node --test bin/lib/grant.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  GRANT_COOKIE,
  GRANT_SKEW_MS,
  cookieValues,
  safePathname,
  safeRelative,
  stripCookie,
  verifyGrant,
} from './grant.mjs';

const SECRET = 'a'.repeat(43);
const SHARE = 'share-abc';
const b64url = (b) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** The minting side, reimplemented here ONLY so this file can stand alone. The
 *  server's version is what runs in production; if these diverge, the round
 *  trip below is what notices. */
function mint(payload, { secret = SECRET, domain = 'fvgrant.v1.' } = {}) {
  const body = b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  return `${body}.${b64url(createHmac('sha256', secret).update(domain + body).digest())}`;
}

const valid = (over = {}) => ({
  v: 1,
  s: SHARE,
  k: 'm',
  u: 'user-1',
  r: null,
  iat: Math.floor(Date.now() / 1000),
  exp: Math.floor(Date.now() / 1000) + 3600,
  ...over,
});

test('verifies a well-formed grant', () => {
  const r = verifyGrant(mint(valid()), { secret: SECRET, shareId: SHARE });
  assert.equal(r.ok, true);
  assert.equal(r.payload.u, 'user-1');
});

test('refuses a tampered payload', () => {
  const g = mint(valid());
  const [body, sig] = g.split('.');
  const flipped = (body[0] === 'e' ? 'f' : 'e') + body.slice(1);
  const r = verifyGrant(`${flipped}.${sig}`, { secret: SECRET, shareId: SHARE });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'sig');
});

test('refuses a different secret', () => {
  const r = verifyGrant(mint(valid(), { secret: 'b'.repeat(43) }), {
    secret: SECRET,
    shareId: SHARE,
  });
  assert.equal(r.reason, 'sig');
});

test('refuses another share id — one machine may serve several', () => {
  const r = verifyGrant(mint(valid({ s: 'other' })), { secret: SECRET, shareId: SHARE });
  assert.equal(r.reason, 'share');
});

test('refuses a different domain prefix — no cross-purpose replay', () => {
  const r = verifyGrant(mint(valid(), { domain: 'fvsomethingelse.' }), {
    secret: SECRET,
    shareId: SHARE,
  });
  assert.equal(r.reason, 'sig');
});

test('refuses a null or empty secret WITHOUT hashing', () => {
  // Every share created before this feature has a null grant_secret. Null must
  // read as "no SSO gate here", never as "the empty key".
  for (const secret of [null, undefined, '']) {
    assert.equal(verifyGrant(mint(valid()), { secret, shareId: SHARE }).reason, 'empty');
  }
});

test('expiry honours the skew, in one direction', () => {
  const exp = Math.floor(Date.now() / 1000);
  const g = mint(valid({ exp }));
  assert.equal(
    verifyGrant(g, { secret: SECRET, shareId: SHARE, nowMs: exp * 1000 + GRANT_SKEW_MS - 5_000 }).ok,
    true
  );
  const past = verifyGrant(g, {
    secret: SECRET,
    shareId: SHARE,
    nowMs: exp * 1000 + GRANT_SKEW_MS + 5_000,
  });
  assert.equal(past.reason, 'exp');
  // The payload rides back so a tester can be re-bounced with its token.
  assert.equal(past.payload.s, SHARE);
});

test('malformed shapes are refused, never thrown', () => {
  for (const raw of ['', 'nodot', '.lead', 'trail.', 'a.b', 'a b.c d']) {
    assert.equal(verifyGrant(raw, { secret: SECRET, shareId: SHARE }).ok, false);
  }
});

test('stripCookie drops only ours', () => {
  assert.equal(stripCookie(`a=1; ${GRANT_COOKIE}=x; b=2`, GRANT_COOKIE), 'a=1; b=2');
  // Nothing left → the caller must delete the header, not send an empty one.
  assert.equal(stripCookie(`${GRANT_COOKIE}=x`, GRANT_COOKIE), '');
  // The driver's own app owns these and breaks without them.
  assert.equal(stripCookie('sid=9; theme=dark', GRANT_COOKIE), 'sid=9; theme=dark');
});

test('cookieValues returns EVERY value, so a duplicate cannot shadow', () => {
  const vals = cookieValues(`${GRANT_COOKIE}=planted; a=1; ${GRANT_COOKIE}=real`, GRANT_COOKIE);
  assert.deepEqual(vals, ['planted', 'real']);
});

test('safePathname parses rather than prefix-matching', () => {
  // The bug this prevents: `/__fv/cbXYZ` handled as the callback, or the
  // callback proxied to the dev server because the query was reordered.
  assert.equal(safePathname('/__fv/cb?g=1&to=%2Fx'), '/__fv/cb');
  assert.equal(safePathname('/__fv/cb'), '/__fv/cb');
  assert.notEqual(safePathname('/__fv/cbXYZ'), '/__fv/cb');
  assert.equal(safePathname(undefined), '/');
});

test('safeRelative refuses anything a browser reads as an origin', () => {
  for (const bad of ['//evil.com', '/\\evil.com', 'https://evil.com', 'evil', '/a\r\nb']) {
    assert.equal(safeRelative(bad), '/');
  }
  assert.equal(safeRelative('/app?x=1'), '/app?x=1');
  assert.equal(safeRelative(''), '/');
});
