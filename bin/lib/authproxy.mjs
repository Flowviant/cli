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
 *    (a) THE COOKIE. A top-level visit's grant cookie stays `SameSite=Lax`;
 *        a framed navigation gets a partitioned one. The attribute and its
 *        argument (CHIPS, the Safari Partitioned drop) live in
 *        `previewFramePolicy.mjs` (`grantCookieSite`); its CSRF backstop is
 *        `crossSiteAbuse` in `previewGatePolicy.mjs`. What stays here is only
 *        the server's own callback, which asks `grantCookieSite` with the
 *        request's `Sec-Fetch-Dest` when it sets the cookie.
 *    (b) THE FRAME POLICY. In grant mode the forwarded response's frame policy
 *        is REWRITTEN to `frame-ancestors 'self' <app origin>`; password-only
 *        mode rewrites NOTHING. The rule and its argument live in
 *        `previewFramePolicy.mjs` (`rewriteFramePolicy`).
 *
 * WHO GETS IN — the credential predicate, the per-source and global failure
 * counts, the cross-site backstop and the admission order both transports ask
 * — is `previewGatePolicy.mjs` (split out 2026-09-26, SOLID SRP). This file is
 * the server: it answers the callback, forwards HTTP, pipes upgrades and owns
 * every socket's lifetime.
 *
 * Three things this file gets wrong easily, all of them fixed here and all of
 * them worth keeping fixed:
 *  - the credential must NOT reach the origin. `headers: req.headers` forwarded
 *    `authorization` verbatim, handing the gate password to whatever code the
 *    branch happens to be running. It is stripped now.
 *  - the comparison is over a secret, so it is constant-time over a digest
 *    rather than `===` over a string (`sameSecret`, `grant.mjs`, asked by
 *    `previewGatePolicy.mjs`).
 *  - the grant cookie must be stripped from the forwarded request too, and
 *    ONLY ours: deleting the whole `cookie` header breaks the driver's own app,
 *    which legitimately owns its session cookies.
 *  - `stop()` was a bare `server.close()`, which refuses NEW connections and
 *    leaves live ones alone — so a held HMR websocket kept the page alive for
 *    the one most-engaged viewer after teardown. Live sockets are tracked and
 *    destroyed.
 */

import { createServer, request } from 'node:http';
import { randomBytes } from 'node:crypto';
import { GRANT_COOKIE, safePathname, safeRelative, stripCookie, verifyGrant } from './grant.mjs';
import { createGatePolicy, isBrowserNav } from './previewGatePolicy.mjs';
import { appOriginOf, grantCookieSite, rewriteFramePolicy } from './previewFramePolicy.mjs';

/**
 * Start the gate in front of a dev server on `targetPort`. Resolves
 * { port, user, password, stop } — or NULL, which the caller must treat as a
 * hard failure. Binds loopback only; cloudflared connects locally, and the
 * password is what gates the public hostname.
 *
 * `onAbuse` fires once, after MAX_FAILED_TOTAL rejected attempts across all
 * sources, so the caller can tear the whole share down rather than leaving a
 * URL under attack. A single source is blocked on its own, at MAX_FAILED,
 * without ending anybody else's share (`previewGatePolicy.mjs`).
 */
export function startAuthProxy({
  targetPort,
  // The address that reaches the ATTRIBUTED socket (listeners.mjs `originFor`)
  // — `::1` for a dev server bound to the IPv6 loopback. Defaults to the IPv4
  // loopback it always dialled, for a caller that measured nothing.
  targetHost = '127.0.0.1',
  log,
  onAbuse,
  grantSecret,
  shareId,
  authorizeUrl,
}) {
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

  // Who gets in, and this share's failure counts (`previewGatePolicy.mjs`).
  const policy = createGatePolicy({ grants, grantSecret, shareId, expected, log, onAbuse });
  // The one origin allowed to frame us, null in password-only mode
  // (`previewFramePolicy.mjs`).
  const appOrigin = appOriginOf(grants, authorizeUrl);

  // The gate credential is OURS and stops here. Everything else is passed
  // through untouched: the origin is the driver's own dev server and rewriting
  // its request would be us editing their app's input.
  const forwardOpts = (req) => {
    const headers = { ...req.headers };
    // Only when it IS the gate credential. Anything else in Authorization is
    // the previewed app's own (a Bearer to its API, its own Basic realm) and
    // the app breaks without it; ours must still never reach branch code.
    if (policy.viaPassword(req)) delete headers.authorization;
    delete headers['proxy-authorization'];
    // ONLY OURS. The driver's app owns its own cookies and breaks without them;
    // our grant is a signed bearer token and must not reach branch code.
    const rest = stripCookie(headers.cookie, GRANT_COOKIE);
    if (rest) headers.cookie = rest;
    else delete headers.cookie; // never send a bare empty `cookie:`
    return {
      host: targetHost,
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
    const lastExpired = policy.lastExpired();
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
    // FRAMED means Partitioned (header rule 4a, `previewFramePolicy.mjs`).
    const site = grantCookieSite(req.headers['sec-fetch-dest']);
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
    // 3. One admission, the same one the upgrade path asks.
    const verdict = policy.admit(req);
    // A blocked source gets 429, not the challenge — a WWW-Authenticate here
    // would invite the retry the block exists to end. Only that source's
    // Basic attempts are refused; every other viewer's share is untouched.
    if (verdict === 'blocked') {
      res.writeHead(429, { 'Content-Type': 'text/plain', ...noStore });
      res.end('too many failed attempts from this address');
      return;
    }
    // 4. The grant is a cookie, and a cookie can be ridden (header rule 4a's
    // backstop). Never a bounce — the caller HAS a credential; the request
    // SHAPE is what is refused.
    if (verdict === 'cross-site') {
      res.writeHead(403, { 'Content-Type': 'text/plain', ...noStore });
      res.end('cross-site request refused');
      return;
    }
    if (verdict !== 'ok') {
      if (grants && verdict !== 'badpass' && isBrowserNav(req)) return bounce(req, res, verdict);
      return challenge(res);
    }
    const proxyReq = request(forwardOpts(req), (proxyRes) => {
      // The one RESPONSE rewrite this gate performs (header rule 4b): the
      // frame policy. Everything else is the driver's own app talking.
      res.writeHead(proxyRes.statusCode || 502, rewriteFramePolicy(proxyRes.headers, appOrigin));
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
    // OWN THE SOCKET FROM THE FIRST LINE. Between this handler firing and the
    // origin's 101, the client socket had no 'error' listener — a browser
    // that RSTs mid-handshake (tab closed during HMR reconnect) emitted
    // 'error' with nobody listening, and an uncaughtException took the WHOLE
    // daemon down (2026-08 audit HIGH, reproduced on Node 24; closed
    // 2026-09-02). The post-101 block still swaps in the cross-destroy pair.
    socket.on('error', () => socket.destroy());
    // Nothing under the reserved prefix is ever piped to the origin.
    if (safePathname(req.url).startsWith('/__fv/')) {
      socket.destroy();
      return;
    }
    // NEVER 302 HERE — browsers fail an upgrade rather than following a 3xx, so
    // a bounce would read as a dead dev server. The cookie IS sent on a
    // same-origin handshake, so the predicate works unchanged; a cookie-less
    // upgrade stays a 401 and the page's HMR client reconnects once the human
    // has re-authenticated in the main document. A blocked source's Basic
    // handshake gets the same 429 the request path sends, and no challenge.
    const upgradeVerdict = policy.admit(req);
    if (upgradeVerdict === 'blocked') {
      socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
      socket.destroy();
      return;
    }
    // The same cross-site backstop as the request path: a cookie-ridden
    // cross-site handshake (Sec-Fetch-Mode: websocket) is refused; the framed
    // app's own HMR socket is same-origin and never trips it.
    if (upgradeVerdict === 'cross-site') {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    if (upgradeVerdict !== 'ok') {
      socket.write('HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm="Flowviant preview"\r\n\r\n');
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
