/**
 * Agent review entry — the one beat that runs the project check and then the
 * AI pre-review the moment an agent's queue empties.
 *
 * Only the SEQUENCING lives here (SOLID F039). The check (workAgentCheck.mjs)
 * and the pre-review (workAgentPrecheck.mjs) change for different reasons and
 * are built by the manager with only the dependencies each one uses; this
 * module is handed the two workers and owns the order and the no-throw rule.
 */

export function createWorkAgentReview({ runCheck, runPrecheck }) {
  /**
   * REVIEW ENTRY — everything this machine does the moment an agent's queue
   * empties, in one place.
   *
   * It exists so the two readings cannot drift apart at the three call sites
   * that own this beat (the settle reply, the held body's re-POST, and the
   * stale-merge re-read after base is folded in). Each of those used to call
   * `runCheck` directly; a second thing to run at the same moment is a second
   * thing three call sites can forget.
   *
   * THE CHECK FIRST, ALWAYS. It is a local command whose answer the board wants
   * on the row immediately; the pre-review is a model call that may take
   * minutes. Ordering them the other way would put a label behind a label.
   *
   * NEITHER MAY THROW PAST THIS POINT. Both are optional readouts and both run
   * INSIDE the place's writer lock on a path whose callers settle real work —
   * `runAgentMerge` in particular reports a claimed merge after this returns.
   */
  const runReviewEntry = async (agentId, wt, agentName) => {
    try {
      await runCheck(agentId, wt);
    } catch {
      /* the row keeps its previous check answer, which is null the first time */
    }
    try {
      await runPrecheck(agentId, wt, agentName);
    } catch {
      /* no pre-review is posted, and absence renders nothing */
    }
  };

  return { runReviewEntry };
}