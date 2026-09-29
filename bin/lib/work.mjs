/**
 * Work sessions — the Workbench tabs and the agent lanes, daemon side: THE
 * MANAGER that builds every lane and hands each one exactly what it uses.
 *
 * A tab is a held coding-CLI session (Claude or codex — the server names the
 * brain per tab, and the pin holds it) with BUILD permissions in a PERSISTENT
 * worktree on its own `session/<id>` branch. Nothing here is detached and
 * nothing is ever reset — uncommitted state between turns IS the session, and
 * blowing it away would be closing the human's editor mid-thought. (Plan
 * worktrees are the deliberate opposite: reset at base every turn.)
 *
 * The daemon's reconcile loop (fleet.mjs) constructs one manager per run and
 * feeds it roster jobs; the only state it borrows from the loop is read
 * through the getters (the MCP URL, the lease TTL and the base can change with
 * any poll).
 *
 * THIS FILE RUNS NO LANE OF ITS OWN (2026-09-26, SOLID F037). It was the
 * implementation site of every workflow the loop guarantees — process-group
 * bookkeeping, the settle queue, publishing, the worktree readout,
 * attachments, the tab's whole turn, retirement — at 3.2k lines, so a change
 * to any one of them was a change to all of their file. Each now has a
 * sibling named for what it does, and this file owns only what is genuinely
 * the manager's: the shared maps (named at every factory that reads them,
 * F164), the artifact reporter and the landed observer that several lanes
 * share, the network-git bound, the construction ORDER (a factory is built
 * after everything it is handed), and the two answers the loop asks of the
 * whole — `workBusy` and the returned surface. A pure rule or constant
 * (REPO_PLACE, the resume-id guards, brainFor, the turn lock) is IMPORTED by
 * every lane that reads it, never carried through here.
 *
 *   workPlaces.mjs         where a session works, its worktree, its markers
 *   workSessionGroups.mjs  which process groups each tab started
 *   workChildren.mjs       the live CLI children, teardown, the admission
 *   workAgentPublish.mjs   pushing and fetching an agent's branch
 *   workPlaceReports.mjs   the worktree readout: settle, burst, sweep
 *   workReportQueue.mjs    every settle, held and retried until delivered
 *   workSessionTokens.mjs  the per-session work credential
 *   workNarration.mjs      the tab's live line and the deferral sentence
 *   workAttachments.mjs    files the human attached, brought to disk (tabs and agents)
 *   workSessionRuntime.mjs which CLI a tab speaks, which conversation resumes
 *   workAdoptCarry.mjs     adoption's dirty carry
 *   workSessionTurns.mjs   a tab's turn, start to settle
 *   workRetire.mjs         held sessions, retirement, manual-place freshening
 *   workToolLog.mjs        one turn's tool cards, folded and capped (pure)
 *   workCommandAudit.mjs   one turn's `$ …` audit, batched to the server
 *   workBrain.mjs          the model and effort a turn may put on argv (pure)
 *   workIntake.mjs         one incoming ticket drafted into a card, read-only (2026-09-28)
 *   turnLock.mjs           whether a live CLI of ours holds a directory's turn
 *   (and, split earlier: workDiffs, workPreviews, workPullRequests, workShip,
 *   workAgentPlans, workAgentCheck, workAgentPrecheck, workAgentReview,
 *   workAgentTurns, workAgentMerges, workProcesses; and out of workAgentTurns,
 *   SOLID F036: workAgentTurnReports, workAgentTurnExecution,
 *   workAgentTurnBegun, workAgentTurnOutcome)
 */

import { createWorkProcesses } from './workProcesses.mjs';
import { createWorkAgentMerges } from './workAgentMerges.mjs';
import { createWorkAgentTurns } from './workAgentTurns.mjs';
import { createWorkAgentCheck } from './workAgentCheck.mjs';
import { createWorkAgentPrecheck } from './workAgentPrecheck.mjs';
import { createWorkAgentReview } from './workAgentReview.mjs';
import { createWorkAgentPlans } from './workAgentPlans.mjs';
import { createWorkIntake } from './workIntake.mjs';
import { createWorkShipper } from './workShip.mjs';
import { createWorkPullRequests } from './workPullRequests.mjs';
import { createWorkPreviews } from './workPreviews.mjs';
import { createWorkDiffs } from './workDiffs.mjs';
import { createWorkPlaces } from './workPlaces.mjs';
import { createWorkSessionGroups } from './workSessionGroups.mjs';
import { createWorkChildren } from './workChildren.mjs';
import { createWorkAgentPublish } from './workAgentPublish.mjs';
import { createWorkPlaceReports } from './workPlaceReports.mjs';
import { createWorkReportQueue } from './workReportQueue.mjs';
import { createWorkSessionTokens } from './workSessionTokens.mjs';
import { createWorkNarration } from './workNarration.mjs';
import { createWorkAttachments } from './workAttachments.mjs';
import { createWorkSessionRuntime } from './workSessionRuntime.mjs';
import { createAdoptCarry } from './workAdoptCarry.mjs';
import { createWorkSessionTurns } from './workSessionTurns.mjs';
import { createWorkRetire } from './workRetire.mjs';
import { FLEET_URL, FLEET_TOKEN, USER_AGENT } from './config.mjs';
import { gitNet as gitNetIn, excludeInWorktree } from './git.mjs';
import { createLandedObserver } from './landed.mjs';
import { createPlaceLock } from './placeLock.mjs';
import { warn } from './ui.mjs';
import { FLOWVIANT_OWN_PATHS } from './knowledgeLibrary.mjs';
import { buildArtifactUpload, changedSince, snapshotArtifacts } from './artifacts.mjs';
import { createArtifactReporter } from './artifactReporter.mjs';
import { renderDesignPreview } from './artifactPreview.mjs';
import { scrub as envScrub, secretIn as envSecretIn } from './uplinkScrub.mjs';

export function createWorkManager({
  repoRoot,
  baseDir,
  getBaseRef,
  getMcpUrl,
  getLeaseTtl,
  /** "The repo picture changed — look again." See the caller in fleet.mjs. */
  onRepoChanged = () => {},
  /**
   * CLI turns this manager did not spawn — today exactly one, the wiki
   * cartographer, which lives in wikiRunner.mjs and is wired by fleet.mjs. A callback for the
   * same reason `onRepoChanged` is one: work.mjs is imported BY fleet.mjs and
   * cannot import back. It exists because the concurrency bound is a bound on
   * the MACHINE: a count that can see three lanes out of four is a ceiling with
   * a hole in it.
   */
  extraLiveTurns = () => 0,
  /**
   * DOES THE SERVER TAKE ARTIFACTS (2026-09-22)? The roster's
   * `artifactsAccepted`, read at SPAWN like the knowledge directory is, so the
   * first turn after a server deploy already carries the paragraph. A getter
   * for `getBaseRef`'s reason: the answer is the latest poll's, not startup's.
   * Absent (false) is what an older server says, and then no turn is told
   * about a panel that server cannot draw.
   */
  getArtifactsAccepted = () => false,
}) {
  /**
   * WHERE SHIP LANDS, read fresh every time rather than captured at startup.
   *
   * A getter, like `getMcpUrl` and `getLeaseTtl` beside it, because the answer
   * can now change while the daemon runs: a human sets `projects.baseBranch`
   * and the next roster poll carries it. Captured by value this would be
   * whatever `origin/HEAD` said the moment the process booted — which is also
   * the shape of the bug it replaces, where an unset `origin/HEAD` froze
   * `origin/<branch you happened to be on>` for the life of the daemon.
   */
  const baseRef = () => getBaseRef();
  // What arrived on base, whichever road it took — observed after every beat
  // that can move origin/<base>: the sweep's fetch, a ship's push, a PR merge
  // this daemon performed. See landed.mjs for the seeding and delivery rules.
  const landed = createLandedObserver({ repoRoot, baseRef });
  /**
   * THE ARTIFACT RELAY (2026-09-22, 0.94.0) — what a turn wrote under
   * `.flowviant/artifacts/`, uploaded after it. One reporter for the life of
   * the manager so its held bodies survive from one beat to the next; see
   * artifacts.mjs for the snapshot rule and the bounds, artifactReporter.mjs for the delivery shape.
   */
  const artifacts = createArtifactReporter({
    fleetUrl: FLEET_URL,
    token: FLEET_TOKEN,
    userAgent: USER_AGENT,
    scrub: envScrub,
    // …and for the binaries it cannot scrub, the same list as a byte check:
    // a hit is withheld, never uploaded rewritten (artifacts.mjs).
    secretIn: envSecretIn,
    log: (line) => warn(line),
    // The disk half and the browser half, handed in (artifactReporter.mjs).
    listChanged: changedSince,
    buildUpload: buildArtifactUpload,
    renderPreview: renderDesignPreview,
  });
  /**
   * Snapshot a place's artifact directory before a CLI spawns in it — and make
   * sure git cannot see what this daemon writes under `.flowviant/` there
   * first (`FLOWVIANT_OWN_PATHS` — never the whole directory, whose
   * `check.json` and `deploy.json` are the repo's own). The exclude was only ever
   * written by an attachment fetch or a knowledge sync, so a turn that wrote
   * an artifact in a worktree neither had touched left an untracked
   * `.flowviant/` for the agent's own `git add -A` to commit. Idempotent, and
   * one call covers every worktree (it resolves `--git-common-dir`).
   */
  const beforeArtifacts = (placeDir) => {
    try {
      excludeInWorktree(placeDir, FLOWVIANT_OWN_PATHS);
    } catch {
      /* a convenience, never a guarantee — the prompt also says never commit */
    }
    return snapshotArtifacts(placeDir);
  };
  const workAttempts = new Map(); // turn id -> completed runTurn attempts
  const shipping = new Set(); // sessionIds with a ship queued/running here
  const { placeLocks, inPlace } = createPlaceLock();

  /**
   * A NETWORK GIT CALL, TIMED AND NON-INTERACTIVE.
   *
   * `execFileSync` blocks the daemon's whole event loop — the reason every `gh`
   * call on the merge path carries a timeout — and a push is the call most
   * likely to hang: a credential helper with nothing to answer it, a remote
   * black hole. Unattended tail work nobody asked for must not be able to stop
   * every turn on the machine, so it is bounded here and `GIT_TERMINAL_PROMPT=0`
   * turns a prompt into an immediate, reportable failure.
   */
  const gitNet = (args, ms) => gitNetIn(args, repoRoot, ms);

  // ── THE SESSION'S OWN HALF — built first, because the lanes below are handed it.
  const { sessionPlaces, placeOf, learnPlaces, placeDir, placeWtFor, sessionMetaPath } =
    createWorkPlaces({ repoRoot, baseDir, baseRef, onRepoChanged });
  const { sessionGroups, noteSessionGroup, pruneSessionGroups, sessionProcesses } =
    createWorkSessionGroups({ repoRoot });
  const { workChildren, groupKillChildren, shutdownWork, liveTurnCount, liveTurns, admit } =
    createWorkChildren({ extraLiveTurns });
  const { agentPublished, agentRemoteAt, publishAgentBranch, fetchPublishedBranch } =
    createWorkAgentPublish({ repoRoot, gitNet });
  const { reportSessionWorktree, reportPlaceWorktrees, burstListeners, reportWorktrees } =
    createWorkPlaceReports({
      repoRoot,
      baseRef,
      placeOf,
      placeDir,
      sessionMetaPath,
      sessionProcesses,
      pruneSessionGroups,
      agentPublished,
      agentRemoteAt,
      publishAgentBranch,
      landed,
    });
  const {
    pendingWorkReports,
    pendingShipReports,
    postBestEffort,
    REJECT_RETRY_MS,
    settleWorkTurn,
    settleShip,
    flushWorkReports,
    sweepMergedSessionBranch,
  } = createWorkReportQueue({
    repoRoot,
    baseRef,
    workAttempts,
    artifacts,
    landed,
    onRepoChanged,
    reportPlaceWorktrees,
    burstListeners,
  });
  const { workTokens, mintWorkToken } = createWorkSessionTokens({ getLeaseTtl });
  const { makeNarrator, sayTurnDeferred, lastDeferSaid } = createWorkNarration();
  const { fetchAttachments, fetchAgentFiles } = createWorkAttachments();
  const { sessionRuntime, agyRegistryLookup } = createWorkSessionRuntime({ sessionMetaPath });
  const { carryDirtyState } = createAdoptCarry({ sessionMetaPath });
  const { processWorkTurns, workAnswering } = createWorkSessionTurns({
    repoRoot,
    baseDir,
    getMcpUrl,
    getArtifactsAccepted,
    admit,
    inPlace,
    workChildren,
    workAttempts,
    sessionPlaces,
    placeOf,
    placeWtFor,
    sessionMetaPath,
    beforeArtifacts,
    artifacts,
    settleWorkTurn,
    pendingWorkReports,
    workTokens,
    mintWorkToken,
    sessionRuntime,
    agyRegistryLookup,
    carryDirtyState,
    fetchAttachments,
    makeNarrator,
    sayTurnDeferred,
    lastDeferSaid,
    noteSessionGroup,
    reportPlaceWorktrees,
    burstListeners,
  });

  /*
   * THE SHARED MAPS GO BY NAME (2026-09-26, SOLID F164). They were one
   * eight-field `state` bag handed to six factories that each read one to
   * three of it, which hid every worker's real dependencies. Each factory now
   * names exactly the maps it reads or writes, so a reader sees at the call
   * which lanes share which map (workChildren: plans, review, turns; the
   * publication maps: turns and merges).
   */

  const { processDiffJobs } = createWorkDiffs({
    repoRoot,
  });

  const { processPreviewJobs, livePreviewIds, retirePreviews, shutdownPreviews } = createWorkPreviews({
    placeDir,
  });

  const { processPrJobs } = createWorkPullRequests({
    placeOf,
    repoRoot,
    baseDir,
    baseRef,
    gitNet,
    landed,
    onRepoChanged,
  });

  const { processShipJobs } = createWorkShipper({
    inPlace,
    placeOf,
    settleShip,
    repoRoot,
    baseDir,
    gitNet,
    baseRef,
    placeWtFor,
    sessionMetaPath,
    shipping,
    pendingShipReports,
  });

  const { processAgentPlanJobs, planning } = createWorkAgentPlans({
    postBestEffort,
    baseDir,
    baseRef,
    inPlace,
    repoRoot,
    admit,
    placeLocks,
    workChildren,
  });

  const { processIntakeJobs, intake } = createWorkIntake({
    postBestEffort,
    inPlace,
    repoRoot,
    admit,
    workChildren,
  });

  // The check and the pre-review are built with only what each one uses; the
  // review entry beat is handed the two and owns only their order.
  const { runCheck } = createWorkAgentCheck({
    repoRoot,
    postBestEffort,
    workChildren,
    groupKillChildren,
    // Only to find the agent's browser profile (noWindowEnv.mjs).
    sessionMetaPath,
  });
  const { runPrecheck } = createWorkAgentPrecheck({
    baseRef,
    admit,
    sessionMetaPath,
    workChildren,
  });
  const { runReviewEntry } = createWorkAgentReview({ runCheck, runPrecheck });

  const { processAgentTurnJobs, settleAgentTurns, agentTurns, agentChildren, agentReported } = createWorkAgentTurns({
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
    fetchAgentFiles,
  });

  const { processAgentMergeJobs, agentMerges } = createWorkAgentMerges({
    repoRoot,
    inPlace,
    baseDir,
    gitNet,
    baseRef,
    runReviewEntry,
    onRepoChanged,
    landed,
    agentRemoteAt,
    agentPublished,
  });

  // Built after the agent lane: retirement stops a stopped agent's CLI, and
  // only the agent lane knows which child that is.
  const { heldSessionIds, retireWorkSessions, freshenManualPlaces } = createWorkRetire({
    repoRoot,
    baseDir,
    baseRef,
    placeOf,
    placeLocks,
    shipping,
    workTokens,
    agentChildren,
    sweepMergedSessionBranch,
  });

  const { processKillJobs } = createWorkProcesses({
    placeDir,
    reportPlaceWorktrees,
    sessionGroups,
  });

  /**
   * Is ANY session work in flight — the answer safeToUpdate needs. A self-
   * update re-execs the process: a mid-turn CLI would be SIGTERM'd and its
   * half-finished answer settled as the tab's reply, and a queued-but-
   * undelivered settle report would die in memory — after which the skip-
   * guard's protection is gone and the re-exec'd daemon re-runs a turn whose
   * side effects (edits, commits, cards) already happened. `placeLocks` holds
   * an entry for every place with a running or waiting turn or ship (entries
   * self-delete when a place goes quiet); the other collections are belt over
   * braces for the windows around it.
   */
  const workBusy = () =>
    placeLocks.size > 0 ||
    // A planning turn is a live CLI child of ours, and an auto-update that
    // SIGTERMs it mid-flight would leave a press claimed, unsettled and
    // waiting out its lease while somebody watches a spinner.
    planning.size > 0 ||
    intake.size > 0 ||
    // An agent turn is real work in a real worktree. Killed mid-flight it
    // leaves uncommitted edits and a turn the server will eventually expire
    // into a card nobody can explain.
    agentTurns.size > 0 ||
    agentMerges.size > 0 ||
    // A finished agent turn whose settle has not landed lives only in this
    // process; a restart here is the six-hour park the held body exists to
    // prevent. Same reason the tab's report queues are below.
    agentReported.size > 0 ||
    shipping.size > 0 ||
    workChildren.size > 0 ||
    workAnswering.size > 0 ||
    pendingWorkReports.size > 0 ||
    pendingShipReports.size > 0;

  return {
    flushWorkReports,
    learnPlaces,
    processWorkTurns,
    processShipJobs,
    processDiffJobs,
    processKillJobs,
    processPrJobs,
    heldSessionIds,
    processPreviewJobs,
    livePreviewIds,
    retirePreviews,
    shutdownPreviews,
    retireWorkSessions,
    reportWorktrees,
    shutdownWork,
    workBusy,
    // The machine's own admission answer, and what it is counting. Handed to
    // the loop so the lanes it owns — the wiki cartographer (wikiRunner.mjs) — ask the
    // same question, and so the machine snapshot can charge memory to the work
    // holding it.
    admit,
    liveTurns,
    liveTurnCount,
    processAgentPlanJobs,
    processIntakeJobs,
    processAgentTurnJobs,
    // Only the displacement stand-down calls this — see its comment. Exported
    // rather than hooked into `shutdownWork` because the signal handlers cannot
    // await, and a settle that is not awaited is a settle that did not happen.
    settleAgentTurns,
    processAgentMergeJobs,
    freshenManualPlaces,
  };
}
