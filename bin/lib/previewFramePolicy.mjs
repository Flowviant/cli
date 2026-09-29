/**
 * THE FRAME IS THE APP'S AND ONLY THE APP'S — the preview gate's frame rules,
 * as pure functions over headers. Split out of `authproxy.mjs` (SOLID SRP,
 * 2026-09-26): which browser may frame a share, and with which cookie
 * attribute, changes for browser-engine reasons that have nothing to do with
 * how the gate supervises sockets, so it gets one home the HTTP path imports
 * and a test that reads headers in and headers out with no server running.
 *
 * Two rules live here (header rules 4a and 4b in `authproxy.mjs`):
 *
 *  (a) THE COOKIE. `SameSite=Lax` is kept for a top-level visit — it is the
 *      CSRF boundary and works in every browser ever shipped. A FRAMED
 *      navigation (`Sec-Fetch-Dest: iframe`) instead gets `SameSite=None;
 *      Partitioned` (CHIPS): partitioning keys the cookie to the top-level
 *      site that framed it, so evil.com framing this hostname gets its OWN
 *      empty jar, never the viewer's grant — which is why None here is not
 *      the CSRF hole it would be unpartitioned. Branching on Sec-Fetch-Dest
 *      rather than always sending both attributes matters: Safari 18.5–26.1
 *      DROPPED any Set-Cookie carrying `Partitioned` outright, so stamping it
 *      unconditionally would break the working top-level path on those
 *      builds. A browser too old to send Sec-Fetch-Dest gets Lax and the
 *      frame fails exactly as it always did — Open remains the escape. The
 *      backstop for the browsers that ignore `Partitioned` is
 *      `crossSiteAbuse` in `previewGatePolicy.mjs`.
 *  (b) THE FRAME POLICY. In grant mode the forwarded response's frame policy
 *      is REWRITTEN to `frame-ancestors 'self' <app origin>` (origin taken
 *      from `authorizeUrl`, the one app fact this gate already holds). That
 *      permits exactly ONE cross-origin framer — the app the viewer is
 *      already authenticated to — instead of switching clickjacking
 *      protection off for everyone; enforced `frame-ancestors` outranks
 *      `X-Frame-Options` in every current engine, and the stripped XFO is
 *      the belt-and-braces for the rest. Password-only mode rewrites
 *      NOTHING: there is no app origin to allow and no cookie that could
 *      authenticate a frame, so the origin's own policy stands verbatim.
 */

/** The one app fact this gate holds: the origin allowed to frame us. Derived
 *  from `authorizeUrl` (server-built from PUBLIC_APP_URL) rather than a new
 *  wire field, so an older server changes nothing and no floor is needed.
 *  Null when the gate runs password-only (`grants` false) or the URL does not
 *  parse — and a null origin rewrites nothing. */
export function appOriginOf(grants, authorizeUrl) {
  let appOrigin = null;
  try {
    if (grants) appOrigin = new URL(authorizeUrl).origin;
  } catch {
    appOrigin = null;
  }
  return appOrigin;
}

/** FRAMED means Partitioned (rule (a) above). Sec-Fetch-Dest survives the
 *  whole redirect chain (it describes the navigation, not the hop), so the
 *  callback sees `iframe` exactly when the Workbench is the one asking. */
export function grantCookieSite(secFetchDest) {
  const dest = String(secFetchDest || '').toLowerCase();
  const framed = dest === 'iframe' || dest === 'frame' || dest === 'embed' || dest === 'object';
  return framed ? 'SameSite=None; Partitioned' : 'SameSite=Lax';
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
export function rewriteFramePolicy(headers, appOrigin) {
  if (!appOrigin) return headers;
  const framePolicy = () => `frame-ancestors 'self' ${appOrigin}`;
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
}
