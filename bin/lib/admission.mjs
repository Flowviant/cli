/**
 * MAY THIS MACHINE START ONE MORE CLI RIGHT NOW?
 *
 * One question, asked at every spawn point, answering `null` (go ahead) or
 * `{ reason }` — the machine's own measured sentence, relayed at the thing that
 * is waiting and nowhere else.
 *
 * ── WHY THIS EXISTS ──
 *
 * Flowviant froze somebody's computer. Three separate holes, all of them the
 * same shape — a bound that had been written down and then stopped being
 * enforced:
 *
 *   · `MAX_CONCURRENT` (config.mjs) is computed from the box's real memory and
 *     cores, sent to the server on every poll, and was enforced NOWHERE. Its
 *     local enforcement lived in the dispatch lane and was deleted with it; the
 *     comment claiming otherwise outlived the code by a month.
 *   · `processWorkTurns` had no slice, so every session turn the roster offered
 *     started in one tick.
 *   · agent turns start four per tick, forever, and nothing looked at memory
 *     before spawning a process that routinely holds gigabytes.
 *
 * ── WHAT THIS IS NOT ──
 *
 * It is not a capacity meter: nothing is published ahead of the decision, and
 * the only time anyone hears about it is the moment it actually fires.
 *
 * NARROWED 2026-09-17, knowingly. The effective ceiling now rides the poll as
 * `mt` and is shown in two places, and neither is a meter: project SETTINGS,
 * beside the control that sets it — a dial has to say what it is currently
 * worth or it is a control with no readout — and on the board ONLY while a real
 * agent is being deferred, which is the "at the thing that is waiting, in the
 * moment" carve-out this product already grants. What stays forbidden is the
 * resting global chip and any statement of HEADROOM: "room for N more" is still
 * dead, and the refusal below still names ACTIVITY and never the bound. It does
 * not kill anything — no signal is sent on Flowviant's initiative, ever. It
 * does not park an agent: a park needs a human gesture to lift, and pressure
 * clears on its own, so a deferral is simply a spawn that did not happen this
 * tick. And it never settles the job it defers — the server re-offers on the
 * next poll, which is the whole reason declining is safe.
 *
 * ── ORDER, AND WHY CAPACITY IS ASKED FIRST ──
 *
 * The count is ours and exact; the pressure reading is the box's and a couple
 * of seconds old. When both would refuse, the exact one is the honest sentence.
 *
 * The capacity reason DOES ride the roster's `pr` relay, and the clause here
 * used to say it must not — "four turns are running is activity, which the
 * board already shows". The board shows AGENTS; it has never shown a Workbench
 * turn or the wiki cartographer, both of which hold this ceiling, and the law
 * those words come from says the opposite of what they were used for: queueing
 * is said "AT THE THING THAT IS WAITING, in the moment, never budgeted for in
 * advance on a global chip". The sentence below names ACTIVITY and never the
 * ceiling, and it is relayed to exactly one place — the row that is stalled.
 * Withholding it meant the poll sent `pr=-`, i.e. MEASURED AND FINE, at the
 * precise moment the machine was refusing everything.
 *
 * ── THE COUNT MUST NOT GO STALE INSIDE A TICK ──
 *
 * Every spawn in this daemon is ASYNCHRONOUS and every lane loop is not: the
 * session-turn loop runs `inPlace(...)` per job without awaiting it, so the
 * child does not reach `workChildren` until a later microtask, and the loop
 * asked `liveTurnCount()` again on the very next line. The number could not
 * move, so `0 >= 1` was false eight times in a row and a box with a ceiling of
 * one started eight session turns, four agent turns, the planner and the wiki
 * sweep in a single reconcile — the guard biting only on the NEXT tick, after
 * the box was already loaded. That is the freeze this file exists to prevent,
 * re-armed and still open.
 *
 * A RESERVATION closes it. `admit.reserve()` is taken the moment a job is
 * admitted and released when its child registers (or when the job ends without
 * one), so the very next `admit` in the same tick counts the spawn that has
 * been decided on but not yet happened. It is the count made honest about the
 * future it has already committed to — not a queue, not a budget, and never
 * published: nothing outside this module can read the number.
 *
 * A LEAKED RESERVATION WOULD SHRINK THE CEILING FOREVER, so every caller
 * releases in a `finally` as well as at the spawn, and the release is
 * idempotent so doing both is the normal case rather than a bug.
 */

import { MAX_CONCURRENT, MAX_CONCURRENT_FROM_ENV } from './config.mjs';
import { pressureVerdict } from './resources.mjs';

/**
 * ── THE CEILING HAS THREE POSSIBLE AUTHORS (2026-09-17) ──
 *
 * The owner's box derived ONE, so every parallel agent serialized here with
 * nothing but a per-agent pulse line to explain it: "thats why i was
 * immediately confused. theres nothing telling me that i could only have one
 * agent on the board." His fix was to move the dial into the product — "it
 * shouldnt be a variable on the npx to make it friendly for non tech users. why
 * cant it be on the web interface?" — so the roster reply may now carry
 * `maxTurns`.
 *
 * THE ORDER IS ENV > SERVER > DERIVED, and the middle one is the new arrival:
 *
 *  · ENV WINS because an operator who typed `FLOWVIANT_MAX_CONCURRENT=2` at the
 *    box is stating their last word about their own machine, and a control they
 *    cannot see must not silently overrule it. This is the same posture the
 *    daemon keeps everywhere else it is handed an instruction: the app decides
 *    the product, the box decides the box.
 *  · THE SERVER'S DIAL beats the derivation because the app is where every
 *    decision in this product is made, and the derivation is a GUESS about
 *    hardware — a good one, but one a person looking at their own machine is
 *    entitled to overrule without opening a terminal.
 *  · THE DERIVATION is the resting state, and it is what a project that has
 *    never touched the dial gets. `null` — not 0, not NaN — is what "nobody
 *    said" looks like, so the fallback is reached by ABSENCE rather than by a
 *    sentinel number that could be mistaken for a bound.
 *
 * Pure, and exported, so the order can be proved without a server, a poll or a
 * box of any particular size.
 */
export function pickMaxTurns({ env = null, server = null, derived = 1 } = {}) {
  const clamp = (n) => {
    const v = Number(n);
    if (!Number.isFinite(v) || v < 1) return null;
    return Math.min(Math.floor(v), 32);
  };
  return clamp(env) ?? clamp(server) ?? clamp(derived) ?? 1;
}

/**
 * THE LAST NUMBER THE SERVER NAMED, or null.
 *
 * A module holder rather than a value threaded through `createWorkManager`,
 * because the reader and the writer are two files apart and one poll apart: the
 * POLL learns it (fleet.mjs) and every ADMISSION reads it, including the ones
 * work.mjs takes in lanes fleet.mjs never sees. The alternative — passing it
 * down — would mean the number that bound a spawn was whatever was current when
 * the manager was CONSTRUCTED, which is exactly the frozen-at-startup bug
 * `getBaseRef` and `getLeaseTtl` are getters to avoid.
 */
let serverMaxTurns = null;

/**
 * Record what the roster said. ANYTHING THAT IS NOT A USABLE NUMBER CLEARS IT,
 * and both directions of that matter:
 *
 *  · a MALFORMED value must not become a ceiling — `Number('')` is 0 and a
 *    ceiling of 0 refuses every spawn forever, which is a machine that has
 *    silently stopped working;
 *  · an ABSENT value is how "Auto" is spelled on the wire (the server simply
 *    does not send the key), and how an older SERVER looks. Both mean the
 *    derivation stands, so absence has to clear a value set by an earlier poll
 *    rather than leaving the last dial standing forever — otherwise turning the
 *    dial back to Auto would be unspellable.
 */
export function setServerMaxTurns(raw) {
  const v = Number(raw);
  serverMaxTurns = Number.isFinite(v) && v >= 1 ? Math.min(Math.floor(v), 32) : null;
  return serverMaxTurns;
}

/** THE NUMBER IN FORCE RIGHT NOW — read per admission, and reported to the app
 *  on the poll as `mt`, because it is the bound the refusal is about. */
export function effectiveMaxTurns() {
  return pickMaxTurns({
    env: MAX_CONCURRENT_FROM_ENV ? MAX_CONCURRENT : null,
    server: serverMaxTurns,
    derived: MAX_CONCURRENT,
  });
}

export function createAdmission({
  liveTurnCount,
  /** A NUMBER OR A FUNCTION. The function form is the live one: the ceiling can
   *  move between two polls now, so a value captured when the manager was built
   *  would be the dial as it stood at daemon start for the rest of the process.
   *  A number is still accepted, and every test here passes one — the whole
   *  point of injecting it. */
  maxConcurrent = effectiveMaxTurns,
  verdict = pressureVerdict,
} = {}) {
  /** Slots taken by a decision whose process does not exist yet. A Set of
   *  tokens rather than a counter: a double release then costs nothing, which
   *  is what lets a caller release at the spawn AND in its `finally`. */
  const holding = new Set();

  /** `level` is 'churn' (unattended lanes) or 'interactive' (a session turn
   *  somebody is watching). See pressureVerdict for why the two differ. */
  function admit(level) {
    const counted = Number(liveTurnCount?.() ?? 0);
    const live = (Number.isFinite(counted) ? counted : 0) + holding.size;
    /**
     * READ PER ADMISSION, and falling back to the DERIVED number rather than to
     * nothing. A ceiling that comes out NaN is not a permissive ceiling, it is
     * NO ceiling — `live >= NaN` is false every time — which is precisely the
     * unguarded spawn loop that froze somebody's computer. The local derivation
     * is the one value in this process that cannot be garbage.
     */
    const asked =
      typeof maxConcurrent === 'function' ? Number(maxConcurrent()) : Number(maxConcurrent);
    const ceiling =
      Number.isFinite(asked) && asked >= 1 ? Math.min(Math.floor(asked), 32) : MAX_CONCURRENT;
    if (live >= ceiling)
      return {
        reason: `the machine is already running ${live} CLI turn${live === 1 ? '' : 's'}`,
      };
    return verdict(level) ?? null;
  }

  /**
   * TAKE THE SLOT THIS ADMISSION JUST GRANTED, and hand back the release.
   *
   * Called only after `admit` has answered null, by every caller that then goes
   * on to spawn. It is deliberately a second call rather than something `admit`
   * returns: `admit` answers a QUESTION and several of its callers ask it in
   * places where nothing is about to be started.
   */
  admit.reserve = () => {
    const token = {};
    holding.add(token);
    return () => holding.delete(token);
  };

  /** For tests: slots taken and not yet released. Never relayed anywhere. */
  admit.reserved = () => holding.size;

  return admit;
}
