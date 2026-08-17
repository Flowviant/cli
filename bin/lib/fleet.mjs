/**
 * Fleet daemon. Install ONCE with a fleet credential; manage everything from
 * Flowviant. The daemon polls GET /api/v2/fleet/agents, reconciles one persistent
 * git worktree + worker loop per roster agent, rotates each worker's short-lived
 * MCP token, and only spawns Claude when the server says an agent has work.
 */

import { mkdirSync, existsSync, rmSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';
import {
  VERSION,
  FLEET_URL,
  FLEET_TOKEN,
  USER_AGENT,
  MCP_URL,
  SAFE,
  POLL_SECONDS,
  MAX_CONCURRENT,
  IDLE_SECONDS,
  RECONCILE_SECONDS,
  REFRESH_BEFORE_SECONDS,
  LIVE,
  AUTO_UPDATE,
  ALLOW_PATCHES,
} from './config.mjs';
import { handleVersionSignal } from './update.mjs';
import {
  git,
  resetWorktree,
  ensureWorktree,
  repoRootOrDie,
  detectBaseRef,
  originSlug,
  baseBranchName,
  isValidPrUrl,
  isValidBranch,
  isSafePathSegment,
  worktreeDiffstat,
} from './git.mjs';
import { c, LABEL_COLORS, info, note, ok, warn, fail } from './ui.mjs';
import { revertPatch, withPatchLock } from './patch.mjs';
import {
  sleep,
  mcpFor,
  runTurn,
  sawSentinel,
  blockedId,
  SYSTEM_SINGLE,
  SINGLE_KICKOFF,
  SINGLE_RESUME,
  SYSTEM_WIKI,
  WIKI_KICKOFF,
  SYSTEM_REGROUND,
  SYSTEM_PLAN_CHECK,
  PLAN_CHECK_KICKOFF,
  REGROUND_KICKOFF,
  SYSTEM_PLAN,
  PLAN_TURN_KICKOFF,
  SYSTEM_WORK,
  WORK_TURN_KICKOFF,
  SYSTEM_QUICK_EDIT,
  QUICK_EDIT_KICKOFF,
} from './claude.mjs';
import { runLiveWorker, readTaskMarker } from './live.mjs';
import { reapOrphanPreviews } from './preview.mjs';
import { preflight } from './preflight.mjs';
import { connectStream } from './stream.mjs';
import { ensureVault, syncVault } from './vault.mjs';
import {
  envQueryParams,
  handleRosterEnv,
  materializeInto,
  myPubB64,
  scrub as envScrub,
} from './env.mjs';
import { processDeployJobs, reportDeployConfig } from './deploy.mjs';
import { machineSnapshot } from './resources.mjs';
import { detectRuntimes, pickRuntimeFor, RUNTIMES } from './runtimes.mjs';

async function fetchRoster(haveIds) {
  const url = new URL(FLEET_URL);
  if (haveIds.length) url.searchParams.set('have', haveIds.join(','));
  // What this machine will run at once. The server grows lanes to meet waiting
  // work beneath this, instead of the user pre-sizing a pool by hand — only the
  // machine knows its cores, its RAM and whose Claude quota is being spent.
  // Older servers ignore the param, so sending it is always safe.
  url.searchParams.set('capacity', String(MAX_CONCURRENT));
  // WHICH CLIs this machine actually has, so the app can stop guessing.
  //
  // Until now every surface that listed Gemini or Codex said "not wired up yet"
  // and meant it literally: nothing had ever looked. That was the honest answer
  // while it was true, and it stops being honest the moment a second runtime can
  // run — an app that cannot tell "Codex is not installed" from "we never
  // checked" will confidently tell you the wrong one.
  //
  // A statement about this MACHINE and nothing else: no account, no quota, no
  // entitlement. Detection is cached after the first poll (one version probe per
  // CLI), so this costs a query param thereafter. Older servers ignore an
  // unknown param, so sending it is always safe.
  try {
    const drivable = detectRuntimes()
      .filter((r) => r.dispatchable)
      .map((r) => r.id);
    if (drivable.length) url.searchParams.set('runtimes', drivable.join(','));
  } catch {
    /* detection is best-effort — a probe must never fail the poll */
  }
  // Env-sync identity + materialized version (the Settings "env vN" chip).
  try {
    for (const [k, v] of Object.entries(await envQueryParams())) {
      if (v) url.searchParams.set(k, v);
    }
  } catch {
    /* env identity is best-effort — the poll must never fail on it */
  }
  // An explicit User-Agent is required: Node's default ("node"/empty) trips
  // Cloudflare Bot Fight Mode (403). A descriptive product UA passes.
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${FLEET_TOKEN}`, 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(30_000), // a black-holed poll must not stall the loop
  });
  if (res.status === 401 || res.status === 403) {
    // Fleet credential revoked/expired — retrying can't recover; signal exit.
    const e = new Error(`fleet credential rejected (${res.status})`);
    e.auth = true;
    throw e;
  }
  if (!res.ok) throw new Error(`fleet poll failed (${res.status})`);
  const body = await res.json();
  // Validate the shape here so a malformed 200 (deploy hiccup, error envelope)
  // throws a NORMAL retryable error inside the loop's try/catch, instead of a
  // `roster.agents.map` TypeError escaping to top-level and killing the daemon.
  const data = body?.data;
  if (!data || !Array.isArray(data.agents)) {
    throw new Error('fleet poll returned an unexpected shape');
  }
  // Drop roster agents with an unsafe id BEFORE they're used as a path segment.
  data.agents = data.agents.filter((a) => {
    if (isSafePathSegment(a?.agentId)) return true;
    warn(`ignoring roster agent with an invalid id: ${JSON.stringify(a?.agentId)}`);
    return false;
  });
  return data; // { mcpUrl, leaseTtlSeconds, agents: [{agentId,name,token,reviewGate,hasWork}] }
}

const RUN_DIFFSTAT_URL = FLEET_URL.replace(/\/agents\/?$/, '/run-diffstat');

/**
 * Post what a run has changed, every 20s, until the returned stop() is called.
 *
 * Daemon-side rather than an MCP tool the agent calls: the agent forgets, each
 * call costs tokens, and anything the agent reports about itself is downstream
 * of whatever it is currently reading. The daemon owns the worktree, so it can
 * just look.
 *
 * Posts when the numbers MOVED, and otherwise once every couple of minutes to
 * say the worktree is still being watched. Both halves are needed. Writing the
 * same row every 20s would make a wedged turn look busy; never re-writing it
 * makes a HEALTHY run look dead, because the reader treats a sample it has not
 * seen refreshed in three minutes as a daemon that stopped — and an agent that
 * finishes editing and then spends fifteen minutes running the test suite
 * produces exactly the same silence as one that died. REFRESH_MS sits well
 * inside that window so an idle-but-live worktree keeps its panel.
 */
const DIFFSTAT_REFRESH_MS = 120_000;

function sampleDiffstat(cwd, baseRef, intentId, agentId) {
  let last = '';
  let lastSentAt = 0;
  let alive = true;
  const post = async () => {
    if (!alive) return;
    let stat = null;
    try {
      stat = worktreeDiffstat(cwd, baseRef);
    } catch {
      return; // a worktree mid-reset is not an error worth reporting
    }
    if (!stat) return;
    const key = JSON.stringify(stat);
    if (key === last && Date.now() - lastSentAt < DIFFSTAT_REFRESH_MS) return;
    try {
      const res = await fetch(RUN_DIFFSTAT_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${FLEET_TOKEN}`,
          'User-Agent': USER_AGENT,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(15_000),
        // The lane, not just the task: the server matches the run on both, so a
        // sample can only ever overwrite the diffstat of THIS lane's own run.
        body: JSON.stringify({ taskId: intentId, agentId, diffstat: stat }),
      });
      // Only a sample the server ACCEPTED counts as sent. Marking it delivered
      // before the round-trip meant a dropped request suppressed every retry
      // for as long as the numbers held still — which is precisely when the
      // reader is about to expire the panel.
      if (res.ok) {
        last = key;
        lastSentAt = Date.now();
      }
    } catch {
      /* best-effort: `last` is untouched, so the next tick tries again */
    }
  };
  const t = setInterval(() => void post(), 20_000);
  // Kick once after a beat so a fast task still reports something before it ends.
  const first = setTimeout(() => void post(), 5_000);
  return () => {
    alive = false;
    clearInterval(t);
    clearTimeout(first);
  };
}

// One roster agent's loop: persistent worktree, one intent per turn, reset to
// base between tasks (fresh conversation), resume in place while on a blocker.
async function runFleetWorker({ agentId, label, cwd, baseRef, getToken, getHasWork, getNext, getMcpUrl, isAlive, onChild, onTokenSuspect }) {
  let resuming = false;
  let needsReset = true; // reset to base before a FRESH task, not on idle polls
  // The task this lane is currently holding. `next` only arrives on a FRESH
  // turn, but a run that comes back from a blocker is still building the same
  // intent — without remembering it here, the entire post-blocker half of a run
  // reports no diffstat and the tray blanks mid-build.
  let heldIntentId = null;
  // The CLI the task in flight is being built by — held across a resume for
  // the reason documented at the assignment below.
  let heldRuntime = 'claude';
  let phase = ''; // '', 'idle', 'blocked' — log each transition once, not per poll
  const enter = (p, fn, msg) => {
    if (phase !== p) {
      phase = p;
      fn(`${label} ${msg}`);
    }
  };
  while (isAlive()) {
    const token = getToken(agentId);
    if (!token) {
      await sleep(IDLE_SECONDS);
      continue;
    }
    // Idle = no claimable work (the server tells us via the roster poll). Don't
    // spawn Claude just to find nothing — that's a wasted API call. A blocked
    // task (resuming) still polls, so its resolution gets picked up.
    if (!resuming && !getHasWork(agentId)) {
      enter('idle', info, 'idle — no work assigned');
      await sleep(IDLE_SECONDS);
      continue;
    }
    if (!resuming && needsReset) {
      resetWorktree(cwd, baseRef); // clean slate for a new task
      materializeInto(cwd); // reset wiped the env files (git clean -fd) — rewrite
      needsReset = false;
    }
    // The task the server says is next for this lane, read ONCE per turn: the
    // runtime, model and effort below become process flags, so they must
    // describe the same task the kickoff tells the agent to claim. Re-reading
    // the map mid-turn could pair one task's flags with another's work.
    const next = resuming ? null : getNext?.(agentId) || null;
    if (next?.intentId) heldIntentId = next.intentId;
    // WHICH CLI builds this one. Chosen in the app by @mentioning it and carried
    // on the roster hint; absent (older server, or a task captured before there
    // was a choice) it is Claude, which is what every task ran on until now.
    //
    // A resume must keep the runtime it started on — the session, the worktree
    // and the branch all belong to that CLI, and handing its half-finished work
    // to a different one mid-task is not a fallback, it is a second author.
    if (!resuming) heldRuntime = next?.runtime || 'claude';
    const { dir, args: mcpArgs, env: mcpEnv } = mcpFor(heldRuntime, token, getMcpUrl());
    let out = '';
    // Report what this run is changing, while it is changing it. The commits
    // endpoint can only describe work that has already reached the provider, so
    // without this the app has nothing to say about a task for the whole time it
    // is being built. Only when we know WHICH task this turn is for — the same
    // hint that carries its model and effort — because a diffstat attributed to
    // the wrong run is worse than none. On a resume that is the intent this
    // lane already holds; the worktree it is about to keep editing is the same
    // one, so the samples describe the same run.
    const stopDiffstat = heldIntentId
      ? sampleDiffstat(cwd, baseRef, heldIntentId, agentId)
      : null;
    try {
      out = await runTurn({
        prompt: resuming ? SINGLE_RESUME : SINGLE_KICKOFF(next?.intentId),
        resume: resuming,
        system: SYSTEM_SINGLE,
        cwd,
        runtime: heldRuntime,
        mcpArgs,
        mcpEnv,
        label,
        // Per-task overrides — null/absent means this machine's own defaults
        // (FLOWVIANT_MODEL, and the CLI's own effort). A resume keeps the
        // session it already has, so there is nothing to re-pick there.
        model: next?.model || undefined,
        effort: next?.effort || undefined,
        onSpawn: (ch) => onChild?.(ch),
      });
    } finally {
      stopDiffstat?.();
      // `dir` is null for a runtime that needed no file on disk (Codex reads its
      // token from the environment) — rmSync would throw on undefined.
      if (dir) rmSync(dir, { recursive: true, force: true });
      onChild?.(null);
    }
    if (!isAlive()) break;
    if (blockedId(out)) {
      enter('blocked', warn, `${c.yellow('paused')}${c.dim(' — waiting on your review/answer in Flowviant')}`);
      resuming = true;
      await sleep(POLL_SECONDS);
      continue;
    }
    if (sawSentinel(out, 'NOTHING')) {
      enter('idle', info, 'idle — no work assigned');
      resuming = false;
      heldIntentId = null; // let go of the task, and of its diffstat
      await sleep(IDLE_SECONDS);
      continue;
    }
    if (sawSentinel(out, 'DONE')) {
      ok(`${label} ${c.dim('finished a task — PR opened for your review')}`);
      phase = '';
      resuming = false;
      needsReset = true;
      heldIntentId = null;
      continue;
    }
    // No sentinel — the turn didn't complete the protocol. Almost always the
    // flowviant MCP failed to surface its tools (usually a stale worker token).
    // Drop the cached token so the next poll re-mints a fresh one, then retry —
    // don't fake a blocker or a completion.
    enter('reconnect', warn, `${c.yellow('no result')}${c.dim(' — refreshing token, retrying')}`);
    onTokenSuspect?.(agentId);
    // A no-sentinel turn while RESUMING a blocked task is a transient MCP/token
    // failure, not completion — retry in place and KEEP the worktree. Resetting
    // here would wipe the blocked task's uncommitted changes. Only a fresh-task
    // turn (not resuming) warrants a clean slate next time.
    if (!resuming) {
      needsReset = true;
      heldIntentId = null; // fresh slate next turn — nothing held to sample
    }
    await sleep(IDLE_SECONDS);
  }
  info(`${label} stopped`);
}

export async function runFleetDaemon() {
  console.log('');
  console.log(`  ${c.bold(c.cyan('◣ flowviant'))}  ${c.dim(`fleet daemon · v${VERSION}`)}`);
  console.log(`  ${c.dim('──────────────────────────────────────────────')}`);
  const repoRoot = repoRootOrDie();
  const baseRef = detectBaseRef(repoRoot);
  info(SAFE ? 'mode   · safe (restricted toolset)' : 'mode   · unattended (skips permission prompts)');
  info(`repo   · ${repoRoot}`);
  info(`base   · ${baseRef}`);
  // Stated out loud because it is the one setting that lets something else write
  // into the checkout you are sitting in.
  info(
    ALLOW_PATCHES
      ? 'patches· accepted — small changes land in your checkout for Keep/Revert (--no-patches to refuse)'
      : 'patches· refused — everything arrives as a branch + PR'
  );
  info(`server · ${FLEET_URL}`);
  console.log('');
  await preflight({ needGit: true });
  // Kill any preview dev-server/tunnel groups a previously-crashed daemon left
  // running (detached children survive an ungraceful exit) before we start fresh.
  reapOrphanPreviews((m) => info(m));

  // Persistent worktree home (0.9.0) — survives daemon restarts AND reboots,
  // so Ctrl+C mid-task never loses local work. Keyed per repo path.
  const repoKey = `${basename(repoRoot)}-${createHash('sha256').update(repoRoot).digest('hex').slice(0, 8)}`;
  const baseDir = join(homedir(), '.flowviant', 'worktrees', repoKey);
  mkdirSync(baseDir, { recursive: true });

  // ONE CHECKOUT PER TASK, named after the task. Worktrees used to be
  // `agent-<agentId>` — a long-lived tree per lane, reset to base between
  // tasks — and that was the last thing a lane owned. Now a lane is a
  // credential and nothing more, which is what makes it disposable: the server
  // can hand any lane any task, and two tasks can never be in each other's
  // files even when one is mid-edit.
  const taskWorktreePath = (intentId) => join(baseDir, `task-${intentId}`);
  const worktreeFor = (intentId) => {
    const r = ensureWorktree(repoRoot, taskWorktreePath(intentId), baseRef);
    // Only on creation: a resumed tree already has its env, and rewriting it
    // mid-task would clobber anything the agent changed.
    if (r.fresh) {
      try {
        materializeInto(r.path);
      } catch {
        /* best-effort — the task still builds, secrets-backed paths may 500 */
      }
    }
    return r;
  };
  try {
    const kb = Number(execFileSync('du', ['-sk', baseDir], { encoding: 'utf8' }).split('\t')[0]);
    if (kb > 1024)
      info(
        `disk   · worktrees ${(kb / 1024 / 1024).toFixed(1)} GB at ~/.flowviant/worktrees — \`flowviant clean\` reclaims`
      );
  } catch {
    /* du unavailable (Windows) — skip the disk line */
  }

  // Reap long-dead task checkouts. Per-lane trees were self-limiting — N lanes,
  // N directories, reused forever. Per-task trees are not: every task ever
  // built leaves one behind, so without this the disk grows without bound and
  // `flowviant clean` becomes a chore rather than a convenience.
  //
  // Age, not state, is the test. The daemon has no list of which intents are
  // still open, and asking the server for one would put a delete behind a
  // network call that can fail — so anything untouched for a fortnight goes,
  // which is far beyond how long a task stays reviewable and far beyond any
  // pause a human takes mid-build. Runs at startup only: mid-run this would
  // race a worker that is quietly parked on a blocker.
  try {
    const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
    let reaped = 0;
    for (const name of readdirSync(baseDir)) {
      if (!name.startsWith('task-')) continue;
      const p = join(baseDir, name);
      try {
        if (statSync(p).mtimeMs > cutoff) continue;
        // Through git, so the worktree REGISTRATION goes too — an rm -rf leaves
        // a stale entry that blocks re-adding the same path later.
        git(['worktree', 'remove', '--force', p], repoRoot);
        reaped++;
      } catch {
        /* held, gone, or not ours — leave it for `flowviant clean` */
      }
    }
    if (reaped) info(`disk   · reclaimed ${reaped} task worktree${reaped === 1 ? '' : 's'} idle > 14d`);
  } catch {
    /* the worktree home may not exist yet on a first run */
  }
  const tokenByAgent = new Map(); // agentId -> latest worker token
  const mintedAt = new Map(); // agentId -> ms when we last got a fresh token
  const hasWorkByAgent = new Map(); // agentId -> server says it has claimable work
  // agentId -> the intent the server would hand this lane next: { intentId,
  // title, model, effort }. `--model`/`--effort` are fixed when Claude starts,
  // and by then nothing has been claimed — so the server names the task first
  // and the turn pins its claim to that id. Absent on older servers, in which
  // case the lane behaves exactly as it did before: generic kickoff, machine
  // defaults.
  const nextByAgent = new Map();
  let leaseTtlSeconds = 24 * 60 * 60; // updated from each roster response
  let mcpUrl = MCP_URL;
  const workers = new Map(); // agentId -> { state, promise, wt, label }
  let daemonAlive = true; // flipped false on shutdown so the stream stops reconnecting
  let stream = null; // push channel handle (set once the loop is set up)

  // Shutdown KEEPS the worktrees: in-flight local work survives Ctrl+C and
  // resumes in place on the next run (the task marker matches). Worktrees are
  // only removed when an agent is deleted from the roster, or by
  // `flowviant clean`.
  const teardown = () => {
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
      wikiChild?.kill('SIGKILL');
    } catch {
      /* best-effort */
    }
    for (const [, w] of workers) {
      w.state.alive = false;
      try {
        w.state.child?.kill('SIGKILL');
      } catch {
        /* best-effort */
      }
      // Stop the detached preview (dev server + cloudflared tunnel) — it's its
      // own process group and survives our exit, otherwise leaking a port-bound
      // server + a live tunnel serving a stale branch until reboot.
      try {
        w.state.stopPreview?.();
      } catch {
        /* best-effort */
      }
    }
  };
  process.on('SIGINT', () => {
    console.log('');
    note('shutting down — stopping workers. Worktrees are kept: in-flight work resumes next run.');
    teardown();
    process.exit(130);
  });
  // Keep the daemon alive on a stray rejection. Many loops here are fire-and-
  // forget (`void drainWiki()`, dispatch, sync) and rely on their callees never
  // rejecting; Node ≥15 terminates the process on an unhandled rejection, which
  // would kill every in-flight agent worker over one transient error. Log and
  // survive instead — a wedged sub-task self-heals on the next poll.
  process.on('unhandledRejection', (reason) => {
    warn(`unhandled rejection (daemon kept alive): ${reason?.stack || reason}`);
  });

  // Merge jobs (Flowvy-commanded): approved PRs to squash-merge to main on the
  // user's own gh. `merging` guards against re-processing a job mid-flight.
  const MERGE_DONE_URL = FLEET_URL.replace(/\/agents\/?$/, '/merge-done');
  const MERGE_FAILED_URL = FLEET_URL.replace(/\/agents\/?$/, '/merge-failed');
  const merging = new Set();
  const mergeAttempts = new Map(); // job.id -> transient-failure count
  /** Returns whether the server actually accepted it. Callers that spend a
   *  Claude turn per attempt need to know: swallowing the failure silently made
   *  an unreachable endpoint look identical to a settled job, so the turn
   *  re-ran on every poll. */
  const reportMergeOutcome = async (url, body) => {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${FLEET_TOKEN}`,
          'User-Agent': USER_AGENT,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(30_000),
        body: JSON.stringify(body),
      });
      return res.ok;
    } catch {
      /* best-effort — the job reappears next poll if this failed */
      return false;
    }
  };
  /** Same POST, but hands back the parsed `data`. A compare-and-set answers in
   *  the BODY (`taken: false` is a perfectly successful 200), so reading only
   *  `res.ok` would tell a lane it won a race it actually lost. */
  const postForData = async (url, body) => {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${FLEET_TOKEN}`,
          'User-Agent': USER_AGENT,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(30_000),
        body: JSON.stringify(body),
      });
      if (!res.ok) return null;
      return (await res.json())?.data ?? null;
    } catch {
      return null;
    }
  };
  // Patch reverts: a patch landed straight in this checkout, and a human took it
  // back. The commits are HERE, not on the server, so the reverse-apply happens
  // here too — a revert, never a reset, because the owner has almost certainly
  // worked on top by now. Serialised through the same lock as applies.
  const PATCH_REVERT_DONE_URL = FLEET_URL.replace(/\/agents\/?$/, '/patch-revert-done');
  const reverting = new Set();
  const processPatchRevertJobs = (jobs) => {
    for (const job of jobs ?? []) {
      if (!job || typeof job.id !== 'string' || !Array.isArray(job.shas)) continue;
      if (reverting.has(job.id)) continue;
      reverting.add(job.id);
      (async () => {
        try {
          note(`${c.cyan('revert')} ${c.dim(`— ${job.title}`)}`);
          const res = await withPatchLock(() =>
            Promise.resolve(revertPatch({ repoRoot, shas: job.shas }))
          );
          if (res.ok) ok(`${c.dim('reverted')} ${job.title}`);
          else warn(`revert failed for "${job.title}": ${res.error}`);
          // ALWAYS report, success or not. Without this the flag stays set, the
          // roster re-serves the job every poll, and each pass reverts the
          // revert — the change flapping in and out of the owner's tree forever.
          await reportMergeOutcome(PATCH_REVERT_DONE_URL, {
            taskId: job.id,
            ok: res.ok,
            error: res.ok ? undefined : String(res.error ?? 'revert failed'),
          });
        } finally {
          reverting.delete(job.id);
        }
      })();
    }
  };

  // Plan checks: the ground-truth pass. Generation drafted these against a
  // module manifest and wiki summaries — proxies for the repo. This runs where
  // the checkout is, opens the real files, and reports corrections back into the
  // thread. Read-only by construction; it never edits.
  /**
   * Pull the plan-check JSON off the tail of a Claude turn.
   *
   * The model is told to end with a bare JSON object, but a turn can trail
   * prose, a fence, or a stray newline. Scan backwards for the last balanced
   * object and validate it hard: anything shaped wrong is dropped rather than
   * written into someone's plan. Returns null when nothing usable was found.
   */
  const parsePlanChecks = (out, intents) => {
    const text = String(out ?? '');
    const known = new Set(intents.map((i) => i.id));
    const end = text.lastIndexOf('}');
    if (end === -1) return null;
    // NOTE: `lastIndexOf(x, -1)` returns 0, NOT -1 — the position argument is
    // clamped, so the obvious `start = lastIndexOf('{', start - 1)` loop spins
    // forever once it reaches index 0 and the parse fails. That hangs the
    // daemon's event loop, not just this job. Walk with an explicit stop, and
    // cap the attempts so a pathological turn can't burn the poll cycle either.
    let start = text.lastIndexOf('{', end);
    for (let attempts = 0; start !== -1 && attempts < 200; attempts++) {
      let parsed = null;
      try {
        parsed = JSON.parse(text.slice(start, end + 1));
      } catch {
        /* not a complete object at this offset — step back and retry */
      }
      if (!parsed || !Array.isArray(parsed.checks)) {
        if (start === 0) break;
        start = text.lastIndexOf('{', start - 1);
        continue;
      }
      return parsed.checks
        .filter((ch) => ch && typeof ch.id === 'string' && known.has(ch.id))
        .map((ch) => ({
          id: ch.id,
          alreadyBuilt: ch.alreadyBuilt === true,
          evidence: typeof ch.evidence === 'string' ? ch.evidence.slice(0, 300) : '',
          anchors: Array.isArray(ch.anchors)
            ? ch.anchors.filter((a) => typeof a === 'string' && a.length < 200).slice(0, 6)
            : [],
          points:
            typeof ch.points === 'number' && Number.isFinite(ch.points)
              ? Math.max(0, Math.min(13, Math.round(ch.points)))
              : null,
          note: typeof ch.note === 'string' ? ch.note.slice(0, 400) : '',
        }))
        .slice(0, 30);
    }
    return null;
  };

  /**
   * Everything that reads or rewrites the shared `wikiWt` worktree takes this:
   * the wiki sweep, the post-merge re-ground, the plan check, and consults.
   *
   * They are one directory. The wiki queue hard-resets it (`checkout --detach`,
   * `reset --hard`, `clean -fd`) between tasks, which pulls the files out from
   * under anything else mid-read — and two Claude turns in one working tree is
   * incoherent even without the reset.
   */
  let wikiLock = Promise.resolve();
  const withWikiLock = (fn) => {
    const run = wikiLock.then(fn, fn);
    wikiLock = run.then(
      () => {},
      () => {}
    );
    return run;
  };

  /** A clean detached checkout at base — what "the real code" has to mean for a
   *  question about the repo, rather than whatever half-finished state an agent
   *  worktree happens to be in. Shared by the plan check and consults. */
  const ensureWikiWorktree = () => {
    if (!existsSync(wikiWt)) {
      try {
        git(['worktree', 'add', '--detach', wikiWt, baseRef], repoRoot);
      } catch {
        git(['worktree', 'prune'], repoRoot);
        git(['worktree', 'add', '--detach', wikiWt, baseRef], repoRoot);
      }
      return;
    }
    // It already exists — which means it is pinned to whatever base pointed at
    // when it was FIRST created, possibly weeks ago. "Reads the real code" has
    // to mean the current base, so re-point it. Best-effort: a stale answer
    // beats no answer, and the next turn tries again.
    try {
      git(['fetch', 'origin', '--quiet'], repoRoot);
      git(['checkout', '--detach', baseRef], wikiWt);
      git(['reset', '--hard', baseRef], wikiWt);
      git(['clean', '-fd'], wikiWt);
    } catch {
      /* offline, or a turn left it dirty — read what we have */
    }
  };

  const PLAN_CHECK_DONE_URL = FLEET_URL.replace(/\/agents\/?$/, '/plan-check-done');
  // Machine telemetry — what the box is doing with itself, for the admin view.
  const MACHINE_URL = FLEET_URL.replace(/\/agents\/?$/, '/machine');
  const checkingPlans = new Set();
  const processPlanCheckJobs = (jobs) => {
    for (const job of jobs ?? []) {
      // New name first; the roster mirrors `intents` off `tasks` for exactly
      // this fallback window.
      const planTasks = Array.isArray(job?.tasks) ? job.tasks : job?.intents;
      if (!job || typeof job.id !== 'string' || !Array.isArray(planTasks)) continue;
      if (checkingPlans.has(job.id)) continue;
      if (planTasks.length === 0) continue;
      checkingPlans.add(job.id);
      (async () => {
        try {
          // WHICH CLI answers a turn nobody @mentioned. Resolved per job rather
          // than once at startup: a CLI can be installed while the daemon runs.
          const planRt = pickRuntimeFor('consult');
          if (!planRt) {
            warn(`plan check for "${job.title}" skipped — no installed CLI can run a read-only turn`);
            checkingPlans.delete(job.id);
            return;
          }
          note(`${c.cyan('plan')} ${c.dim(`— checking "${job.title}" against your code…`)}`);
          const out = await withWikiLock(async () => {
            ensureWikiWorktree();
            return runTurn({
              prompt: PLAN_CHECK_KICKOFF({ title: job.title, intents: planTasks }),
              resume: false,
              system: SYSTEM_PLAN_CHECK,
              cwd: wikiWt,
              // Reads the repo and reports JSON — it authors nothing either.
              readOnly: true,
              runtime: planRt,
              label: c.cyan('[plan]'),
            });
          });
          const checks = parsePlanChecks(out, planTasks);
          if (checks === null) {
            warn(`plan check for "${job.title}": no usable JSON — leaving the plan as drafted`);
          }
          await reportMergeOutcome(PLAN_CHECK_DONE_URL, {
            taskId: job.id,
            checks: checks ?? [],
          });
          if (checks?.length) {
            ok(`${c.cyan('plan')} ${c.dim(`— ${checks.length} correction${checks.length === 1 ? '' : 's'} for "${job.title}"`)}`);
          } else {
            ok(`${c.cyan('plan')} ${c.dim(`— "${job.title}" checks out against your code`)}`);
          }
        } catch (e) {
          warn(`plan check failed for "${job.title}": ${e?.message ?? e}`);
          // Clear the flag anyway — a stuck job would re-run every poll forever.
          await reportMergeOutcome(PLAN_CHECK_DONE_URL, { taskId: job.id, checks: [] });
        } finally {
          checkingPlans.delete(job.id);
        }
      })();
    }
  };

  // ── Planning sessions ────────────────────────────────────────────────────
  //
  // A turn in a plan thread, answered inside a HELD session. This was the
  // consult, which answered one question in prose and kept nothing: it existed
  // because the planner was a different, weaker brain and this turn's only job
  // was to correct it from the real code. That planner is gone, so the session
  // reads the repo AND writes the plan, over many turns, in one context.
  //
  // Two things changed shape as a result.
  //
  // ONE WORKTREE PER PLAN, not the shared `wikiWt`. Every CLI here resumes with
  // "continue the last session in this directory" (`--continue`, `resume
  // --last`) rather than by session id, so the WORKING DIRECTORY *is* the
  // session handle. A shared directory would have made two plans on one machine
  // take turns wearing each other's context — and the wiki queue hard-resets
  // that directory between tasks, which would pull the files out from under a
  // session mid-argument. A private detached checkout per plan also means plan
  // turns no longer queue behind the wiki lock.
  //
  // IT CARRIES MCP. A consult passed none — nothing to write. A session spawns
  // slices, re-shapes them, drops them and maintains the spec, all of which are
  // control-plane calls. The token is the fleet's PLAN principal, whose entire
  // tool set is those five: it cannot claim, cannot open a worktree, cannot
  // commit. That absence is the product rule, not a hardening measure — it is
  // what makes "add a dark mode toggle" typed at a plan add a slice instead of
  // building one, with nothing reading the sentence to decide.
  const CONSULT_DONE_URL = FLEET_URL.replace(/\/agents\/?$/, '/consult-done');
  const PLAN_TOKEN_URL = FLEET_URL.replace(/\/agents\/?$/, '/plan-token');
  const answering = new Set();
  const consultAttempts = new Map(); // turn id -> tries
  /** Give up after this many turns on one message. A /consult-done that never
   *  reaches the server (offline, 500) would otherwise re-run the whole Claude
   *  turn every poll, forever, on the owner's quota. */
  const MAX_CONSULT_TRIES = 3;
  /** ONE planning turn at a time on this machine. Sessions are per-plan so they
   *  no longer collide on a directory, but the roster can hand back a batch, and
   *  un-awaited spawns would put N concurrent CLI processes on someone's laptop
   *  for what is, on the human's side, a chat. */
  let consultChain = Promise.resolve();

  /**
   * The plan credential, cached until it stops working.
   *
   * Minted lazily rather than at startup: most daemons never host a planning
   * session, and a token nobody uses is a credential sitting on disk for no
   * reason. Rotated by the server on every mint, so a re-mint after a 401 is the
   * recovery path.
   */
  let planToken = null;
  const mintPlanToken = async (force = false) => {
    if (planToken && !force) return planToken;
    try {
      const res = await fetch(PLAN_TOKEN_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${FLEET_TOKEN}`, 'User-Agent': USER_AGENT },
      });
      if (!res.ok) return null;
      const data = await res.json().catch(() => null);
      planToken = data?.data?.token ?? null;
      return planToken;
    } catch {
      return null;
    }
  };

  /**
   * This plan's session directory — its context, expressed as a place.
   *
   * A detached checkout at base, like a consult's, but PRIVATE and PERSISTENT:
   * private so `--continue` resumes this argument rather than whichever ran last
   * on the box, persistent so it survives the daemon restarting or updating
   * under it. Re-pointed at the current base each turn, because "reads your
   * code" has to mean the code as it is now — a plan that runs for days would
   * otherwise keep answering from the commit it was opened at.
   *
   * Returns null when the id is not a safe path segment: it comes off the wire.
   */
  const planWtFor = (planId) => {
    if (!isSafePathSegment(planId)) return null;
    const wt = join(baseDir, 'plans', planId);
    const fresh = !existsSync(wt);
    if (fresh) {
      try {
        git(['worktree', 'add', '--detach', wt, baseRef], repoRoot);
      } catch {
        git(['worktree', 'prune'], repoRoot);
        try {
          git(['worktree', 'add', '--detach', wt, baseRef], repoRoot);
        } catch {
          return null;
        }
      }
    } else {
      try {
        git(['fetch', 'origin', '--quiet'], repoRoot);
        git(['checkout', '--detach', baseRef], wt);
        git(['reset', '--hard', baseRef], wt);
        git(['clean', '-fd'], wt);
      } catch {
        /* offline, or a turn left it dirty — read what we have */
      }
    }
    return { wt, fresh };
  };

  /**
   * Retire the least-recently-touched session directories.
   *
   * The bound belongs HERE, in the machine, and never in the interface: ten
   * plans open across a team is ten checkouts on one box, which is a resource
   * question. Announcing a session limit in the app would be advertising
   * capacity, which this product does not do. A retired session simply rebuilds
   * from the spec next time it is asked for — the fallback the server already
   * expects, and which the thread says out loud when it happens.
   */
  const MAX_PLAN_SESSIONS = 8;
  const planTouched = new Map(); // planId -> ms
  const retireIdlePlanSessions = () => {
    const dir = join(baseDir, 'plans');
    if (!existsSync(dir)) return;
    let ids;
    try {
      ids = readdirSync(dir);
    } catch {
      return;
    }
    if (ids.length <= MAX_PLAN_SESSIONS) return;
    const oldestFirst = ids.sort(
      (a, b) => (planTouched.get(a) ?? 0) - (planTouched.get(b) ?? 0)
    );
    for (const id of oldestFirst.slice(0, ids.length - MAX_PLAN_SESSIONS)) {
      try {
        git(['worktree', 'remove', '--force', join(dir, id)], repoRoot);
      } catch {
        try {
          rmSync(join(dir, id), { recursive: true, force: true });
        } catch {
          /* it is a directory we will overwrite next time; not worth failing a turn */
        }
      }
      planTouched.delete(id);
    }
    try {
      git(['worktree', 'prune'], repoRoot);
    } catch {
      /* best effort */
    }
  };

  // Quick edits — a SECOND Claude alongside a task this machine is already
  // building. Unlike every other roster job it does not get a worktree of its
  // own: the whole point is to work in the one the running task opened, on that
  // branch, so the change rides along with the delivery instead of becoming a
  // second thing to merge.
  const JOIN_TAKE_URL = FLEET_URL.replace(/\/agents\/?$/, '/join-take');
  const JOIN_DONE_URL = FLEET_URL.replace(/\/agents\/?$/, '/join-done');
  const joining = new Set();
  /** ONE quick edit at a time, ACROSS worktrees. Two of them in the same tree
   *  would fight over the index; two in different trees would still be two extra
   *  Claudes on the owner's account on top of the tasks already running. */
  let joinChain = Promise.resolve();

  /** The worktree currently building this intent, or null if this machine isn't.
   *  Now a direct lookup rather than a scan: a task's checkout is named after
   *  the task, so there is exactly one place it could be. The marker is still
   *  consulted, but for LIFECYCLE rather than identity — a directory that
   *  outlived its run (finished, cleared its marker, kept for the review
   *  preview) exists but is not building anything, and must not take an edit. */
  const worktreeBuilding = (intentId) => {
    const wt = taskWorktreePath(intentId);
    try {
      if (existsSync(wt) && readTaskMarker(wt) === intentId) return { wt };
    } catch {
      /* a worktree that vanished isn't building anything */
    }
    return null;
  };

  const processJoinJobs = (jobs) => {
    for (const job of jobs ?? []) {
      if (!job || typeof job.id !== 'string' || !job.instruction) continue;
      if (joining.has(job.id)) continue;
      joining.add(job.id);
      joinChain = joinChain.then(async () => {
        let settled = false;
        try {
          const target = worktreeBuilding(job.taskId ?? job.intentId);
          if (!target) {
            // The run ended (or moved) between the human pressing ⚡ and this
            // poll. Settle rather than retry: there is no worktree to join, and
            // an unsettled row holds the reset interlock open forever.
            await reportMergeOutcome(JOIN_DONE_URL, {
              joinId: job.id,
              ok: false,
              result: 'that task is no longer building on this machine',
            });
            settled = true;
            return;
          }
          // Compare-and-set BEFORE spending a Claude turn: two lanes can wake on
          // the same push, and running one instruction twice into one worktree
          // is exactly the double-edit this is meant to avoid.
          const quickRt = pickRuntimeFor('build');
          if (!quickRt) return; // nothing here can edit code; leave the join unclaimed
          const claim = await postForData(JOIN_TAKE_URL, { joinId: job.id });
          if (!claim?.taken) return;
          note(
            `${c.cyan('quick')} ${c.dim(`— ${job.askedByName || 'someone'} on "${job.taskTitle || job.intentTitle || 'a task'}"`)}`
          );
          const out = await runTurn({
            prompt: QUICK_EDIT_KICKOFF({
              intentTitle: job.taskTitle ?? job.intentTitle,
              instruction: job.instruction,
              askedByName: job.askedByName,
            }),
            // Never resume: this is its own tiny turn, not a continuation of the
            // task's session. Resuming would hand it the other agent's context
            // and, with it, the other agent's job.
            resume: false,
            system: SYSTEM_QUICK_EDIT,
            cwd: target.wt,
            runtime: quickRt,
            // No MCP: a join records no run, claims nothing, completes nothing.
            // Its only report is the one this daemon posts below.
            label: c.cyan('[quick]'),
          });
          const summary = (out || '').trim();
          await reportMergeOutcome(JOIN_DONE_URL, {
            joinId: job.id,
            ok: summary.length > 0,
            // Scrub: a summary can quote config or env-adjacent code.
            result: envScrub(summary).slice(0, 4000) || 'no change reported',
          });
          settled = true;
          ok(`${c.cyan('quick')} ${c.dim('— landed on the task branch')}`);
        } catch (e) {
          warn(`quick edit failed: ${e?.message ?? e}`);
          if (!settled) {
            await reportMergeOutcome(JOIN_DONE_URL, {
              joinId: job.id,
              ok: false,
              result: e?.message ?? 'the change could not be applied',
            }).catch(() => {});
          }
        } finally {
          joining.delete(job.id);
        }
      });
    }
  };

  const processConsultJobs = (jobs) => {
    for (const job of jobs ?? []) {
      if (!job || typeof job.id !== 'string' || !job.question) continue;
      if (answering.has(job.id)) continue;
      const tries = (consultAttempts.get(job.id) ?? 0) + 1;
      if (tries > MAX_CONSULT_TRIES) continue;
      consultAttempts.set(job.id, tries);
      answering.add(job.id);
      consultChain = consultChain.then(async () => {
        try {
          note(`${c.cyan('plan')} ${c.dim(`— ${job.askedByName || 'someone'} on "${job.planTitle || 'a plan'}"`)}`);
          // The profile is the enforcement, not the prompt: this turn is steered
          // by anything a project editor can type, and it holds write tools. A
          // runtime that cannot express `plan` does not get the job rather than
          // getting it with guarantees nobody wrote down — which today excludes
          // Antigravity, whose mediated shape fits a build and not an argument.
          const planRt = pickRuntimeFor('plan');
          if (!planRt) {
            warn('a planning turn is waiting, but no installed CLI can run a planning session');
            return;
          }
          const token = await mintPlanToken();
          if (!token) {
            warn('a planning turn is waiting, but the plan credential could not be minted');
            return;
          }
          const dir = planWtFor(job.taskId);
          if (!dir) {
            warn(`a planning turn is waiting, but its session directory could not be opened`);
            return;
          }
          planTouched.set(job.taskId, Date.now());
          // Resume only when this plan already HAS a session here. A fresh
          // directory means either the first turn or a session we retired, and
          // both want the same thing: start over from the spec, which the
          // kickoff carries. `--continue` against an empty directory is not an
          // error on every CLI, so asking `fresh` is what keeps it honest.
          const resume = !dir.fresh && Boolean(job.sessionRef);
          const mcp = mcpFor(planRt, token, mcpUrl);
          let out;
          try {
            out = await runTurn({
              prompt: PLAN_TURN_KICKOFF({
                planId: job.taskId,
                planTitle: job.planTitle,
                question: job.question,
                askedByName: job.askedByName,
                // Sent only when we are NOT resuming: a live session already has
                // the argument in its context, and re-stating the spec every
                // turn would spend tokens telling it what it just wrote. On a
                // rebuild it is the whole inheritance.
                spec: resume ? null : job.spec,
              }),
              resume,
              system: SYSTEM_PLAN,
              cwd: dir.wt,
              // Read the repo, write the PLAN. No Edit/Write/commit anywhere in
              // the toolset — the prompt says so too, but the prompt is what an
              // injected message competes with.
              planPerm: true,
              mcpArgs: mcp.args,
              mcpEnv: mcp.env,
              runtime: planRt,
              label: c.cyan('[plan]'),
            });
          } finally {
            if (mcp.dir) rmSync(mcp.dir, { recursive: true, force: true });
          }
          const answer = (out || '').trim();
          const posted = await reportMergeOutcome(CONSULT_DONE_URL, {
            consultId: job.id,
            ok: answer.length > 0,
            // Scrub: a reply can quote config or env-adjacent code.
            answer: envScrub(answer).slice(0, 8000),
            // The handle the server stores, reported on EVERY turn: a session we
            // had to rebuild comes back under a new directory state, and a
            // stored handle that does not follow it leaves later turns trying to
            // resume something that is gone.
            sessionRef: dir.wt,
          });
          if (posted) consultAttempts.delete(job.id);
          ok(`${c.cyan('plan')} ${c.dim('— replied in the plan thread')}`);
          retireIdlePlanSessions();
        } catch (e) {
          // Settle it. A turn that cannot be answered must not re-burn quota
          // every poll, and silence would leave the human waiting on a machine
          // that already gave up.
          await reportMergeOutcome(CONSULT_DONE_URL, {
            consultId: job.id,
            ok: false,
            answer: e?.message ?? 'the planning turn failed',
          });
          warn(`planning turn failed: ${e?.message ?? e}`);
        } finally {
          answering.delete(job.id);
        }
      });
    }
  };

  // ── Work sessions — the Workbench tabs ─────────────────────────────────────
  //
  // A tab is a held Claude session with BUILD permissions in a PERSISTENT
  // worktree on its own branch. The opposite of a plan directory on both
  // counts: nothing here is detached and nothing is ever reset — uncommitted
  // state between turns IS the session, and blowing it away would be closing
  // the human's editor mid-thought.
  const WORK_TOKEN_URL = FLEET_URL.replace(/\/agents\/?$/, '/work-token');
  const WORK_DONE_URL = FLEET_URL.replace(/\/agents\/?$/, '/work-turn-done');
  const workAnswering = new Set();
  const workAttempts = new Map(); // turn id -> tries
  const MAX_WORK_TRIES = 3;
  /** Per-SESSION serialization, parallel ACROSS sessions: turns within one tab
   *  must land in order (they share a directory and a context), but two tabs
   *  are two terminals — the human opened both on purpose. */
  const workChains = new Map(); // sessionId -> Promise

  let workToken = null;
  const mintWorkToken = async (force = false) => {
    if (workToken && !force) return workToken;
    try {
      const res = await fetch(WORK_TOKEN_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${FLEET_TOKEN}`, 'User-Agent': USER_AGENT },
      });
      if (!res.ok) return null;
      const data = await res.json().catch(() => null);
      workToken = data?.data?.token ?? null;
      return workToken;
    } catch {
      return null;
    }
  };

  /**
   * This tab's worktree — its held context, expressed as a place, ON A BRANCH.
   *
   * Fresh: branch `session/<id>` off the current base. Existing: touched not at
   * all — no fetch-reset-clean like a plan directory, because the dirty state
   * is the point. If the directory was retired but the branch survives, the
   * worktree re-attaches to the branch and the committed work is still there.
   */
  const sessionWtFor = (sessionId) => {
    if (!isSafePathSegment(sessionId)) return null;
    const wt = join(baseDir, 'sessions', sessionId);
    const fresh = !existsSync(wt);
    if (fresh) {
      const branch = `session/${sessionId}`;
      try {
        git(['worktree', 'add', '-b', branch, wt, baseRef], repoRoot);
      } catch {
        git(['worktree', 'prune'], repoRoot);
        try {
          // The branch may already exist (a retired directory's work) — attach.
          git(['worktree', 'add', wt, branch], repoRoot);
        } catch {
          try {
            git(['worktree', 'add', '-b', branch, wt, baseRef], repoRoot);
          } catch {
            return null;
          }
        }
      }
    }
    return { wt, fresh };
  };

  /**
   * Retire the least-recently-touched CLEAN session directories past the cap.
   * A dirty worktree is never touched — uncommitted work is the human's, and a
   * resource bound does not outrank it. Committed work survives retirement on
   * the session branch either way.
   */
  const MAX_WORK_DIRS = 12;
  const workTouched = new Map(); // sessionId -> ms
  const retireIdleWorkSessions = () => {
    const dir = join(baseDir, 'sessions');
    if (!existsSync(dir)) return;
    let ids;
    try {
      ids = readdirSync(dir);
    } catch {
      return;
    }
    if (ids.length <= MAX_WORK_DIRS) return;
    const oldestFirst = ids.sort(
      (a, b) => (workTouched.get(a) ?? 0) - (workTouched.get(b) ?? 0)
    );
    let excess = ids.length - MAX_WORK_DIRS;
    for (const id of oldestFirst) {
      if (excess <= 0) break;
      const wt = join(dir, id);
      try {
        if (git(['status', '--porcelain'], wt).trim() !== '') continue; // dirty — skip
        git(['worktree', 'remove', wt], repoRoot);
        workTouched.delete(id);
        excess--;
      } catch {
        /* leave it; a directory we can't cleanly remove is not worth a turn */
      }
    }
    try {
      git(['worktree', 'prune'], repoRoot);
    } catch {
      /* best effort */
    }
  };

  const processWorkTurns = (jobs) => {
    for (const job of jobs ?? []) {
      if (!job || typeof job.id !== 'string' || !job.body || !job.sessionId) continue;
      if (workAnswering.has(job.id)) continue;
      const tries = (workAttempts.get(job.id) ?? 0) + 1;
      if (tries > MAX_WORK_TRIES) continue;
      workAttempts.set(job.id, tries);
      workAnswering.add(job.id);
      const chain = workChains.get(job.sessionId) ?? Promise.resolve();
      workChains.set(
        job.sessionId,
        chain.then(async () => {
          try {
            note(
              `${c.cyan('tab')} ${c.dim(`— ${job.askedByName || 'the owner'} in "${job.sessionName || 'a session'}"`)}`
            );
            const workRt = pickRuntimeFor('build');
            if (!workRt) {
              warn('a session turn is waiting, but no installed CLI can build here');
              return;
            }
            const token = await mintWorkToken();
            if (!token) {
              warn('a session turn is waiting, but the work credential could not be minted');
              return;
            }
            const dir = sessionWtFor(job.sessionId);
            if (!dir) {
              warn('a session turn is waiting, but its worktree could not be opened');
              return;
            }
            workTouched.set(job.sessionId, Date.now());
            const resume = !dir.fresh && Boolean(job.sessionRef);
            const mcp = mcpFor(workRt, token, mcpUrl);
            let out;
            try {
              out = await runTurn({
                prompt: WORK_TURN_KICKOFF({
                  sessionId: job.sessionId,
                  sessionName: job.sessionName,
                  message: job.body,
                  askedByName: job.askedByName,
                }),
                resume,
                system: SYSTEM_WORK,
                cwd: dir.wt,
                mcpArgs: mcp.args,
                mcpEnv: mcp.env,
                runtime: workRt,
                label: c.cyan('[tab]'),
              });
            } finally {
              if (mcp.dir) rmSync(mcp.dir, { recursive: true, force: true });
            }
            const answer = (out || '').trim();
            const posted = await reportMergeOutcome(WORK_DONE_URL, {
              turnId: job.id,
              ok: answer.length > 0,
              // Scrub: a reply can quote config or env-adjacent code.
              answer: envScrub(answer).slice(0, 16000),
              sessionRef: dir.wt,
            });
            if (posted) workAttempts.delete(job.id);
            ok(`${c.cyan('tab')} ${c.dim('— replied in the session')}`);
            retireIdleWorkSessions();
          } catch (e) {
            await reportMergeOutcome(WORK_DONE_URL, {
              turnId: job.id,
              ok: false,
              answer: e?.message ?? 'the session turn failed',
            });
            warn(`session turn failed: ${e?.message ?? e}`);
          } finally {
            workAnswering.delete(job.id);
          }
        })
      );
    }
  };

  // Ship — a session's branch merging to main, on the human's word.
  //
  // --no-ff, NEVER squash: every delivered card carries commit shas as its
  // receipts, and a squash would point them all at commits that no longer
  // exist on main. Sequence: refuse a dirty worktree (auto-committing someone's
  // mid-thought state is not shipping, it is guessing), fold main INTO the
  // branch first so conflicts surface in the worktree where the session can
  // resolve them, collect the branch's own commits (the server's
  // reconciliation input), then merge outward through a throwaway worktree so
  // nobody's checkout moves. Failures report INTO the tab — a ship that failed
  // silently leaves the human believing their work is on main.
  const SHIP_DONE_URL = FLEET_URL.replace(/\/agents\/?$/, '/ship-done');
  const shipping = new Set();
  let shipChain = Promise.resolve();

  const processShipJobs = (jobs) => {
    for (const job of jobs ?? []) {
      if (!job || typeof job.sessionId !== 'string') continue;
      if (shipping.has(job.sessionId)) continue;
      shipping.add(job.sessionId);
      shipChain = shipChain.then(async () => {
        const done = (payload) =>
          reportMergeOutcome(SHIP_DONE_URL, { sessionId: job.sessionId, ...payload }).catch(
            () => {}
          );
        try {
          if (!isSafePathSegment(job.sessionId)) {
            await done({ ok: false, error: 'invalid session id' });
            return;
          }
          note(`${c.cyan('ship')} ${c.dim(`— "${job.sessionName || job.sessionId}"`)}`);
          const wt = join(baseDir, 'sessions', job.sessionId);
          if (!existsSync(wt)) {
            await done({ ok: false, error: 'no session worktree on this machine' });
            return;
          }
          if (git(['status', '--porcelain'], wt) !== '') {
            await done({
              ok: false,
              error:
                'the session has uncommitted changes — ask it to commit or discard them first',
            });
            return;
          }
          try {
            git(['fetch', 'origin', '--quiet'], repoRoot);
          } catch {
            /* offline fetch — merge against what we have */
          }
          // Fold main into the branch FIRST: conflicts land here, in the
          // session's own worktree, where the next turn can resolve them.
          try {
            git(['merge', '--no-edit', baseRef], wt);
          } catch {
            try {
              git(['merge', '--abort'], wt);
            } catch {
              /* nothing in progress */
            }
            await done({
              ok: false,
              error: 'conflicts with main — ask the session to resolve them, then ship again',
            });
            return;
          }
          // The branch's own commits — the server's reconciliation input.
          // --no-merges: fold-commits describe plumbing, not work.
          const commits = git([
            'log',
            `${baseRef}..HEAD`,
            '--no-merges',
            '--format=%H%x09%s',
          ], wt)
            .split('\n')
            .filter(Boolean)
            .map((l) => {
              const [sha, ...rest] = l.split('\t');
              return { sha, subject: envScrub(rest.join('\t')).slice(0, 200) };
            });
          if (commits.length === 0) {
            await done({ ok: false, error: 'nothing to ship — no commits on the session branch' });
            return;
          }
          // Merge outward through a throwaway worktree so no checkout moves.
          const branch = `session/${job.sessionId}`;
          const tmp = join(baseDir, 'ship', job.sessionId);
          try {
            try {
              git(['worktree', 'remove', '--force', tmp], repoRoot);
            } catch {
              /* not there — fine */
            }
            git(['worktree', 'add', '--detach', tmp, baseRef], repoRoot);
            git([
              'merge',
              '--no-ff',
              branch,
              '-m',
              `ship(${job.sessionName || job.sessionId.slice(0, 8)}): ${commits.length} commit${commits.length === 1 ? '' : 's'}`,
            ], tmp);
            git(['push', 'origin', `HEAD:${baseBranchName(baseRef)}`], tmp);
          } finally {
            try {
              git(['worktree', 'remove', '--force', tmp], repoRoot);
              git(['worktree', 'prune'], repoRoot);
            } catch {
              /* best effort */
            }
          }
          await done({ ok: true, commits });
          ok(`${c.cyan('ship')} ${c.dim(`— ${commits.length} commit${commits.length === 1 ? '' : 's'} on main`)}`);
        } catch (e) {
          await done({ ok: false, error: envScrub(e?.message ?? 'the merge failed').slice(0, 500) });
          warn(`ship failed: ${e?.message ?? e}`);
        } finally {
          shipping.delete(job.sessionId);
        }
      });
    }
  };

  const processMergeJobs = (jobs) => {
    for (const job of jobs ?? []) {
      if (!job || typeof job.id !== 'string') continue; // a null element would wedge the loop
      if (merging.has(job.id)) continue;
      merging.add(job.id);
      (async () => {
        try {
          note(`${c.cyan('merge')} ${c.dim(`— ${job.title}`)}`);
          let merged = false;
          let failedReason = null; // permanent — tell the thread, clear the flag
          // Refuse a PR URL that isn't an https github.com PR in THIS repo — a
          // bad/hostile server must not merge a PR in another repo the user's
          // gh can write to (and a leading '-' would be a gh flag).
          if (!isValidPrUrl(job.prUrl, originSlug(repoRoot))) {
            mergeAttempts.delete(job.id);
            await reportMergeOutcome(MERGE_FAILED_URL, {
              taskId: job.id,
              message: 'refused: PR URL is not a pull request in this repository',
            });
            warn(`merge REFUSED for "${job.title}": untrusted PR URL ${String(job.prUrl)}`);
            return;
          }
          // STACKED PR: it targets its blocker's branch so the review shows only
          // its own diff. The server holds this job until that blocker merged, so
          // by now the blocker's commits are in the base ref — re-point before
          // squashing, or the change lands in the blocker's branch and never
          // reaches the trunk while the card cheerfully says "Merged".
          if (job.retargetToBase) {
            try {
              // baseBranchName, not baseRef: `gh pr edit --base` needs a branch
              // that exists in the repo, and detectBaseRef hands back a
              // remote-tracking ref (origin/main) that GitHub 422s on.
              execFileSync('gh', ['pr', 'edit', job.prUrl, '--base', baseBranchName(baseRef)], {
                cwd: repoRoot,
                stdio: ['ignore', 'pipe', 'pipe'],
              });
            } catch (e) {
              // Already targeting base is the common no-op; anything else is
              // reported rather than merged into the wrong place.
              const err = e.stderr?.toString?.() || e.message || '';
              if (!/no changes|already/i.test(err)) {
                mergeAttempts.delete(job.id);
                await reportMergeOutcome(MERGE_FAILED_URL, {
                  taskId: job.id,
                  message: `could not retarget the stacked PR onto ${baseBranchName(baseRef)} — merging it now would land in the branch below it, not ${baseBranchName(baseRef)}`,
                });
                warn(`merge held for "${job.title}": retarget failed — ${err.split('\n')[0]}`);
                return;
              }
            }
          }
          try {
            execFileSync('gh', ['pr', 'merge', job.prUrl, '--squash', '--delete-branch'], {
              cwd: repoRoot,
              stdio: ['ignore', 'pipe', 'pipe'],
            });
            merged = true;
          } catch (e) {
            const err = e.stderr?.toString?.() || e.message || '';
            const line = err.split('\n')[0] || 'gh pr merge failed';
            // Only "already merged" is a real success; a CLOSED-without-merge PR
            // also matches "not open"/"closed" but nothing landed on main —
            // report it as a failure so the thread learns the truth.
            if (/already merged/i.test(err)) merged = true;
            else if (/not open|closed/i.test(err)) {
              failedReason = 'the PR was closed without merging';
            } else if (/conflict|not mergeable|CONFLICTING/i.test(err)) {
              // Permanent until a human/agent acts — don't spin on it.
              failedReason = `merge conflict with ${baseRef} — the branch needs a rebase`;
            } else {
              // Transient (auth hiccup, network, CI requirement): retry a few
              // polls, then surface it instead of silently looping forever.
              const n = (mergeAttempts.get(job.id) ?? 0) + 1;
              mergeAttempts.set(job.id, n);
              if (n >= 3) failedReason = line;
              else warn(`merge failed for "${job.title}": ${line} — will retry`);
            }
          }
          if (merged) {
            mergeAttempts.delete(job.id);
            await reportMergeOutcome(MERGE_DONE_URL, { taskId: job.id });
            ok(`${c.cyan('merged')} ${c.dim(`— ${job.title} → ${baseRef}`)}`);
            // The code just landed — re-ground the living wiki for what shipped
            // (touched nodes re-read + a persistent feature-history node).
            // Direct enqueue = immediacy; the server's durable regroundJobs list
            // (created by merge-done above, cleared by our reground-done report)
            // is the restart-safe backstop — dedup'd here by groundedIntents.
            enqueueReground(job.id, job.prUrl, job.title, job.dirtiesPages);
          } else if (failedReason) {
            // Report into the thread (server narrates + re-arms the merge
            // button + notifies) — the job disappears from the roster.
            mergeAttempts.delete(job.id);
            await reportMergeOutcome(MERGE_FAILED_URL, {
              taskId: job.id,
              message: failedReason,
            });
            warn(`merge failed for "${job.title}": ${failedReason} — reported to the thread`);
          }
        } finally {
          merging.delete(job.id);
        }
      })();
    }
  };

  // Cleanup jobs (task restarts): close the abandoned PR + delete its remote
  // branch on the user's own gh, so a restart doesn't litter the repo.
  const CLEANUP_DONE_URL = FLEET_URL.replace(/\/agents\/?$/, '/cleanup-done');
  const cleaning = new Set();
  const processCleanupJobs = (jobs) => {
    for (const job of jobs ?? []) {
      if (!job || typeof job.id !== 'string') continue; // a null element would wedge the loop
      if (cleaning.has(job.id)) continue;
      cleaning.add(job.id);
      (async () => {
        try {
          note(`${c.cyan('cleanup')} ${c.dim(`— ${job.title} (restarted)`)}`);
          // Same guards as merge: only close a PR in THIS repo, only delete a
          // well-formed non-base branch. A bad server must not close a stranger's
          // PR or delete `main` (`--delete` with `main`) via a cleanup job.
          if (job.prUrl && isValidPrUrl(job.prUrl, originSlug(repoRoot))) {
            try {
              execFileSync(
                'gh',
                [
                  'pr',
                  'close',
                  job.prUrl,
                  '--comment',
                  'Task restarted in Flowviant — this attempt was discarded.',
                  '--delete-branch',
                ],
                { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] }
              );
            } catch (e) {
              // Already closed/merged/missing = fine; anything else we still
              // report done — a restart must never wedge on stale remotes.
              const err = e.stderr?.toString?.() || e.message || '';
              warn(`cleanup for "${job.title}": ${err.split('\n')[0] || 'gh pr close failed'}`);
            }
          } else if (job.branch && isValidBranch(job.branch, repoRoot, baseRef)) {
            try {
              // Explicit refspec form so a leading '-' can't be a git flag.
              execFileSync('git', ['push', 'origin', `:refs/heads/${job.branch}`], {
                cwd: repoRoot,
                stdio: ['ignore', 'pipe', 'pipe'],
              });
            } catch {
              /* branch already gone — fine */
            }
          } else if (job.prUrl || job.branch) {
            warn(`cleanup REFUSED for "${job.title}": untrusted PR/branch value`);
          }
          await reportMergeOutcome(CLEANUP_DONE_URL, { taskId: job.id });
          ok(`${c.cyan('cleaned')} ${c.dim(`— ${job.title}`)}`);
        } finally {
          cleaning.delete(job.id);
        }
      })();
    }
  };

  // Living-wiki work runs ONE turn at a time in a dedicated repo worktree (off
  // the agents' checkouts). Claude READS the repo there and writes the markdown
  // VAULT (~/.flowviant/vaults/<projectId>) — plain files, no MCP tools; the
  // daemon hash-diff syncs the vault to the server after each turn. Two
  // triggers enqueue: a Regenerate click (full SWEEP, finalize-prunes) and a
  // successful merge (incremental RE-GROUND). One queue + runner serializes
  // them so they never collide on the worktree or the vault. Wiki work needs no
  // agent online.
  const wikiWt = join(baseDir, 'wiki');
  const REGROUND_DONE_URL = FLEET_URL.replace(/\/agents\/?$/, '/reground-done');
  const WIKI_VAULT_URL = FLEET_URL.replace(/\/agents\/?$/, '/wiki-vault');
  const WIKI_PROGRESS_URL = FLEET_URL.replace(/\/agents\/?$/, '/wiki-progress');
  const wikiQueue = [];
  let wikiBusy = false;
  let wikiChild = null; // the wiki turn's Claude process — tracked so teardown can kill it
  let lastSweepAt = null; // dedup: run each Regenerate request once
  const groundedIntents = new Set(); // dedup: re-ground each delivery once
  // The vault is keyed by the server project this fleet credential serves
  // (learned from the roster); until the first poll names it, fall back to a
  // repo-keyed dir so a stale-server daemon still works.
  let wikiProjectId = null;
  const vaultDirFor = () =>
    wikiProjectId && isSafePathSegment(wikiProjectId)
      ? join(homedir(), '.flowviant', 'vaults', wikiProjectId)
      : join(homedir(), '.flowviant', 'vaults', repoKey);

  // Stream what the wiki turn is doing to the app (the canvas renders the read
  // phase). Throttled to ~1/s — the FIRST activity of a run and the terminal
  // `done` frame force-send so the cover appears fast and clears cleanly.
  let lastProgressAt = 0;
  const postWikiProgress = async (body, force = false) => {
    const now = Date.now();
    if (!force && now - lastProgressAt < 600) return;
    lastProgressAt = now;
    // Uplink scrub: narration/labels can quote repo content, and repo content
    // can contain a synced secret — redact known values before anything leaves
    // this machine.
    const safe = {
      ...body,
      ...(typeof body.activity === 'string' ? { activity: envScrub(body.activity) } : {}),
      ...(Array.isArray(body.recent) ? { recent: body.recent.map((s) => envScrub(s)) } : {}),
    };
    try {
      await fetch(WIKI_PROGRESS_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${FLEET_TOKEN}`,
          'User-Agent': USER_AGENT,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(15_000),
        body: JSON.stringify(safe),
      });
    } catch {
      /* best-effort — a dropped frame is harmless, the next one supersedes it */
    }
  };

  const enqueueSweep = (job) => {
    if (!job || job.requestedAt === lastSweepAt) return;
    lastSweepAt = job.requestedAt;
    // A full sweep is expensive — never stack two. One queued sweep already
    // covers any newer Regenerate click (it reads the repo fresh when it runs).
    // A failed/partial sweep stays recoverable: re-clicking Regenerate always
    // refreshes requestedAt server-side, beating this dedup.
    if (wikiQueue.some((t) => t.type === 'sweep')) return;
    wikiQueue.push({ type: 'sweep' });
    void drainWiki();
  };
  const enqueueReground = (intentId, prUrl, title, dirtiesPages) => {
    if (!intentId || groundedIntents.has(intentId)) return;
    groundedIntents.add(intentId);
    wikiQueue.push({
      type: 'reground',
      intentId,
      prUrl,
      title: title || 'a delivered task',
      // What the PLAN thought this would invalidate. A hint, not the truth —
      // the turn still reads the real changed files; this catches pages whose
      // frontmatter file list has drifted, or that document a concept rather
      // than a directory.
      dirtiesPages: Array.isArray(dirtiesPages) ? dirtiesPages : [],
    });
    void drainWiki();
  };

  // Changed files of a (merged) PR, for the re-ground prompt. Capped so a huge
  // PR can't blow up the prompt. prUrl was already validated before the merge.
  // Returns null on a gh FAILURE (network/auth) — distinct from a PR that
  // genuinely changed nothing — so the caller can retry instead of silently
  // consuming the durable job with no re-ground run.
  const changedFilesForPr = (prUrl) => {
    try {
      const out = execFileSync('gh', ['pr', 'view', prUrl, '--json', 'files'], {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return (JSON.parse(out).files ?? []).map((f) => f.path).filter(Boolean).slice(0, 60);
    } catch {
      return null;
    }
  };
  const regroundAttempts = new Map(); // intentId -> gh-failure count

  async function drainWiki() {
    if (wikiBusy || wikiQueue.length === 0) return;
    wikiBusy = true;
    // Held for the WHOLE drain: this loop resets the worktree between tasks, and
    // a consult reading it mid-reset sees files vanish under it.
    return withWikiLock(async () => {
    try {
      while (wikiQueue.length) {
        const task = wikiQueue.shift();
        // The vault is plain files — the turn needs no MCP server and no
        // cartographer token; the daemon itself syncs afterwards on the fleet
        // credential.
        // Guard the mkdir: this runs OUTSIDE the per-task try below, so an
        // ENOSPC/EACCES here (disk full is an anticipated prod condition —
        // worktrees + vault history grow) would escape drainWiki as an unhandled
        // rejection and take down the whole daemon mid-work. Skip this sweep on
        // failure instead.
        let vaultDir;
        try {
          vaultDir = vaultDirFor();
          ensureVault(vaultDir);
        } catch (e) {
          warn(`wiki sweep skipped — vault dir unavailable: ${e?.message || e}`);
          continue;
        }
        // Live progress for this turn: a rolling FEED of everything Claude does
        // (thinking, narration, reads, node writes), the file count, and the
        // phase — streamed to the app (throttled; each frame carries the whole
        // recent tail so a dropped POST loses nothing). elapsedSec is the
        // daemon's own clock.
        const mode = task.type === 'sweep' ? 'sweep' : 'reground';
        const startedAt = Date.now();
        let filesRead = 0;
        let phase = 'reading';
        // Distinct vault pages this turn has written. Counted HERE, from the
        // stream, because it is the only place that knows mid-turn: the daemon
        // syncs the vault to the server once, AFTER the turn returns, so a
        // server-side count of "rows touched since the turn began" is zero for
        // the entire writing phase — which is exactly how long the bar needs it.
        // A Set, not a counter: pages get written once and then edited, and
        // three tool calls on one page are one page.
        const pagesSeen = new Set();
        const feed = [];
        const frame = (extra) => ({
          mode,
          phase,
          activity: feed[feed.length - 1] ?? '',
          recent: feed.slice(-24),
          filesRead,
          pagesWritten: pagesSeen.size,
          elapsedSec: Math.round((Date.now() - startedAt) / 1000),
          ...extra,
        });
        const onActivity = (a) => {
          if (a.kind === 'read') filesRead++;
          if (a.kind === 'write') {
            phase = 'writing';
            pagesSeen.add(a.path || a.label);
          }
          // Collapse runs of bare "thinking…" so the feed doesn't fill with it.
          if (!(a.label === 'thinking…' && feed[feed.length - 1] === 'thinking…')) {
            feed.push(a.label);
            if (feed.length > 48) feed.shift();
          }
          void postWikiProgress(frame());
        };
        // Heartbeat: re-send the current frame every 5s even with no new stream
        // event, so the app's freshness window never lapses during a long
        // thinking block or slow tool (which emit nothing until they finish) —
        // otherwise the cover would flap back to the empty state mid-sweep.
        let heartbeat = null;
        try {
          // Immediate frame so the cover shows the daemon feed right away (the
          // "reading your code" phase), not a static message, while Claude warms up.
          feed.push('starting…');
          await postWikiProgress(frame(), true);
          heartbeat = setInterval(() => void postWikiProgress(frame(), true), 5000);
          if (!existsSync(wikiWt)) {
            try {
              git(['worktree', 'add', '--detach', wikiWt, baseRef], repoRoot);
            } catch {
              git(['worktree', 'prune'], repoRoot);
              git(['worktree', 'add', '--detach', wikiWt, baseRef], repoRoot);
            }
          }
          resetWorktree(wikiWt, baseRef);
          let sha = '';
          try {
            sha = git(['rev-parse', 'HEAD'], wikiWt);
          } catch {
            /* detached/no HEAD — still writes the map, just ungrounded */
          }
          // Sync the vault after the turn regardless of the sentinel: a died
          // sweep's partial pages still persist (merge, no prune) — only a
          // COMPLETED sweep finalizes, so an interrupted one can't erase pages.
          const runSync = async (finalize) => {
            try {
              const r = await syncVault({
                dir: vaultDir,
                url: WIKI_VAULT_URL,
                token: FLEET_TOKEN,
                userAgent: USER_AGENT,
                finalize,
                groundedAtSha: sha || undefined,
                // Powers the GitHub blob links behind every cited file path.
                repoFullName: originSlug(repoRoot) || undefined,
                warn,
                // Redact synced secrets a page may have quoted from the repo.
                scrub: envScrub,
              });
              if (r.skipped) note(`${c.cyan('wiki')} ${c.dim('— vault unchanged, nothing to sync')}`);
              else
                ok(
                  `${c.cyan('wiki')} ${c.dim(
                    `— synced ${r.uploaded} page${r.uploaded === 1 ? '' : 's'} (${r.pages} total${r.deleted ? `, ${r.deleted} removed` : ''})`
                  )}`
                );
            } catch (e) {
              warn(`wiki vault sync failed: ${e.message} — pages stay local; next turn retries`);
            }
          };
          // The cartographer needs to read the repo and write ONLY the vault —
          // a narrower promise than "build", so it is its own profile.
          const wikiRt = pickRuntimeFor('wiki');
          if (!wikiRt) {
            warn('wiki generation skipped — no installed CLI can run a vault-scoped turn');
            return;
          }
          const wikiLabel = RUNTIMES[wikiRt].label;
          if (task.type === 'sweep') {
            note(`${c.cyan('wiki')} ${c.dim(`— regenerating: your ${wikiLabel} is reading the repo…`)}`);
            const out = await runTurn({
              prompt: WIKI_KICKOFF(sha, vaultDir),
              resume: false,
              system: SYSTEM_WIKI(vaultDir),
              cwd: wikiWt,
              wikiPerm: true,
              vaultDir,
              runtime: wikiRt,
              label: c.cyan('[wiki]'),
              streamJson: true,
              onActivity,
              onSpawn: (ch) => {
                wikiChild = ch;
              },
            });
            const complete = sawSentinel(out, 'WIKI_DONE');
            if (complete) ok(`${c.cyan('wiki')} ${c.dim('— vault regenerated from your code.')}`);
            else
              warn('wiki sweep ended without WIKI_DONE — partial pages synced; retry from the app.');
            await runSync(complete);
          } else {
            const files = changedFilesForPr(task.prUrl);
            if (files === null) {
              // gh failed (network/auth) — retry via the durable job a couple
              // of times before consuming it, so a transient outage doesn't
              // silently drop the re-ground.
              const n = (regroundAttempts.get(task.intentId) ?? 0) + 1;
              regroundAttempts.set(task.intentId, n);
              if (n < 3) {
                warn(`wiki re-ground for "${task.title}": gh failed — will retry (${n}/3)`);
                groundedIntents.delete(task.intentId); // let the roster re-offer it
                continue;
              }
              warn(`wiki re-ground for "${task.title}": gh failed ${n} times — giving up (heals on the next full sweep)`);
            } else if (files.length === 0) {
              note(`${c.cyan('wiki')} ${c.dim(`— "${task.title}": no changed files to re-ground`)}`);
            } else {
              note(`${c.cyan('wiki')} ${c.dim(`— re-grounding after "${task.title}"…`)}`);
              const out = await runTurn({
                prompt: REGROUND_KICKOFF({
                  sha,
                  title: task.title,
                  files,
                  vaultDir,
                  predictedPages: task.dirtiesPages ?? [],
                }),
                resume: false,
                system: SYSTEM_REGROUND(vaultDir),
                cwd: wikiWt,
                wikiPerm: true,
                vaultDir,
                runtime: wikiRt,
                label: c.cyan('[wiki]'),
                streamJson: true,
                onActivity,
                onSpawn: (ch) => {
                  wikiChild = ch;
                },
              });
              if (sawSentinel(out, 'REGROUND_DONE'))
                ok(`${c.cyan('wiki')} ${c.dim(`— vault updated for "${task.title}".`)}`);
              else warn(`wiki re-ground for "${task.title}" ended without REGROUND_DONE.`);
              await runSync(false);
            }
            // Consume the durable job: attempted = done (success or not — the
            // sync is idempotent and a failed turn heals on the next full
            // sweep), so a failing re-ground can't loop-burn quota. Only a
            // crash BEFORE this line leaves the job listed for a retry.
            regroundAttempts.delete(task.intentId);
            await reportMergeOutcome(REGROUND_DONE_URL, { taskId: task.intentId });
          }
        } catch (e) {
          warn(`wiki ${task.type} failed: ${e.message}`);
        } finally {
          wikiChild = null;
          if (heartbeat) clearInterval(heartbeat);
          // Terminal frame so the app cover clears promptly (don't wait for the
          // freshness window to lapse). force-sent past the throttle.
          await postWikiProgress(frame({ done: true }), true);
          // Safety net: the wiki turn is read-only on the repo by CONTRACT, but
          // permission enforcement is a curated tool list, not a path jail —
          // discard anything a confused turn wrote to the worktree so it can
          // never leak into a later turn or a push.
          try {
            resetWorktree(wikiWt, baseRef);
          } catch {
            /* best-effort */
          }
        }
      }
    } finally {
      wikiBusy = false;
    }
    });
  }

  let connected = false; // log the first successful poll once
  let rosterSig = null; // last roster membership, to log changes only
  let idleBeatAt = 0; // throttle the "still alive" idle heartbeat
  let cappedWarned = false; // say once, not every reconcile, why extra lanes idle
  let joinCount = 0; // for stable per-agent label colours

  // ── Push channel: a server wake short-circuits the reconcile sleep so a job is
  // picked up in ~a round trip instead of on the next poll. The socket only
  // nudges — we still fetch the roster below — so it's pure latency, and the
  // poll stays the fallback whenever the socket is down. `waitReconcile()`
  // resolves on either a wake or the RECONCILE_SECONDS timeout, whichever first.
  let wakeSignal = null; // { resolve, timer } while the loop is idling
  let pendingWake = false; // a wake that landed mid-reconcile — honored next wait
  const fireWake = () => {
    if (wakeSignal) {
      clearTimeout(wakeSignal.timer);
      const { resolve } = wakeSignal;
      wakeSignal = null;
      resolve();
    } else {
      pendingWake = true; // not idling right now; don't lose the wake
    }
  };
  const waitReconcile = () => {
    if (pendingWake) {
      pendingWake = false;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        wakeSignal = null;
        resolve();
      }, RECONCILE_SECONDS * 1000);
      wakeSignal = { resolve, timer };
    });
  };
  stream = connectStream({ onWake: () => fireWake(), isAlive: () => daemonAlive });

  // Which agents to tell the server we already hold a good token for. We keep
  // our token (omit a re-mint) UNLESS it's near expiry AND the worker is idle
  // (no child mid-turn) — then we drop it from `have` to force a fresh token,
  // safely between turns so we never swap a credential out from under a run.
  const buildHave = () =>
    [...tokenByAgent.keys()].filter((id) => {
      const ageS = (Date.now() - (mintedAt.get(id) ?? 0)) / 1000;
      const nearExpiry = ageS > leaseTtlSeconds - REFRESH_BEFORE_SECONDS;
      const midTurn = workers.get(id)?.state.child != null;
      return !nearExpiry || midTurn;
    });

  // Reconcile loop: poll roster, start new workers, stop removed ones.
  for (;;) {
    let roster;
    try {
      roster = await fetchRoster(buildHave());
    } catch (e) {
      if (e.auth) {
        fail(`${e.message} — credential revoked or invalid. Shutting down.`);
        teardown();
        process.exit(1);
      }
      warn(`roster poll failed: ${e.message} — retrying in ${RECONCILE_SECONDS}s`);
      await sleep(RECONCILE_SECONDS);
      continue;
    }
    if (!connected) {
      connected = true;
      ok('Connected to Flowviant — watching your roster.');
      // Name the scoped project so a mismatch (this daemon serves project A, but
      // you're viewing project B's wiki) is obvious instead of a silent no-op.
      if (roster.project) {
        note(
          `${c.cyan('project')} · ${c.bold(roster.project.name)} ${c.dim(`(${roster.project.id})`)}`
        );
        note(c.dim('  wiki + agents stream to THIS project — view its Code canvas in Flowviant.'));
      }
    }
    if (roster.mcpUrl) mcpUrl = roster.mcpUrl;
    if (roster.project?.id) wikiProjectId = roster.project.id; // keys the vault dir
    if (roster.leaseTtlSeconds) leaseTtlSeconds = roster.leaseTtlSeconds;
    // Keep the daemon current. Safe = no worker mid-task (true at startup, since
    // no workers are spawned yet). If it self-updates it re-execs into the new
    // version and this process becomes a proxy — stop the loop.
    if (roster.daemon) {
      // "No worker mid-task" must include the wiki runner: updating mid-sweep
      // re-execs the daemon, orphans the wiki Claude, and the fresh process
      // starts a second sweep racing it on the same vault.
      const safeToUpdate =
        !wikiBusy && [...workers.values()].every((w) => w.state.child == null);
      const updating = handleVersionSignal({
        latest: roster.daemon.latest,
        min: roster.daemon.min,
        autoUpdate: AUTO_UPDATE,
        safeToUpdate,
        teardown,
      });
      if (updating) return;
    }
    processMergeJobs(roster.mergeJobs);
    processPatchRevertJobs(roster.patchRevertJobs);
    processPlanCheckJobs(roster.planCheckJobs);
    processConsultJobs(roster.consultJobs);
    processWorkTurns(roster.workTurnJobs);
    processShipJobs(roster.shipJobs);
    processJoinJobs(roster.joinJobs);
    processCleanupJobs(roster.cleanupJobs);
    const rosterIds = new Set(roster.agents.map((a) => a.agentId));

    // Announce roster size only when it changes (not every poll).
    const sig = [...rosterIds].sort().join(',');
    if (sig !== rosterSig) {
      rosterSig = sig;
      if (rosterIds.size === 0) {
        warn('No agents on your roster yet.');
        info('Add agents in Flowviant → Cockpit → Fleet; they spin up here automatically.');
      } else {
        note(`Roster: ${c.bold(String(rosterIds.size))} agent${rosterIds.size === 1 ? '' : 's'}.`);
      }
    }
    // Heartbeat so a quiet/empty daemon visibly stays alive.
    if (rosterIds.size === 0 && Date.now() - idleBeatAt > 60_000) {
      idleBeatAt = Date.now();
      info('idle — waiting for agents…');
    }

    for (const a of roster.agents) {
      if (a.token) {
        tokenByAgent.set(a.agentId, a.token);
        mintedAt.set(a.agentId, Date.now());
      }
      hasWorkByAgent.set(a.agentId, !!a.hasWork);
      // The hint's task id, new name first. Normalized ONTO `intentId` here so
      // every downstream read (poll worker, kickoff, diffstat attribution)
      // keeps its one spelling — intent is still the daemon's internal word,
      // taskId is the wire's.
      const nextId = a.next && (a.next.taskId ?? a.next.intentId);
      if (a.next && typeof nextId === 'string')
        nextByAgent.set(a.agentId, { ...a.next, intentId: nextId });
      else nextByAgent.delete(a.agentId);
      if (!workers.has(a.agentId)) {
        // Local ceiling, enforced and not merely requested. The roster can carry
        // more lanes than this machine asked for — someone added capacity by
        // hand, or a second machine shares the fleet — and each extra worker is
        // another Claude session, another worktree and another dev server on
        // somebody's laptop. Skipping the spawn does NOT strand the work: an
        // @mention addresses the FLEET, so any running lane can claim it; the
        // tasks queue behind the ones we did start.
        if (workers.size >= MAX_CONCURRENT) {
          if (!cappedWarned) {
            cappedWarned = true;
            info(
              `running ${MAX_CONCURRENT} task${MAX_CONCURRENT === 1 ? '' : 's'} at a time on this machine — ` +
                `more will queue (FLOWVIANT_MAX_CONCURRENT to change)`
            );
          }
          continue;
        }
        // LIVE lanes get NO checkout of their own — they ask for one per task,
        // once they know which task. Poll mode is the legacy escape hatch and
        // keeps its per-lane tree; it predates per-task sandboxes and isn't
        // worth restructuring for a path nobody runs by default.
        let wt = null;
        if (!LIVE) {
          try {
            ensureWorktree(repoRoot, (wt = join(baseDir, `agent-${a.agentId}`)), baseRef);
          } catch (e) {
            fail(`could not create worktree for "${a.name}": ${e.message}`);
            continue;
          }
          try {
            materializeInto(wt); // synced env into the fresh worktree
          } catch {
            /* best-effort */
          }
        }
        const colorFn = LABEL_COLORS[joinCount++ % LABEL_COLORS.length];
        const label = colorFn(`[${a.name}]`);
        const state = { alive: true, child: null };
        ok(`${label} ${c.dim(LIVE ? 'online — live session' : 'online — worktree ready')}`);
        const workerFn = LIVE ? runLiveWorker : runFleetWorker;
        const promise = workerFn({
          agentId: a.agentId,
          label,
          ...(LIVE ? { worktreeFor } : { cwd: wt }),
          baseRef,
          repoRoot, // for copying the repo's local env into the preview worktree

          getToken: (id) => tokenByAgent.get(id),
          getHasWork: (id) => hasWorkByAgent.get(id) ?? false,
          getNext: (id) => nextByAgent.get(id) ?? null,
          getMcpUrl: () => mcpUrl,
          // Injected rather than imported: fleet.mjs imports live.mjs, so live
          // cannot import back. The live worker is the DEFAULT one, and until
          // this was passed down the whole run-diffstat pipeline was reachable
          // only under FLOWVIANT_POLL=1 — the app's live-changes panel had no
          // data source at all for the path everybody actually runs.
          sampleDiffstat,
          isAlive: () => state.alive,
          onChild: (ch) => {
            state.child = ch;
          },
          // Which task this lane is holding, so per-process memory can be
          // attributed to a task rather than to an anonymous pid. "The box is
          // full" is not actionable; "this task is holding 9GB" is.
          onIntent: (id) => {
            state.intentId = id;
          },
          // Hold the preview's stop fn so teardown/removal can kill the detached
          // dev-server + tunnel (they survive our exit otherwise).
          onPreview: (stop) => {
            state.stopPreview = stop;
          },
          // A turn that couldn't reach the MCP server: forget the cached token so
          // the next reconcile poll re-mints a fresh one (self-heals a token that
          // was rotated/expired out from under a running session).
          onTokenSuspect: (id) => {
            tokenByAgent.delete(id);
            mintedAt.delete(id);
          },
        });
        workers.set(a.agentId, { state, promise, wt, label });
      }
    }

    // Living-wiki work (runs under its own minted wiki token — no agent
    // needed). enqueueSweep queues a Regenerate; regroundJobs re-offers merged
    // deliveries whose re-ground never ran (e.g. we restarted between merge and
    // turn) until we report reground-done; the bare drain flushes anything
    // whose earlier mint failed.
    enqueueSweep(roster.codeMapJob);
    for (const j of roster.regroundJobs ?? []) {
      const rid = j && (j.taskId ?? j.intentId); // new name first, old as fallback
      if (!j || typeof rid !== 'string') continue; // a null element would throw + wedge the loop
      enqueueReground(rid, j.prUrl, j.title, j.dirtiesPages);
    }
    void drainWiki();

    // Env sync tick: register/bootstrap/wrap/rotate/sync as the roster block
    // dictates (self-guarded — one operation at a time, errors retry next
    // poll). A fresh bundle rematerializes every AGENT worktree; the wiki
    // worktree NEVER gets env (the cartographer doesn't need secrets).
    void handleRosterEnv(roster.env, { projectId: roster.project?.id }).then(({ changed }) => {
      if (!changed) return;
      for (const [, w] of workers) {
        try {
          materializeInto(w.wt);
        } catch {
          /* best-effort */
        }
      }
    });

    // Tell the app what this machine is doing with itself. Every reconcile,
    // best-effort, and never awaited — telemetry that can delay a dispatch is
    // worse than no telemetry.
    //
    // The one thing Flowviant could never answer about a task was "why is it
    // slow", because the box was somebody's laptop and only they could look at
    // it. Centralising is supposed to make one machine easier to manage than N
    // laptops; that is only true if the machine is visible. Per-task RSS is the
    // load-bearing part — "the box is full" is not actionable, "this task is
    // holding 9GB" is.
    void reportMergeOutcome(
      MACHINE_URL,
      machineSnapshot({
        worktreeDir: baseDir,
        tasks: [...workers].map(([, w]) => ({
          intentId: w.state.intentId ?? null,
          pid: w.state.child?.pid,
        })),
      })
    );

    // Deploy: a deploy-authorized daemon reports its .flowviant/deploy.json and
    // runs queued deploy jobs (the server only sends deployJobs to authorized
    // machines). Config report is cheap + dedup'd; jobs are single-flight.
    if (roster.env?.deployAuthorized) {
      void reportDeployConfig(repoRoot);
      processDeployJobs(roster.deployJobs, { repoRoot, baseRef, myPubB64 });
    }

    // Stop workers whose agent left the roster (removed in the app).
    for (const [id, w] of [...workers]) {
      if (!rosterIds.has(id)) {
        warn(`${w.label} removed — stopping it now.`);
        w.state.alive = false;
        // Immediate teardown (Q6=B): kill the in-flight Claude process now; its
        // task was already requeued server-side on removal.
        try {
          w.state.child?.kill('SIGKILL');
        } catch {
          /* best-effort */
        }
        try {
          w.state.stopPreview?.();
        } catch {
          /* best-effort */
        }
        // Only poll mode's per-lane tree dies with the lane. A live lane owns no
        // checkout: the task it was building has its own, which must SURVIVE —
        // removing a lane requeues its task, and the next lane to pick that task
        // up resumes in that same directory rather than starting over.
        if (w.wt) {
          try {
            git(['worktree', 'remove', '--force', w.wt], repoRoot);
          } catch {
            /* best-effort */
          }
        }
        workers.delete(id);
        tokenByAgent.delete(id);
        hasWorkByAgent.delete(id);
        nextByAgent.delete(id);
        mintedAt.delete(id); // was leaked on removal (finding 14)
      }
    }

    // Idle until the next poll deadline OR a push wake — whichever comes first.
    await waitReconcile();
  }
}
