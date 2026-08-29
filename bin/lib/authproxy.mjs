/**
 * The password gate in front of a shared preview. cloudflared → this proxy →
 * the dev server the DRIVER started in their own worktree.
 *
 * MANDATORY, not opt-in (2026-08-21). It was `.flowviant/preview.json`
 * "auth": true, defaulting OFF, and its caller logged "tunneling WITHOUT a
 * password" to a console nobody reads and opened the tunnel anyway. A tunnel
 * publishes a worktree holding the project's materialized dev secrets; there is
 * no honest default but closed. `startAuthProxy` returning null now means the
 * share is ABORTED and the machine says why.
 *
 * Minimal and dependency-free: forwards HTTP, and pipes WS upgrades (HMR) — the
 * browser re-sends the cached Basic-auth header on same-origin upgrades, so HMR
 * still authenticates.
 *
 * TWO DOORS SINCE 0.56.0. The password above is now the AUTOMATION path (curl,
 * Playwright, a native mobile client); the default for a human is a Flowviant
 * session. A cookie-less browser NAVIGATION is bounced to the app, which checks
 * the visitor is signed in and on the project and hands back an HMAC grant this
 * gate verifies offline (`grant.mjs`) before setting a cookie. Four rules that
 * fall out of that and must survive any edit:
 *
 *  - `/__fv/` IS RESERVED on this origin. The callback must be answered here,
 *    before the auth check (it is by definition the unauthenticated request
 *    that establishes authentication) and before forwarding (or the grant lands
 *    in the dev server's access log). The gate therefore stops being a pure
 *    pass-through, which is a deliberate, documented loss.
 *  - NEVER 302 A NON-NAVIGATION. A 302 is re-issued as GET and silently drops
 *    the body, so an unauthenticated POST from the previewed app would become a
 *    mystery GET instead of a visible 401. This is also exactly what keeps
 *    curl, Playwright and native clients on the password path.
 *  - NEVER 302 A WEBSOCKET UPGRADE. Browsers do not follow 3xx on an upgrade,
 *    they fail the connection — HMR would break in a way that looks like a dead
 *    dev server. A cookie-less upgrade stays a 401.
 *  - THE FRAME IS THE APP'S AND ONLY THE APP'S (0.72.0, and this reverses the
 *    old "cannot be embedded, the Workbench must not try" rule deliberately —
 *    the Workbench now DOES frame the share, so both halves are re-argued
 *    here). Two changes, one per blocker:
 *    (a) THE COOKIE. `SameSite=Lax` is kept for a top-level visit — it is the
 *        CSRF boundary and works in every browser ever shipped. A FRAMED
 *        navigation (`Sec-Fetch-Dest: iframe`) instead gets `SameSite=None;
 *        Partitioned` (CHIPS): partitioning keys the cookie to the top-level
 *        site that framed it, so evil.com framing this hostname gets its OWN
 *        empty jar, never the viewer's grant — which is why None here is not
 *        the CSRF hole it would be unpartitioned. Branching on Sec-Fetch-Dest
 *        rather than always sending both attributes matters: Safari 18.5–26.1
 *        DROPPED any Set-Cookie carrying `Partitioned` outright, so stamping it
 *        unconditionally would have broken the working top-level path on those
 *        builds. A browser too old to send Sec-Fetch-Dest gets Lax and the
 *        frame fails exactly as it always did — Open remains the escape.
 *        AND THE PARTITIONING CLAIM HAS A BACKSTOP, because one browser class
 *        breaks it: Chromium 76–113 (and same-vintage webviews/forks) sends
 *        Sec-Fetch-Dest — so it takes this branch — while ignoring the
 *        `Partitioned` attribute it has never heard of, storing a PLAIN
 *        unpartitioned SameSite=None cookie: the exact CSRF hole the sentence
 *        above says partitioning prevents. So `crossSiteAbuse` refuses a
 *        GRANT-authenticated request that Fetch Metadata marks cross-site
 *        unless it is a top-level GET/HEAD navigation (the Open link, the
 *        frame's own src). Every browser in the vulnerable class sends
 *        Sec-Fetch-Site (it shipped alongside Dest), a browser sending
 *        neither never got a None cookie in the first place, and the password
 *        path is exempt — Basic auth is never attached cross-site by a
 *        browser, so curl and Playwright feel nothing.
 *    (b) THE FRAME POLICY. In grant mode the forwarded response's frame policy
 *        is REWRITTEN to `frame-ancestors 'self' <app origin>` (origin taken
 *        from `authorizeUrl`, the one app fact this gate already holds). That
 *        permits exactly ONE cross-origin framer — the app the viewer is
 *        already authenticated to — instead of switching clickjacking
 *        protection off for everyone; enforced `frame-ancestors` outranks
 *        `X-Frame-Options` in every current engine, and the stripped XFO is
 *        the belt-and-braces for the rest. Password-only mode rewrites
 *        NOTHING: there is no app origin to allow and no cookie that could
 *        authenticate a frame, so the origin's own policy stands verbatim.
 *
 * Three things this file gets wrong easily, all of them fixed here and all of
 * them worth keeping fixed:
 *  - the credential must NOT reach the origin. `headers: req.headers` forwarded
 *    `authorization` verbatim, handing the gate password to whatever code the
 *    branch happens to be running. It is stripped now.
 *  - the comparison is over a secret, so it is constant-time over a digest
 *    rather than `===` over a string.
 *  - the grant cookie must be stripped from the forwarded request too, and
 *    ONLY ours: deleting the whole `cookie` header breaks the driver's own app,
 *    which legitimately owns its session cookies.
 *  - `stop()` was a bare `server.close()`, which refuses NEW connections and
 *    leaves live ones alone — so a held HMR websocket kept the page alive for
 *    the one most-engaged viewer after teardown. Live sockets are tracked and
 *    destroyed.
 */

import { createServer, request } from 'node:http';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { GRANT_COOKIE, cookieValues, safePathname, safeRelative, stripCookie, verifyGrant } from './grant.mjs';

/** Failed attempts before the proxy stops answering at all. A quick tunnel's
 *  hostname is unguessable, so this is not the primary control — it is what
 *  turns a discovered URL from an offline guessing target into a visible,
 *  self-closing incident. */
const MAX_FAILED = 25;

const digest = (s) => createHash('sha256').update(String(s)).digest();

/** Constant-time over sha256 digests, so length never leaks and a missing
 *  header costs the same as a wrong one. */
function sameSecret(a, b) {
  try {
    return timingSafeEqual(digest(a ?? ''), digest(b ?? ''));
  } catch {
    return false;
  }
}

/**
 * Start the gate in front of a dev server on `targetPort`. Resolves
 * { port, user, password, stop } — or NULL, which the caller must treat as a
 * hard failure. Binds loopback only; cloudflared connects locally, and the
 * password is what gates the public hostname.
 *
 * `onAbuse` fires once, after MAX_FAILED rejected attempts, so the caller can
 * tear the whole share down rather than leaving a URL under attack.
 */
export function startAuthProxy({ targetPort, log, onAbuse, grantSecret, shareId, authorizeUrl }) {
  // ALL THREE OR NONE. Two of the three is a gate that cannot bounce anybody:
  // a secret with no authorize URL has nowhere to send them, an authorize URL
  // with no secret cannot verify what comes back. An older SERVER sends none of
  // them, and that degrades to exactly today's behaviour — password only.
  // A MISSING SECRET MUST NEVER DEGRADE TO OPEN: the mandatory-gate invariant
  // above is unchanged, and a null return still aborts the share.
  const grants = Boolean(grantSecret && shareId && authorizeUrl);
  const user = 'preview';
  // 24 bytes → 32 url-safe chars. It was 9 bytes, chosen when this was an
  // opt-in convenience; it is the only thing between a public hostname and a
  // worktree now.
  const password = randomBytes(24).toString('base64url');
  const expected = 'Basic ' + Buffer.from(`${user}:${password}`).toString('base64');

  let failed = 0;
  let abused = false;
  /** The payload of the last validly-signed but EXPIRED grant seen, so a
   *  tester can be re-bounced with the token inside it. */
  let lastExpired = null;

  /**
   * A PURE CREDENTIAL PREDICATE — no method, no Accept, no path. That is what
   * lets the websocket upgrade handler reuse it verbatim, and it is why routing
   * decisions live in the request handler instead.
   *
   * Tristate-plus: 'ok' | 'none' | 'expired' | 'forged' | 'badpass'.
   */
  const credential = (req) => {
    if (abused) return 'badpass';
    if (sameSecret(req.headers['authorization'], expected)) {
      failed = 0;
      return 'ok';
    }
    // ONLY A WRONG PASSWORD COUNTS AS AN ATTEMPT, and this is a reason rather
    // than a preference. A forged HMAC is not brute-forceable, so counting it
    // buys nothing — while counting it would hand any stranger who finds the
    // hostname a 25-request KILL SWITCH on the owner's share, because onAbuse
    // tears the whole thing down. An expired-but-validly-signed grant must
    // never count either, or a viewer who left a tab open overnight closes the
    // share on their own reload. MAX_FAILED keeps its exact meaning, which is
    // also why the 'abuse' ended-reason sentence stays true.
    if (req.headers['authorization']) {
      failed += 1;
      if (failed >= MAX_FAILED && !abused) {
        abused = true;
        log?.(`preview gate: ${failed} failed attempts — closing the share.`);
        try {
          onAbuse?.();
        } catch {
          /* the caller's teardown is best-effort */
        }
      }
      return 'badpass';
    }

    if (!grants) return 'none';
    // EVERY value for our name, not the first — a duplicate must not shadow.
    for (const raw of cookieValues(req.headers.cookie, GRANT_COOKIE)) {
      const r = verifyGrant(raw, { secret: grantSecret, shareId });
      if (r.ok) return 'ok';
      if (r.reason === 'exp') {
        lastExpired = r.payload;
        return 'expired';
      }
    }
    return String(req.headers.cookie ?? '').includes(GRANT_COOKIE) ? 'forged' : 'none';
  };

  const authed = (req) => credential(req) === 'ok';

  /**
   * The CSRF backstop for the partitioned cookie (header rule 4a): a browser
   * old enough to ignore `Partitioned` while honouring `SameSite=None` will
   * attach the grant to cross-site requests, so a request that FETCH METADATA
   * says is cross-site is refused unless it is a plain navigation GET/HEAD —
   * the two shapes this product legitimately serves cross-site (the Open
   * link, the Workbench frame's own src; a rendered attacker frame is then
   * stopped by the frame-ancestors rewrite). Applies ONLY to grant-cookie
   * auth: a password in an Authorization header is never attached cross-site
   * by a browser, and clients that send no Sec-Fetch headers never held a
   * None cookie, so absence stays permitted.
   */
  const crossSiteAbuse = (req) => {
    if (String(req.headers['sec-fetch-site'] || '').toLowerCase() !== 'cross-site') return false;
    const mode = String(req.headers['sec-fetch-mode'] || '').toLowerCase();
    // Cross-site fetch/XHR/img/script with the cookie — nothing legitimate
    // looks like this: the framed app's own subresources are same-origin.
    if (mode && mode !== 'navigate') return true;
    // A cross-site POST navigation is the classic auto-submitted CSRF form.
    return !(req.method === 'GET' || req.method === 'HEAD');
  };

  /** True when THIS request authenticated with the password rather than the
   *  cookie — the credential class CSRF cannot ride. */
  const viaPassword = (req) => sameSecret(req.headers['authorization'], expected);

  /** The one app fact this gate holds: the origin allowed to frame us. Derived
   *  from `authorizeUrl` (server-built from PUBLIC_APP_URL) rather than a new
   *  wire field, so an older server changes nothing and no floor is needed. */
  let appOrigin = null;
  try {
    if (grants) appOrigin = new URL(authorizeUrl).origin;
  } catch {
    appOrigin = null;
  }

  /**
   * Replace the origin's frame policy with ours: `frame-ancestors 'self'
   * <app origin>`. Rules that must survive any edit:
   *  - REWRITE the directive inside an existing enforced CSP, never append a
   *    second policy beside it — multiple CSP headers intersect, so an origin
   *    `frame-ancestors 'none'` would still win over anything we added.
   *  - APPEND a policy holding only our directive when the origin stated no
   *    frame-ancestors at all — a public tunnel hostname deserves a frame
   *    policy even when localhost never needed one.
   *  - LEAVE Report-Only alone: browsers ignore frame-ancestors there, and
   *    rewriting a report channel would be editing the driver's telemetry.
   *  - DELETE X-Frame-Options: an enforced frame-ancestors makes every current
   *    engine ignore it anyway; deleting is for the stragglers.
   */
  const framePolicy = () => `frame-ancestors 'self' ${appOrigin}`;
  const rewriteFramePolicy = (headers) => {
    if (!grants || !appOrigin) return headers;
    const out = { ...headers };
    delete out['x-frame-options'];
    let sawDirective = false;
    // Node joins duplicate response headers with ', ', so one string can hold
    // SEVERAL policies (comma-separated), each holding several directives
    // (semicolon-separated). Split on BOTH levels or replacing a directive
    // eats the tail of a neighbouring policy — CSP source lists never contain
    // a comma, so the outer split is safe.
    const rewriteOne = (v) =>
      String(v)
        .split(',')
        .map((policy) =>
          policy
            .split(';')
            .map((part) => {
              if (/^\s*frame-ancestors(\s|$)/i.test(part)) {
                sawDirective = true;
                return ` ${framePolicy()}`;
              }
              return part;
            })
            .join(';')
        )
        .join(',');
    const csp = out['content-security-policy'];
    if (csp !== undefined) {
      out['content-security-policy'] = Array.isArray(csp) ? csp.map(rewriteOne) : rewriteOne(csp);
    }
    if (!sawDirective) {
      const existing = out['content-security-policy'];
      if (existing === undefined) out['content-security-policy'] = framePolicy();
      else out['content-security-policy'] = Array.isArray(existing) ? [...existing, framePolicy()] : [existing, framePolicy()];
    }
    return out;
  };

  // The gate credential is OURS and stops here. Everything else is passed
  // through untouched: the origin is the driver's own dev server and rewriting
  // its request would be us editing their app's input.
  const forwardOpts = (req) => {
    const headers = { ...req.headers };
    delete headers.authorization;
    delete headers['proxy-authorization'];
    // ONLY OURS. The driver's app owns its own cookies and breaks without them;
    // our grant is a signed bearer token and must not reach branch code.
    const rest = stripCookie(headers.cookie, GRANT_COOKIE);
    if (rest) headers.cookie = rest;
    else delete headers.cookie; // never send a bare empty `cookie:`
    return {
      host: '127.0.0.1',
      port: targetPort,
      method: req.method,
      path: req.url,
      headers,
    };
  };

  const challenge = (res) => {
    res.writeHead(401, {
      'WWW-Authenticate': 'Basic realm="Flowviant preview"',
      'Content-Type': 'text/plain',
      // A preview is a moving target by definition; nothing about it should sit
      // in a cache the viewer cannot see.
      'Cache-Control': 'no-store',
    });
    res.end(
      grants
        ? 'This preview needs a Flowviant session, or the automation password shown in Flowviant.'
        : 'This preview is password-protected. Enter the password shown in Flowviant.'
    );
  };

  // Every live socket, so stop() can actually end the ones already talking.
  const sockets = new Set();

  /** A top-level browser navigation, and nothing else. A 302 is re-issued as
   *  GET and drops the body, so bouncing a POST would turn an unauthenticated
   *  write into a mystery GET; and this is what keeps curl and native clients
   *  on the password path. */
  const isBrowserNav = (req) =>
    (req.method === 'GET' || req.method === 'HEAD') &&
    /text\/html/.test(req.headers.accept || '');

  const noStore = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };

  /** Send them to the app to be vouched for. The gate never names its own
   *  hostname: it sends the share id, and the SERVER builds the absolute
   *  callback from the URL it already stored — so the app never trusts a
   *  hostname supplied by the tunnel side. */
  const bounce = (req, res, verdict) => {
    const u = new URL(authorizeUrl);
    u.searchParams.set('s', shareId);
    u.searchParams.set('to', safeRelative(req.url));
    // Re-bounce a tester with the token that was inside their expired grant —
    // they no longer hold the original link, and the server re-checks the hash
    // ONLINE, which is what makes a tester link revocable at all.
    if (verdict === 'expired' && lastExpired?.k === 't' && lastExpired?.r) {
      u.searchParams.set('t', String(lastExpired.r));
      u.searchParams.set('x', '1');
    } else if (verdict === 'expired') {
      u.searchParams.set('x', '1');
    }
    res.writeHead(302, { Location: u.toString(), ...noStore });
    res.end();
  };

  /** The callback. Answered ENTIRELY here — it never touches the origin. */
  const handleCallback = (req, res) => {
    const u = new URL(req.url, 'http://x');
    const r = verifyGrant(u.searchParams.get('g'), { secret: grantSecret, shareId });
    // NOT a redirect: bouncing a failed callback back to the app is how you
    // build an infinite loop out of a clock skew.
    if (!r.ok) return challenge(res);
    const to = safeRelative(u.searchParams.get('to'));
    const maxAge = Math.max(0, r.payload.exp - Math.floor(Date.now() / 1000));
    // FRAMED means Partitioned (header rule 4a). Sec-Fetch-Dest survives the
    // whole redirect chain (it describes the navigation, not the hop), so the
    // callback sees `iframe` exactly when the Workbench is the one asking.
    const dest = String(req.headers['sec-fetch-dest'] || '').toLowerCase();
    const framed = dest === 'iframe' || dest === 'frame' || dest === 'embed' || dest === 'object';
    const site = framed ? 'SameSite=None; Partitioned' : 'SameSite=Lax';
    // The immediate 302 to a clean path is MANDATORY, not cosmetic: it takes
    // `?g=` out of the address bar, out of the Referer every subresource would
    // carry, and out of browser history. It cannot take it out of cloudflared's
    // access log — which is why the grant is short-lived and share-bound.
    res.writeHead(302, {
      'Set-Cookie': `${GRANT_COOKIE}=${r.raw}; Path=/; Secure; HttpOnly; ${site}; Max-Age=${maxAge}`,
      Location: to,
      ...noStore,
    });
    res.end();
  };

  const server = createServer((req, res) => {
    const path = safePathname(req.url);
    // 1. The callback, BEFORE the auth check and BEFORE any forwarding.
    if (grants && path === '/__fv/cb') return handleCallback(req, res);
    // 2. Reserve the prefix so nothing under it is ever proxied.
    if (path.startsWith('/__fv/')) {
      res.writeHead(404, { 'Content-Type': 'text/plain', ...noStore });
      res.end('not found');
      return;
    }
    // 3. One predicate.
    const verdict = credential(req);
    if (verdict !== 'ok') {
      if (grants && verdict !== 'badpass' && isBrowserNav(req)) return bounce(req, res, verdict);
      return challenge(res);
    }
    // 4. The grant is a cookie, and a cookie can be ridden (header rule 4a's
    // backstop). Never a bounce — the caller HAS a credential; the request
    // SHAPE is what is refused.
    if (grants && crossSiteAbuse(req) && !viaPassword(req)) {
      res.writeHead(403, { 'Content-Type': 'text/plain', ...noStore });
      res.end('cross-site request refused');
      return;
    }
    const proxyReq = request(forwardOpts(req), (proxyRes) => {
      // The one RESPONSE rewrite this gate performs (header rule 4b): the
      // frame policy. Everything else is the driver's own app talking.
      res.writeHead(proxyRes.statusCode || 502, rewriteFramePolicy(proxyRes.headers));
      proxyRes.pipe(res);
    });
    proxyReq.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('preview origin not reachable');
    });
    req.pipe(proxyReq);
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  // WS upgrade (HMR). The browser resends the Basic-auth header on same-origin
  // upgrades, so we gate it too, then pipe the two sockets together.
  server.on('upgrade', (req, socket, head) => {
    // Nothing under the reserved prefix is ever piped to the origin.
    if (safePathname(req.url).startsWith('/__fv/')) {
      socket.destroy();
      return;
    }
    // NEVER 302 HERE — browsers fail an upgrade rather than following a 3xx, so
    // a bounce would read as a dead dev server. The cookie IS sent on a
    // same-origin handshake, so `authed` works unchanged; a cookie-less upgrade
    // stays a 401 and the page's HMR client reconnects once the human has
    // re-authenticated in the main document.
    if (!authed(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm="Flowviant preview"\r\n\r\n');
      socket.destroy();
      return;
    }
    // The same cross-site backstop as the request path: a cookie-ridden
    // cross-site handshake (Sec-Fetch-Mode: websocket) is refused; the framed
    // app's own HMR socket is same-origin and never trips it.
    if (grants && crossSiteAbuse(req) && !viaPassword(req)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    const proxyReq = request(forwardOpts(req));
    proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
      const headerLines = Object.entries(proxyRes.headers).map(([k, v]) => `${k}: ${v}`);
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${headerLines.join('\r\n')}\r\n\r\n`);
      if (proxyHead && proxyHead.length) proxySocket.unshift(proxyHead);
      proxySocket.pipe(socket);
      socket.pipe(proxySocket);
      sockets.add(proxySocket);
      proxySocket.on('close', () => sockets.delete(proxySocket));
      proxySocket.on('error', () => socket.destroy());
      socket.on('error', () => proxySocket.destroy());
    });
    proxyReq.on('error', () => socket.destroy());
    if (head && head.length) proxyReq.write(head);
    proxyReq.end();
  });

  return new Promise((resolve) => {
    // Could not bind → the caller ABORTS the share. There is no no-proxy path
    // to fall back to any more.
    server.on('error', () => resolve(null));
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      log?.(`preview gate on :${port}`);
      resolve({
        port,
        user,
        password,
        // What was ACTUALLY installed, reported back so the app never asserts a
        // door nobody observed.
        gateMode: grants ? 'grant' : 'password',
        stop: () => {
          try {
            server.close();
          } catch {
            /* already closed */
          }
          // close() only stops NEW connections. An open HMR socket would keep
          // serving the viewer who is still looking at it.
          for (const s of sockets) {
            try {
              s.destroy();
            } catch {
              /* already gone */
            }
          }
          sockets.clear();
        },
      });
    });
  });
}
