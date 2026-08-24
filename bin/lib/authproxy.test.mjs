/**
 * THE GATE, EXERCISED — real sockets, a real origin, real requests.
 *
 * `grant.test.mjs` tests the helpers. It cannot tell you whether the proxy
 * CALLS them, and the single easiest thing to forget in this whole feature is
 * one line in `forwardOpts` — delete the cookie strip and every test there
 * stays green while the gate hands a signed bearer token to whatever code the
 * branch happens to be running. So this file starts the thing and looks at what
 * comes out the other side.
 *
 * The origin here is a stub that echoes the headers it received, which is the
 * only way to assert a NEGATIVE about forwarding.
 *
 * Run: node --test bin/lib/authproxy.test.mjs
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { startAuthProxy } from './authproxy.mjs';
import { GRANT_COOKIE } from './grant.mjs';

const SECRET = 'k'.repeat(43);
const SHARE = 'sh-test';
const b64url = (b) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function mint(over = {}) {
  const payload = {
    v: 1,
    s: SHARE,
    k: 'm',
    u: 'u1',
    r: null,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...over,
  };
  const body = b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  return `${body}.${b64url(createHmac('sha256', SECRET).update('fvgrant.v1.' + body).digest())}`;
}

/** An origin that reports back exactly what reached it. */
const origin = createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ url: req.url, headers: req.headers }));
});
await new Promise((r) => origin.listen(0, '127.0.0.1', r));
const originPort = origin.address().port;

const gate = await startAuthProxy({
  targetPort: originPort,
  grantSecret: SECRET,
  shareId: SHARE,
  authorizeUrl: 'https://app.flowviant.com/api/v2/preview/authorize',
});
assert.ok(gate, 'the gate must bind');

after(() => {
  gate.stop();
  origin.close();
});

const base = `http://127.0.0.1:${gate.port}`;
const get = (path, headers = {}) =>
  fetch(base + path, { headers, redirect: 'manual' });

test('the gate reports the door it installed', () => {
  assert.equal(gate.gateMode, 'grant');
});

test('NC1 — the grant cookie NEVER reaches the origin, and other cookies do', async () => {
  const res = await get('/x', {
    accept: 'text/html',
    cookie: `sid=keepme; ${GRANT_COOKIE}=${mint()}; theme=dark`,
  });
  assert.equal(res.status, 200);
  const seen = (await res.json()).headers;
  // Ours is stripped …
  assert.ok(!String(seen.cookie ?? '').includes(GRANT_COOKIE), 'grant cookie leaked to origin');
  // … and the driver's own app keeps its session, which breaks without it.
  assert.match(seen.cookie, /sid=keepme/);
  assert.match(seen.cookie, /theme=dark/);
  // The gate credential stops here too — this one shipped as a bug once.
  assert.equal(seen.authorization, undefined);
});

test('a cookie-only request authenticates without any password', async () => {
  const res = await get('/ok', { cookie: `${GRANT_COOKIE}=${mint()}` });
  assert.equal(res.status, 200);
});

test('a forged grant does not get in', async () => {
  const [body] = mint().split('.');
  const res = await get('/x', { cookie: `${GRANT_COOKIE}=${body}.deadbeef` });
  assert.equal(res.status, 401);
});

test('a DUPLICATE cookie cannot shadow the real one', async () => {
  // A page on the origin can call document.cookie. Checking only the first
  // match would let a planted value lock the viewer out.
  const res = await get('/x', {
    cookie: `${GRANT_COOKIE}=garbage; ${GRANT_COOKIE}=${mint()}`,
  });
  assert.equal(res.status, 200);
});

test('a cookie-less BROWSER NAVIGATION bounces to the app', async () => {
  const res = await get('/deep/path?q=1', { accept: 'text/html' });
  assert.equal(res.status, 302);
  const loc = new URL(res.headers.get('location'));
  assert.equal(loc.origin, 'https://app.flowviant.com');
  assert.equal(loc.searchParams.get('s'), SHARE);
  // It sends a RELATIVE path and never its own hostname — the server builds the
  // absolute callback from the URL it already stored.
  assert.equal(loc.searchParams.get('to'), '/deep/path?q=1');
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
});

test('a cookie-less API request gets 401, NOT a redirect', async () => {
  // This is what keeps curl, Playwright and native mobile clients on the
  // password path. A 302 would also be re-issued as GET and drop the body.
  const res = await get('/api/thing', { accept: 'application/json' });
  assert.equal(res.status, 401);
  assert.match(res.headers.get('www-authenticate') ?? '', /Basic/);
});

test('a POST is never bounced, even from a browser', async () => {
  const res = await fetch(base + '/submit', {
    method: 'POST',
    headers: { accept: 'text/html' },
    body: 'x=1',
    redirect: 'manual',
  });
  assert.equal(res.status, 401);
});

test('the password still works — it is the automation path, not a deleted one', async () => {
  const auth = 'Basic ' + Buffer.from(`${gate.user}:${gate.password}`).toString('base64');
  const res = await get('/x', { authorization: auth });
  assert.equal(res.status, 200);
});

test('the callback sets a __Host- cookie and redirects to a clean path', async () => {
  const res = await get(`/__fv/cb?g=${encodeURIComponent(mint())}&to=%2Fapp%3Fx%3D1`);
  assert.equal(res.status, 302);
  // The immediate 302 is mandatory: it takes ?g= out of the address bar, out of
  // the Referer every subresource carries, and out of browser history.
  assert.equal(res.headers.get('location'), '/app?x=1');
  const cookie = res.headers.get('set-cookie');
  assert.match(cookie, new RegExp(`^${GRANT_COOKIE}=`));
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Lax/);
});

test('the callback refuses an off-origin destination', async () => {
  const res = await get(`/__fv/cb?g=${encodeURIComponent(mint())}&to=%2F%2Fevil.com`);
  assert.equal(res.headers.get('location'), '/');
});

test('a bad grant at the callback does NOT redirect — no loop', async () => {
  const res = await get('/__fv/cb?g=nonsense');
  assert.equal(res.status, 401);
});

test('the reserved prefix is never proxied', async () => {
  // `/__fv/cbXYZ` must not be treated as the callback, and must not reach the
  // origin either.
  const res = await get('/__fv/cbXYZ', { cookie: `${GRANT_COOKIE}=${mint()}` });
  assert.equal(res.status, 404);
});

test('NC6 — a forged grant does not count toward the abuse kill switch', async () => {
  // Counting it would hand any stranger who finds the hostname a 25-request
  // kill switch on the owner's share. Well past MAX_FAILED here.
  const [body] = mint().split('.');
  for (let i = 0; i < 40; i++) {
    await get('/x', { cookie: `${GRANT_COOKIE}=${body}.forged${i}` });
  }
  // Still serving.
  const res = await get('/x', { cookie: `${GRANT_COOKIE}=${mint()}` });
  assert.equal(res.status, 200);
});

test('an EXPIRED grant re-bounces rather than counting as an attempt', async () => {
  const stale = mint({ exp: Math.floor(Date.now() / 1000) - 7200, k: 't', r: 'tok-1' });
  const res = await get('/x', { accept: 'text/html', cookie: `${GRANT_COOKIE}=${stale}` });
  assert.equal(res.status, 302);
  const loc = new URL(res.headers.get('location'));
  // A tester is re-bounced with the token from inside their own grant — they no
  // longer hold the original link, and the server re-checks it ONLINE, which is
  // what makes a tester link revocable at all.
  assert.equal(loc.searchParams.get('t'), 'tok-1');
  assert.equal(loc.searchParams.get('x'), '1');
});
