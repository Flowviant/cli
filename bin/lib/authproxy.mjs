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
 * Three things this file gets wrong easily, all of them fixed here and all of
 * them worth keeping fixed:
 *  - the credential must NOT reach the origin. `headers: req.headers` forwarded
 *    `authorization` verbatim, handing the gate password to whatever code the
 *    branch happens to be running. It is stripped now.
 *  - the comparison is over a secret, so it is constant-time over a digest
 *    rather than `===` over a string.
 *  - `stop()` was a bare `server.close()`, which refuses NEW connections and
 *    leaves live ones alone — so a held HMR websocket kept the page alive for
 *    the one most-engaged viewer after teardown. Live sockets are tracked and
 *    destroyed.
 */

import { createServer, request } from 'node:http';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

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
export function startAuthProxy({ targetPort, log, onAbuse }) {
  const user = 'preview';
  // 24 bytes → 32 url-safe chars. It was 9 bytes, chosen when this was an
  // opt-in convenience; it is the only thing between a public hostname and a
  // worktree now.
  const password = randomBytes(24).toString('base64url');
  const expected = 'Basic ' + Buffer.from(`${user}:${password}`).toString('base64');

  let failed = 0;
  let abused = false;
  const authed = (req) => {
    if (abused) return false;
    if (sameSecret(req.headers['authorization'], expected)) {
      failed = 0;
      return true;
    }
    // A bare GET with no header is the browser's first move on every load, and
    // it is answered with a 401 challenge — it is not an attempt.
    if (req.headers['authorization']) failed += 1;
    if (failed >= MAX_FAILED && !abused) {
      abused = true;
      log?.(`preview gate: ${failed} failed attempts — closing the share.`);
      try {
        onAbuse?.();
      } catch {
        /* the caller's teardown is best-effort */
      }
    }
    return false;
  };

  // The gate credential is OURS and stops here. Everything else is passed
  // through untouched: the origin is the driver's own dev server and rewriting
  // its request would be us editing their app's input.
  const forwardOpts = (req) => {
    const headers = { ...req.headers };
    delete headers.authorization;
    delete headers['proxy-authorization'];
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
    res.end('This preview is password-protected. Enter the password shown in Flowviant.');
  };

  // Every live socket, so stop() can actually end the ones already talking.
  const sockets = new Set();

  const server = createServer((req, res) => {
    if (!authed(req)) return challenge(res);
    const proxyReq = request(forwardOpts(req), (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
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
    if (!authed(req)) {
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
