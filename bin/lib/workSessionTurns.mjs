/**
 * A WORKBENCH TAB'S TURN — offered, admitted, placed, adopted, pinned to its
 * CLI, credentialed, resumed, run, persisted and settled.
 *
 * Split out of work.mjs (2026-09-26, SOLID F037). This is ONE lifecycle and it
 * stays one function on purpose — the order of its refusals IS the contract
 * (no place, no worktree, a live lock, the wrong brain, no credential: each
 * settles in words or waits, before anything is spawned), and pulling its
 * steps apart would scatter that order across files. What it USES and does not
 * own went to siblings, each named at the factory call in work.mjs: the place
 * and its markers (workPlaces.mjs), the settle queue (workReportQueue.mjs),
 * the credential (workSessionTokens.mjs), the runtime pin (workSessionRuntime
 * .mjs), the adopt carry (workAdoptCarry.mjs), attachments
 * (workAttachments.mjs), the live line (workNarration.mjs), the tool log
 * (workToolLog.mjs) and the command audit (workCommandAudit.mjs).
 */
import { existsSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { git, isSafePathSegment } from './git.mjs';
import { processStartTime } from './procRegistry.mjs';
import { c, note, ok, warn } from './ui.mjs';
import { mcpFor } from './claude.mjs';
import { runTurn as defaultRunTurn } from './runTurn.mjs';
import { addUsage } from './turnUsage.mjs';
import {
  SYSTEM_WORK,
  SYSTEM_CAPTURE,
  WORK_TURN_KICKOFF,
  CAPTURE_TURN_KICKOFF,
  SYSTEM_WORK_PLAIN,
  WORK_TURN_KICKOFF_PLAIN,
  withProjectContext,
} from './prompts.mjs';
import { knowledgeDirFor } from './knowledgeFiles.mjs';
import { scrub as envScrub } from './uplinkScrub.mjs';
import { recordSkills, recordMcpServers } from './runtimeCapabilities.mjs';
import { isTerminalSessionLive } from './claudeSessions.mjs';
import { isAgyConversationLive } from './agySessions.mjs';
import { resumeRetriesFresh } from './resumeLost.mjs';
import { turnLockedByLivePid } from './turnLock.mjs';
import { brainFor } from './workBrain.mjs';
import { REPO_PLACE } from './workPlaces.mjs';
import { CODEX_THREAD_RE, AGY_CONV_RE } from './workSessionRuntime.mjs';
import { createToolLog } from './workToolLog.mjs';
import { createCommandAudit } from './workCommandAudit.mjs';

/**
 * THE ONE SENTENCE A PLAN TURN'S SYSTEM PROMPT GAINS (0.97.0), composed here
 * rather than in prompts.mjs because it is a MODIFIER on whichever contract
 * the tab runs, not a contract of its own.
 *
 * The enforcement is not this sentence — it is `--permission-mode plan`, under
 * which the CLI itself refuses every write (claudePosture.mjs, PLAN_MODE_PERM). What
 * the sentence buys is the ANSWER: the plain contract above it says "edit
 * freely, commit", and a turn told only that would spend itself discovering
 * refusals. It also says not to reach for `ExitPlanMode` (measured: disabled
 * under `-p`, and the probe turn then asked the person to leave plan mode
 * themselves) — leaving plan mode is the person's switch in the tab.
 */
export const PLAN_TURN_SENTENCE =
  'THIS IS A PLANNING TURN: the person switched this tab to plan mode, so read what you need, decide, and answer with the plan itself as your reply — change nothing (the CLI refuses every write this turn, whatever the mechanics above say about editing, committing or artifacts), and do not try to leave plan mode; they switch it off in the tab when they want the plan carried out.';

export function createWorkSessionTurns({
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
  // The real CLI driver; injectable only so the lane can be driven in a test
  // without spending a model turn (the wiki runner's shape).
  runTurn = defaultRunTurn,
}) {
  const workAnswering = new Set(); // turn ids currently queued/running here
  const MAX_WORK_TRIES = 3;

  const processWorkTurns = (jobs) => {
    for (const job of jobs ?? []) {
      if (!job || typeof job.id !== 'string' || !job.body || !job.sessionId) continue;
      if (workAnswering.has(job.id)) continue;
      // The turn already RAN and its answer sits in the delivery queue — never
      // run it again while the report is merely undelivered.
      if (pendingWorkReports.has(job.id)) continue;
      /**
       * THE BOX IS ABOUT TO FALL OVER, OR THIS MACHINE IS ALREADY AT ITS
       * CEILING. Defer: return without settling and without consuming an
       * attempt — the shape the live-CLI lock below uses, for the same reason.
       * The job stays pending and the server re-offers it next poll; settling
       * it would tell the human their message failed when nothing ran.
       *
       * `interactive`, not `churn`: somebody is watching a composer they just
       * pressed enter in, so this holds out until the box is genuinely about to
       * die rather than yielding early the way the unattended lanes do.
       *
       * AND THE SLOT IS RESERVED BEFORE THE NEXT ITERATION ASKS. This loop is
       * synchronous and every spawn under it is not — `inPlace` resolves its
       * callback in a later microtask — so `liveTurnCount()` could not move
       * between jobs and a roster offering eight turns admitted all eight
       * against a ceiling of one. See admission.mjs.
       */
      const hold = admit('interactive');
      if (hold) {
        sayTurnDeferred(job.sessionId, job.id, hold.reason);
        continue;
      }
      const releaseSlot = admit.reserve();
      lastDeferSaid.delete(job.sessionId);
      workAnswering.add(job.id);
      const place = job.place || job.sessionId;
      /**
       * VALIDATED AT THE TRUST BOUNDARY, exactly as `learnPlaces` validates
       * the roster's map — this is the OTHER writer of `sessionPlaces`, in the
       * same reconcile tick, BEFORE the preview jobs and the sweep read it. An
       * unchecked value stored here reaches every `placeDir` consumer: the
       * turn is spawned in it, `burstListeners` measures it, and a share would
       * publicly tunnel a directory OUTSIDE the checkout — the exact traversal
       * the preview feature's port attribution exists to prevent. Settled out
       * loud rather than skipped, because a silently dropped turn strands the
       * tab for the server's whole expiry window.
       */
      if (place !== REPO_PLACE && !isSafePathSegment(place)) {
        void settleWorkTurn(job.id, {
          ok: false,
          answer:
            'the server named a working directory this machine refuses to use — close and reopen the tab, then send the message again',
        }).finally(() => workAnswering.delete(job.id));
        releaseSlot();
        continue;
      }
      // Remembered for every other beat — the sweep, ship, the preview
      // re-check — so they all ask the same directory this turn runs in.
      sessionPlaces.set(job.sessionId, place);
      // A READER: other turns in this place run alongside it. See `inPlace`.
      inPlace(place, false, async () => {
        /** This turn's artifact snapshot — set once the place is resolved and
         *  a CLI is about to spawn there; read in the `finally`. Null on every
         *  path that never ran a CLI, which is exactly when nothing is new. */
        let artifactScan = null;
        /** This turn's tool log — declared HERE, outside the `try`, because
         *  the `catch` below spreads it into the failed settle. Declared inside,
         *  the catch threw a ReferenceError instead of settling: the error's
         *  words were lost and the turn was re-offered and re-run. Null until
         *  the turn gets as far as building one. */
        let toolLog = null;
        /**
         * WHAT THIS TURN SPENT, AS THE CLI COUNTED IT (2026-09-28) — declared
         * out here for the same reason as the tool log: the `catch` spreads it
         * into the failed settle. SUMMED over both spawns (turnUsage.mjs): a
         * resume that came back empty and its fresh retry both spent tokens.
         * Null until a CLI reports, so every refusal before a spawn carries
         * none, which is what `...(usage ? … : {})` rests on. The server
         * charges it once per turn, behind a one-shot claim, so a settle that
         * sits in the retry queue and is posted again adds nothing.
         */
        let usage = null;
        /** THE MODEL THE TURN RAN ON, as its CLI named it (turnModel.mjs) —
         *  out here beside `usage`, and spread wherever it is. Last write wins
         *  across a fresh retry: that spawn is the one that answered. */
        let model = null;
        try {
          const tries = workAttempts.get(job.id) ?? 0;
          if (tries >= MAX_WORK_TRIES) {
            // Out of local tries: SETTLE, don't skip — a silently skipped turn
            // strands the tab for the server's whole 24h expiry window.
            await settleWorkTurn(job.id, {
              ok: false,
              answer: `the turn failed ${tries} times on this machine — check the daemon log, then send the message again`,
            });
            return;
          }
          note(
            `${c.cyan('tab')} ${c.dim(`— ${job.askedByName || 'the owner'} in "${job.sessionName || 'a session'}"`)}`
          );
          // ── ADOPTION: a tab born from a TERMINAL session ────────────────
          // The server sends `adopt {id, cwd}` only while the session has no
          // sessionRef — no turn has ever spoken from a worktree here — and
          // the first turn resumes the terminal conversation by forking it
          // into the tab's own worktree. Everything the server asserts is
          // re-validated MACHINE-side: the id shape, the source directory,
          // and — decisive — that the terminal is actually closed, because
          // forking a session someone is still typing into puts two Claudes
          // on one conversation.
          const adopting = Boolean(job.adopt) && !job.sessionRef;
          let srcHead = null;
          let adoptSrc = null; // the validated, realpath'd source checkout
          if (adopting) {
            if (
              typeof job.adopt.id !== 'string' ||
              !/^[0-9a-f][0-9a-f-]{6,62}$/i.test(job.adopt.id)
            ) {
              await settleWorkTurn(job.id, {
                ok: false,
                answer: 'that terminal session id is not one this machine can resume',
              });
              return;
            }
            let srcCwd = null;
            try {
              srcCwd = realpathSync(String(job.adopt.cwd ?? ''));
              if (!statSync(srcCwd).isDirectory()) srcCwd = null;
            } catch {
              srcCwd = null;
            }
            if (!srcCwd) {
              await settleWorkTurn(job.id, {
                ok: false,
                answer: "the terminal session's directory no longer exists on the machine",
              });
              return;
            }
            // Inside the repo, outside the daemon's own worktrees: an adopt
            // source is a HUMAN's checkout, and one of our directories showing
            // up here means a stale or confused offer, not a session to fork.
            const under = (p, root) =>
              p === root || p.startsWith(root.endsWith('/') ? root : `${root}/`);
            let realRoot = repoRoot;
            let realBase = baseDir;
            try {
              realRoot = realpathSync(repoRoot);
            } catch {
              /* keep the literal path */
            }
            try {
              realBase = realpathSync(baseDir);
            } catch {
              /* keep the literal path */
            }
            if (!under(srcCwd, realRoot)) {
              await settleWorkTurn(job.id, {
                ok: false,
                answer: "the terminal session's directory is outside this project's repository",
              });
              return;
            }
            if (under(srcCwd, realBase)) {
              await settleWorkTurn(job.id, {
                ok: false,
                answer:
                  "that directory is one of the daemon's own worktrees — its session is already a tab, not something to adopt",
              });
              return;
            }
            try {
              srcHead = git(['rev-parse', 'HEAD'], srcCwd);
            } catch {
              await settleWorkTurn(job.id, {
                ok: false,
                answer:
                  "the terminal session's directory is not a usable git checkout (no HEAD to branch from)",
              });
              return;
            }
            // Liveness by the SESSION's own runtime: Claude has a real pid
            // registry; agy only leaves store-write recency + a process check,
            // and adoption there is a MOVE (no fork exists), so the composite
            // errs toward refusing — a false "live" costs a retry in minutes,
            // a false "ended" puts two drivers on one conversation store.
            const adoptLive =
              job.runtime === 'antigravity'
                ? isAgyConversationLive(job.adopt.id)
                : isTerminalSessionLive(job.adopt.id);
            if (adoptLive) {
              await settleWorkTurn(job.id, {
                ok: false,
                answer:
                  'That terminal session is still open on the machine — close it there first, then adopt.',
              });
              return;
            }
            adoptSrc = srcCwd;
          }
          // Based at the SOURCE's HEAD when adopting — the resumed
          // conversation was had against those commits, not the project base.
          // The PLACE this tab works in — its own worktree unless the server
          // named another. An older server sends no `place` and the default is
          // the session's own id, which is what every tab has always done.
          const dir = placeWtFor(place, adopting ? srcHead : undefined);
          if (!dir) {
            await settleWorkTurn(job.id, {
              ok: false,
              answer:
                'the session worktree could not be opened on the machine — check the daemon log',
            });
            return;
          }
          // A live CLI is ALREADY in this worktree — this daemon's previous
          // life, most likely; the lock outlives a restart. Leave the job
          // pending and look again next poll; spawning a second CLI would put
          // two Claudes in one held context. Costs no attempt: nothing ran.
          const lockPath = sessionMetaPath(dir.wt, 'flowviant-turn.lock');
          if (turnLockedByLivePid(lockPath)) {
            warn(
              `a turn is already running in "${job.sessionName || job.sessionId}" — waiting for it to finish`
            );
            return;
          }
          // WHICH BRAIN the roster says this tab speaks (null/absent = Claude,
          // which is what every tab ran on until now) — honored by
          // sessionRuntime: on a first turn a named runtime IS the pick, and a
          // named runtime that disagrees with the pin settles below.
          // What the artifact directory held BEFORE this turn — the capture chat
          // excepted: it runs read-only, is never told about artifacts, and
          // whatever sibling tabs wrote in this shared place is theirs.
          if (job.capture !== true) artifactScan = { dir: dir.wt, before: beforeArtifacts(dir.wt) };
          const rt = sessionRuntime(dir.wt, job.runtime || null, job.sessionId);
          if (rt.mismatch) {
            // Something upstream changed this tab's identity mid-life. A held
            // context must never be answered by a different brain — say so.
            await settleWorkTurn(job.id, {
              ok: false,
              answer: `this tab is pinned to ${rt.mismatch.pin} but the server says it is a ${rt.mismatch.runtime} tab — reopen a new tab`,
            });
            return;
          }
          if (rt.missing) {
            await settleWorkTurn(job.id, {
              ok: false,
              answer: `this session runs on ${rt.missing}, which is no longer installed on the machine — reinstall it, or open a new tab`,
            });
            return;
          }
          if (rt.unsupported) {
            // A pin from before the session-capable gate existed — or a
            // first-turn tab the server named for one — can carry a runtime no
            // tab can run on (Antigravity has no MCP config, and the session's
            // whole control plane rides one). An honest sentence beats the
            // mcpFor throw this used to crash into every turn.
            await settleWorkTurn(job.id, {
              ok: false,
              answer: `this session runs on ${rt.unsupported}, which cannot drive a Terminal tab on this machine — open a new tab`,
            });
            return;
          }
          if (!rt.id) {
            await settleWorkTurn(job.id, {
              ok: false,
              answer:
                'No coding CLI is installed on the machine — install Claude Code (or another supported CLI), then send the message again',
            });
            return;
          }
          if (adopting && rt.id !== 'claude' && rt.id !== 'antigravity') {
            // An adopt id names a conversation in ITS OWN CLI's store: claude
            // forks it (--resume --fork-session), agy moves it
            // (--conversation). Codex has no adoptable store yet, and its
            // args builder backstops this with a loud throw — but a sentence
            // here beats a stack there.
            await settleWorkTurn(job.id, {
              ok: false,
              answer:
                'adopting this terminal session needs its own CLI on the machine — install it, then try again',
            });
            return;
          }
          /**
           * A PLAN TURN (0.97.0): the tab's switch, off the job. CLAUDE ONLY —
           * `--permission-mode plan` is Claude Code's, and a codex or agy turn
           * has no way to spell it, so it is refused HERE in words rather than
           * run as a build turn wearing the word. The server never sends the
           * key for a non-Claude tab; this is the machine's own half. Never on
           * a capture chat, which is read-only by its own profile already.
           */
          const planTurn = job.planMode === true && job.capture !== true;
          if (planTurn && rt.id !== 'claude') {
            await settleWorkTurn(job.id, {
              ok: false,
              answer: `plan mode runs on Claude Code only, and this tab is ${rt.id} — turn plan off in the tab, then send the message again`,
            });
            return;
          }
          // A PLAIN tab (agy) mounts no MCP: no credential to mint, no config
          // to write. The trade is stated in SYSTEM_WORK_PLAIN — no cards, no
          // streaming — and the honesty survives on the existing rails: the
          // answer lands via work-turn-done, the rail says "no card yet", and
          // ship-time reconciliation books every branch commit.
          const plainTab = rt.id === 'antigravity';
          let mint = null;
          if (!plainTab) {
            mint = await mintWorkToken(job.sessionId);
            if (!mint) mint = await mintWorkToken(job.sessionId, true); // one transient blip ≠ a dead turn
            // Another daemon on this credential holds the session. Return
            // WITHOUT settling: the holder is answering this same turn, and
            // settling it here — even as a failure — would race the real
            // answer and could win. Dropping it means the turn stays pending
            // and the holder's answer lands, which is the whole point.
            if (mint?.heldElsewhere) {
              workAnswering.delete(job.id);
              return;
            }
            if (mint?.gone) {
              await settleWorkTurn(job.id, {
                ok: false,
                answer:
                  'Flowviant no longer offers this session to this machine — the tab may have been closed or moved',
              });
              return;
            }
            if (!mint?.token) {
              await settleWorkTurn(job.id, {
                ok: false,
                answer:
                  'the machine could not mint a session credential from Flowviant — check its connection, then send the message again',
              });
              return;
            }
          }
          // CODEX RESUMES BY THREAD ID, never by `--last`: `resume --last` is
          // the MACHINE's most recent codex conversation, and two codex tabs —
          // or a tab plus a codex dispatch — would cross-resume each other's
          // context. The id was captured off thread.started (runtimeEvents.mjs) and
          // persisted below, beside the runtime pin; absent, the turn runs
          // FRESH in the same worktree — the dirty state is most of the held
          // context, and a machine-global guess is someone else's conversation.
          /**
           * CLAUDE RESUMES BY THE CONVERSATION ID THIS TAB SPOKE UNDER.
           *
           * `--continue` is CWD-KEYED. That was unambiguous while one directory
           * meant one tab, and it stopped being true the day tabs moved into
           * their driver's project folder: every tab there said `--continue`
           * and every one of them resumed whichever conversation had spoken
           * most recently in that directory. Tab B inherited tab A's entire
           * context, and each turn afterwards ping-ponged between them — the
           * exact failure the codex note two blocks down warns about for
           * `resume --last`, arriving for Claude by a different route.
           *
           * The id comes from the CLI's own `system.init` event, which the
           * stream parser already surfaces, and is pinned per session so it is
           * unambiguous wherever the tab is standing.
           *
           * NO ID, NO `--continue`: a tab whose place is shared starts FRESH
           * rather than guessing, because in a shared directory the guess is
           * someone else's conversation. `--continue` survives only where the
           * directory belongs to this tab alone, which is the one case it was
           * ever right for.
           */
          let claudeResumeId = null;
          if (rt.id === 'claude') {
            const convMarker = sessionMetaPath(dir.wt, 'flowviant-claude-session', job.sessionId);
            if (convMarker && existsSync(convMarker)) {
              try {
                const v = readFileSync(convMarker, 'utf8').trim();
                if (/^[A-Za-z0-9_-]{8,64}$/.test(v)) claudeResumeId = v;
              } catch {
                /* unreadable marker — run fresh */
              }
            }
          }
          let codexResumeId = null;
          if (rt.id === 'codex') {
            const threadMarker = sessionMetaPath(dir.wt, 'flowviant-codex-thread', job.sessionId);
            if (threadMarker && existsSync(threadMarker)) {
              try {
                const v = readFileSync(threadMarker, 'utf8').trim();
                if (CODEX_THREAD_RE.test(v)) codexResumeId = v;
              } catch {
                /* unreadable marker — run fresh */
              }
            }
          }
          // AGY RESUMES BY CONVERSATION ID, learned once and pinned beside the
          // runtime marker: an adopted tab knows it from the adopt hint; a new
          // tab learns it from agy's own cwd registry after its first turn.
          // The marker beats `--continue` because it is the tab's OWN identity
          // — the registry maps a cwd to whatever ran there LAST, and a
          // dispatch sharing the machine could overwrite that between turns.
          let agyConvId = null;
          if (rt.id === 'antigravity' && !adopting) {
            const convMarker = sessionMetaPath(dir.wt, 'flowviant-agy-conversation', job.sessionId);
            if (convMarker && existsSync(convMarker)) {
              try {
                const v = readFileSync(convMarker, 'utf8').trim();
                if (AGY_CONV_RE.test(v)) agyConvId = v;
              } catch {
                /* unreadable marker — run fresh */
              }
            }
          }
          // Resume iff a conversation is known to live in THIS directory. For
          // Claude that proof is the server's sessionRef — only ever a path
          // some turn actually SPOKE from (see the settle below), and it must
          // match the directory we just opened. For codex it is the stored
          // thread id, which lives IN the directory and is stronger. Anything
          // else starts fresh IN the existing worktree — never a reset; the
          // dirty state is the session.
          // agy layers its two resumes: the pinned conversation id when the
          // marker exists (deterministic, registry-proof), else the Claude
          // rule — a tab that has SPOKEN from this directory may `--continue`
          // it (cwd-keyed; measured safe), so a lost marker degrades to the
          // weaker resume instead of silently starting over.
          const spokeHere = !dir.fresh && Boolean(job.sessionRef) && job.sessionRef === dir.wt;
          // A place this tab does NOT have to itself: `--continue` there is a
          // guess at somebody else's conversation, so it is withheld and only
          // a pinned id may resume.
          const placeIsMine = !placeOf(job.sessionId) || placeOf(job.sessionId) === job.sessionId;
          const resume =
            rt.id === 'codex'
              ? Boolean(codexResumeId)
              : rt.id === 'antigravity'
                ? Boolean(agyConvId) || (placeIsMine && spokeHere)
                : Boolean(claudeResumeId) || (placeIsMine && spokeHere);
          // The dirty carry, on the adopt worktree's FIRST life only: a
          // re-attempted adoption (the directory already exists) carried what
          // it could the first time, and re-applying would double it. A carry
          // problem never fails the adoption — it becomes one bracketed line
          // in the prompt, so the AGENT tells the user what stayed behind.
          let carryNote = '';
          if (adopting && dir.fresh && adoptSrc) carryNote = carryDirtyState(adoptSrc, dir.wt, job.sessionId);
          // The tab's transcript starts EMPTY on adoption (scrollback is
          // disposable, the held context is the brain — never import an
          // archive), so the first reply opens with a recap: the human sees
          // the thread they are picking up without asking for it.
          const adoptNote = adopting
            ? '[ADOPTED SESSION — this conversation was brought in from a terminal. Begin your reply with a 2-3 sentence recap of where it left off and what state carried over, then answer the message.]'
            : '';
          // A PLAN TURN RUNS PLAIN TOO (0.97.0): measured on 2.1.281, plan mode
          // refuses every `mcp__flowviant` call ("Cannot call … while in plan
          // mode") unless the tool is annotated read-only, and none of the
          // session tools are — so mounting the control plane would hand the
          // turn a list of tools it can only fail at. The credential is still
          // minted above: its lease answers (held elsewhere, gone) are about
          // the SESSION, and a plan turn needs them as much as any other.
          const mcp =
            plainTab || planTurn
              ? { args: [], env: null, dir: null }
              : mcpFor(rt.id, mint.token, getMcpUrl());
          // The tab's model/effort, if it named any. Spread into turnArgs so
          // BOTH runTurn calls below carry it — the retry is the same turn on
          // the same brain, not a quieter second opinion.
          const brain = brainFor(job, rt.id);
          // Attempts count RUNS: the infra refusals above consumed nothing and
          // settled on their own terms.
          workAttempts.set(job.id, tries + 1);
          let out;
          let seenThreadId = null; // codex's conversation id, off thread.started
          let seenClaudeSession = null; // claude's own conversation id, off system.init
          const spawned = []; // this turn's children, for the teardown registry
          // THE TURN'S TOOL LOG — see workToolLog.mjs for its shape rules.
          const turnLog = createToolLog(dir.wt);
          toolLog = turnLog.toolLog;
          const { pushToolEvent } = turnLog;
          const narrator = makeNarrator(job.sessionId, job.id, () =>
            toolLog.ev.length > 0 ? toolLog : undefined
          );


          // THE COMMAND AUDIT — see workCommandAudit.mjs.
          const { flushAudit, auditCommand } = createCommandAudit({
            sessionId: job.sessionId,
            turnId: job.id,
            runtime: rt.id,
            cwd: dir.wt,
          });
          try {
            // Files first, then the message that references them: the agent
            // must be able to open what it is being told about. Only the ones
            // that actually landed are named.
            const files = await fetchAttachments(dir.wt, job.attachments);
            const filesNote = files.length
              ? `[FILES THE HUMAN ATTACHED TO THIS MESSAGE — already on disk in this worktree]\n${files
                  .map((f) => `- ${f}`)
                  .join('\n')}`
              : '';
            const message = [job.body, filesNote, adoptNote, carryNote]
              .filter(Boolean)
              .join('\n\n');
            // A CAPTURE chat (the board's New task conversation): its own
            // system prompt, its own kickoff, and the scratch planner's
            // READ-ONLY permission profile — the prompt says stage-never-file
            // and the profile is what makes "read-only" true rather than
            // asserted. Server-flagged per job; a server too old to flag it
            // simply runs an ordinary tab, which the web's version floor
            // prevents ever being offered.
            const captureTab = job.capture === true;
            const turnArgs = {
              // A plain tab has no tools to name and no session id to pass —
              // its kickoff asks for one complete report instead of a stream.
              prompt: plainTab || planTurn
                ? WORK_TURN_KICKOFF_PLAIN({
                    sessionName: job.sessionName,
                    message,
                    askedByName: job.askedByName,
                  })
                : captureTab
                  ? CAPTURE_TURN_KICKOFF({
                      sessionId: job.sessionId,
                      sessionName: job.sessionName,
                      message,
                      askedByName: job.askedByName,
                    })
                  : WORK_TURN_KICKOFF({
                    sessionId: job.sessionId,
                    sessionName: job.sessionName,
                    message,
                    askedByName: job.askedByName,
                  }),
              // ONE PROFILE (turnProfile.mjs): the capture chat's read-only
              // `plan` list; or a plan turn's `plan-mode` — `--permission-mode
              // plan` INSTEAD of the build posture, never beside
              // `--dangerously-skip-permissions`, which silently wins
              // (claudePosture.mjs, PLAN_MODE_PERM); else the build posture.
              profile: captureTab ? 'plan' : planTurn ? 'plan-mode' : 'build',
              // The adopt turn resumes the TERMINAL conversation by forking it
              // into this cwd (claude: --resume <id> --fork-session). After it
              // speaks once, the fork lives natively here and turn 2+ is the
              // ordinary --continue resume path, unchanged.
              ...(adopting ? { adoptResumeId: job.adopt.id } : {}),
              // THE PROJECT'S KNOWLEDGE LIBRARY (0.94.0) rides as one appended
              // paragraph, and only while this box holds one — see
              // `withProjectContext`. Resolved at spawn, not at startup, so a
              // library that synced a second ago is in THIS turn.
              ...(() => {
                const knowledgeDir = knowledgeDirFor(repoRoot);
                return {
                  // A PLAN TURN (0.97.0) runs the PLAIN contract — it has no
                  // Flowviant tools, see `mcp` above — with no artifacts
                  // paragraph (plan mode cannot write one) and the planning
                  // sentence appended. Every other tab is untouched.
                  system: planTurn
                    ? `${withProjectContext(SYSTEM_WORK_PLAIN, { knowledgeDir, artifacts: false })}\n\n${PLAN_TURN_SENTENCE}`
                    : withProjectContext(
                        plainTab ? SYSTEM_WORK_PLAIN : captureTab ? SYSTEM_CAPTURE : SYSTEM_WORK,
                        // ARTIFACTS (0.94.0): every tab but the read-only capture
                        // chat, and only while the server can show one.
                        { knowledgeDir, artifacts: !captureTab && getArtifactsAccepted() }
                      ),
                  // The directory is OUTSIDE a worktree's cwd; Claude Code is
                  // told it may read there (`--add-dir`) rather than left to
                  // refuse a read-only capture turn a path it was just handed.
                  knowledgeDir,
                };
              })(),
              // Present only when the tab named one — see brainFor.
              ...brain,
              // The tab watches the CLI work. Claude needs the flag to speak
              // events at all (codex and agy always do); `answerFromResult`
              // keeps `out` — which IS the reply posted to the transcript — to
              // the final result, so streamed prose is narrated once and
              // posted once. Every line goes to the narrator above, throttled.
              streamJson: true,
              answerFromResult: true,
              onActivity: (a) => {
                narrator.line(a?.label);
                auditCommand(a);
              },
              // The structured twin of the line above — see toolLog.
              onToolEvent: pushToolEvent,
              // The CLI's own token counts, tagged with which CLI counted them
              // — ADDED, not set: both runTurn calls below share these args.
              onUsage: (u) => {
                usage = addUsage(usage, { ...u, runtime: rt.id });
              },
              onModel: (m) => {
                model = m;
              },
              // What this CLI says it can be asked for by name. Harvested off
              // the init event the stream already carries — no probe, no scan,
              // no extra spawn — and reported on the next roster poll so the
              // composer can autocomplete a `/`. See runtimeCapabilities.mjs for why it is
              // learned from a turn rather than looked up.
              onInit: (i) => {
                recordSkills(i.skills);
                // The CLI's mounted MCP servers and connectors (0.97.0) — the
                // same free fact off the same event; see recordMcpServers.
                recordMcpServers(i.mcpServers);
                // The conversation this turn is actually speaking under. Held
                // and persisted after the turn ends, so the NEXT one resumes
                // this exact thread rather than whatever the directory saw
                // last. Last write wins on purpose: a resume that fell back to
                // fresh reports the fresh id, healing the marker.
                if (typeof i.sessionId === 'string' && i.sessionId.trim())
                  seenClaudeSession = i.sessionId.trim();
              },
              cwd: dir.wt,
              mcpArgs: mcp.args,
              mcpEnv: mcp.env,
              // A PERSON AT THE KEYBOARD MAY ASK FOR A WINDOW (2026-09-29): a
              // Terminal tab keeps its environment's display. The capture chat
              // does not — it only reads and stages cards, and the person
              // talking to it may be on a phone (noWindowEnv.mjs).
              display: !captureTab,
              runtime: rt.id,
              label: c.cyan('[tab]'),
              // Only codex announces one (thread.started); held here so the id
              // this turn actually SPOKE under is what gets persisted after it
              // ends. Last write wins on purpose: a failed resume that fell
              // back to fresh reports the fresh run's id, healing the marker.
              onThreadId: (id) => {
                seenThreadId = String(id ?? '').trim() || seenThreadId;
              },
              onSpawn: (ch) => {
                if (!ch) return;
                spawned.push(ch);
                // Keyed to the SESSION it serves — that id is what the machine
                // snapshot charges this child's memory to.
                workChildren.set(ch, job.sessionId);
                // The process exists, so the reserved slot is now counted by
                // the registry itself. Idempotent — the `finally` below releases
                // it again for every path that never got here.
                releaseSlot();
                // The CLI is spawned `detached`, so its pid IS its process
                // group id — and every process it starts inherits that, through
                // `nohup` and `setsid` alike. Remembered per SESSION rather
                // than per turn, because the whole point is the watcher that
                // outlives the turn that started it.
                if (ch.pid) noteSessionGroup(job.sessionId, ch.pid);
                if (lockPath && ch.pid) {
                  try {
                    const start = processStartTime(ch.pid);
                    writeFileSync(lockPath, start ? `${ch.pid}:${start}` : String(ch.pid));
                  } catch {
                    /* best-effort */
                  }
                }
              },
            };
            out = await runTurn({
              ...turnArgs,
              resume,
              resumeThreadId: codexResumeId || claudeResumeId || undefined,
              resumeConversationId: agyConvId || undefined,
            });
            // A resume that produced NOTHING usually means the held
            // conversation is gone (a first turn that crashed before writing
            // state, a wiped CLI dir — or, on codex, a deleted thread). Retry
            // once fresh in the SAME worktree — never reset — instead of
            // bricking the tab forever; the retry carries no resumeThreadId,
            // so codex genuinely starts over rather than re-asking for the
            // thread that just came back empty. NEVER on an adopt turn
            // (`resume` is structurally false there, and the guard says so out
            // loud): a fresh conversation would silently discard the adoption
            // and answer as a new session wearing its name — the empty adopt
            // turn settles failed below instead.
            /**
             * …OR PRODUCED ONLY THE CLI SAYING THE CONVERSATION IS GONE.
             *
             * "Produced nothing" was the whole test, and it is not the shape
             * these failures take: Claude Code answers a dead `--resume` id
             * with a result event carrying `errors: ['No conversation found
             * with session ID: …']` and writes the same line to stderr, so
             * `out` is non-empty. The backstop never fired, the turn settled
             * SUCCESSFULLY with that error as its answer, and — because the
             * marker is only rewritten when an init event is seen, and there
             * was none — the dead id stayed pinned. Every later message in
             * that tab replied identically, with nothing on any surface able
             * to clear it. A tab bricked forever by its own CLI pruning its
             * history, which it does on its own schedule.
             */
            if (
              !adopting &&
              resumeRetriesFresh({ resume, out, runtime: rt.id, sawInit: Boolean(seenClaudeSession) })
            ) {
              out = await runTurn({ ...turnArgs, resume: false });
            }
          } finally {
            // The CLI has stopped printing, so stop relaying. The LINE itself
            // is cleared server-side at settle — clearing it here would race
            // the settle and blank the tab a beat before the reply lands.
            narrator.stop();
            flushAudit();
            for (const ch of spawned) workChildren.delete(ch);
            if (lockPath) {
              try {
                rmSync(lockPath, { force: true });
              } catch {
                /* best-effort */
              }
            }
            if (mcp.dir) rmSync(mcp.dir, { recursive: true, force: true });
          }
          // Persist the codex thread id AFTER the turn ends, so the next turn
          // resumes exactly the conversation that just spoke. Shape-guarded
          // before it ever touches disk — it later rides in argv as
          // `resume <id>` — and best-effort, like the runtime pin: an
          // unwritable marker just means the tab runs fresh next turn.
          // The conversation THIS TAB just spoke under, pinned so the next
          // turn resumes it by id rather than asking the directory. Written
          // after the turn for the same reason codex's is: an id learned
          // mid-turn is only true once the turn that learned it finished.
          if (
            rt.id === 'claude' &&
            seenClaudeSession &&
            /^[A-Za-z0-9_-]{8,64}$/.test(seenClaudeSession)
          ) {
            const convMarker = sessionMetaPath(dir.wt, 'flowviant-claude-session', job.sessionId);
            if (convMarker) {
              try {
                writeFileSync(convMarker, seenClaudeSession);
              } catch {
                /* best-effort — the next turn re-learns it */
              }
            }
          }
          if (rt.id === 'codex' && seenThreadId && CODEX_THREAD_RE.test(seenThreadId)) {
            const threadMarker = sessionMetaPath(dir.wt, 'flowviant-codex-thread', job.sessionId);
            if (threadMarker) {
              try {
                writeFileSync(threadMarker, seenThreadId);
              } catch {
                /* best-effort */
              }
            }
          }
          const answer = (out || '').trim();
          // No output at all smells like a dead MCP credential (the lane
          // workers' no-sentinel case) — drop the cached token so the next
          // turn re-mints instead of failing the same way forever.
          if (!answer) workTokens.delete(job.sessionId);
          if (adopting && !answer) {
            // The fork came back with nothing — the terminal session's
            // transcript is most likely gone (cleaned, expired, deleted). Say
            // exactly that; no sessionRef is recorded, so the server keeps
            // offering the adoption and a retry after the user checks is cheap.
            await settleWorkTurn(job.id, {
              ok: false,
              answer: "Couldn't resume the terminal session — it may have been removed.",
              // Whatever it DID before coming back empty is exactly the
              // question a failed turn's log answers.
              ...(toolLog.ev.length > 0 ? { tools: toolLog } : {}),
              // …and an empty fork still spent what it spent.
              ...(usage ? { usage } : {}),
              ...(model ? { model } : {}),
            });
            warn('adopt turn produced no output — settled as failed');
            return;
          }
          // Persist the agy conversation id once the turn actually SPOKE — an
          // adopted tab pins the id it moved in (the adopt hint); a new tab
          // learns the one its first fresh turn just created, from agy's own
          // cwd registry. From here on the marker is the tab's identity and
          // the registry is never trusted again.
          if (rt.id === 'antigravity' && answer.length > 0) {
            const convMarker = sessionMetaPath(dir.wt, 'flowviant-agy-conversation', job.sessionId);
            if (convMarker && !existsSync(convMarker)) {
              const learned = adopting ? job.adopt.id : agyRegistryLookup(dir.wt);
              if (learned && AGY_CONV_RE.test(learned)) {
                try {
                  writeFileSync(convMarker, learned);
                } catch {
                  /* best-effort — an unpinned tab resumes via --continue's cwd key */
                }
              }
            }
          }
          await settleWorkTurn(job.id, {
            ok: answer.length > 0,
            answer:
              answer.length > 0
                ? // Scrub: a reply can quote config or env-adjacent code.
                  envScrub(answer).slice(0, 16000)
                : 'the turn produced no output on the machine — its CLI may be signed out; try again',
            // Only a turn that actually SPOKE proves a conversation lives
            // here. Recording the path unconditionally is how a crashed first
            // turn used to brick resume for the session's whole life.
            ...(answer.length > 0 ? { sessionRef: dir.wt } : {}),
            // The turn's tool log, in final form — the durable copy that lands
            // on the settled message (the live copy on the record is cleared
            // at settle). Already scrubbed at collection.
            ...(toolLog.ev.length > 0 ? { tools: toolLog } : {}),
            ...(usage ? { usage } : {}),
            ...(model ? { model } : {}),
          });
          if (answer.length > 0) ok(`${c.cyan('tab')} ${c.dim('— replied in the session')}`);
          else warn('session turn produced no output — settled as failed');
        } catch (e) {
          await settleWorkTurn(job.id, {
            ok: false,
            // Scrub, like every string that leaves this machine: an exception
            // routinely quotes command output, and command output can quote a
            // synced secret.
            answer: envScrub(String(e?.message ?? 'the session turn failed')).slice(0, 2000),
            // "What did it do before it failed" is exactly the question a
            // crashed turn's log answers — same spread as the main settle.
            ...(toolLog?.ev.length > 0 ? { tools: toolLog } : {}),
            // A turn that threw after its CLI ran still spent what it spent.
            ...(usage ? { usage } : {}),
            ...(model ? { model } : {}),
          });
          warn(`session turn failed: ${e?.message ?? e}`);
        } finally {
          workAnswering.delete(job.id);
          // Nothing spawned, or everything already has: releasing twice is the
          // normal case and costs nothing. A reservation that leaked would
          // shrink this machine's ceiling for the life of the process.
          releaseSlot();
          // The turn just changed the directory — say what it looks like now,
          // whether it succeeded or blew up (a failed turn can still have
          // written half a file, and the tab should show that honestly). NOT
          // awaited: this runs inside the session's chain, and a slow POST
          // would delay the next turn of that tab behind a readout.
          void reportPlaceWorktrees(job.sessionId).catch(() => {});
          burstListeners(job.sessionId);
          // …and relay what it wrote to SHOW its owner (2026-09-22) — the same
          // beat, the same reason it is not awaited. A failed turn's half-drawn
          // page is still what the turn left, and the tab should see it.
          if (artifactScan) {
            void artifacts
              .report({
                placeDir: artifactScan.dir,
                before: artifactScan.before,
                sessionId: job.sessionId,
                turnId: job.id,
              })
              .catch(() => {});
          }
        }
      });
    }
  };

  return { processWorkTurns, workAnswering };
}
