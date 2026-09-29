/**
 * WHO GETS THROUGH THE PREVIEW GATE — the credential, abuse and cross-site
 * decisions, with no server in sight. Split out of `authproxy.mjs` (SOLID SRP,
 * 2026-09-26): these are security rules that change on their own schedule
 * (a threshold, a Fetch Metadata shape, a credential class), and the HTTP
 * request path and the WebSocket upgrade path must ask them IN THE SAME ORDER.
 * Before the split each transport spelled the order out by hand; now both ask
 * `admit(req)` and differ only in how they write the answer onto the wire
 * (a response vs raw bytes on an upgrade socket).
 *
 * `authproxy.mjs` still owns the server, the forwarding and the sockets; it
 * builds one `createGatePolicy` per share, which holds that share's failure
 * counts and the last expired grant seen.
 *
 * Two things this file gets wrong easily, both fixed here and both worth
 * keeping fixed:
 *  - the comparison is over a secret, so it is constant-time over a digest
 *    rather than `===` over a string (`sameSecret`, whose one home is
 *    `grant.mjs`).
 *  - ONLY a wrong Basic password counts as an attempt (see `credential`).
 */

import { GRANT_COOKIE, cookieValues, sameSecret, verifyGrant } from './grant.mjs';

/** Wrong-password attempts from ONE source before that source's Basic
 *  attempts are refused outright. A quick tunnel's hostname is unguessable,
 *  so this is not the primary control — but it is KNOWN to every past
 *  member, tester and password recipient, whose access cannot be recalled.
 *  The threshold is per source because one global counter made 25 wrong
 *  guesses from any URL holder a kill switch on everyone else's share. */
export const MAX_FAILED = 25;

/** Counted failures across ALL sources before the whole share tears down.
 *  The per-source block above answers a single abuser; this answers a
 *  DISTRIBUTED guessing run (addresses rotating to stay under MAX_FAILED
 *  each) — the original self-closing-incident property, kept at a threshold
 *  ordinary use cannot reach: a blocked source stops counting, so getting
 *  here takes eight independent sources each burning their full allowance. */
export const MAX_FAILED_TOTAL = 200;

/** Bound on the per-source map — a rotating attacker must not grow daemon
 *  memory without limit. Eviction is oldest-first and CAN un-block an evicted
 *  source, but cycling 500 fresh sources costs at least 500 counted failures,
 *  and the global backstop closes the share long before that. */
export const MAX_SOURCES = 500;

/** An Authorization header in the Basic scheme — the only shape the gate's own
 *  password ever arrives in, and so the only one it grades. */
export const isBasic = (v) => typeof v === 'string' && /^\s*basic(\s|$)/i.test(v);

/** cloudflared forwards the real client address in Cf-Connecting-Ip; a
 *  direct local connection (the machine's own curl, the tests) has only the
 *  socket. The header is attacker-writable in principle, but lying in it
 *  only SPREADS one attacker across per-source counters — which is exactly
 *  the shape MAX_FAILED_TOTAL exists to answer. */
export const sourceOf = (req) =>
  String(req.headers['cf-connecting-ip'] || req.socket?.remoteAddress || 'unknown');

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
 *
 * Why a backstop at all: Chromium 76–113 (and same-vintage webviews/forks)
 * sends Sec-Fetch-Dest — so it takes the framed-cookie branch — while
 * ignoring the `Partitioned` attribute it has never heard of, storing a PLAIN
 * unpartitioned SameSite=None cookie. Every browser in that class sends
 * Sec-Fetch-Site (it shipped alongside Dest), and a browser sending neither
 * never got a None cookie in the first place.
 */
export const crossSiteAbuse = (req) => {
  if (String(req.headers['sec-fetch-site'] || '').toLowerCase() !== 'cross-site') return false;
  const mode = String(req.headers['sec-fetch-mode'] || '').toLowerCase();
  // Cross-site fetch/XHR/img/script with the cookie — nothing legitimate
  // looks like this: the framed app's own subresources are same-origin.
  if (mode && mode !== 'navigate') return true;
  // A cross-site POST navigation is the classic auto-submitted CSRF form.
  return !(req.method === 'GET' || req.method === 'HEAD');
};

/** A top-level browser navigation, and nothing else. A 302 is re-issued as
 *  GET and drops the body, so bouncing a POST would turn an unauthenticated
 *  write into a mystery GET; and this is what keeps curl and native clients
 *  on the password path. */
export const isBrowserNav = (req) =>
  (req.method === 'GET' || req.method === 'HEAD') &&
  /text\/html/.test(req.headers.accept || '');

/**
 * One share's gate policy. `grants` says whether the grant door is installed
 * (all three of secret, share id and authorize URL arrived); `expected` is the
 * full `Basic …` header the automation password produces.
 *
 * `onAbuse` fires once, after MAX_FAILED_TOTAL rejected attempts across all
 * sources, so the caller can tear the whole share down rather than leaving a
 * URL under attack. A single source is blocked on its own, at MAX_FAILED,
 * without ending anybody else's share.
 */
export function createGatePolicy({ grants, grantSecret, shareId, expected, log, onAbuse }) {
  let failedTotal = 0;
  let abused = false;
  /** source → wrong-password count, insertion-ordered so eviction below is
   *  oldest-first. A source at MAX_FAILED is BLOCKED: its Basic attempts are
   *  refused BEFORE the comparison and stop counting toward the total. */
  const failedBySource = new Map();
  /** The payload of the last validly-signed but EXPIRED grant seen, so a
   *  tester can be re-bounced with the token inside it. */
  let lastExpired = null;

  const sourceBlocked = (req) => (failedBySource.get(sourceOf(req)) ?? 0) >= MAX_FAILED;

  const noteFailure = (req) => {
    const src = sourceOf(req);
    const count = (failedBySource.get(src) ?? 0) + 1;
    // Delete-then-set so Map insertion order tracks recency, making the
    // eviction below an LRU rather than "whoever failed first".
    failedBySource.delete(src);
    failedBySource.set(src, count);
    if (failedBySource.size > MAX_SOURCES) {
      failedBySource.delete(failedBySource.keys().next().value);
    }
    if (count === MAX_FAILED) {
      log?.(`preview gate: ${count} failed attempts from ${src} — refusing that source.`);
    }
    // MONOTONE, never reset by a success: a distributed run has no successes
    // to hide behind, and a legitimate share cannot reach the backstop —
    // every source stops counting at MAX_FAILED, so 200 needs eight distinct
    // sources each exhausting their own allowance.
    failedTotal += 1;
    if (failedTotal >= MAX_FAILED_TOTAL && !abused) {
      abused = true;
      log?.(`preview gate: ${failedTotal} failed attempts across sources — closing the share.`);
      try {
        onAbuse?.();
      } catch {
        /* the caller's teardown is best-effort */
      }
    }
  };

  /**
   * A PURE CREDENTIAL PREDICATE — no method, no Accept, no path. That is what
   * lets the websocket upgrade handler reuse it verbatim, and it is why routing
   * decisions live in the request handler instead.
   *
   * Tristate-plus: 'ok' | 'none' | 'expired' | 'forged' | 'badpass' | 'blocked'.
   */
  const credential = (req) => {
    if (abused) return 'badpass';
    // ONLY A WRONG PASSWORD COUNTS AS AN ATTEMPT, and this is a reason rather
    // than a preference. A forged HMAC is not brute-forceable, so counting it
    // buys nothing — while counting it would hand any stranger who finds the
    // hostname a kill switch on the owner's share, because onAbuse tears the
    // whole thing down. An expired-but-validly-signed grant must never count
    // either, or a viewer who left a tab open overnight closes the share on
    // their own reload.
    //
    // AND ONLY A *BASIC* HEADER IS A PASSWORD ATTEMPT (audit 2026-09-24). Any
    // Authorization header used to be graded against the gate password, so a
    // previewed SPA calling its own `/api` with `Authorization: Bearer …` was
    // answered 401 with a Basic challenge — over a valid grant cookie — and 25
    // such calls blocked that viewer, eight viewers tore the share down, and
    // the origin never saw its own header. A Bearer (or any other scheme) is
    // the APP's credential: it is not ours to grade and it rides through.
    //
    // A VALID GRANT COOKIE IS ASKED FIRST, for the same reason: an app that
    // itself speaks Basic sends a header that is not our password, and a
    // viewer the app has vouched for must not be graded on it. A grant is
    // HMAC-verified, so asking it first opens no brute-force path.
    let grantVerdict = 'none';
    if (grants) {
      // EVERY value for our name, not the first — a duplicate must not shadow.
      for (const raw of cookieValues(req.headers.cookie, GRANT_COOKIE)) {
        const r = verifyGrant(raw, { secret: grantSecret, shareId });
        if (r.ok) return 'ok';
        if (r.reason === 'exp' && grantVerdict === 'none') {
          lastExpired = r.payload;
          grantVerdict = 'expired';
        }
      }
      if (grantVerdict === 'none' && String(req.headers.cookie ?? '').includes(GRANT_COOKIE)) {
        grantVerdict = 'forged';
      }
    }

    if (isBasic(req.headers['authorization'])) {
      // A blocked source is refused BEFORE the comparison — a block that
      // still grades guesses would let the brute force run to a correct hit.
      if (sourceBlocked(req)) return 'blocked';
      if (sameSecret(req.headers['authorization'], expected)) {
        // Per-source only: a shared NAT recovers when one person behind it
        // gets the password right; failedTotal stays monotone (see above).
        failedBySource.delete(sourceOf(req));
        return 'ok';
      }
      noteFailure(req);
      return 'badpass';
    }
    return grantVerdict;
  };

  /** True when THIS request authenticated with the password rather than the
   *  cookie — the credential class CSRF cannot ride. */
  const viaPassword = (req) => sameSecret(req.headers['authorization'], expected);

  /**
   * THE ONE ADMISSION ORDER both transports ask: the credential first, then —
   * only for a caller who HAS one — the cross-site backstop. The grant is a
   * cookie, and a cookie can be ridden (header rule 4a's backstop); a
   * refusal there is never a bounce, because the caller has a credential and
   * the request SHAPE is what is refused.
   *
   * Returns the credential verdict ('blocked', 'none', 'expired', 'forged',
   * 'badpass'), 'cross-site', or 'ok'.
   */
  const admit = (req) => {
    const verdict = credential(req);
    if (verdict !== 'ok') return verdict;
    if (grants && crossSiteAbuse(req) && !viaPassword(req)) return 'cross-site';
    return 'ok';
  };

  return {
    admit,
    viaPassword,
    /** The payload of the last validly-signed but expired grant seen. */
    lastExpired: () => lastExpired,
  };
}
