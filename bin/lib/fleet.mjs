/**
 * The machine daemon — what `flowviant` runs once a credential is resolved.
 * It starts (lock, preflight, the worktree home, the signal handlers), then
 * polls GET /api/fleet/agents forever and hands each roster key to the lane
 * that owns it. Nothing here spawns a CLI on its own initiative: every turn,
 * ship, plan, merge or wiki sweep starts because a roster key named it.
 *
 * THIS FILE IS THE START SEQUENCE AND THE RECONCILE LOOP (SOLID audit
 * 2026-09-26, F038): on every roster it decides what each key means and in
 * what order. What a lane DOES lives beside it — the poll's query string
 * (fleetRoster.mjs), the machine's own reports (fleetReports.mjs), holdership
 * and the terminal signals (holder.mjs), the wiki runner (wikiRunner.mjs), the
 * checkout job lanes (fleetJobs.mjs), the start steps (fleetStartup.mjs), the
 * reconcile wait (fleetWake.mjs), and session/agent work (work.mjs).
 *
 * Over the 500-line mark as ONE LIFECYCLE, not as debt: what is left is the
 * intake order over roster keys, and most of its length is the argument for
 * that order. Moving the order out would move the reconciliation itself.
 */

import {
  VERSION,
  FLEET_URL,
  FLEET_TOKEN,
  USER_AGENT,
  MCP_URL,
  SAFE,
  RECONCILE_SECONDS,
  AUTO_UPDATE,
  CREDENTIAL,
  learnProjectId,
  storedCredentialInUse,
} from './config.mjs';
import { projectLabel } from './credentials.mjs';
import { handleVersionSignal } from './update.mjs';
import { compareVersions } from './versionOrder.mjs';
import { emitMachineEvent } from './daemonLogging.mjs';
import { writeDaemonState } from './daemonState.mjs';
import { repoRootOrDie, detectBaseRef, baseBranchName, excludeInWorktree, usableBaseRef } from './git.mjs';
import { c, info, note, ok, warn, fail } from './ui.mjs';
import { sleep } from './claude.mjs';
import { reapOrphanPreviews } from './previewRegistry.mjs';
import { preflight } from './preflight.mjs';
import { connectStream } from './stream.mjs';
import { myPubB64 } from './boxIdentity.mjs';
import { scanEnvForScrub } from './env.mjs';
import { sweepVaultArtefactsOnce } from './vaultArtefacts.mjs';
import {
  deploysInFlight,
  deploysInFlightLabels,
  processDeployJobs,
  reportDeploysAbandoned,
  whenDeploysSettle,
} from './deploy.mjs';
import { createLeave } from './standDownExit.mjs';
import { stopWorkLanes } from './standDownGate.mjs';
import { markLockDraining } from './instance.mjs';
import { reportDeployConfig } from './deployConfig.mjs';
import { probeSkillsOnce } from './runtimeCapabilities.mjs';
import { createWorkManager } from './work.mjs';
import { INTAKE_ROSTER_KEY } from './workIntake.mjs';
import { createKnowledgeSync } from './knowledge.mjs';
import { knowledgeFetcher } from './knowledgeFetch.mjs';
import { FLOWVIANT_OWN_PATHS } from './knowledgeLibrary.mjs';
import { setServerMaxTurns } from './admission.mjs';
import { ourConversationIds } from './localSessions.mjs';
import { announceFirstPoll, fetchRoster } from './fleetRoster.mjs';
import {
  maybeReportEnv,
  maybeReportLocalSessions,
  maybeReportRepoState,
  maybeReportTools,
  repoStateChanged,
  reportMachine,
} from './fleetReports.mjs';
import { createHolderWatch, obeyRosterCommands } from './holder.mjs';
import { createWikiRunner } from './wikiRunner.mjs';
import { createCleanupLane, createPatchRevertLane } from './fleetJobs.mjs';
import { installSignalHandlers, takeInstanceLockOrExit, tidyWorktreeHome, worktreeHome } from './fleetStartup.mjs';
import { createReconcileWait } from './fleetWake.mjs';

export async function runFleetDaemon({ afterLock = null } = {}) {
  let desktopProjectId = CREDENTIAL?.entry?.projectId ?? null;
  let wasServing = false;
  // `?? -1`: an unreadable target is not an applied update (and `null >= 0` is true in JS).
  if (process.env.FLOWVIANT_UPDATE_TARGET && (compareVersions(VERSION, process.env.FLOWVIANT_UPDATE_TARGET) ?? -1) >= 0)
    emitMachineEvent({ event: 'update-applied', from: process.env.FLOWVIANT_UPDATE_FROM ?? null, to: VERSION });
  console.log('');
  console.log(`  ${c.bold(c.cyan('◣ flowviant'))}  ${c.dim(`machine daemon · v${VERSION}`)}`);
  console.log(`  ${c.dim('──────────────────────────────────────────────')}`);
  const repoRoot = repoRootOrDie();
  /**
   * WHERE SHIP LANDS. Detected at startup, then OVERRIDDEN by the roster when a
   * human has chosen one (`projects.baseBranch`).
   *
   * A `let` and a getter rather than a const, because the answer can change
   * while the daemon runs — and because the detected value itself is fragile:
   * with no `origin/HEAD` set, `detectBaseRef` falls back to
   * `origin/<whatever was checked out at startup>`, which froze for the life of
   * the process. A stored value is the fix; this is the wiring that lets it
   * reach the code that merges.
   */
  let baseRef = detectBaseRef(repoRoot);
  const getBaseRef = () => baseRef;
  /**
   * THE PROJECT'S KNOWLEDGE LIBRARY (0.94.0) — synced into THIS checkout's
   * `.flowviant/knowledge/` whenever the roster's manifest moves. One copy per
   * box, in the checkout, because every worktree on the box can read an
   * absolute path (knowledge.mjs says why a copy per worktree is wrong). The
   * exclude is written first so the library never shows as a change in the
   * operator's own `git status` or in a checkout tab's diffstat.
   */
  /** The roster's `artifactsAccepted`, latest poll — see `getArtifactsAccepted`
   *  on the work manager. False until a server says otherwise. */
  let artifactsAccepted = false;
  const knowledgeSync = createKnowledgeSync({
    checkoutDir: repoRoot,
    fetchFile: knowledgeFetcher({ fleetUrl: FLEET_URL, token: FLEET_TOKEN, userAgent: USER_AGENT }),
    onExclude: (dir) => excludeInWorktree(dir, FLOWVIANT_OWN_PATHS),
    log: (line) => note(c.dim(line)),
  });
  info(SAFE ? 'mode   · safe (restricted toolset)' : 'mode   · unattended (skips permission prompts)');
  // WHICH PROJECT, before anything connects — the roster names it again a few
  // seconds later with the server's word, but "which project is this daemon
  // about to serve" must not require a network round trip to answer. Only when
  // the credential came from the STORE: a --fleet/env token names no project
  // until the roster does.
  if (CREDENTIAL?.entry && storedCredentialInUse()) {
    info(`serves · ${projectLabel(CREDENTIAL.entry)} ${c.dim(`(${CREDENTIAL.entry.projectId.slice(0, 8)}…)`)}`);
  }
  info(`repo   · ${repoRoot}`);
  info(`base   · ${baseRef}`);
  info(`server · ${FLEET_URL}`);
  console.log('');

  takeInstanceLockOrExit(repoRoot);
  // The repo binding the start path's picker or confirm was answered with.
  // Persisted HERE, after the lock, so a refused start moves nothing: moving it
  // first stranded the daemon already serving that project's own checkout at
  // its next unattended restart. Best-effort — an unwritable store costs the
  // next start a question, never this one its machine.
  try {
    afterLock?.();
  } catch {
    /* the binding is asked again next time */
  }
  writeDaemonState(desktopProjectId, { limits: {}, holder: null });

  await preflight({ needGit: true });

  // FEED THE SCRUBBER BEFORE ANYTHING CAN POST, not on the first roster tick.
  //
  // What stood here warmed the VAULT's encrypted cache off the stored
  // credential's projectId, so a worktree created on the first poll after a
  // restart was not materialized against an empty bundle. The vault is deleted;
  // the ordering lesson survives and applies to the one thing that replaced it.
  // `scrub()` redacts the checkout's own `.env*` values out of everything this
  // daemon posts, and a redactor that has not read yet redacts nothing — so the
  // first read happens here, before the first poll, rather than on the 60s beat
  // that keeps it current. A daemon that starts, immediately answers a turn and
  // posts its stream must already know what to hide.
  //
  // Best-effort and unconditional: it reads files in a directory this process
  // is already standing in, needs no credential and names no project, so the
  // whole `--fleet`-overrides-the-store hazard the old warm had to reason
  // about does not exist here.
  try {
    scanEnvForScrub(repoRoot);
  } catch {
    /* an unreadable checkout redacts nothing — the 60s beat retries */
  }

  // Kill any preview dev-server/tunnel groups a previously-crashed daemon left
  // running (detached children survive an ungraceful exit) before we start fresh.
  reapOrphanPreviews((m) => info(m));

  const { repoKey, baseDir } = worktreeHome(repoRoot);

  // WHAT THE DELETED VAULT LEFT ON THIS DISK — once, here, because this is the
  // first point at which both directories it wrote into are known. Deleting the
  // code that writes a file does not delete the file: the encrypted
  // `~/.flowviant/env-cache` and the PLAINTEXT `.env` files `materializeInto`
  // put in every worktree survive the upgrade on every box that ever ran a
  // daemon before this release. Only files carrying the vault's own header are
  // removed — see vaultArtefacts.mjs for why "no marker, no delete" is
  // absolute, and for the stated bound on the walk. Never throws, and silent
  // unless it actually removed something.
  sweepVaultArtefactsOnce({ roots: [repoRoot, baseDir], log: (m) => info(m) });

  tidyWorktreeHome(baseDir, repoRoot);
  let leaseTtlSeconds = 24 * 60 * 60; // updated from each roster response
  let mcpUrl = MCP_URL;
  let daemonAlive = true; // flipped false on shutdown so the stream stops reconnecting
  let stream = null; // push channel handle (set once the loop is set up)
  let workShutdown = null; // kills live session-turn CLIs (set with the work manager below)
  let wiki = null; // the living-wiki runner (set once the work manager exists)

  // Shutdown KEEPS the worktrees: in-flight local work survives Ctrl+C and
  // resumes in place on the next run (the task marker matches). Worktrees are
  // only removed when an agent is deleted from the roster, or by
  // `flowviant clean`.
  const teardown = () => {
    // FIRST: no lane spawns again, and no turn killed below hands back its
    // output — the process may live on to drain a deploy (standDownGate.mjs).
    stopWorkLanes();
    daemonAlive = false;
    try {
      stream?.close();
    } catch {
      /* best-effort */
    }
    // A mid-sweep wiki Claude must die with the daemon — orphaning it leaves it
    // burning quota, and a restarted daemon would start a SECOND sweep racing
    // it on the same vault dir + sync state.
    try {
      wiki?.kill();
    } catch {
      /* best-effort */
    }
    // Session-turn CLIs die with the daemon too: an orphan keeps editing the
    // session worktree and burning quota, and its live-pid lock would make the
    // restarted daemon skip that tab's turns for as long as it survived.
    try {
      workShutdown?.();
    } catch {
      /* best-effort */
    }
    // Detached tunnels survive our exit by design, so leaving them would strand
    // a public hostname until the box rebooted.
    shutdownPreviews();
  };

  // THE DISPATCH-ERA MERGE LANE IS DELETED (review 2026-09-26). It squash-
  // merged Flowvy-approved PRs on the user's gh — `--squash`, against the
  // never-squash law — and every server since the pivot sends `mergeJobs: []`
  // (a wire fossil, `rosterResponse.ts`). Merges run through `prWorkflow.mjs`
  // (session PR job, agent approve) and `shipMerge.mjs`, and nowhere else.
  const processPatchRevertJobs = createPatchRevertLane({ repoRoot });

  // ── Work sessions — the Workbench tabs ─────────────────────────────────────
  //
  // The whole machinery — per-session turn/ship chains, per-session work
  // tokens, the settle-every-turn contract, the ship executor, worktree
  // retirement — is wired by work.mjs (each lane in its own work*.mjs); this
  // hands it the loop's mutable state.
  const {
    flushWorkReports,
    learnPlaces,
    processWorkTurns,
    processShipJobs,
    processDiffJobs,
    processKillJobs,
    processPrJobs,
    processAgentPlanJobs,
    processIntakeJobs,
    processAgentTurnJobs,
    processAgentMergeJobs,
    freshenManualPlaces,
    heldSessionIds,
    processPreviewJobs,
    livePreviewIds,
    retirePreviews,
    shutdownPreviews,
    retireWorkSessions,
    reportWorktrees,
    shutdownWork,
    settleAgentTurns,
    workBusy,
    admit,
    liveTurns,
  } = createWorkManager({
    repoRoot,
    baseDir,
    getBaseRef,
    getMcpUrl: () => mcpUrl,
    getLeaseTtl: () => leaseTtlSeconds,
    /**
     * The cartographer is a CLI turn too, and it is the one this manager cannot
     * see — it lives in the wiki runner (wikiRunner.mjs), not in
     * `workChildren`. Without it the machine's ceiling would be a ceiling with
     * a hole in it: a wiki sweep over a large repo is one of the heaviest turns
     * the daemon runs.
     *
     * Read lazily (it is only ever called from the reconcile loop, long after
     * `wiki` is created below), for the same reason `onRepoChanged` is a
     * callback: work.mjs is imported BY this file and cannot import back. What
     * it counts is the runner's to say — see `liveTurns` there.
     */
    extraLiveTurns: () => wiki?.liveTurns() ?? 0,
    /**
     * Whether the server takes artifacts — the roster's own word, latest poll
     * (2026-09-22). Read lazily for the reason above: the roster loop that
     * writes it runs long after this manager is built.
     */
    getArtifactsAccepted: () => artifactsAccepted,
    /**
     * "THE REPO JUST CHANGED — look again."
     *
     * `maybeReportRepoState` is on its own 60s wall clock and nothing ever
     * reset it, so every Flowviant action that alters the branch/worktree
     * picture — a ship deleting the merged branch, retirement removing a
     * directory and pruning, a tab being cut — left the rail's Repository block
     * listing things that no longer exist for up to a minute. It is the same
     * rule the diffstat just learned: an action that changes what the machine
     * would measure must cause a new measurement.
     *
     * A callback rather than an export because work.mjs is imported BY this
     * file, so it cannot import back. Clearing the timestamp is enough — the
     * next reconcile does the scan, on the beat it already runs.
     */
    onRepoChanged: () => {
      repoStateChanged();
    },
  });
  workShutdown = shutdownWork; // teardown can now reach the live session CLIs

  const processCleanupJobs = createCleanupLane({ repoRoot, getBaseRef });

  // Living-wiki work: one cartographer turn at a time, off the agents'
  // checkouts (wikiRunner.mjs). Wiki work needs no agent online.
  wiki = createWikiRunner({ repoRoot, baseDir, repoKey, getBaseRef, admit });
  /**
   * IS THIS MACHINE WORKING — every lane this process runs: the wiki
   * cartographer, session and agent work (`workBusy` — turns, plans, merges,
   * ships, undelivered settles), and deploys.
   *
   * One predicate for the two callers that must not restart the daemon under
   * work: the self-update gate above, and the desktop app's automatic install,
   * which reads it from `status --json` (`busy`, written each tick by
   * `reportBusy`, 2026-09-26 — SOLID F034). The tray used to infer idleness
   * from the server's list of WORKING AGENTS, which cannot see a Workbench
   * turn, a ship or a deploy.
   */
  const machineBusy = () => wiki.busy() || workBusy() || deploysInFlight() > 0;
  const reportBusy = () =>
    writeDaemonState(desktopProjectId, { busy: machineBusy(), busyAt: new Date().toISOString() });
  /**
   * HOW EVERY STAND-DOWN LEAVES — after the teardown, and after any deploy in
   * flight has finished and reported (standDownExit.mjs, ruling 2026-09-26).
   * The signal handlers are installed here, beside it, rather than at the
   * teardown: nothing between the two awaits, so no signal could have been
   * handled any earlier.
   */
  const leave = createLeave({
    inFlight: deploysInFlight,
    labels: deploysInFlightLabels,
    settled: whenDeploysSettle,
    abandon: reportDeploysAbandoned,
    markDraining: (what) => markLockDraining(FLEET_TOKEN, what),
    // The tray reads this as working (its `stopped` came first, from the
    // stand-down itself); `deploy` is the same `target → env` words.
    announce: (what) => emitMachineEvent({ event: 'draining', deploy: what }),
    reportBusy,
    exit: (code) => process.exit(code),
    log: { note, warn },
  });
  installSignalHandlers(teardown, leave);

  let connected = false; // log the first successful poll once
  let rosterSig = null; // last roster membership, to log changes only
  let idleBeatAt = 0; // throttle the "still alive" idle heartbeat
  // WHOSE MACHINE THIS IS, as of the last poll the server arbitrated. 'absent'
  // is the reserved meaning — an older server, or a poll with no envpub — and
  // everything downstream of it must read exactly as it did before 0.84.0.
  const holderWatch = createHolderWatch({ say: (m) => note(m) });
  let holderState = 'absent';

  // ── Push channel: a server wake short-circuits the reconcile sleep (see
  // fleetWake.mjs). The socket only nudges — we still fetch the roster below.
  const { fireWake, waitReconcile } = createReconcileWait();
  stream = connectStream({ onWake: () => fireWake(), isAlive: () => daemonAlive });
  // Reconcile loop: poll the roster, hand each key to its lane, report, wait.
  //
  // A STAND-DOWN ENDS THE LOOP, WHICHEVER DOOR IT CAME THROUGH. The roster
  // stand-downs and the revoked credential `return` where they happen; a
  // SIGNAL arrives between awaits, from outside, so every await in the loop is
  // followed by the same question (`standingDown`) and the loop returns into
  // `leave`'s wait. Past this line nothing takes work: no poll, no turn, no
  // share, no new deploy — only the deploys already claimed run on to their
  // report (standDownExit.mjs).
  const standingDown = () => leave.leaving();
  for (;;) {
    if (standingDown()) return leave.drained();
    let roster;
    try {
      // The churn admission, asked ONCE here and relayed as `pr`: the same
      // question every unattended lane asks a few lines later, so what the
      // board is told and what the machine then does cannot disagree.
      roster = await fetchRoster(
        livePreviewIds(),
        heldSessionIds(),
        admit('churn'),
        repoRoot,
        getBaseRef()
      );
    } catch (e) {
      if (standingDown()) return leave.drained();
      if (e.auth) {
        emitMachineEvent({ event: 'stopped', reason: 'credential-revoked' });
        fail(`${e.message} — credential revoked or invalid. Shutting down.`);
        teardown();
        // EXIT 0, for the same reason the commanded-stop path does: a revoked
        // credential is a terminal, asked-for-by-someone state, and a relaunch
        // can never fix it. Under `Restart=on-failure` a nonzero code has
        // systemd relaunch the daemon immediately — a restart loop hammering
        // dead-credential polls, fighting the Disconnect that revoked it, and
        // ending in a unit that reads as a crash rather than a kill. Through
        // `leave`, so a deploy in flight still finishes; its report will most
        // likely be refused too, and the lease says so in words.
        await leave(0);
        return;
      }
      warn(`roster poll failed: ${e.message} — retrying in ${RECONCILE_SECONDS}s`);
      // Work already running keeps running offline; the measurement keeps up.
      reportBusy();
      await sleep(RECONCILE_SECONDS);
      continue;
    }
    if (standingDown()) return leave.drained();
    if (!connected) {
      connected = true;
      ok('Connected to Flowviant — watching your roster.');
      announceFirstPoll(roster);
    }
    if (roster.project?.id) desktopProjectId = roster.project.id;
    writeDaemonState(desktopProjectId, { lastPoll: new Date().toISOString() });
    if (roster.mcpUrl) mcpUrl = roster.mcpUrl;
    /**
     * HOW MANY TURNS THE APP SAYS THIS MACHINE MAY RUN (2026-09-17).
     *
     * Set on EVERY poll, including the ones that carry no key — absence is how
     * "Auto" is spelled and how an older server looks, and both mean the
     * derivation stands. Leaving a previous value in place on an absent key
     * would make turning the dial back to Auto unspellable, which is the
     * learn-only bug `listSessionPlaces` already paid for once.
     *
     * HERE, ABOVE EVERY LANE, so a number that arrived on this poll binds the
     * spawns this same reconcile is about to decide. The `mt` the NEXT poll
     * reports is therefore the value that was actually in force.
     */
    setServerMaxTurns(roster.maxTurns);
    if (roster.project?.id) wiki.setProjectId(roster.project.id); // keys the vault dir
    // The server's word on which project this token serves — settles the env
    // report's salt for a token that came from --fleet or the environment.
    learnProjectId(roster.project?.id);
    if (roster.leaseTtlSeconds) leaseTtlSeconds = roster.leaseTtlSeconds;
    // THE THREE SIGNALS THAT END THIS DAEMON — a commanded stop, then a
    // displacement, then a removal (holder.mjs, `obeyRosterCommands`). ABOVE
    // the holder observation and the version signal: `handleVersionSignal` can
    // re-exec this process, and a machine somebody just stopped, moved or
    // removed coming back up wearing a newer version is the one outcome nobody
    // asked for.
    if (
      await obeyRosterCommands(roster, {
        settleAgentTurns,
        flushWorkReports,
        teardown,
        exit: (code) => leave(code),
      })
    )
      return;
    if (standingDown()) return leave.drained();
    /**
     * WHOSE MACHINE THIS IS. Absent = a server that does not arbitrate, and then
     * this is a no-op and the daemon behaves exactly as 0.83.0 did.
     *
     * A standby keeps polling and keeps everything the restricted roster still
     * drives — its `activeWorkSessions` is credential-scoped and correct, so the
     * sweep below is unchanged behaviour and must not be skipped, or a standby
     * would start deleting worktrees it cannot see the tabs for.
     */
    holderState = holderWatch.observe(roster.holder);
    writeDaemonState(desktopProjectId, {
      lastPoll: new Date().toISOString(),
      holder: ({ mine: 'serving', standby: 'inactive' })[holderState] ?? null,
    });
    if (holderState === 'mine' && !wasServing) emitMachineEvent({ event: 'serving' });
    wasServing = holderState === 'mine';
    // Keep the daemon current. Safe = nothing mid-work (`machineBusy`). If it
    // self-updates it re-execs into the new version and this process becomes a
    // proxy — stop the loop.
    if (roster.daemon) {
      // "Nothing mid-work" must include the wiki runner: updating mid-sweep
      // re-execs the daemon, orphans the wiki Claude, and the fresh process
      // starts a second sweep racing it on the same vault. And it must include
      // SESSION work (workBusy — turns, ships, undelivered settle reports): a
      // re-exec mid-turn SIGTERMs the tab's CLI and settles a partial answer.
      //
      // ONE ANSWER to "is this machine working?" (`machineBusy`), the
      // same one the desktop app's auto-install reads — which is how a deploy
      // in flight joined this gate (2026-09-26): re-exec'ing under one would
      // stop its heartbeat mid-run.
      const safeToUpdate = !machineBusy();
      const updating = handleVersionSignal({
        latest: roster.daemon.latest,
        min: roster.daemon.min,
        autoUpdate: AUTO_UPDATE,
        safeToUpdate,
        teardown,
      });
      if (await updating) return;
      if (standingDown()) return leave.drained();
    }
    // Settle any turn/ship answers whose earlier report POST failed BEFORE
    // taking new work — the skip-if-pending guards make the ordering safe, but
    // delivering first keeps the tab honest a poll sooner.
    void flushWorkReports();
    processPatchRevertJobs(roster.patchRevertJobs);
    // WHERE each live tab works, BEFORE anything measures one: the sweep below
    // and every preview check ask `placeOf`, and a tab nobody has typed into
    // yet has taught it nothing.
    learnPlaces(roster.sessionPlaces);
    processWorkTurns(roster.workTurnJobs);
    // The roster's live-session list rides along: an ENDED session's ship
    // must not be refused by checks whose remedies need a live tab.
    processShipJobs(roster.shipJobs, roster.activeWorkSessions);
    // AFTER the work/ship intake: retirement is the server saying which
    // sessions are LIVE, and the guards above (chains, shipping) are populated
    // by the intake this same tick.
    // BEFORE retirement, and the order is load-bearing: `git worktree remove`
    // under a running dev server leaves it serving bytes from open file handles
    // in a directory that no longer exists — a human is shown the wrong thing
    // and nothing errors anywhere.
    retirePreviews(roster.activeWorkSessions);
    // THEN the process the tunnel pointed at, and only then the worktree. A
    // viewer must not see a 502 from a gate whose origin vanished, and
    // `retireWorkSessions`'s dirty check inspects only TRACKED files — so
    // `git worktree remove` would happily pull the directory out from under a
    // running node process, which then serves bytes from open file handles in
    // a directory that no longer exists, with no error anywhere.
    /**
     * WHERE SHIP LANDS, if a human has chosen. Absence means "you decide" —
     * the state every daemon was in before this existed, and what an
     * unconfigured project still means — so it must NOT clear a detection.
     * Announced on change, because a silent switch of merge target is the one
     * thing worse than not offering the choice at all.
     */
    if (typeof roster.baseBranch === 'string' && roster.baseBranch.trim()) {
      const want = usableBaseRef(repoRoot, `origin/${baseBranchName(roster.baseBranch.trim())}`);
      if (want !== baseRef) {
        note(`base   · ${want} ${c.dim('(set for this project)')}`);
        baseRef = want;
      }
    }
    // A session another daemon on this credential is serving is NOT a closed
    // tab. Without this the daemon that lost the lease removes the worktree the
    // winner is working in — absence would mean "somebody else won" instead of
    // "the tab closed".
    retireWorkSessions(roster.activeWorkSessions, roster.sessionsHeldElsewhere);
    // Diffs somebody has open and is waiting on. Project-scoped rather than
    // per-session: `git show` runs from the repo ROOT, which can see a closed
    // tab's branch and a shipped commit on main alike.
    processDiffJobs(roster.diffJobs);
    // The knowledge library: synced when its rev moves, left ALONE when the key
    // is absent (an older server, or a project that never had one). Never
    // awaited — a fifty-megabyte library must not hold a roster tick, and the
    // sync serialises itself. The next turn to spawn after it lands reads it.
    void knowledgeSync.onRoster(roster.knowledge);
    // ARTIFACTS (0.94.0): the server's own word on whether it can show one,
    // re-read every poll. Absent is an older server and means false — the turn
    // prompts then say nothing about a panel nobody can draw.
    artifactsAccepted = roster.artifactsAccepted === true;
    // Shares to open or tear down. CLAIMED before acted on — two daemons on one
    // credential are both handed this array, and both opening a tunnel strands
    // a public hostname nobody can settle.
    processPreviewJobs(roster.previewJobs);
    // One measured process a human asked to stop. Claimed before acted on for
    // the same reason a share is, and re-verified against the kernel inside —
    // the pid on this job is a request, never an authority, because pids are
    // recycled and the row the browser clicked is up to a sweep old.
    processKillJobs(roster.killJobs);
    // PR-mode work (push + open, or merge) — leased like a kill: two daemons
    // pushing one branch would open two PRs. Runs under the operator's own
    // `gh` credential; a settle never closes a card (done is observed by the
    // landed walk when the merge reaches base).
    processPrJobs(roster.prJobs);
    // A Deploy press waiting for a plan. AFTER the job lanes above and before
    // the worktree report, for no reason other than that it reads directories
    // those lanes may still be writing — it measures, so a stale read is a
    // slightly worse hint and never a wrong action.
    processAgentPlanJobs(roster.agentPlanJobs);
    processIntakeJobs(roster[INTAKE_ROSTER_KEY]);
    // …and an agent's next card. After the plan jobs because a press becoming
    // agents is the thing that produces these.
    processAgentTurnJobs(roster.agentTurnJobs);
    // …and a branch somebody approved. After the turns: a merge takes the
    // place's WRITER lock, and writer preference means it goes ahead of any
    // reader queued behind it anyway.
    processAgentMergeJobs(roster.agentMergeJobs);
    // Catch each person's manual worktree up to base while it is clean. Silent,
    // fast-forward only, and it never touches an agent's branch.
    freshenManualPlaces();
    // …and what the SURVIVING ones hold: branch, ahead-of-base, diffstat.
    // Throttled inside, never awaited — a `git status` the human cannot run
    // themselves from a browser, relayed. After retirement so a directory that
    // just went away is not reported as a place.
    reportWorktrees(roster.activeWorkSessions);
    // Terminal-session presence, throttled + dedup'd inside; never awaited —
    // the daemon's own worktrees are carved out (a session the daemon spawned
    // is already a tab, not something to offer adopting).
    void maybeReportLocalSessions({
      repoRoot,
      excludeDirs: [baseDir],
      // …and our OWN tabs' conversations. Only the CHECKOUT needs this: every
      // other place is under `baseDir` and already fenced by directory, while
      // the operator's tabs share the checkout with real terminal sessions and
      // cannot be. See `ourConversationIds`.
      excludeIds: ourConversationIds(repoRoot),
    });
    // …and the repo itself: every worktree and every branch, ours and not.
    // Never awaited, throttled inside, and silent on an older server.
    void maybeReportRepoState({ repoRoot, baseRef });
    // WHAT `/` CAN OFFER, on a machine no turn has taught yet. One-shot and
    // self-cancelling (it returns immediately if a turn has already reported),
    // never awaited, and it lands in the cache that the NEXT poll reads — so
    // nothing here waits on a child process. In the loop rather than at
    // startup on purpose: a daemon that has been up since before this release
    // gets measured too, without needing a restart to earn its own menu.
    probeSkillsOnce(repoRoot);
    processCleanupJobs(roster.cleanupJobs);
    // Announce roster membership only when it changes (not every poll).
    const sig = [...new Set(roster.agents.map((a) => a.agentId))].sort().join(',');
    if (sig !== rosterSig) {
      rosterSig = sig;
      // `agents` is permanently [] — the lanes it counted died with dispatch
      // and the array survives only as wire compat, so this runs once, on the
      // first poll. It used to point at the Cockpit, a surface deleted
      // 2026-08-04 that now redirects to the Board. Say what is actually true
      // instead: the machine is up, and work starts in a tab.
      // …unless another box holds the machine. A standby IS connected and IS
      // polling, and saying "machine online" over a daemon the server hands
      // nothing would contradict the standby line printed a moment earlier.
      if (holderState !== 'standby')
        info('Machine online. Open a tab in Flowviant → Terminal to start working.');
    }
    // Heartbeat so a quiet daemon visibly stays alive. Gated on REAL work —
    // it was once gated on `roster.agents`, which the server sends permanently
    // empty, and printed "waiting" once a minute even while a tab's turn was
    // running. `workBusy()` is the honest question: are there session turns,
    // ships or unsettled reports in flight?
    if (!workBusy() && Date.now() - idleBeatAt > 60_000) {
      idleBeatAt = Date.now();
      // `inactive`, the owner's own word for this state since 2026-09-21 — the
      // same word the app's machines list and `flowviant machines` print for
      // this box. The internal state is still called `standby` because it names
      // the SERVER'S arbitration arm rather than anything a person reads; what
      // a person reads is this sentence.
      info(
        holderState === 'standby'
          ? 'inactive — another machine is serving this project.'
          : 'machine online — nothing running right now.'
      );
    }

    wiki.onRoster(roster);

    // WHAT IS IN THIS BOX'S ENV, by name, on its own 60s beat. Never awaited,
    // throttled and deduped inside, and silent forever on an older server.
    // This is what replaced the vault's sync tick — see `maybeReportEnv`.
    void maybeReportEnv(repoRoot);
    void maybeReportTools(repoRoot, getBaseRef());

    // Tell the app what this machine is doing with itself (fleetReports.mjs).
    reportMachine({ worktreeDir: baseDir, liveTurns });

    // Deploy: a daemon on a project with deploy ALLOWED reports its
    // .flowviant/deploy.json and runs queued deploy jobs (the server only sends
    // deployJobs to such projects). Config report is cheap + dedup'd; jobs are
    // single-flight.
    //
    // `roster.deployAllowed`, a top-level boolean the server sends only when
    // TRUE — it used to be `roster.env.deployAuthorized`, read off the vault's
    // own roster block. The fact never belonged there: since migration 0096 the
    // answer comes from the PROJECT row (`projects.deploy_allowed`, owner-only,
    // off by default), not from a per-device column on an enrolled daemon —
    // "every device on a project shares one credential, so a boundary between
    // them is not a boundary". The vault's block is gone; the switch is not, and
    // this is where it now arrives. Absence reads as NOT allowed, which is the
    // withholding direction and the right one for an irreversible act.
    if (roster.deployAllowed) {
      // The BASE branch's copy, not the working tree's — see readDeployConfig.
      // Reporting the working tree would advertise targets the runner will not
      // find, which is the same lie in the other direction.
      void reportDeployConfig(repoRoot, getBaseRef());
      processDeployJobs(roster.deployJobs, { repoRoot, baseRef: getBaseRef(), myPubB64 });
    }

    // THE LOCAL BUSY MEASUREMENT, after this tick's intake so a turn it just
    // started is already counted (see `machineBusy`).
    reportBusy();
    // Idle until the next poll deadline OR a push wake — whichever comes first.
    await waitReconcile();
  }
}
