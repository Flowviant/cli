/**
 * THE GATE'S HALF OF THE GRANT — verify only. This file never mints.
 *
 * A shared preview is served AROUND Flowviant: cloudflared → the gate in
 * `authproxy.mjs` → the dev server the driver started. When the gate meets a
 * browser with no cookie it bounces to the app, which checks the visitor is
 * signed in and on the project, and hands back an HMAC grant signed with the
 * per-share secret the roster gave this machine. The gate verifies that grant
 * HERE, offline, and sets a cookie.
 *
 * OFFLINE IS THE WHOLE DESIGN. The daemon is a pull client with no
 * server→daemon request path, and the gate is listening before cloudflared
 * spawns — so a gate that had to reach api.flowviant.com to answer its first
 * request would either delay the tunnel or open a window where the public
 * hostname is un-gated. It also means a network blip cannot turn somebody's
 * working preview into a 502.
 *
 * THIS FILE IS ONE HALF OF A WIRE CONTRACT. The other half is
 * `apps/api/src/lib/agent-runner/previewGrant.ts` in the Flowviant repo, and
 * the two are tested against the same vectors. A change here that the server
 * does not follow shows up as a preview nobody can open.
 *
 * NO CANONICAL-ENCODING CONTRACT, deliberately: the signature covers the
 * RECEIVED payload string bytes and the JSON is parsed only afterwards. Field
 * order, whitespace and key set are therefore irrelevant to verification, which
 * removes an entire failure mode — an unbootstrappable redirect loop caused by
 * two languages disagreeing about how to serialise an object.
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const GRANT_VERSION = 1;
const DOMAIN = `fvgrant.v${GRANT_VERSION}.`;

/** `__Host-` is required rather than decorative: every quick tunnel is a
 *  hostname under the shared `trycloudflare.com` parent, so without the prefix
 *  a neighbour with their own tunnel could set a Domain-scoped cookie the
 *  browser would also send to ours. The prefix makes the browser refuse any
 *  Domain attribute and forces host-only + Secure + Path=/. */
export const GRANT_COOKIE = '__Host-fv_grant';

/** Tolerance past `exp`, one direction only. Absorbs ordinary clock drift
 *  between the Worker and this box. */
export const GRANT_SKEW_MS = 60_000;

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** Constant-time over sha256 digests, so length never leaks and a missing
 *  value costs the same as a wrong one. Never `===` on a signature. */
function sameDigest(a, b) {
  try {
    const da = createHash('sha256').update(String(a ?? '')).digest();
    const db = createHash('sha256').update(String(b ?? '')).digest();
    return timingSafeEqual(da, db);
  } catch {
    return false;
  }
}

/**
 * Verify a grant against this share's secret.
 *
 * Returns `{ ok: true, raw, payload }`, or `{ ok: false, reason, payload? }`
 * where reason is one of empty | shape | sig | version | share | exp. The
 * payload rides back on an EXPIRY (and only after the signature checked out) so
 * the caller can re-bounce a tester using the token inside it.
 */
export function verifyGrant(raw, { secret, shareId, nowMs, skewMs } = {}) {
  // An empty secret is refused BEFORE anything is hashed. Every share created
  // before this feature has none, and null must read as "no SSO gate here",
  // never as "the empty key".
  if (!raw || !secret) return { ok: false, reason: 'empty' };
  const s = String(raw);
  const dot = s.indexOf('.');
  if (dot <= 0 || dot === s.length - 1) return { ok: false, reason: 'shape' };
  const body = s.slice(0, dot);
  const sig = s.slice(dot + 1);
  if (!/^[A-Za-z0-9_-]+$/.test(body) || !/^[A-Za-z0-9_-]+$/.test(sig)) {
    return { ok: false, reason: 'shape' };
  }

  const expected = b64url(createHmac('sha256', String(secret)).update(DOMAIN + body).digest());
  if (!sameDigest(sig, expected)) return { ok: false, reason: 'sig' };

  let payload;
  try {
    payload = JSON.parse(Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch {
    return { ok: false, reason: 'shape' };
  }
  if (!payload || typeof payload !== 'object') return { ok: false, reason: 'shape' };
  if (payload.v !== GRANT_VERSION) return { ok: false, reason: 'version' };
  // Binds the grant to THIS share. One machine may serve several; a grant for
  // one must not open another.
  if (payload.s !== shareId) return { ok: false, reason: 'share' };

  const now = nowMs ?? Date.now();
  const skew = skewMs ?? GRANT_SKEW_MS;
  if (typeof payload.exp !== 'number' || now > payload.exp * 1000 + skew) {
    return { ok: false, reason: 'exp', payload };
  }
  return { ok: true, raw: s, payload };
}

/**
 * EVERY value for `name` in a Cookie header, not just the first.
 *
 * A `__Host-` cookie cannot be shadowed by a Domain-scoped one, but a page on
 * the origin can still call `document.cookie` and a malformed header can carry
 * a duplicate. Checking only the first match would let a planted value shadow
 * the real one and lock the viewer out; checking all of them cannot.
 */
export function cookieValues(header, name) {
  if (!header) return [];
  const out = [];
  for (const part of String(header).split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    out.push(part.slice(eq + 1).trim());
  }
  return out;
}

/**
 * Drop ONLY our cookie from a Cookie header, preserving everything else.
 *
 * The whole header must not be deleted: the driver's own app legitimately owns
 * its session cookies and would break. And ours must not be forwarded: a signed
 * grant handed to whatever code the branch happens to be running is a bearer
 * token given to the untrusted side of this boundary — the same bug the
 * `authorization` strip already encodes, and that one shipped once.
 *
 * Returns the remaining header, or '' when nothing is left (the caller must
 * then delete the header rather than send an empty one).
 */
export function stripCookie(header, name) {
  if (!header) return '';
  const kept = String(header)
    .split(';')
    .filter((part) => {
      const eq = part.indexOf('=');
      const key = eq < 0 ? part.trim() : part.slice(0, eq).trim();
      return key !== name;
    })
    .map((p) => p.trim())
    .filter(Boolean);
  return kept.join('; ');
}

/**
 * The pathname of a request, PARSED rather than prefix-matched.
 *
 * `req.url.startsWith('/__fv/cb')` also matches `/__fv/cbXYZ`, and an equality
 * test against `req.url` misses a reordered query string, a bare path with no
 * query, and a fragment. Both mistakes are the difference between the callback
 * being handled and being proxied to somebody's dev server with the grant in
 * its access log.
 */
export function safePathname(url) {
  try {
    return new URL(String(url ?? '/'), 'http://x').pathname;
  } catch {
    return '/';
  }
}

/**
 * A destination that cannot be read as an origin.
 *
 * `//evil.com` and `/\evil.com` are protocol-relative to a browser, so a naive
 * "starts with /" check turns the callback into an open redirect on the tunnel
 * origin. Anything that is not a single-slash relative path becomes '/'.
 */
export function safeRelative(raw) {
  if (!raw) return '/';
  const s = String(raw);
  if (s.length > 512) return '/';
  if (/[\r\n]/.test(s)) return '/';
  if (!/^\/(?![/\\])/.test(s)) return '/';
  return s;
}
