/**
 * THE AGENT-TURN LANE: which offered turns run on this machine, and that each
 * one is settled exactly once.
 *
 * Since the 2026-09-26 SOLID pass (F036) this file is the coordinator and
 * nothing else. It admits a roster's turns against the machine's pressure,
 * re-POSTs a finished turn's held body instead of re-running its CLI, refuses
 * the turns no box should run (a traversal place, a card that is gone), takes
 * the agent's place lock as a WRITER, publishes the branch after the settle,
 * and settles everything in flight when the machine moves away. What it hands
 * off, each to the module named for it:
 *  - every POST and the held-body map: workAgentTurnReports.mjs
 *  - running one turn in its worktree: workAgentTurnExecution.mjs
 *  - the begun-guard: workAgentTurnBegun.mjs
 *  - what a finished (or failed) run reports: workAgentTurnOutcome.mjs
 *
 * The split exposed the defect it fixes: a run that THREW left its turn
 * unsettled, so the next offer ran it again. The lane now catches, measures
 * what the run had learned, and settles `nothing` once — unless the run had
 * already sent a settle, which always outranks the crash.
 */
import { existsSync } from 'node:fs';
import { isSafePathSegment } from './git.mjs';
import { c, note } from './ui.mjs';
import { createAgentTurnReports } from './workAgentTurnReports.mjs';
import { createAgentTurnExecution } from './workAgentTurnExecution.mjs';
import { failedTurnSettlement } from './workAgentTurnOutcome.mjs';

export function createWorkAgentTurns({
  REJECT_RETRY_MS,
  baseRef,
  inPlace,
  baseDir,
  repoRoot,
  fetchPublishedBranch,
  placeWtFor,
  sessionMetaPath,
  beforeArtifacts,
  getArtifactsAccepted,
  noteSessionGroup,
  reportSessionWorktree,
  artifacts,
  runReviewEntry,
  publishAgentBranch,
  admit,
  workChildren,
  agentPublished,
  agentRemoteAt,
  /** The turn's files, fetched into its worktree (workAttachments.mjs, 0.112.0). */
  fetchAgentFiles,
}) {
  const {
    postAgentTurn,
    postAgentTrace,
    postAgentActivity,
    postAgentParked,
    pruneHeldReports,
    agentReported,
    agentRejectedUntil,
  } = createAgentTurnReports({ REJECT_RETRY_MS });

  // ── AGENT TURNS: one task per prompt ───────────────────────────────────────
  //
  // An agent is one CLI in one worktree on one branch, working its cards ONE AT
  // A TIME. The server types the next prompt when this one lands; this side
  // does the work and reports what happened.
  //
  // NO MCP ON THIS TURN AT ALL. Everything the agent needs to say fits in its
  // final JSON object, and everything it needs to PROVE is measured from git
  // here afterwards — an agent naming its own commit shas would be a receipt
  // pointing at whatever it liked. That is also what keeps this feature from
  // adding a token kind to a scope map that has silently shipped empty twice.
  //
  // UNLEASED, unlike a plan or a kill. The server hands out at most one turn
  // per agent per poll and its settle is conditional on the row still being
  // pending, so a second daemon cannot advance the queue twice. What it could
  // do is run a CLI twice in one worktree. The in-flight set below cannot
  // prevent that alone: it is keyed by TURN id, so it never sees the
  // DIFFERENT turn the server's TTL-skip hands out while an expired turn's
  // CLI is still running — and a reader lock would run the two side by side.
  // So an agent turn takes its place's lock as a WRITER: an agent is ONE
  // process by definition, and its `a-<id>` place is its own — no tab ever
  // stands there, so the tabs' turns-run-concurrently law is untouched.
  const agentTurns = new Set(); // turn ids in flight on this tick
  /**
   * The CLI a live agent turn is running in, by PLACE.
   *
   * `workChildren` is keyed by the child itself, which answers "kill everything
   * at teardown" and cannot answer "kill THIS agent's". Keyed by place rather
   * than by agent id because the one consumer — the retire sweep — walks
   * directory names, and those are places.
   */
  const agentChildren = new Map(); // placeId -> child process

  const { runAgentTurnInPlace, commitsBetween } = createAgentTurnExecution({
    baseRef,
    baseDir,
    repoRoot,
    fetchPublishedBranch,
    placeWtFor,
    sessionMetaPath,
    beforeArtifacts,
    getArtifactsAccepted,
    noteSessionGroup,
    reportSessionWorktree,
    artifacts,
    runReviewEntry,
    workChildren,
    agentChildren,
    postAgentTrace,
    postAgentActivity,
    postAgentParked,
    fetchAgentFiles,
  });

  /** `releaseSlot` hands back the admission reservation the caller took on this
   *  turn's behalf, at the moment the CLI actually exists. Idempotent and
   *  optional — a caller with no reservation passes nothing. */
  const runAgentTurn = async (job, releaseSlot = () => {}) => {
    const turnId = String(job.id);
    const agentId = String(job.agentId || '');
    const place = String(job.placeId || '');
    if (!isSafePathSegment(place)) {
      await postAgentTurn({ turnId, outcome: 'nothing', answer: 'the machine was handed a turn for a place it will not use as a folder name' });
      return;
    }
    /**
     * A TASK TURN WITH NO CARD IS REFUSED, NOT IMPROVISED.
     *
     * The kickoff (workAgentTurnExecution.mjs) branches on `job.kind === 'task' && job.task` and falls
     * through to the HUMAN kickoff otherwise — and a task turn's body is empty
     * by design, because the daemon composes the prompt from the card's own
     * spec. So a card deleted while its agent held it spawned a real CLI on a
     * prompt whose entire content was "a member of this project said: (nothing).
     * Carry on, and end with the JSON object." Nothing on either side refused
     * it, and an ordinary gesture reached it: the board's Delete.
     *
     * The server now declines to hand out such a job at all. This is the
     * backstop, and it is worth having on its own: it costs one comparison and
     * it is the layer that cannot be skipped by a server on an older deploy.
     * `nothing` is the honest outcome — the agent goes to Stuck saying the turn
     * produced nothing, which is exactly what happened.
     */
    if (job.kind === 'task' && !job.task) {
      await postAgentTurn({
        turnId,
        outcome: 'nothing',
        answer: 'the card this turn was for no longer exists',
      });
      return;
    }

    /**
     * A RUN THAT THROWS IS STILL SETTLED — ONCE (SOLID F036).
     *
     * The run posts its own settle on every path it knows about. `settled`
     * records that one was SENT (delivered or held for re-POST, either way the
     * turn is answered), so a throw after it — the review-entry beat, say —
     * never posts a second, contradicting `nothing`. A throw before it is
     * settled here, with what the run had measured by then: the commits on the
     * branch, the spend, the branch and worktree. Through the same held-body
     * wire, so a failed POST is re-sent on the next offer and the CLI is not
     * run again.
     */
    const measured = { wt: null, before: null, branch: null, usage: null, model: null };
    let settled = false;
    const settleOnce = (body) => {
      settled = true;
      return postAgentTurn(body);
    };

    // A WRITER on the agent's own place — see the lane header. Only `a-<id>`
    // places: those are agents' by construction, and anything else here would
    // be a tab's directory, where a turn is a reader by the product's own law.
    await inPlace(place, place.startsWith('a-'), async () => {
      try {
        await runAgentTurnInPlace(job, { turnId, agentId, place, releaseSlot, postAgentTurn: settleOnce, measured });
      } catch (error) {
        if (settled) return;
        const commits = measured.wt ? commitsBetween(measured.wt, measured.before) : [];
        await postAgentTurn(
          failedTurnSettlement({
            turnId,
            error,
            commits,
            usage: measured.usage,
            model: measured.model,
            branch: measured.branch,
            wt: measured.wt,
          })
        );
      }
    });
    /**
     * …AND THEN PUBLISH, IF THE PROJECT PUBLISHES.
     *
     * AFTER the settle and OUTSIDE the place lock, both deliberately. A push is
     * a network call that can hang for its whole timeout, and it is worth
     * exactly nothing compared with the turn's answer: holding the settle
     * behind it would put a remote's bad day in front of the board, and holding
     * the writer lock through it would put the same delay in front of the next
     * turn.
     *
     * OUT HERE rather than beside any one settle, because `runAgentTurn` has
     * many ways to end and every one of them leaves a branch worth publishing —
     * including the refusals, where what is worth publishing is whatever an
     * earlier turn already committed. The paths with nothing to push say so by
     * having no local branch, which `publishAgentBranch` reads and skips.
     *
     * A REPORT ONLY WHEN SOMETHING CHANGED: an action that changes what the
     * machine would measure must cause a new measurement, and one that changed
     * nothing must not cost a write per turn restating it.
     *
     * …AND AN ABSENT TARGET IS AN INSTRUCTION TO FORGET. The sweep republishes
     * from `agentPublished`, which is this PROCESS's memory — so without the
     * else arm, an owner turning the switch off left every already-publishing
     * agent still pushing every commit it made for the life of the daemon, and
     * the settings copy promising "publishes nothing further" was false. A
     * 0.86.0 daemon only ever sees the key dropped because the project stopped
     * asking (`publishTargetForJob`), so forgetting is exactly what absence
     * means here; an agent nobody asked about has no entry, and the delete is a
     * no-op. It bounds the leak to the one sweep window between the switch and
     * the next settle.
     */
    try {
      if (!job.publishTo) {
        agentPublished.delete(place);
        agentRemoteAt.delete(place);
      } else if (await publishAgentBranch(place, job.publishTo)) {
        void reportSessionWorktree(place).catch(() => {});
      }
    } catch {
      /* publishing is tail work — it may never fail a turn that is already
         settled, whatever went wrong down there */
    }
  };

  const processAgentTurnJobs = (jobs) => {
    const list = Array.isArray(jobs) ? jobs : [];
    pruneHeldReports(list);
    /** One deferral line per tick, however many turns were offered. */
    let saidPressure = false;
    for (const job of list.slice(0, 4)) {
      const id = String(job?.id || '');
      if (!id || agentTurns.has(id)) continue;
      const held = agentReported.get(id);
      // A body the server REFUSED waits out its backoff — still held, so the
      // CLI is never re-run in the meantime.
      if (held && (agentRejectedUntil.get(id) ?? 0) > Date.now()) continue;
      if (held) {
        // Already RAN here; only the settle is outstanding. Re-POST the held
        // body — never the CLI, which would spend the operator's quota again
        // and write a second set of commits. The reply can still carry the one
        // instruction a settle can (`review: true`, the queue just emptied),
        // so the project's check and the AI pre-review run from here too, under
        // the same writer lock the turn itself would have held.
        agentTurns.add(id);
        void (async () => {
          const reply = await postAgentTurn(held.body);
          const place = String(job.placeId || '');
          const wt = typeof held.body.worktree === 'string' ? held.body.worktree : null;
          if (reply?.review === true && isSafePathSegment(place) && wt && existsSync(wt)) {
            await inPlace(place, place.startsWith('a-'), () =>
              runReviewEntry(String(job.agentId || ''), wt, job.agentName)
            );
          }
        })()
          .catch(() => {})
          .finally(() => agentTurns.delete(id));
        continue;
      }
      if (!job.agentId || !job.placeId) continue;
      /**
       * NOT NOW — and NOT SETTLED. An agent turn is the heaviest thing this
       * machine starts (a CLI with build permissions in its own worktree), and
       * four of them a tick with nothing looking at memory is how the daemon
       * froze somebody's computer.
       *
       * Deferring costs the job nothing. The handout DOES claim a lease (and
       * every poll's `renewAgentLeases` keeps it fresh), but the server judges
       * "begun" as activity PLUS a fresh lease — and nothing has run here, so
       * there is no activity to have relayed. A lease with no activity behind
       * it is exactly what lets the server end or re-queue this turn
       * correctly on its own expiry, with no attempt consumed by deferring.
       * Settling it here would be the opposite — it would send the agent to
       * Stuck over a turn this machine never ran.
       *
       * Checked here rather than inside `runAgentTurn` so a HELD BODY above
       * still re-POSTs: that path spawns nothing, and holding a finished
       * turn's settle because the box is busy would park an agent for the
       * server's whole expiry. One LOG line per tick, not per job — a console
       * restating one unchanged fact four times is noise.
       *
       * The DECISION, though, is per job and has to be: spawns in this loop are
       * async, so `workChildren` cannot grow between iterations and four turns
       * would all be admitted against the same stale count. The reserved slot
       * is what the next iteration sees. See admission.mjs.
       */
      const hold = admit('churn');
      if (hold) {
        if (!saidPressure) {
          saidPressure = true;
          note(`${c.cyan('agent')} ${c.dim(`— holding off: ${hold.reason}`)}`);
        }
        continue;
      }
      const releaseSlot = admit.reserve();
      agentTurns.add(id);
      void runAgentTurn(job, releaseSlot).finally(() => {
        // Belt for every path that never reached a spawn — the release is
        // idempotent, so the normal case releases twice.
        releaseSlot();
        agentTurns.delete(id);
      });
    }
  };

  /**
   * SETTLE EVERYTHING IN FLIGHT, because this process is about to go away.
   *
   * The one caller is the displacement stand-down: the project's machine moved
   * to another box, so nothing here will be re-offered to us and nothing else
   * knows these turns were running. An abandoned turn sits pending until the
   * server's six-hour expiry while the board shows an agent working on a machine
   * that has gone — the wedge every settle path in this lane exists to avoid.
   *
   * A HELD BODY OUTRANKS THE SENTENCE, and that is not an optimisation. A turn
   * whose CLI already FINISHED has a real answer queued (delivered, a question,
   * its commits); posting `nothing` over it would be this daemon lying about
   * work it actually did, and the settle is conditional on the row still being
   * pending, so whichever POST lands first is the one the board believes. The
   * held bodies are retried here for the same reason the commanded stop flushes
   * the tab queues: they exist only in this process.
   *
   * Bounded by what is in flight, and awaited by the caller behind a clock —
   * a wedged uplink must not hold the stand-down open.
   */
  const settleAgentTurns = async (sentence) => {
    const answer = String(sentence ?? '').slice(0, 1000);
    const posts = [];
    for (const turnId of agentTurns) {
      if (agentReported.has(turnId)) continue; // its own answer goes below
      posts.push(postAgentTurn({ turnId, outcome: 'nothing', answer }));
    }
    for (const [, held] of agentReported) posts.push(postAgentTurn(held.body));
    await Promise.allSettled(posts);
  };

  return { processAgentTurnJobs, settleAgentTurns, agentTurns, agentChildren, agentReported };
}
