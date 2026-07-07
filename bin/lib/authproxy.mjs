/**
 * Opt-in basic-auth reverse proxy for previews (`.flowviant/preview.json`
 * "auth": true). The public tunnel is otherwise a capability URL — anyone with
 * it reaches the running app. This gates it: cloudflared → this proxy → dev
 * server, with a generated password the app surfaces to the reviewer.
 *
 * Minimal + dependency-free: forwards HTTP, and pipes WS upgrades (HMR) — the
 * browser re-sends the cached Basic-auth header on same-origin upgrades, so HMR
 * still authenticates. If a proxy request fails the page just 502s; it never
 * touches the default (no-auth) preview path.
 */

import { createServer, request } from 'node:http';
import { randomBytes } from 'node:crypto';

/** Start the proxy in front of a dev server on `targetPort`. Resolves
 *  { port, user, password, stop }. Binds loopback only (cloudflared connects
 *  locally); the password is what gates the public tunnel. */
export function startAuthProxy({ targetPort, log }) {
  const user = 'preview';
  const password = randomBytes(9).toString('base64url'); // ~12 url-safe chars
  const expected = 'Basic ' + Buffer.from(`${user}:${password}`).toString('base64');
  const authed = (req) => req.headers['authorization'] === expected;

  const forwardOpts = (req) => ({
    host: '127.0.0.1',
    port: targetPort,
    method: req.method,
    path: req.url,
    headers: req.headers,
  });

  const server = createServer((req, res) => {
    if (!authed(req)) {
      res.writeHead(401, {
        'WWW-Authenticate': 'Basic realm="Flowviant preview"',
        'Content-Type': 'text/plain',
      });
      res.end('This preview is password-protected. Enter the password shown in Flowviant.');
      return;
    }
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

  // WS upgrade (HMR). The browser resends the Basic-auth header on same-origin
  // upgrades, so we can gate it too, then pipe the two sockets together.
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
      proxySocket.on('error', () => socket.destroy());
      socket.on('error', () => proxySocket.destroy());
    });
    proxyReq.on('error', () => socket.destroy());
    if (head && head.length) proxyReq.write(head);
    proxyReq.end();
  });

  return new Promise((resolve) => {
    server.on('error', () => resolve(null)); // couldn't bind → caller falls back to no proxy
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      log?.(`auth proxy on :${port} — preview is password-gated`);
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
        },
      });
    });
  });
}
