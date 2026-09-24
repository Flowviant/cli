/** Agent turns, trace delivery, admission, and held settlement reports. */
import { limitLine } from './workAgentReview.mjs';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FLEET_URL, FLEET_TOKEN, USER_AGENT } from './config.mjs';
import { git, isSafePathSegment } from './git.mjs';
import { parseTurnResult } from './agentPlan.mjs';
import { stashCard } from './agentCards.mjs';
import { c, note } from './ui.mjs';
import { runTurn } from './claude.mjs';
import { SYSTEM_AGENT_FOR, agentTaskKindOf, unknownAgentTaskKind, AGENT_TASK_KICKOFF, AGENT_TASK_SPEC, AGENT_HUMAN_KICKOFF, withProjectContext } from './prompts.mjs';
import { knowledgeDirFor } from './knowledge.mjs';
import { changedArtifacts, scanArtifacts } from './artifacts.mjs';
import { scrub as envScrub } from './env.mjs';
import { canRun, recordSkills, recordMcpServers, toolEventOf, CLAUDE_TOOL_PROSE_KINDS, RUNTIMES } from './runtimes.mjs';
import { makeTraceRelay } from './trace.mjs';

export function createWorkAgentTurns({
  REJECT_RETRY_MS,
  baseRef,
  inPlace,
  baseDir,
  repoRoot,
  fetchPublishedBranch,
  placeWtFor,
  sessionMetaPath,
  brainFor,
  beforeArtifacts,
  getArtifactsAccepted,
  noteSessionGroup,
  reportSessionWorktree,
  artifacts,
  runReviewEntry,
  publishAgentBranch,
  admit,
  state,
}) {
  const AGENT_TURN_DONE_URL = FLEET_URL.replace(/\/agents\/?$/, '/agent-turn-done');
  const AGENT_TRACE_URL = FLEET_URL.replace(/\/agents\/?$/, '/agent-trace');
  const AGENT_ACTIVITY_URL = FLEET_URL.replace(/\/agents\/?$/, '/agent-activity');
  const AGENT_PARKED_URL = FLEET_URL.replace(/\/agents\/?$/, '/agent-parked');

  const { workChildren, agentPublished, agentRemoteAt } = state;

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

  /** Returns the server's reply, because it carries ONE instruction the machine
   *  can act on immediately: `review: true` means the agent's queue just
   *  emptied, so run the project's own check in the worktree we are already
   *  standing in. A job lane for that would need a claim, a floor and a settle
   *  to say something this reply already can. */
  /**
   * Turns whose work is DONE but whose settle has not landed, keyed to the
   * finished BODY. The delivery half of what `pendingWorkReports` is for a
   * tab: a settle that fails to POST must not re-run the turn — that is a
   * second CLI, a second set of commits, and the operator's quota spent again
   * — but a guard that only SKIPPED left the other half undone. One failed
   * POST parked the agent for the server's whole six-hour expiry, holding a
   * cap slot the entire time, and then expired into "nobody ran it" — a false
   * sentence about a turn this machine finished. The server's settle is
   * idempotent (conditional on the row still being pending), so a re-offer of
   * a held turn re-POSTs the stored body instead: safe, and it lands the
   * moment the network heals rather than six hours later.
   *
   * BOUNDED by the roster itself: a held body's clock is refreshed while the
   * server keeps offering its turn, and once offering stops — settled by the
   * re-POST, or expired server-side — the grace below is all that keeps it.
   */
  const agentReported = new Map(); // turnId -> { body, at }
  const agentRejectedUntil = new Map(); // turnId -> earliest re-POST of a refused body
  const AGENT_REPORT_GRACE_MS = 30 * 60_000;

  const postAgentTurn = async (body) => {
    const turnId = String(body.turnId);
    agentReported.set(turnId, { body, at: Date.now() });
    try {
      const res = await fetch(AGENT_TURN_DONE_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${FLEET_TOKEN}`,
          'User-Agent': USER_AGENT,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(30_000),
        body: JSON.stringify(body),
      });
      const j = await res.json().catch(() => null);
      /**
       * ONLY A 2xx IS DELIVERED. The server answers an already-settled,
       * expired or unknown turn with 200 `{ settled: false }` — its only 4xx
       * are a body it could not parse (deploy skew) and auth, and an edge WAF
       * rule tripped by a summary that quotes an exploit string is a 403 from
       * in front of it. Each of those left the turn row PENDING, and dropping
       * the held body on them meant the next offer found nothing held and ran
       * the CLI again: a second set of commits and the operator's quota spent,
       * every poll, for six hours. The tab lane learned this as its 'reject'
       * class. So a refused body stays HELD — it is the skip-guard — and its
       * re-POST backs off instead of hammering a body the server just refused.
       */
      if (res.ok) {
        agentReported.delete(turnId);
        agentRejectedUntil.delete(turnId);
      } else if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
        agentRejectedUntil.set(turnId, Date.now() + REJECT_RETRY_MS);
      }
      return j?.data ?? null;
    } catch {
      // Unsettled — a network error, so the body STAYS held and the next
      // re-offer retries the POST rather than the CLI.
      return null;
    }
  };

  /**
   * ONE BATCH OF A TURN'S TRACE. See trace.mjs for the whole contract.
   *
   * Resolves TRUE for a permanent refusal as well as a success, and that is
   * deliberate: a server with no such route 404s every batch, and a relay that
   * held them would fill its buffer, shed the turn's real steps and retry the
   * same rejected body for the life of the turn. There is no version floor here
   * — this is a daemon→server report, so an older server simply never learns
   * the trace and the board renders what it always did.
   */
  const postAgentTrace = async (body) => {
    try {
      const res = await fetch(AGENT_TRACE_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${FLEET_TOKEN}`,
          'User-Agent': USER_AGENT,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(15_000),
        body: JSON.stringify(body),
      });
      return (
        res.ok ||
        (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429)
      );
    } catch {
      return false; // a blip — the same entries go again at the same seq
    }
  };

  /** How long the final flush may hold the settle. Bounded because the settle
   *  is the turn's contract and the trace is a readout: a wedged uplink costs
   *  the tail of a trace, never the answer behind it. */
  const TRACE_FINAL_FLUSH_MS = 8_000;

  const postAgentActivity = async (agentId, text) => {
    try {
      await fetch(AGENT_ACTIVITY_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${FLEET_TOKEN}`,
          'User-Agent': USER_AGENT,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(15_000),
        body: JSON.stringify({ agentId, text }),
      });
    } catch {
      /* narration is a readout; losing a line costs nothing */
    }
  };

  /** Every sha that landed on this branch between two points. Measured, never
   *  asserted — this is the whole reason an agent is not asked for its own. */
  const commitsBetween = (wt, from) => {
    if (!from) return [];
    /**
     * `--not <base>` and `--no-merges`, because `from..HEAD` alone reports
     * BASE'S commits as this turn's receipts the moment anything folds base in
     * — which the stale path does on purpose before a merge. A receipt naming
     * somebody else's commit is worse than a missing one.
     */
    /**
     * IT CANNOT THROW, and that guard is the whole point of it being here.
     *
     * `git()` throws on a non-zero exit, and `baseRef()` is built from the
     * project's Base branch setting — free text an owner types, never verified
     * against the remote. Point it at a branch with no tracking ref (`develop`
     * on a repo whose remote branch is `dev`) and this exits "fatal: ambiguous
     * argument". The throw escaped `runAgentTurn` AFTER the CLI had already run
     * the card, so `postAgentTurn` was never reached, the server never settled
     * the turn, and the next poll handed back the identical turn — the same
     * card re-run every poll for six hours, on the operator's shared account,
     * piling commits onto the review branch, silently.
     *
     * An unreadable range means we cannot MEASURE the receipts, which is a
     * smaller failure than not settling: the turn still reports, and ship-time
     * reconciliation books whatever no card claimed. Missing beats fabricated
     * and both beat a stall.
     */
    let out;
    try {
      out = git(['log', '--format=%H', '--no-merges', `${from}..HEAD`, '--not', baseRef()], wt);
    } catch {
      return [];
    }
    return typeof out === 'string'
      ? out.split('\n').map((x) => x.trim()).filter(Boolean).slice(0, 50)
      : [];
  };

  /** `releaseSlot` hands back the admission reservation the caller took on this
   *  turn's behalf, at the moment the CLI actually exists. Idempotent and
   *  optional — a caller with no reservation passes nothing. */
  const runAgentTurn = async (job, releaseSlot = () => {}) => {
    const turnId = String(job.id);
    const agentId = String(job.agentId || '');
    const place = String(job.placeId || '');
    if (!isSafePathSegment(place)) {
      await postAgentTurn({ turnId, outcome: 'nothing' });
      return;
    }
    /**
     * A TASK TURN WITH NO CARD IS REFUSED, NOT IMPROVISED.
     *
     * The kickoff below branches on `job.kind === 'task' && job.task` and falls
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

    // A WRITER on the agent's own place — see the lane header. Only `a-<id>`
    // places: those are agents' by construction, and anything else here would
    // be a tab's directory, where a turn is a reader by the product's own law.
    await inPlace(place, place.startsWith('a-'), async () => {
      /**
       * WORK THAT HAS BEGUN LIVES ON EXACTLY ONE BOX, AND THIS MAY NOT BE IT.
       *
       * A project has ONE machine credential and every device is handed the same
       * raw token, so two boxes can both be polling for the same agents. Nothing
       * pushes an agent's branch before approve, so a turn that has already run
       * somewhere has its worktree, its branch and its CONVERSATION on that box's
       * disk and nowhere else. `placeWtFor` cannot tell the difference: it finds
       * no directory, cuts a fresh `session/a-<id>` off base, and the CLI starts
       * with no memory of the card — a confident, context-free redo of work
       * somebody is in the middle of, on the operator's shared account, landing
       * on a rival branch of the same name.
       *
       * So: if the server says this agent has BEGUN and this box holds neither
       * its directory nor its branch, refuse before anything is cut. `nothing` is
       * the honest outcome — this machine did not run the turn — and the sentence
       * says what was measured (two absences here, and the box name only when the
       * server recorded one; inferring where the work is would be invention).
       *
       * THE BRANCH ALONE IS ENOUGH TO CONTINUE. `placeWtFor`'s attach fallback
       * re-attaches a worktree to a surviving branch, so a directory somebody
       * cleaned up on THIS box is same-box recovery of real committed work and
       * behaves exactly as it did before this guard existed.
       *
       * The remedy is the stop path and nothing else. "Reconnect the other
       * machine" is not reachable from here once holdership has moved, and a
       * remedy somebody cannot carry out is worse than none.
       */
      if (job.begun) {
        const wtDir = join(baseDir, 'sessions', place);
        let hasBranch = false;
        /**
         * THREE STATES, AND THE MIDDLE ONE IS WHY THIS IS NOT A BARE CATCH.
         *
         * `rev-parse --verify --quiet` exits 1 and prints nothing for a ref that
         * is not there — that exit code IS the measurement, and it is the one
         * this guard acts on. Any OTHER failure (128 for "not a repository",
         * ENOENT for no git at all, a momentary index lock) measured nothing;
         * collapsing it onto "the branch is absent" would make the daemon assert
         * "this machine does not hold this agent's branch" off a repo it could
         * not read — the guard inventing the very fact it exists to relay.
         *
         * So an unmeasured branch stands the guard DOWN. That re-enters the path
         * this guard is a belt for, which is the fail-open direction it wants;
         * `placeWtFor` is about to fail on the same unreadable repo and say so
         * in its own words, which is the honest sentence.
         */
        let branchMeasured = true;
        try {
          hasBranch = Boolean(
            git(['rev-parse', '--verify', '--quiet', `refs/heads/session/${place}`], repoRoot)
          );
        } catch (e) {
          if (e?.status === 1) hasBranch = false;
          else branchMeasured = false;
        }
        if (branchMeasured && !existsSync(wtDir) && !hasBranch) {
          /**
           * …UNLESS THE WORK IS ON THE REMOTE (0.86.0).
           *
           * The guard's premise was "nothing pushes an agent's branch before
           * approve", and a project that publishes has changed exactly that
           * third of it: the COMMITS are on `origin` under `flowviant/`, so a
           * box that holds neither the directory nor the branch can fetch them
           * and continue the work instead of redoing it. The other two thirds
           * are untouched — the conversation still does not move, which is why
           * the kickoff re-prompts from the card either way.
           *
           * The refusal below is still the fallback, and it is the fallback for
           * BOTH shapes of failure: a project that does not publish (no ref,
           * sentence unchanged) and a fetch that could not land (sentence
           * extended with git's own reason, because "this machine does not hold
           * it" alone would hide that we tried and how it went).
           */
          const fetched = fetchPublishedBranch(place, job.publishedRef);
          if (!fetched?.ok) {
            const on = typeof job.begunOn === 'string' && job.begunOn.trim()
              ? job.begunOn.trim().slice(0, 64)
              : null;
            await postAgentTurn({
              turnId,
              outcome: 'nothing',
              answer:
                `This machine does not hold this agent's worktree or branch${on ? ` — its work is on ${on}` : ''}. ` +
                'Stop the agent to re-plan it here.' +
                (fetched ? ` Its published branch could not be fetched (${fetched.why}).` : ''),
            });
            return;
          }
          // The branch is here and measured. `placeWtFor`'s attach fallback
          // opens a worktree on it below — the same path a directory somebody
          // cleaned up already takes, on commits this box now genuinely holds.
        }
      }
      const dir = placeWtFor(place);
      if (!dir) {
        // No worktree and none could be cut. `nothing` rather than an invented
        // error: the board says the machine went quiet, which is true.
        await postAgentTurn({ turnId, outcome: 'nothing' });
        return;
      }
      const wt = dir.wt;
      /**
       * NEITHER OF THESE MAY THROW. `git()` throws on a non-zero exit, and both
       * of these exit non-zero in states a real worktree reaches: `symbolic-ref`
       * on a DETACHED HEAD (an agent that ran `git checkout <sha>`, a rebase
       * left half-done), and `rev-parse HEAD` on a branch with no commits yet.
       * An escape here happens BEFORE any settle, so the turn stays pending
       * until the six-hour expiry while the agent sits in Working with nothing
       * behind it — the wedge this whole lane exists to avoid.
       *
       * `runAgentMerge` learned this two commits ago and says so in its own
       * comment; this is the same call, in the same file, left unguarded. Both
       * facts are OPTIONAL to a turn — they describe the branch, they do not
       * gate the work — so failing to read them costs a null, not the turn.
       */
      const readGit = (args) => {
        try {
          return (git(args, wt) || '').trim() || null;
        } catch {
          return null;
        }
      };
      // WHERE THE BRANCH WAS BEFORE THIS TURN, so the commits reported are the
      // ones this turn actually made.
      const before = readGit(['rev-parse', 'HEAD']);
      const branch = readGit(['symbolic-ref', '--quiet', '--short', 'HEAD']);

      const rt = job.runtime || 'claude';
      /**
       * WHAT THIS CARD HANDS BACK, AND THE POSTURE THAT FOLLOWS (0.97.0).
       *
       * `code` (the default — absent on the job IS code) is the build turn,
       * byte-for-byte what every agent turn was. `design` and `research` run
       * their own contract (SYSTEM_AGENT_DESIGN / _RESEARCH) under their own
       * posture, which can write ONLY `.flowviant/artifacts/` (claude.mjs).
       *
       * A RUNTIME THAT CANNOT EXPRESS THE POSTURE IS REFUSED, NOT IMPROVISED.
       * Codex and antigravity declare neither (runtimes.mjs), and the only
       * alternative to refusing is running the card as a BUILD turn with
       * permissions skipped — an agent writing code for an ask that was a
       * mockup, reporting success. `nothing` puts the agent in Stuck saying so.
       *
       * THE JOB'S OWN KIND FIRST (2026-09-23). A `human` turn — a send-back
       * from the review deck, an answer — usually names NO card: the queue has
       * emptied, or the card it is about was just re-queued behind it. Read off
       * `job.task` alone, a send-back on a design agent ran as a BUILD turn
       * under the code contract with permissions skipped — the one turn in the
       * owner's loop ("iterate in the review column, the agent opened") that
       * could edit code on an ask that was a mockup. So the server projects the
       * kind of the card the turn is ABOUT onto the job itself (`taskKind`,
       * sent only for design and research; the same `DAEMON_TASK_KIND_MIN`
       * floor as the card's own key, no new one), and the card's key stays the
       * fallback for a server that sends only that. Absent on both is code.
       */
      /**
       * A KIND THIS DAEMON DOES NOT KNOW IS REFUSED, NEVER BUILT (2026-09-23).
       * `agentTaskKindOf` reads anything unrecognised as code — right for a
       * printed label, wrong here, where code means the build posture with
       * permissions skipped. A server that learned a fourth kind ahead of
       * this daemon is exactly the case the version floor cannot cover (the
       * handout does not re-check it), and the answer is an update, said in
       * the word the server used. `nothing` puts the agent in Stuck with it.
       */
      const strangeKind = unknownAgentTaskKind(job.taskKind ?? job.task?.taskKind);
      if (strangeKind !== null) {
        await postAgentTurn({
          turnId,
          outcome: 'nothing',
          answer: `this daemon does not know the card kind '${strangeKind}' — update it`,
          branch,
          worktree: wt,
        });
        return;
      }
      const taskKind = agentTaskKindOf(job.taskKind ?? job.task?.taskKind);
      const posture = taskKind === 'code' ? 'build' : taskKind;
      if (!canRun(RUNTIMES[rt], posture)) {
        await postAgentTurn({
          turnId,
          outcome: 'nothing',
          answer:
            posture === 'build'
              ? `this machine cannot run ${rt}`
              : 'design and research cards run on Claude on this machine',
          branch,
          worktree: wt,
        });
        return;
      }

      // ONE AGENT IS ONE DIRECTORY, so the CLI's own cwd-keyed resume is exactly
      // right here — the ambiguity that forced per-tab session pinning in the
      // Workbench (many tabs, one place) cannot arise. The marker is what
      // distinguishes the first turn from every later one across restarts.
      const ranMarker = sessionMetaPath(wt, 'flowviant-agent-ran');
      /**
       * RESUME IS CLAUDE-ONLY, and that is a correctness rule rather than a
       * preference. Claude's `--continue` is CWD-keyed and one agent is one
       * directory, so it resumes exactly this agent. Codex's `resume --last` is
       * MACHINE-GLOBAL: it would cross-resume whichever conversation spoke most
       * recently anywhere on the box, which is the bug the Workbench fixed in
       * 0.69.0 by pinning per-tab ids. Until an agent pins its own thread id,
       * a codex agent starts fresh each turn — a worse turn, not a wrong one.
       */
      const resume = rt === 'claude' && Boolean(ranMarker && existsSync(ranMarker));

      /**
       * WRITE THE CARD DOWN BEFORE HANDING IT OVER — the material the AI
       * pre-review reads at review entry (see agentCards.mjs).
       *
       * HERE rather than at review entry because here is the ONLY moment this
       * machine holds the card at all: the server feeds an agent one card per
       * prompt and keeps no copy on this disk, so by the time the queue empties
       * card one exists locally as nothing but its own commit messages — which
       * are a claim about the work, not the specification it was judged against.
       *
       * BEFORE the CLI runs rather than after, so a turn that crashes still
       * leaves the spec behind: the card really was given to the agent, the
       * commits it made are on the branch, and a reviewer is entitled to read
       * what was asked for either way.
       *
       * ONE SPEC BUILDER (`AGENT_TASK_SPEC`) shared with the kickoff below, so
       * what the reviewer reads is byte-identical to what the agent read.
       * Failure is swallowed inside `stashCard`: a note about a turn may never
       * cost the turn.
       */
      if (job.kind === 'task' && job.task) {
        stashCard(
          sessionMetaPath(wt, 'flowviant-agent-cards', agentId),
          job.task.id,
          AGENT_TASK_SPEC(job.task)
        );
      }

      /**
       * THE WHOLE STREAM, not just its latest line — see trace.mjs.
       *
       * The pulse below is untouched and still sent: it carries staleness (how
       * long the machine has been quiet), which an append-only list of steps
       * cannot say, because a list that stopped growing looks exactly like a
       * list that is finished.
       */
      const trace = makeTraceRelay({
        agentId,
        turnId,
        post: postAgentTrace,
        scrub: envScrub,
      });
      /**
       * Prose the structured event will carry anyway, dropped so a read does
       * not render twice — but ONLY on a runtime whose stream reaches
       * `onToolEvent` at all. Codex and agy have their own parsers and never
       * call it, so dropping their tool prose would blank their agents' traces.
       * `parse: null` is exactly the claude.mjs stream path. See
       * CLAUDE_TOOL_PROSE_KINDS.
       */
      const doubledKinds = RUNTIMES[rt]?.parse ? null : CLAUDE_TOOL_PROSE_KINDS;

      /**
       * WHICH BRAIN THIS CONTAINER WAS PINNED TO — the same `brainFor` the tab
       * lane runs, on the same two job keys, because an agent turn and a
       * session turn differ in who is watching and in nothing else that a model
       * name touches. Every guard lives in `brainFor`: a second copy here would
       * be a second answer to "is this a model we can spell", and the two would
       * drift the first time one of them learned a new effort.
       *
       * Absent stays genuinely absent — an agent nobody pinned produces the
       * byte-identical argv it produced yesterday, on the machine's own
       * default. That is also what an OLDER server yields, since it sends
       * neither key.
       */
      const brain = brainFor(job);

      let out = '';
      let child = null;
      /**
       * WHAT THIS TURN SPENT, AS THE CLI COUNTED IT (2026-09-19).
       *
       * Held across the whole turn so every settle below can carry it — a turn
       * that hit a limit, produced no parseable outcome or delivered properly
       * all spent real tokens, and a readout that only charged the happy path
       * would under-report the runs somebody opens the number to understand.
       *
       * The three settles it is spread into are the ones that follow a CLI
       * actually running. The pre-spawn refusals above (a bad place, a missing
       * card, the begun-guard) and the teardown sweep below deliberately do NOT
       * take it: nothing ran there, and `usage` stays null anyway, which is
       * what makes `...(usage ? … : {})` the whole guard.
       */
      let usage = null;
      /** The agent's artifact directory as it stood before this turn — the
       *  tab lane's rule, in the agent's own worktree (2026-09-22). */
      const artifactsBefore = beforeArtifacts(wt);
      try {
        out = await runTurn({
          prompt:
            job.kind === 'task' && job.task
              ? AGENT_TASK_KICKOFF({
                  agentName: job.agentName,
                  task: job.task,
                  position: job.position ?? 1,
                  total: job.total ?? 1,
                })
              : AGENT_HUMAN_KICKOFF({
                  agentName: job.agentName,
                  message: job.body ?? '',
                  askedByName: job.askedByName,
                  task: job.task,
                  position: job.position ?? 1,
                  total: job.total ?? 1,
                }),
          // The knowledge paragraph, when this box holds a library — the same
          // composer the tabs use, so an agent and a tab can never be told two
          // different things about the same directory.
          system: withProjectContext(SYSTEM_AGENT_FOR(taskKind), {
            knowledgeDir: knowledgeDirFor(repoRoot),
            // ARTIFACTS (0.94.0), while the server can show one — an agent's
            // land on its page, under the facts row.
            artifacts: getArtifactsAccepted(),
          }),
          knowledgeDir: knowledgeDirFor(repoRoot),
          // Named only for the two non-code kinds; a code turn passes nothing
          // and keeps the build branch it always had.
          ...(posture !== 'build' ? { posture } : {}),
          cwd: wt,
          runtime: rt,
          resume,
          // Present only when the container named one — see brainFor.
          ...brain,
          streamJson: true,
          answerFromResult: true,
          label: c.cyan('[agent]'),
          // The CLI's own tail, relayed. Throttled by the same rule the tab's
          // narrator keeps: overwritten, never appended, and ignored by the
          // board past ~90 seconds.
          onActivity: (a) => {
            const line = a?.label;
            if (!line) return;
            // THE TRACE TAKES EVERY LINE; the pulse takes one every two
            // seconds. Two channels, one stream, and the drop-sampler stays a
            // drop-sampler — buffering the pulse would make a stale line look
            // fresh, which is the one thing it exists to answer.
            //
            // …AND THE TRACE TAKES THE WHOLE LINE. `label` is a 160-char
            // console readout; `full` is what the CLI actually said, when the
            // parser had more than the label could hold (see runtimes.mjs).
            // The fallback is not a degradation — it is what every activity
            // without a fuller form carries, and what an entire pre-0.87.0
            // daemon carried for all of them. The PULSE below is deliberately
            // still `line`: it is one overwritten line on a board, and a
            // paragraph there would be a paragraph nobody can read.
            if (!doubledKinds || !doubledKinds.has(a.kind)) trace.prose(a.kind, a.full ?? line);
            const now = Date.now();
            if (now - (lastAgentBeat.get(agentId) ?? 0) < 2_000) return;
            lastAgentBeat.set(agentId, now);
            void postAgentActivity(agentId, envScrub(String(line)).slice(0, 400));
          },
          // The structured twin of the line above — the same `tool_use` the
          // Workbench's tool cards are built from, scrubbed at collection by
          // the builder itself (bounded window BEFORE its caps; see
          // toolEventOf). A tool it does not know pushes nothing.
          onToolEvent: (name, input) => {
            trace.tool(toolEventOf(name, input, wt, envScrub));
          },
          // The CLI's own per-turn token counts, off the `result` event. One
          // result per turn, so this is a set and not an accumulate — the
          // adding-up happens SERVER-side, behind the settle's idempotent win,
          // because a retried settle must not charge the same turn twice.
          onUsage: (u) => {
            usage = u;
          },
          // WHAT THE CLI SAYS IT CAN BE ASKED FOR, AND WHICH CONNECTORS NEED A
          // LOGIN — the same free fact off the same init event the tab lane
          // records (2026-09-23). Without it a box that only ever runs agents
          // taught the app its skills and connectors ONCE, from the startup
          // probe, and never again: a connector signed into at the box kept
          // reading "needs authorization" for the life of the process.
          onInit: (i) => {
            recordSkills(i.skills);
            recordMcpServers(i.mcpServers);
          },
          onSpawn: (ch) => {
            child = ch;
            // The AGENT it serves — what the machine snapshot charges this
            // child's memory to.
            workChildren.set(ch, agentId);
            // …and the registry now counts what the reservation was standing
            // in for.
            releaseSlot();
            // Under the PLACE, the id every reader asks with — the worktree
            // sweep and `killTargetOk` both key on `a-<agentId>`. Recorded under
            // the bare agent id it was never read, reported `processes: []`
            // over a running watcher, and left one dead entry per turn.
            noteSessionGroup(place, ch.pid);
            // Keyed by PLACE, because the retire sweep iterates directory names
            // and a place id IS one. It is what lets a hard stop actually reach
            // the CLI — see `retireWorkSessions`.
            agentChildren.set(place, ch);
          },
        });
      } finally {
        /**
         * THE TAIL, BEFORE THE SETTLE — so the last thing the agent did is on
         * the record by the time the board is told the turn is over.
         *
         * The server deliberately does NOT require a pending turn to accept a
         * trace batch (a late tail is still that turn's record), so a race here
         * is survivable rather than lossy; flushing first simply means it
         * almost never happens. Bounded, and the settle is what matters: an
         * uplink that will not answer costs the tail and nothing else.
         */
        trace.stop();
        await trace.flush(TRACE_FINAL_FLUSH_MS);
        if (child) workChildren.delete(child);
        if (agentChildren.get(place) === child) agentChildren.delete(place);
        if (ranMarker) {
          try {
            writeFileSync(ranMarker, '1');
          } catch {
            /* a missing marker only costs one un-resumed turn */
          }
        }
        /**
         * AN ACTION THAT CHANGES WHAT THE MACHINE WOULD MEASURE MUST CAUSE A
         * NEW MEASUREMENT — the rule every session settle keeps, and the one
         * lane that did not. An agent's branch diff, head sha and trailered
         * commits only refreshed on the ≤60s sweep, so review opened right
         * after a turn described the branch as it was BEFORE the work.
         *
         * Here rather than after the settle POST because the CLI has exited,
         * so the tree is final — and because a queue that just emptied runs
         * the project's check next, which may hold this function for ten
         * minutes. Fire-and-forget on an endpoint that already exists, so no
         * floor: it must never delay the settle behind it.
         */
        void reportSessionWorktree(place).catch(() => {});
        // …and what it drew to SHOW the person (2026-09-22): uploaded against
        // the AGENT, so it lands on the agent's page whoever is looking.
        // Fire-and-forget for the same reason — never delay the settle.
        void artifacts
          .report({ placeDir: wt, before: artifactsBefore, agentId, turnId })
          .catch(() => {});
      }

      const commits = commitsBetween(wt, before);
      const res = parseTurnResult(out);
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
      if (limit) {
        // EVERY agent parks, because the account is shared: one hitting the
        // limit means all of them have. The turn itself is reported as
        // `nothing` — it did not deliver and it did not ask.
        await postAgentParked(limit);
        await postAgentTurn({
          turnId,
          outcome: 'nothing',
          answer: limit,
          ...(usage ? { usage } : {}),
          branch,
          worktree: wt,
        });
        return;
      }

      if (!res) {
        await postAgentTurn({
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
        return;
      }
      /**
       * A DESIGN OR RESEARCH CARD IS NOT DELIVERED UNTIL ITS ARTIFACT EXISTS
       * (0.97.0) — measured, never taken on the agent's word.
       *
       * Its whole product is one file under `.flowviant/artifacts/`: a `.html`
       * mockup for design, a `.md` write-up for research. A turn that says
       * "delivered" without having written one would land the agent in Review
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
      if (res.outcome === 'delivered' && taskKind !== 'code') {
        const want = taskKind === 'design' ? /\.html?$/i : /\.md$/i;
        const standing = scanArtifacts(wt);
        const wrote = changedArtifacts(artifactsBefore, standing).some((e) => want.test(e.name));
        const present =
          wrote || ((job.kind !== 'task' || job.redo === true) && standing.some((e) => want.test(e.name)));
        if (!present) {
          await postAgentTurn({
            turnId,
            outcome: 'nothing',
            answer:
              taskKind === 'design'
                ? 'the turn ended without writing a mockup under .flowviant/artifacts/'
                : 'the turn ended without writing a write-up under .flowviant/artifacts/',
            ...(commits.length ? { commits } : {}),
            ...(usage ? { usage } : {}),
            branch,
            worktree: wt,
          });
          return;
        }
      }
      const reply = await postAgentTurn({
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
      });
      // The queue just emptied. Run the project's own check and the AI
      // pre-review HERE, in the worktree we are already standing in and still
      // hold the lock on — see `runReviewEntry`.
      if (reply?.review === true) await runReviewEntry(agentId, wt, job.agentName);
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

  const lastAgentBeat = new Map(); // agentId -> last activity POST, ms

  const postAgentParked = async (reason) => {
    try {
      await fetch(AGENT_PARKED_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${FLEET_TOKEN}`,
          'User-Agent': USER_AGENT,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(15_000),
        body: JSON.stringify({ reason }),
      });
    } catch {
      /* the next turn will hit the same limit and try again */
    }
  };

  const processAgentTurnJobs = (jobs) => {
    const list = Array.isArray(jobs) ? jobs : [];
    if (agentReported.size) {
      // The roster is the held bodies' clock: an offered turn is still pending
      // server-side and worth retrying; one the roster stopped naming was
      // settled or expired, and holding its body past a generous grace would
      // grow this map for the life of the process. The server's own expiry is
      // the true bound — the grace only covers its POST racing a final offer.
      const offered = new Set(list.map((j) => String(j?.id || '')));
      const now = Date.now();
      for (const [id, held] of agentReported) {
        if (offered.has(id)) held.at = now;
        else if (now - held.at > AGENT_REPORT_GRACE_MS) {
          agentReported.delete(id);
          agentRejectedUntil.delete(id);
        }
      }
    }
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
