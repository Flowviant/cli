/**
 * ONE TURN'S TOKENS, ADDED UP ACROSS THE SPAWNS THAT MADE IT (2026-09-28).
 *
 * The agent lane SETS its usage — one spawn, one `result` — and leaves the
 * adding-up to the server. The Terminal tab, the capture chat and the wiki
 * are different: a tab turn whose resume came back empty runs a fresh retry
 * in the same turn, and BOTH spawns spent real tokens; reporting only the
 * second would under-count exactly the turns that went wrong. So those lanes
 * sum what each spawn reported before the one settle carries it.
 *
 * The wire shape is the agent lane's, unchanged: `{input, output,
 * cacheCreate, cacheRead, runtime}`. Null-safe on both sides — a spawn that
 * reported nothing adds nothing, and nothing reported at all stays null
 * (never four zeros: "spent nothing" is a claim nobody measured). Each counter
 * is coerced and floored the way `usageFromResult` reads the CLI's numbers.
 * The runtime is the first one named: one turn runs on one CLI.
 */
const n = (v) => {
  const x = Number(v);
  return Number.isFinite(x) && x > 0 ? Math.floor(x) : 0;
};

export function addUsage(a, b) {
  const has = (u) => Boolean(u) && typeof u === 'object';
  if (!has(a) && !has(b)) return null;
  const x = has(a) ? a : {};
  const y = has(b) ? b : {};
  const runtime = x.runtime ?? y.runtime;
  return {
    input: n(x.input) + n(y.input),
    output: n(x.output) + n(y.output),
    cacheCreate: n(x.cacheCreate) + n(y.cacheCreate),
    cacheRead: n(x.cacheRead) + n(y.cacheRead),
    ...(runtime ? { runtime } : {}),
  };
}
