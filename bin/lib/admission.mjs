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
 * the only time anyone hears about it is the moment it actually fires. It does
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

import { MAX_CONCURRENT } from './config.mjs';
import { pressureVerdict } from './resources.mjs';

export function createAdmission({
  liveTurnCount,
  maxConcurrent = MAX_CONCURRENT,
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
    if (live >= maxConcurrent)
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
