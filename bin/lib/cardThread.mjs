/**
 * A CARD'S DISCUSSION, AS THE WIRE HANDS IT OVER (0.106.0) — the owner,
 * 2026-09-27: "yes agents should read card comments".
 *
 * The server relays a card's thread (people's comments AND agents' own notes,
 * replies and delivery cards) onto the jobs that work or plan it:
 * `agentTurnJobs[].cardThread` (the one card a turn is about, named by
 * `taskId` and `title`) and `agentPlanJobs[].tasks[].thread`. Each is
 * `{ entries: [{ who, at, text }], omitted }`, oldest first — the newest run
 * of the thread that fits the server's budget, with `omitted` counting the
 * older entries it left out.
 *
 * THE WIRE IS NOT TRUSTED. The server bounded it (`CARD_THREAD_BUDGET` in the
 * app's agent-runner.schema.ts); this module reads it again, entry by entry,
 * and applies the SAME numbers — a copy the release gate holds to the server's
 * (`scripts/check-app-parity.mjs`, rule 5). A malformed entry is dropped
 * alone; a name or a time is one bounded line (a line break would forge a
 * second entry); a text past its cap is cut and marked; entries past the
 * budget are dropped from the OLDEST end and counted, so an agent is never
 * handed a thread that silently starts in the middle.
 *
 * Absent, empty or wholly malformed reads as null, and a null thread prints
 * NOTHING — which is why every prompt for a card nobody discussed (and every
 * job from a server older than 0.106.0) stays byte-identical.
 *
 * Pure data and pure functions: no imports, no environment, no I/O — prompts
 * imports it, and prompts is strings.
 */

/** The server's `CARD_THREAD_BUDGET`, row for row: a TURN reads one card, a
 *  PLAN glances at many. */
export const CARD_THREAD_BUDGET = Object.freeze({
  turn: Object.freeze({ entries: 30, chars: 6000, entryChars: 1500 }),
  plan: Object.freeze({ entries: 6, chars: 1200, entryChars: 400 }),
});
/** The server's `CARD_THREAD_WHO_MAX` — a name is a label. */
export const CARD_THREAD_WHO_MAX = 80;
/** The server's `CARD_THREAD_AT_MAX` — an ISO time, with room. */
export const CARD_THREAD_AT_MAX = 40;
/** A count is a number a prompt prints; past this it is not a count. */
const OMITTED_MAX = 1_000_000;

/**
 * THE MOST ONE TURN'S DISCUSSION CAN ADD TO A CARD SPEC, rendered — so the
 * spec stash (agentCards.mjs `MAX_SPEC_CHARS`) can hold a card with its
 * discussion whole, and the pre-review reads what the agent read. The text is
 * at most `chars`; the renderer adds at most two characters and a newline per
 * text line (<= 3x the text), a header line per entry, and two lines of its
 * own. `cardThread.test.mjs` renders the worst case against it.
 */
export const CARD_THREAD_RENDER_MAX =
  3 * CARD_THREAD_BUDGET.turn.chars +
  CARD_THREAD_BUDGET.turn.entries * (CARD_THREAD_WHO_MAX + CARD_THREAD_AT_MAX + 10) +
  200;

const oneLine = (v, max) => String(v).replace(/[\r\n]+/g, ' ').trim().slice(0, max);

/**
 * A thread off the wire, re-bounded at `budget`'s row ('turn' | 'plan'; an
 * unknown row is the tighter plan one), or null when there is nothing in it to
 * print. Never throws.
 */
export function readCardThread(raw, budget = 'turn') {
  const b = CARD_THREAD_BUDGET[budget] ?? CARD_THREAD_BUDGET.plan;
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.entries)) return null;
  const good = [];
  for (const e of raw.entries) {
    if (!e || typeof e !== 'object') continue;
    if (typeof e.who !== 'string' || typeof e.at !== 'string' || typeof e.text !== 'string') continue;
    const whole = e.text.replace(/\r\n?/g, '\n').trim();
    if (!whole) continue;
    good.push({
      who: oneLine(e.who, CARD_THREAD_WHO_MAX) || 'member',
      at: oneLine(e.at, CARD_THREAD_AT_MAX),
      text: whole.length > b.entryChars ? `${whole.slice(0, b.entryChars - 1)}…` : whole,
    });
  }
  // The newest contiguous run that fits — the server's own walk.
  const kept = [];
  let chars = 0;
  for (let i = good.length - 1; i >= 0 && kept.length < b.entries; i--) {
    if (chars + good[i].text.length > b.chars) break;
    chars += good[i].text.length;
    kept.push(good[i]);
  }
  if (kept.length === 0) return null;
  const sent = Number.isInteger(raw.omitted) && raw.omitted > 0 ? Math.min(raw.omitted, OMITTED_MAX) : 0;
  return { entries: kept.reverse(), omitted: sent + (good.length - kept.length) };
}
