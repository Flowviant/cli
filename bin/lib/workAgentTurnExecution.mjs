/**
 * ONE AGENT TURN, RUN: the worktree, the CLI, and what it left behind.
 *
 * Split out of workAgentTurns.mjs (SOLID F036, 2026-09-26). The lane there
 * decides WHICH turns run and makes sure each one is settled exactly once; this
 * runs one, inside the place lock the lane already holds — the begun-guard
 * (workAgentTurnBegun.mjs), the worktree and its branch facts, the kind's
 * refusals, the prompt, the CLI and its resume, the trace and pulse relays,
 * the markers and the re-measurement after it exits — then hands the
 * measurements to the one settlement decision (workAgentTurnOutcome.mjs) and
 * posts the body that decision chose.
 *
 * `postAgentTurn` arrives PER TURN, from the lane, rather than from the report
 * module directly: the lane wraps it to learn that a settle was sent, which is
 * what lets its catch settle a turn that threw — and never one that already
 * answered. `measured` is the same bargain the other way: the branch facts and
 * the spend, written here as they are learned, read by that catch.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { PROJECT_ID } from './config.mjs';
import { setRuntimeLimit } from './daemonState.mjs';
import { git } from './git.mjs';
import { stashCard } from './agentCards.mjs';
import { c } from './ui.mjs';
import { runTurn } from './runTurn.mjs';
import { SYSTEM_AGENT_FOR, AGENT_TASK_KICKOFF, AGENT_TASK_SPEC, AGENT_HUMAN_KICKOFF, withProjectContext } from './prompts.mjs';
import { AGENT_TASK_KINDS, agentTaskKindOf, unknownAgentTaskKind } from './agentTaskKinds.mjs';
import { knowledgeDirFor } from './knowledgeFiles.mjs';
import { scrub as envScrub } from './uplinkScrub.mjs';
import { canRun, RUNTIMES } from './runtimes.mjs';
import { recordSkills, recordMcpServers } from './runtimeCapabilities.mjs';
import { toolEventOf, CLAUDE_TOOL_PROSE_KINDS } from './runtimeEvents.mjs';
import { makeTraceRelay } from './trace.mjs';
import { readBaseTools, prepareAgentTools } from './projectTools.mjs';
import { runTurnResumingOnce } from './resumeLost.mjs';
import { CODEX_THREAD_RE } from './workSessionRuntime.mjs';
import { brainFor } from './workBrain.mjs';
import { begunTurnRefusal } from './workAgentTurnBegun.mjs';
import { agentTurnSettlement } from './workAgentTurnOutcome.mjs';
import { ensureArtifactDir, ensureFenceScratch } from './artifacts.mjs';
import { agentBrowserHome } from './noWindowEnv.mjs';
import { committedMergeResolution } from './agentMergeResolution.mjs';

export function createAgentTurnExecution({
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
}) {
  /** How long the final flush may hold the settle. Bounded because the settle
   *  is the turn's contract and the trace is a readout: a wedged uplink costs
   *  the tail of a trace, never the answer behind it. */
  const TRACE_FINAL_FLUSH_MS = 8_000;

  const lastAgentBeat = new Map(); // agentId -> last activity POST, ms

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

  /**
   * The turn, run inside its place's writer lock (the lane takes it). `turnId`,
   * `agentId` and `place` are the lane's own readings of the job, handed down
   * so the two can never disagree about which directory this is.
   *
   * `releaseSlot` hands back the admission reservation the lane took on this
   * turn's behalf, at the moment the CLI actually exists. Idempotent.
   */
  const runAgentTurnInPlace = async (job, { turnId, agentId, place, releaseSlot, postAgentTurn, measured }) => {
    // WORK THAT HAS BEGUN LIVES ON EXACTLY ONE BOX — read BEFORE anything is
    // cut, because `placeWtFor` would cut a rival branch of the same name. The
    // rule and its three-state branch measurement: workAgentTurnBegun.mjs.
    if (job.begun) {
      const refusal = begunTurnRefusal(job, place, { baseDir, repoRoot, fetchPublishedBranch });
      if (refusal) {
        await postAgentTurn({ turnId, outcome: 'nothing', answer: refusal });
        return;
      }
    }
    const dir = placeWtFor(place);
    if (!dir) {
      // No worktree and none could be cut. `nothing`, WITH git's own words:
      // without them the agent sat in Stuck with no question and no reason
      // (the owner, 2026-09-25: "it got stuck without saying why").
      const why = placeWtFor.lastError ?? null;
      await postAgentTurn({ turnId, outcome: 'nothing', ...(why ? { answer: `This machine could not start the turn: ${why}` } : {}) });
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
    // …and the same three facts for the lane's catch: a turn that throws past
    // here is still settled with what was measured (workAgentTurns.mjs).
    measured.wt = wt;
    measured.before = before;
    measured.branch = branch;

    const rt = job.runtime || 'claude';
    /**
     * WHAT THIS CARD HANDS BACK, AND THE POSTURE THAT FOLLOWS (0.97.0).
     *
     * `code` (the default — absent on the job IS code) is the build turn,
     * byte-for-byte what every agent turn was. `design` and `research` run
     * their own contract (SYSTEM_AGENT_DESIGN / _RESEARCH) under their own
     * posture, which can write ONLY `.flowviant/artifacts/` (claudePosture.mjs).
     *
     * A RUNTIME THAT CANNOT EXPRESS THE POSTURE IS REFUSED, NOT IMPROVISED.
     * Antigravity declares none of them and Codex declares `design` (since
     * 0.115.0) and `image` but not `research` (runtimeCodex.mjs,
     * runtimeAntigravity.mjs), and the only
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
     * sent for every non-code kind; the card's own key's floor, no new one),
     * and the card's key stays the
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
    // What this kind IS — its posture, its artifact, its refusal — is one
    // entry in agentTaskKinds.mjs; nothing below branches on the kind name.
    const kind = AGENT_TASK_KINDS[taskKind];
    const posture = kind.posture;
    if (!canRun(RUNTIMES[rt], posture)) {
      await postAgentTurn({
        turnId,
        outcome: 'nothing',
        answer: kind.offRuntime(rt),
        branch,
        worktree: wt,
      });
      return;
    }
    /**
     * A NON-CODE CARD WRITES ONE DIRECTORY, SO IT STANDS FIRST (0.114.0).
     * Codex's image fence makes `.flowviant/artifacts` its only writable root
     * and cannot create it from inside; every kind posture writes nowhere
     * else. Made only as a real directory under a real `.flowviant`
     * (`ensureArtifactDir`): a committed `.flowviant` symlink would otherwise
     * point the fence's one write grant at somewhere outside the worktree. A
     * worktree where it cannot stand is settled in words, before any CLI runs.
     */
    if (kind.artifact && !ensureArtifactDir(wt)) {
      await postAgentTurn({
        turnId,
        outcome: 'nothing',
        answer: "this worktree's .flowviant/artifacts is not a real directory, so there is nowhere to write what the card hands back",
        branch,
        worktree: wt,
      });
      return;
    }
    /**
     * …AND ITS SCRATCH BESIDE IT, EMPTY (0.115.0): a fenced shell's temp files
     * (a here-document, `mktemp`) go under `.flowviant/tmp`, which Codex's
     * design fence grants because `/tmp` is read-only in there
     * (`ensureFenceScratch`). Made for every file kind — one rule, no kind
     * named — and refused in words where it cannot stand as a real directory.
     */
    if (kind.artifact && !ensureFenceScratch(wt)) {
      await postAgentTurn({
        turnId,
        outcome: 'nothing',
        answer: "this worktree's .flowviant/tmp is not a real directory, so the fenced turn has no scratch to work in",
        branch,
        worktree: wt,
      });
      return;
    }

    // ONE AGENT IS ONE DIRECTORY, so the CLI's own cwd-keyed resume is exactly
    // right here — the ambiguity that forced per-tab session pinning in the
    // Workbench (many tabs, one place) cannot arise. The marker is what
    // distinguishes the first turn from every later one across restarts.
    //
    // IT MEANS "CLAUDE HAS SPOKEN HERE", and since 2026-09-24 only a Claude
    // turn writes it: an agent can be switched between CLIs, and a marker a
    // codex turn left behind would send the first Claude turn to
    // `--continue` a directory holding no Claude conversation at all.
    const ranMarker = sessionMetaPath(wt, 'flowviant-agent-ran');
    /**
     * CODEX RESUMES BY ITS OWN THREAD ID, PINNED PER AGENT (2026-09-24).
     *
     * Resume was Claude-only, because codex's `resume --last` is
     * MACHINE-GLOBAL and would cross-resume whichever conversation spoke
     * last anywhere on the box. The cost was that every codex card started
     * a stranger: no memory of the card before it, and — worse — an answer
     * to the agent's own question arrived at a codex that never asked it.
     * The Workbench solved the same problem in 0.69.0 by pinning the id
     * `thread.started` announces; this is that, keyed by the AGENT rather
     * than a tab. The id is shape-checked before it rides argv.
     */
    const codexThreadMarker =
      rt === 'codex' ? sessionMetaPath(wt, 'flowviant-agent-codex-thread', agentId) : null;
    let codexResumeId = null;
    if (codexThreadMarker && existsSync(codexThreadMarker)) {
      try {
        const v = readFileSync(codexThreadMarker, 'utf8').trim();
        if (CODEX_THREAD_RE.test(v)) codexResumeId = v;
      } catch {
        /* unreadable marker — run fresh */
      }
    }
    let seenThreadId = null;
    const resume =
      rt === 'codex'
        ? Boolean(codexResumeId)
        : rt === 'claude' && Boolean(ranMarker && existsSync(ranMarker));
    /**
     * …AND THE HOME THAT THREAD IS FILED UNDER, KEPT PER AGENT (2026-09-29).
     *
     * Codex's thread index records each rollout under the CODEX_HOME the turn
     * ran with, as that path — not the personal store the link leads to — so
     * the per-turn home in /tmp every turn used to get died with its turn and
     * took the pinned thread with it: the next card's `resume` failed "no
     * rollout found" and the agent went to Stuck. Beside the thread marker,
     * in the worktree's private git dir: outside the working tree (never
     * committed, never seen by `git add -A`), refreshed by every turn and
     * removed only with the worktree, when the agent retires and its threads
     * stop mattering. One agent runs one turn at a time (its place's writer
     * lock), so no two turns refresh it at once. Null (no git dir to hold it)
     * is the per-turn home again, and a lost resume then runs once fresh.
     */
    const codexAgentHome =
      rt === 'codex' ? sessionMetaPath(wt, 'flowviant-agent-codex-home', agentId) : null;

    /**
     * THE TURN'S FILES, ON DISK BEFORE THE PROMPT NAMES THEM (0.112.0) — the
     * Terminal's order: the agent must be able to open what it is told about.
     * Into this worktree's `.flowviant/uploads/`, which the common exclude
     * already hides from git, so a screenshot is never committed by the
     * agent's `git add -A`. After the kind's refusals (a turn refused runs
     * nothing and needs no files) and before the stash, which names the
     * card's files beside its discussion so the pre-review — a fresh reader
     * standing in this same worktree — is pointed at what the agent was.
     * No key is no call: a turn without files touches nothing here, and its
     * prompt is byte-for-byte what it was.
     */
    const files =
      Array.isArray(job.attachments) && job.attachments.length > 0
        ? await fetchAgentFiles(wt, job.attachments)
        : { message: [], card: [] };

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
     * what the reviewer reads is byte-identical to what the agent read — the
     * card's discussion included (0.106.0): both are handed the same
     * `job.cardThread`, and the builder prints it inside the spec — and the
     * card's files after it (0.112.0), fetched just above.
     * Failure is swallowed inside `stashCard`: a note about a turn may never
     * cost the turn.
     */
    if (job.kind === 'task' && job.task) {
      stashCard(
        sessionMetaPath(wt, 'flowviant-agent-cards', agentId),
        job.task.id,
        AGENT_TASK_SPEC(job.task, job.cardThread, files.card)
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
     * `parse: null` is exactly the claudeStream.mjs stream path. See
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
    const brain = brainFor(job, rt);

    let out = '';
    let child = null;
    /**
     * EVERY CHILD THIS TURN SPAWNED, not only the last (2026-09-29). A lost
     * resume runs once more fresh (runTurnResumingOnce), so a turn can own two
     * CLIs, and `child` names only the second: the first stayed in
     * `workChildren` for the life of the daemon — one phantom live turn per
     * retry, held against the machine's ceiling, and `workBusy()` true for
     * ever, which holds the self-update and the tray's install for ever.
     */
    const spawnedChildren = new Set();
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
    /** THE MODEL THE TURN RAN ON, as its CLI named it (turnModel.mjs) — rides
     *  every settle `usage` rides, for the same reason; null sends no key. */
    let model = null;
    /**
     * THE AGENT'S LAST MESSAGE, ALONE — where the final JSON object lives.
     * Codex's `out` is every message plus stderr plus error text, and
     * `parseTurnResult` takes the first object that fits, so an early
     * message quoting the format could be read as the outcome. Claude never
     * calls this (its `out` is already the result under `answerFromResult`).
     */
    let lastAnswer = null;
    /** The agent's artifact directory as it stood before this turn — the
     *  tab lane's rule, in the agent's own worktree (2026-09-22). */
    const artifactsBefore = beforeArtifacts(wt);
    let projectTools = null;
    try {
      // A turn reads the base ref afresh. Changes the agent has made to its
      // own worktree cannot silently change the next turn's tools.
      projectTools = prepareAgentTools(readBaseTools(repoRoot, baseRef()), rt, process.env, wt, { codexHome: codexAgentHome });
      const agentTurnArgs = {
        prompt:
          job.kind === 'task' && job.task
            ? AGENT_TASK_KICKOFF({
                agentName: job.agentName,
                task: job.task,
                // The card's discussion (0.106.0), printed inside THE CARD by
                // the same builder the stash above wrote down — and the files
                // on it (0.112.0), after it, the same way.
                cardThread: job.cardThread,
                cardFiles: files.card,
                position: job.position ?? 1,
                total: job.total ?? 1,
              })
            : AGENT_HUMAN_KICKOFF({
                agentName: job.agentName,
                message: job.body ?? '',
                askedByName: job.askedByName,
                task: job.task,
                // The discussion on the one card this message is about, in a
                // fence of its own after the person's words (0.106.0).
                cardThread: job.cardThread,
                // The files (0.112.0): the person's inside their words, the
                // card's at the foot of its discussion.
                messageFiles: files.message,
                cardFiles: files.card,
                position: job.position ?? 1,
                total: job.total ?? 1,
              }),
        // The knowledge paragraph, when this box holds a library — the same
        // composer the tabs use, so an agent and a tab can never be told two
        // different things about the same directory.
        // Spoken to the CLI that runs it (0.115.0): a mockup on Codex is
        // told it is Codex, never Claude.
        system: withProjectContext(SYSTEM_AGENT_FOR(taskKind, RUNTIMES[rt]?.label), {
          knowledgeDir: knowledgeDirFor(repoRoot),
          // ARTIFACTS (0.94.0), while the server can show one — an agent's
          // land on its page, under the facts row.
          artifacts: getArtifactsAccepted(),
        }) + (projectTools.instructions ? `\n\n${projectTools.instructions}` : ''),
        agentTools: projectTools,
        ...(projectTools.codexHome ? { mcpEnv: { CODEX_HOME: projectTools.codexHome } } : {}),
        // NOBODY IS AT THIS SCREEN (2026-09-29): no display, BROWSER=none, and
        // a browser profile of the agent's own, kept beside its Codex home —
        // so a Chrome it starts to look at its page never reaches the
        // person's (noWindowEnv.mjs).
        browserHome: agentBrowserHome(sessionMetaPath, wt, agentId),
        ...(posture === 'build' && rt === 'claude'
          ? { mcpArgs: ['--strict-mcp-config', '--mcp-config', projectTools.mcpPath] }
          : posture === 'build' && rt === 'codex'
            ? { mcpArgs: projectTools.codexArgs }
            : {}),
        knowledgeDir: knowledgeDirFor(repoRoot),
        // The kind's posture, as the one turn profile (turnProfile.mjs):
        // build for code, the fenced design/research postures otherwise.
        profile: posture,
        cwd: wt,
        runtime: rt,
        resume,
        resumeThreadId: codexResumeId || undefined,
        onThreadId: (id) => {
          seenThreadId = String(id ?? '').trim() || seenThreadId;
        },
        onAnswer: (t) => {
          lastAnswer = t;
        },
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
          // parser had more than the label could hold (see runtimeEvents.mjs).
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
        // …tagged with WHICH CLI counted it (2026-09-24), so the server can
        // split an agent's spend per CLI rather than labelling a codex
        // agent's total with whatever the pre-review spent.
        onUsage: (u) => {
          usage = { ...u, runtime: rt };
        },
        onModel: (m) => {
          model = m;
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
          spawnedChildren.add(ch);
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
      };
      /**
       * A RESUME THAT CAME BACK EMPTY, OR WITH ONLY THE CLI SAYING THE
       * CONVERSATION IS GONE, RUNS ONCE MORE FRESH — the tab lane's rule,
       * for the tab lane's reason: a pinned id the CLI has since pruned
       * (or a `--continue` over a directory Claude never spoke in, which an
       * agent switched between CLIs can reach) would otherwise settle
       * `nothing` on every turn forever. Same worktree, never a reset. The
       * init evidence the rule needs is measured by the sequence itself
       * (resumeLost.mjs, SOLID F001): a successful answer that merely
       * MENTIONS a missing session is never run twice.
       */
      out = await runTurnResumingOnce(runTurn, agentTurnArgs, {
        resume,
        runtime: rt,
        beforeFresh: () => {
          seenThreadId = null;
          lastAnswer = null;
          model = null;
        },
      });
    } finally {
      // What the CLI counted, for the lane's catch if anything below throws.
      measured.usage = usage;
      measured.model = model;
      projectTools?.cleanup();
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
      for (const ch of spawnedChildren) workChildren.delete(ch);
      if (agentChildren.get(place) === child) agentChildren.delete(place);
      if (ranMarker && rt === 'claude') {
        try {
          writeFileSync(ranMarker, '1');
        } catch {
          /* a missing marker only costs one un-resumed turn */
        }
      }
      // The thread THIS turn spoke under, pinned so the next card, answer
      // or merge-resolve resumes it. After the turn, like the tab lane: an
      // id learned mid-turn is only true once the turn that learned it ends.
      if (codexThreadMarker && seenThreadId && CODEX_THREAD_RE.test(seenThreadId)) {
        try {
          writeFileSync(codexThreadMarker, seenThreadId);
        } catch {
          /* best-effort — the next turn runs fresh */
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
    // WHAT THE TURN REPORTS is one decision, off what was measured here
    // (workAgentTurnOutcome.mjs). The side effects it implies stay on this
    // side: the machine's limit state, the park, and the review-entry beat.
    const { res, limit, body, final } = agentTurnSettlement({
      turnId,
      job,
      kind,
      out,
      lastAnswer,
      usage,
      model,
      commits,
      artifactsBefore,
      branch,
      wt,
    });
    if (res) setRuntimeLimit(PROJECT_ID, rt, null);
    if (limit) {
      setRuntimeLimit(PROJECT_ID, rt, limit);
      // Every agent ON THIS CLI parks, because that account is shared: one
      // hitting the limit means all of them have. Named since 2026-09-24 —
      // a machine can hold a Claude login and a Codex login, and a Codex
      // limit is no reason to stop the Claude agents. The turn itself is
      // reported as `nothing` — it did not deliver and it did not ask.
      await postAgentParked(limit, rt);
    }
    if (job.kind === 'merge_resolve' && body.outcome === 'delivered') {
      body.mergeResolved = committedMergeResolution(wt, before, baseRef());
    }
    const reply = await postAgentTurn(body);
    // The queue just emptied. Run the project's own check and the AI
    // pre-review HERE, in the worktree we are already standing in and still
    // hold the lock on — see `runReviewEntry`. Only after the settle that may
    // say delivered: the three `nothing` settles never opened it.
    if (final && reply?.review === true) await runReviewEntry(agentId, wt, job.agentName);
  };

  return { runAgentTurnInPlace, commitsBetween };
}
