/**
 * VERSION ORDER — the one parser and comparator every version decision on this
 * box uses: the takeover downgrade guard (instance.mjs), the self-update
 * signals (update.mjs, fleet.mjs), the behind marks in the read-only views
 * (views.mjs) and the newest nvm Node (loginPath.mjs).
 *
 * Split out (SOLID F005) because four hand-written rules disagreed on a
 * version they could not read: one called it EQUAL, one called each
 * unreadable part ZERO, one called it "not older", one never asked. A
 * comparison now answers UNKNOWN (`null`) out loud, and each caller states its
 * own policy for it. Every policy so far is the house one: unknown gates
 * nothing (the takeover guard refuses only a measured downgrade).
 *
 * What parses: an optional leading `v`, one to three dot-separated decimal
 * parts (a missing minor or patch reads as zero — `0.57` is `0.57.0`, the
 * legacy shape the update tests pin), and an optional `-prerelease`/`+build`
 * tail, which orders nothing (every rule this replaced ignored it too).
 * Anything else — a letter inside a part, a fourth part, an empty string — is
 * unknown.
 */
const VERSION_RE = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+][0-9A-Za-z.+-]*)?$/;

/** `[major, minor, patch]`, or null when the text is not a version. */
export function parseVersion(v) {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const m = VERSION_RE.exec(String(v).trim());
  if (!m) return null;
  const parts = [m[1], m[2] ?? '0', m[3] ?? '0'].map(Number);
  return parts.every(Number.isSafeInteger) ? parts : null;
}

/** -1 | 0 | 1, or null (UNKNOWN) when either side does not parse. */
export function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
  return 0;
}

/** True only when BOTH parse and `a` is strictly older. Unknown is not older. */
export const versionBelow = (a, b) => compareVersions(a, b) === -1;
