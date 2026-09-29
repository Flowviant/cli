/**
 * WHAT A TURN WHOSE CLI RAN REPORTS — decided off what was measured, never off
 * the agent's word alone.
 *
 * Split out of workAgentTurns.mjs (SOLID F036, 2026-09-26). The four settles
 * that follow a CLI (a limit, no declared outcome, a missing artifact, the
 * parsed result) are one decision with its own rules — a limit only when the
 * turn declared nothing, an artifact kind delivered only once its file is
 * measured, every relayed string scrubbed BEFORE it is cut — and the run that
 * feeds it (workAgentTurnExecution.mjs) changes for reasons none of those
 * rules share. Pure but for one read-only artifact scan, so each rule is a
 * unit test here instead of a source pin behind a CLI nobody spawns in tests.
 *
 * `failedTurnSettlement` is the fifth: a turn whose execution THREW. Its only
 * caller is the lane's catch (workAgentTurns.mjs), which measures what it can
 * and settles once, so a crash in the run can never leave a turn unsettled to
 * be re-offered and re-run on the operator's account.
 *
 * `agentTurnSettlement` returns `{ res, limit, body, final }`; the caller posts
 * `body` through the one turn-done wire, clears or sets the machine's limit off
 * `res`/`limit`, parks on `limit`, and runs the review-entry beat only after a
 * `final` settle.
 */
import { limitLine } from './cliLimit.mjs';
import { parseTurnResult } from './agentPlan.mjs';
import { changedArtifacts, scanArtifacts } from './artifacts.mjs';
import { scrub as envScrub } from './uplinkScrub.mjs';

export function agentTurnSettlement({ turnId, job, kind, out, lastAnswer, usage, model = null, commits, artifactsBefore, branch, wt }) {
  const res = (lastAnswer && parseTurnResult(lastAnswer)) || parseTurnResult(out);
  /**
   * A LIMIT IS ONLY A LIMIT WHEN THE TURN PRODUCED NOTHING.
   *
   * `limitLine` is a literal phrase match over the CLI's output, and the
   * output of a successful turn contains whatever the agent wrote — so a
   * card about rate limiting, or a summary mentioning one, parked every
   * agent on the project. Gating on "the turn declared no outcome" is what
   * makes the match mean what it says: the CLI failed and this is the
   * sentence it failed with.
   */
  const limit = res ? null : limitLine(out);
  /** What the caller posts, and whether it is the one settle that may say
   *  delivered (the only one whose reply can open the review-entry beat).
   *  Every one carries the model the CLI said it ran on, when it said
   *  (turnModel.mjs) — a turn that stopped still ran on something. */
  const report = (body, final = false) => ({ res, limit, body: model ? { ...body, model } : body, final });
  if (limit) {
    // The turn itself is reported as `nothing` — it did not deliver and it
    // did not ask. The park that goes with it is the caller's side effect
    // (workAgentTurnExecution.mjs): every agent on this CLI stops.
    return report({
      turnId,
      outcome: 'nothing',
      answer: limit,
      ...(usage ? { usage } : {}),
      branch,
      worktree: wt,
    });
  }

  if (!res) {
    return report({
      turnId,
      outcome: 'nothing',
      // The CLI's own words when it produced any. A turn that explained why
      // it stopped is far more use than "the agent stopped".
      answer: out.trim()
        ? envScrub(out).slice(-1500)
        : 'the turn produced no output on the machine — its CLI may be signed out',
      ...(commits.length ? { commits } : {}),
      ...(usage ? { usage } : {}),
      branch,
      worktree: wt,
    });
  }
  /**
   * A NON-CODE CARD IS NOT DELIVERED UNTIL ITS ARTIFACT EXISTS (0.97.0;
   * the 3D-model and presentation kinds 0.105.0) — measured, never taken on
   * the agent's word.
   *
   * Its product is under `.flowviant/artifacts/`, and the kind's table
   * (agentTaskKinds.mjs) says which file proves it: a `.html` mockup for
   * design, a `.html` deck, a `.md` write-up for research, and a `.html`
   * page for a 3D model (the model is built in it, 0.107.0). A turn that
   * says "delivered" without having written one would land the agent in Review
   * with nothing to look at and a summary describing a page that does not
   * exist — so it settles `nothing` with the measured sentence, and the
   * agent lands in Stuck with a true reason instead.
   *
   * WHAT COUNTS: on a TASK turn, only what the scan found NEW OR CHANGED
   * this turn (`changedArtifacts` against the snapshot taken before the
   * spawn) — a second design card in the same agent must not pass on the
   * first card's page. On a HUMAN turn (an answer, a send-back) a matching
   * file already standing in the directory also counts: "keep it as it
   * is" is a legitimate answer to a question the agent asked after
   * drawing, and the turn did not have to rewrite the page to deliver it.
   *
   * …AND ON A REDO (2026-09-23): a TASK turn re-running a card this agent
   * already delivered, which is what a send-back's "Needs work" queues —
   * the human turn in front of it usually rewrote the mockup already, so
   * the task turn that follows truthfully says "revised last turn" with
   * nothing new to write, and the task rule sent it to Stuck with a false
   * sentence. The server marks such a job `redo: true` (a link delivered
   * before, or carrying a `needs_work` verdict), and then a standing match
   * counts, as it does for a human turn. No floor: an older server never
   * sends the key, and absent keeps the stricter task rule.
   *
   * Commits are still reported if any exist — the posture prevents them,
   * and a report never lies by omission about what is on the branch.
   */
  if (res.outcome === 'delivered' && kind.artifact) {
    const want = kind.artifact.match;
    const has = (l) => l.some((e) => want.test(e.name));
    const standing = scanArtifacts(wt);
    const wrote = has(changedArtifacts(artifactsBefore, standing));
    const present = wrote || ((job.kind !== 'task' || job.redo === true) && has(standing));
    if (!present) {
      return report({
        turnId,
        outcome: 'nothing',
        answer: kind.artifact.missing,
        ...(commits.length ? { commits } : {}),
        ...(usage ? { usage } : {}),
        branch,
        worktree: wt,
      });
    }
  }
  return report(
    {
      turnId,
      outcome: res.outcome,
      answer: envScrub(res.answer ?? '').slice(0, 8000),
      ...(commits.length ? { commits } : {}),
      // SCRUBBED like the answer beside it: a raised card lands in the
      // project doc every member reads, and a brief quoting the `.env` the
      // agent just read ("value sk_live_… is logged in pay.ts") went out
      // verbatim while the same value in the summary was redacted.
      ...(res.raised?.length
        ? {
            raised: res.raised.map((r) => ({
              title: envScrub(r.title).slice(0, 300),
              ...(r.brief ? { brief: envScrub(r.brief).slice(0, 2000) } : {}),
            })),
          }
        : {}),
      ...(usage ? { usage } : {}),
      /**
       * THE AGENT'S RUNNING ACCOUNT OF THIS BRANCH (2026-09-22).
       *
       * The owner: "we should add a brief summary of what the agent has done
       * overall at the top that updates." A RELAY — the agent wrote it in its
       * own final JSON object and nothing here composes, narrows or infers
       * one. It rides only this settle, which is the one that follows a
       * PARSED result: the two `nothing` settles above it come from a turn
       * that declared no outcome at all, so there is no account to carry and
       * inventing one would be the machine speaking for the agent.
       *
       * SCRUBBED BEFORE IT IS CUT, the order that matters and the one the
       * check's output lane learned the expensive way: `envScrub` replaces
       * EXACT values, so a paragraph capped first hands the scrub a
       * credential already cut in half — it matches nothing and the surviving
       * prefix ships. `parseTurnResult` trims it and bounds it for absurdity
       * at 8000, DELIBERATELY above the 1000 below, so this slice is the
       * first one a value of any interest meets and the scrub has already
       * run when it does. The first cut of this feature bounded the parser at
       * 1000 as well, which read identically and quietly put the cap first.
       *
       * OMITTED WHEN THE TURN DID NOT WRITE ONE, never sent empty. Absence is
       * the server's signal to KEEP the last account that was true; an empty
       * string would blank the head because a model dropped a key.
       */
      ...(res.progress ? { progress: envScrub(res.progress).slice(0, 1000) } : {}),
      branch,
      worktree: wt,
    },
    true
  );
}

/**
 * A TURN WHOSE RUN THREW IS STILL SETTLED, ONCE, AS `nothing` (SOLID F036).
 *
 * Before this, a throw anywhere between the lock and the settle — base-branch
 * agent instructions over the turn's limit (`readBaseTools` throws), a tool
 * config that could not be prepared, a hook that failed after the CLI had
 * committed — escaped the lane with nothing posted. The turn stayed pending,
 * the agent sat in Working with nothing behind it, and every roster offer ran
 * the whole turn again until the six-hour expiry: past the CLI, that is a
 * second set of commits on the operator's quota, every poll.
 *
 * The sentence is the error's own words, SCRUBBED BEFORE IT IS CUT (a thrown
 * message can quote a path or an argv carrying a value). What the run measured
 * before it threw rides along: the commits already on the branch (a report
 * never lies by omission), the spend if the CLI counted one, and the branch
 * and worktree when a worktree existed. Nothing measured, nothing claimed.
 */
export function failedTurnSettlement({ turnId, error, commits = [], usage = null, model = null, branch = null, wt = null }) {
  // An Error's message, or a thrown string; anything else says nothing rather
  // than "[object Object]".
  const why = (typeof error === 'string' ? error : typeof error?.message === 'string' ? error.message : '').trim();
  return {
    turnId,
    outcome: 'nothing',
    answer: envScrub(
      why ? `This machine could not finish the turn: ${why}` : 'This machine could not finish the turn.'
    ).slice(0, 1500),
    ...(commits.length ? { commits } : {}),
    ...(usage ? { usage } : {}),
    ...(model ? { model } : {}),
    ...(wt ? { branch, worktree: wt } : {}),
  };
}
