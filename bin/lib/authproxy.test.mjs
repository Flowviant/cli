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

/** An origin that reports back exactly what reached it — and, under `/hdr/`,
 *  answers wearing the frame policy named in the path, so the response-rewrite
 *  tests exercise a real proxied response rather than the helper. */
const origin = createServer((req, res) => {
  const headers = { 'Content-Type': 'application/json' };
  if (req.url.startsWith('/hdr/deny')) {
    headers['X-Frame-Options'] = 'DENY';
    headers['Content-Security-Policy'] = "default-src 'self'; frame-ancestors 'none'; img-src data:";
  } else if (req.url.startsWith('/hdr/noframe')) {
    headers['Content-Security-Policy'] = "default-src 'self'";
  } else if (req.url.startsWith('/hdr/reportonly')) {
    headers['Content-Security-Policy-Report-Only'] = "frame-ancestors 'none'";
  } else if (req.url.startsWith('/hdr/double')) {
    // Two CSP headers — the wire folds them into one comma-joined string, and
    // a rewrite that only splits on ';' eats the second policy's head.
    res.setHeader('Content-Security-Policy', [
      "script-src 'self'; frame-ancestors 'none'",
      "default-src 'self'; img-src data:",
    ]);
  }
  res.writeHead(200, headers);
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

// fetch() is a browser-faithful client: it OVERRIDES `Sec-Fetch-Mode` with its
// own value ('cors'), so tests that assert on Fetch Metadata must speak raw
// HTTP to control the headers exactly.
import { request as httpRequest } from 'node:http';
const raw = (path, { method = 'GET', headers = {}, body } = {}) =>
  new Promise((resolve, reject) => {
    const r = httpRequest(
      { host: '127.0.0.1', port: gate.port, path, method, headers },
      (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode }));
      }
    );
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });

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

test('a FRAMED callback sets a Partitioned SameSite=None cookie instead of Lax', async () => {
  // Sec-Fetch-Dest describes the navigation and survives the redirect chain,
  // so the callback sees `iframe` exactly when the Workbench is the framer.
  // Partitioned keys the jar to the top-level site, which is what makes
  // SameSite=None here not a CSRF hole.
  const res = await get(`/__fv/cb?g=${encodeURIComponent(mint())}&to=%2F`, {
    'sec-fetch-dest': 'iframe',
  });
  assert.equal(res.status, 302);
  const cookie = res.headers.get('set-cookie');
  assert.match(cookie, /SameSite=None/);
  assert.match(cookie, /Partitioned/);
  assert.doesNotMatch(cookie, /SameSite=Lax/);
  // Still __Host--eligible: Secure, Path=/, no Domain.
  assert.match(cookie, /Secure/);
  assert.match(cookie, /Path=\//);
  assert.doesNotMatch(cookie, /Domain=/);
});

test('a TOP-LEVEL callback never carries Partitioned — Safari 18.5–26.1 drops such cookies whole', async () => {
  const res = await get(`/__fv/cb?g=${encodeURIComponent(mint())}&to=%2F`, {
    'sec-fetch-dest': 'document',
  });
  assert.match(res.headers.get('set-cookie'), /SameSite=Lax/);
  assert.doesNotMatch(res.headers.get('set-cookie'), /Partitioned/);
});

test("the origin's frame refusal is rewritten to permit exactly the app", async () => {
  const res = await get('/hdr/deny', { cookie: `${GRANT_COOKIE}=${mint()}` });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-frame-options'), null, 'XFO must be stripped');
  const csp = res.headers.get('content-security-policy');
  // The directive is REWRITTEN in place, never appended beside the origin's
  // own — two CSP headers intersect, so an appended allow would still lose to
  // the origin's frame-ancestors 'none'.
  assert.match(csp, /frame-ancestors 'self' https:\/\/app\.flowviant\.com/);
  assert.doesNotMatch(csp, /frame-ancestors 'none'/);
  // The rest of the origin's policy is untouched — the gate edits the frame
  // policy and nothing else.
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /img-src data:/);
});

test('an origin with NO frame policy gets ours added', async () => {
  const res = await get('/hdr/noframe', { cookie: `${GRANT_COOKIE}=${mint()}` });
  const csp = res.headers.get('content-security-policy');
  assert.match(csp, /frame-ancestors 'self' https:\/\/app\.flowviant\.com/);
  assert.match(csp, /default-src 'self'/);
});

test('TWO CSP policies survive the rewrite whole — only the directive is replaced', async () => {
  const res = await get('/hdr/double', { cookie: `${GRANT_COOKIE}=${mint()}` });
  const csp = res.headers.get('content-security-policy');
  assert.match(csp, /frame-ancestors 'self' https:\/\/app\.flowviant\.com/);
  assert.doesNotMatch(csp, /frame-ancestors 'none'/);
  // The neighbouring policy's directives are intact on both sides of the comma.
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /img-src data:/);
});

test('Report-Only is left alone — rewriting a report channel edits telemetry', async () => {
  const res = await get('/hdr/reportonly', { cookie: `${GRANT_COOKIE}=${mint()}` });
  assert.equal(res.headers.get('content-security-policy-report-only'), "frame-ancestors 'none'");
});

test('a PASSWORD-ONLY gate rewrites nothing — no app origin, no framing story', async () => {
  const pwGate = await startAuthProxy({ targetPort: originPort });
  assert.ok(pwGate);
  try {
    const auth = 'Basic ' + Buffer.from(`${pwGate.user}:${pwGate.password}`).toString('base64');
    const res = await fetch(`http://127.0.0.1:${pwGate.port}/hdr/deny`, {
      headers: { authorization: auth },
      redirect: 'manual',
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.match(res.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  } finally {
    pwGate.stop();
  }
});

test('CSRF backstop — a cross-site FETCH riding the grant cookie is refused', async () => {
  // Chromium 76–113 honours SameSite=None while ignoring Partitioned, so the
  // grant can arrive on a cross-site request there. Fetch Metadata is the
  // backstop: nothing legitimate is a cross-site non-navigation.
  const res = await raw('/api/data', {
    headers: {
      cookie: `${GRANT_COOKIE}=${mint()}`,
      'sec-fetch-site': 'cross-site',
      'sec-fetch-mode': 'cors',
    },
  });
  assert.equal(res.status, 403);
});

test('CSRF backstop — a cross-site POST navigation (auto-submitted form) is refused', async () => {
  const res = await raw('/submit', {
    method: 'POST',
    headers: {
      cookie: `${GRANT_COOKIE}=${mint()}`,
      'sec-fetch-site': 'cross-site',
      'sec-fetch-mode': 'navigate',
      accept: 'text/html',
    },
    body: 'x=1',
  });
  assert.equal(res.status, 403);
});

test('CSRF backstop — a cross-site GET NAVIGATION still works: it is the Open link and the frame src', async () => {
  const res = await raw('/page', {
    headers: {
      cookie: `${GRANT_COOKIE}=${mint()}`,
      accept: 'text/html',
      'sec-fetch-site': 'cross-site',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-dest': 'iframe',
    },
  });
  assert.equal(res.status, 200);
});

test('CSRF backstop — same-origin subresources inside the frame are untouched', async () => {
  const res = await raw('/assets/app.js', {
    headers: {
      cookie: `${GRANT_COOKIE}=${mint()}`,
      'sec-fetch-site': 'same-origin',
      'sec-fetch-mode': 'cors',
    },
  });
  assert.equal(res.status, 200);
});

test('CSRF backstop — the PASSWORD path is exempt: Basic auth never rides cross-site', async () => {
  const auth = 'Basic ' + Buffer.from(`${gate.user}:${gate.password}`).toString('base64');
  const res = await raw('/hook', {
    method: 'POST',
    headers: { authorization: auth, 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors' },
    body: '{}',
  });
  assert.equal(res.status, 200);
});

test('CSRF backstop — no Sec-Fetch headers means no refusal: such a browser never held a None cookie', async () => {
  const res = await raw('/submit', {
    method: 'POST',
    headers: { cookie: `${GRANT_COOKIE}=${mint()}` },
    body: 'x=1',
  });
  assert.equal(res.status, 200);
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
