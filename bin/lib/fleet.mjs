/**
 * Fleet daemon. Install ONCE with a fleet credential; manage everything from
 * Flowviant. The daemon polls GET /api/v2/fleet/agents, reconciles one persistent
 * git worktree + worker loop per roster agent, rotates each worker's short-lived
 * MCP token, and only spawns Claude when the server says an agent has work.
 */

import {
  mkdirSync,
  existsSync,
  rmSync,
  readdirSync,
  statSync,
} from 'node:fs';
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
  DAEMON_INSTANCE,
  POLL_SECONDS,
  MAX_CONCURRENT,
  IDLE_SECONDS,
  RECONCILE_SECONDS,
  REFRESH_BEFORE_SECONDS,
  LIVE,
  AUTO_UPDATE,
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
import { c, info, note, ok, warn, fail } from './ui.mjs';
import { revertPatch, withPatchLock } from './patch.mjs';
import {
  sleep,
  mcpFor,
  runTurn,
  sawSentinel,
  blockedId,
  SYSTEM_WIKI,
  WIKI_KICKOFF,
  SYSTEM_REGROUND,
  REGROUND_KICKOFF,
} from './claude.mjs';
import { reapOrphanPreviews } from './preview.mjs';
import { acquireInstanceLock } from './instance.mjs';
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
import { detectRuntimes, knownSkills, pickRuntimeFor, RUNTIMES } from './runtimes.mjs';
import { createWorkManager } from './work.mjs';
import { scanLocalSessions } from './localSessions.mjs';

async function fetchRoster(haveIds, livePreviewSessionIds = [], heldSessionIds = []) {
  const url = new URL(FLEET_URL);
  if (haveIds.length) url.searchParams.set('have', haveIds.join(','));
  // What this machine will run at once. The server grows lanes to meet waiting
  // work beneath this, instead of the user pre-sizing a pool by hand — only the
  // machine knows its cores, its RAM and whose Claude quota is being spent.
  // Older servers ignore the param, so sending it is always safe.
  url.searchParams.set('capacity', String(MAX_CONCURRENT));
  // WHICH DAEMON this machine runs, so the server can gate version-dependent
  // work — codex Workbench tabs are only created for machines whose daemon can
  // actually serve them (dv >= 0.46.0). The same source the self-update check
  // compares against the roster's daemon.latest (config.mjs VERSION, read off
  // our own package.json). Older servers ignore unknown params, so sending it
  // unconditionally is always safe.
  url.searchParams.set('dv', VERSION);
  // The permission posture this machine runs turns under — '1' when
  // FLOWVIANT_SAFE narrows the toolset, '0' when everything is granted. A
  // statement of configuration, not a request: the app SHOWS it in Settings
  // so a team can see whether the shared box runs wide open, and enforces
  // nothing (membership is the consent boundary). Older servers ignore it.
  url.searchParams.set('safe', SAFE ? '1' : '0');
  // WHICH PROCESS, so the server can lease preview work to exactly one of two
  // daemons on one credential. Older servers ignore unknown params.
  url.searchParams.set('di', DAEMON_INSTANCE);
  // Which shares this machine is still serving. It rides the poll rather than
  // taking an endpoint of its own: one beat, no floor, and the stale window is
  // the reconcile interval instead of minutes — which matters, because a share
  // the server still calls live is a 530 on somebody's phone. Always set, even
  // empty: '' means "serving none", absent would mean "an older daemon".
  url.searchParams.set('pv', livePreviewSessionIds.join(','));
  // The sessions this daemon holds a worktree for. Its LEASE on each renews
  // here — one beat, no extra endpoint, and the server can tell "this daemon is
  // still serving that tab" from "it went away" within a reconcile interval
  // instead of minutes. Always set, even empty: '' means "holding none".
  url.searchParams.set('ws', heldSessionIds.join(','));
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
  // WHAT THE CLI CAN BE ASKED FOR BY NAME, so the composer can autocomplete a
  // `/` the way the terminal does. Learned from the init event of a turn we
  // already ran (runtimes.mjs) — never probed, because spawning a CLI to fill a
  // dropdown would spend the operator's quota on an affordance.
  //
  // NOT SENT until a turn has taught us: absent means "no turn has run here
  // yet", and the app renders no menu rather than asserting this machine has no
  // skills. An empty report, though, IS a fact and is sent as such — hence the
  // null check rather than a truthiness check on the array.
  try {
    const skills = knownSkills();
    if (skills !== null) url.searchParams.set('skills', skills.join(','));
  } catch {
    /* best-effort — the poll must never fail on a readout */
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


/**
 * Terminal-session presence: tell the server which Claude sessions exist in
 * this repo (localSessions.mjs reads them off Claude's own on-disk state), so
 * the Workbench can offer "adopt this terminal session as a tab". Best-effort
 * in exactly the way the env/runtimes blocks are — a presence report that can
 * fail a poll is worse than no presence at all — with three quiet economies:
 * the scan runs at most once a minute (the reconcile loop ticks far faster), a
 * report identical to the last DELIVERED one is not re-sent, and a 404 means
 * an older server that has never heard of the endpoint, after which this
 * process stops asking (a deploy that adds it also restarts nothing on this
 * machine, so silence-until-restart costs one daemon restart, not a feature).
 */
const LOCAL_SESSIONS_URL = FLEET_URL.replace(/\/agents\/?$/, '/local-sessions');
const LOCAL_SESSIONS_SCAN_MS = 60_000;
// The web hides a report older than 10 minutes (presence must not linger as
// fact after the machine dies), so an UNCHANGED report is re-sent inside that
// window anyway — the re-send is the machine's heartbeat on this fact, and
// suppressing it entirely would blank the strip while everything still holds.
const LOCAL_SESSIONS_RESEND_MS = 5 * 60_000;
let localSessionsUnsupported = false; // the server 404'd — quiet until restart
let localSessionsScanAt = 0;
let localSessionsSent = null; // last payload the server ACCEPTED, stringified
let localSessionsSentAt = 0;
async function maybeReportLocalSessions({ repoRoot, excludeDirs }) {
  if (localSessionsUnsupported) return;
  if (Date.now() - localSessionsScanAt < LOCAL_SESSIONS_SCAN_MS) return;
  localSessionsScanAt = Date.now();
  let payload;
  try {
    // scanLocalSessions orders deterministically, so this string only changes
    // when the facts on disk do — the dedup below compares whole payloads.
    payload = JSON.stringify({ sessions: scanLocalSessions({ repoRoot, excludeDirs }) });
  } catch {
    return; // presence must never throw into the poll loop
  }
  if (payload === localSessionsSent && Date.now() - localSessionsSentAt < LOCAL_SESSIONS_RESEND_MS)
    return;
  try {
    const res = await fetch(LOCAL_SESSIONS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${FLEET_TOKEN}`,
        'User-Agent': USER_AGENT,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(15_000),
      body: payload,
    });
    if (res.status === 404) {
      localSessionsUnsupported = true; // older server — it REPLACED nothing here
      return;
    }
    // Only an accepted report counts as sent; anything else forgets the
    // last-sent payload so the next pass retries instead of dedup-suppressing
    // a report the server never received.
    localSessionsSent = res.ok ? payload : null;
    localSessionsSentAt = res.ok ? Date.now() : 0;
  } catch {
    localSessionsSent = null;
    localSessionsSentAt = 0;
  }
}

/**
 * A STOP COMMANDED BY FLOWVIANT, read off the roster poll.
 *
 * The daemon is a PULL client — the /fleet/stream socket is a one-way wake
 * nudge with no server→daemon request path — so "stop this machine" can never
 * be a request the server makes of us. It rides the roster RESPONSE instead, on
 * the same `daemon` object the version signal already travels on, which is why
 * it needs no new endpoint and no version floor: an older daemon reads an
 * unknown key as nothing and keeps running, and fail-open is the safe direction
 * for a switch whose failure mode is "your machine went dark".
 *
 * The server decides whether a stop is LIVE — it stamps the credential and only
 * sends the key inside a short honor window — and the daemon does NOT re-derive
 * that. The key's PRESENCE is the command. Evaluating the same TTL on both
 * sides would make clock skew the arbiter of whether a machine may run, and get
 * it wrong in the direction that bricks the box: a relaunch that re-reads an
 * old timestamp and stops itself again, forever.
 *
 * Pure and exported so the decision can be proved without a credential or a
 * live server. `null` means keep running.
 */
export function shouldStop(rosterDaemon) {
  const stop = rosterDaemon?.stop;
  // An OBJECT, and not an array: `typeof [] === 'object'`, so the plain typeof
  // guard let `stop: []` — an empty list, which is how this codebase spells "no
  // jobs" on every other roster key — read as a live stop with no reason. A
  // switch that kills a machine gets the narrow test.
  if (!stop || typeof stop !== 'object' || Array.isArray(stop)) return null;
  // Re-sanitized HERE even though the server wrote it: this string is operator
  // prose typed into a SQL UPDATE and then printed straight to a terminal, so
  // control bytes would let a stop reason repaint the console it is being read
  // on, and an unbounded one would bury the line that matters. The WORDING is
  // untouched — the operator's own sentence is the whole point of the field,
  // and paraphrasing it would leave the person at the keyboard guessing.
  const reason = String(stop.reason ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
  return { stop: true, reason };
}

// One roster agent's loop: persistent worktree, one intent per turn, reset to
// base between tasks (fresh conversation), resume in place while on a blocker.

export async function runFleetDaemon() {
  console.log('');
  console.log(`  ${c.bold(c.cyan('◣ flowviant'))}  ${c.dim(`machine daemon · v${VERSION}`)}`);
  console.log(`  ${c.dim('──────────────────────────────────────────────')}`);
  const repoRoot = repoRootOrDie();
  const baseRef = detectBaseRef(repoRoot);
  info(SAFE ? 'mode   · safe (restricted toolset)' : 'mode   · unattended (skips permission prompts)');
  info(`repo   · ${repoRoot}`);
  info(`base   · ${baseRef}`);
  info(`server · ${FLEET_URL}`);
  console.log('');

  // ONE DAEMON PER CREDENTIAL. Before preflight, before the preview reap,
  // before anything with a side effect — a second daemon must not so much as
  // install a CLI or clear a registry on its way to being refused. Keyed on the
  // credential rather than the repo, because two checkouts on one credential is
  // the SAME project served twice, and the worst version of this: their session
  // worktrees are in different directories, so the per-turn lock cannot even see
  // across them. See instance.mjs for why that lock is not enough on its own.
  // Same repo -> this run replaces whatever was serving it. Different repo ->
  // refused, and nothing is signalled. See instance.mjs's header for the rule.
  const instance = acquireInstanceLock(FLEET_TOKEN, repoRoot, {
    takeover:
      process.argv.includes('--takeover') || process.argv.includes('--takeover-downgrade'),
    noTakeover:
      process.argv.includes('--no-takeover') || process.env.FLOWVIANT_NO_TAKEOVER === '1',
    allowDowngrade: process.argv.includes('--takeover-downgrade'),
    log: (m) => info(m),
  });
  if (!instance.ok) {
    const h = instance.holder;
    console.log('');
    // Two different refusals, because they are two different mistakes and the
    // fix is not the same. Same CREDENTIAL: one project is being served twice.
    // Same REPO under another credential: two daemons in one working tree,
    // which the credential-keyed lock cannot see on its own.
    if (instance.takeoverFailed) {
      fail(`could not replace the running daemon: ${instance.takeoverFailed}`);
    } else if (instance.sameRepo) {
      fail('a flowviant daemon is already running in this repo.');
    } else {
      fail('a flowviant daemon is already running for this credential.');
    }
    if (h?.pid) info(`holder · pid ${h.pid}${h.repoRoot ? ` in ${h.repoRoot}` : ''}`);
    // The two-checkouts case is the one nobody spots on their own: both tabs
    // look healthy, and the damage is doubled cards and doubled edits in a repo
    // you are not looking at. Name the other repo when it is a different one.
    if (!instance.sameRepo && h?.repoRoot && h.repoRoot !== repoRoot) {
      warn('that is a DIFFERENT checkout — one credential serves one project, so both would answer the same tabs.');
      // Not offered lightly: that daemon is serving other work, and this
      // command was run somewhere else. Replacing it is a decision, not a
      // restart, so it takes a word.
      note('run with --takeover to stop it and serve this repo instead.');
    }
    // WITHHELD when we could not identify the holder. ALLOW_MULTI runs this
    // daemon unguarded beside one we just admitted we cannot see, and in the
    // same repo that is two `git fetch`, two worktree sweeps, and one
    // `retireWorkSessions` deleting directories the other is serving. Offering
    // it as the way out of "I don't know what that process is" would be handing
    // someone the worst option at the moment they have the least information.
    if (!instance.unidentified) {
      note('or run this one with FLOWVIANT_ALLOW_MULTI=1 if you know what you are doing.');
    }
    console.log('');
    process.exit(1);
  }
  if (instance.unguarded)
    warn('could not take the single-instance lock (unwritable ~/.flowviant) — running unguarded');

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
  // DEAD, and kept only because unpicking it is a rewire rather than a
  // deletion: nothing calls `workers.set` anywhere in this tree. It held
  // DISPATCH lanes, and the server has sent `agents: []` permanently since
  // 2026-08-19, so every loop below iterates nothing. Two `stopPreview` calls
  // hung off it until 2026-08-21 and read as live preview wiring; they were
  // deleted, not rewired. When the Workbench preview lands, its teardown is
  // keyed on sessionId and belongs beside retireWorkSessions in work.mjs —
  // NOT here.
  const workers = new Map(); // agentId -> { state, promise, wt, label }
  let daemonAlive = true; // flipped false on shutdown so the stream stops reconnecting
  let stream = null; // push channel handle (set once the loop is set up)
  let workShutdown = null; // kills live session-turn CLIs (set with the work manager below)

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
    // Session-turn CLIs die with the daemon too: an orphan keeps editing the
    // session worktree and burning quota, and its live-pid lock would make the
    // restarted daemon skip that tab's turns for as long as it survived.
    try {
      workShutdown?.();
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
    }
    // Detached tunnels survive our exit by design, so leaving them would strand
    // a public hostname until the box rebooted.
    shutdownPreviews();
  };
  process.on('SIGINT', () => {
    console.log('');
    note('shutting down — stopping workers. Worktrees are kept: in-flight work resumes next run.');
    teardown();
    process.exit(130);
  });
  // A service manager stops the daemon with SIGTERM, not Ctrl+C. Without this
  // handler every child survived a `systemctl stop` — the exact orphaning the
  // teardown exists to prevent.
  process.on('SIGTERM', () => {
    console.log('');
    note('shutting down (SIGTERM) — stopping workers. Worktrees are kept: in-flight work resumes next run.');
    teardown();
    process.exit(143);
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

  // Machine telemetry — what the box is doing with itself, for the admin view.
  const MACHINE_URL = FLEET_URL.replace(/\/agents\/?$/, '/machine');




  // ── Work sessions — the Workbench tabs ─────────────────────────────────────
  //
  // The whole machinery — per-session turn/ship chains, per-session work
  // tokens, the settle-every-turn contract, the ship executor, worktree
  // retirement — lives in work.mjs; this hands it the loop's mutable state.
  const {
    flushWorkReports,
    processWorkTurns,
    processShipJobs,
    processDiffJobs,
    heldSessionIds,
    processPreviewJobs,
    livePreviewIds,
    retirePreviews,
    shutdownPreviews,
    retireWorkSessions,
    reportWorktrees,
    shutdownWork,
    workBusy,
  } = createWorkManager({
    repoRoot,
    baseDir,
    baseRef,
    getMcpUrl: () => mcpUrl,
    getLeaseTtl: () => leaseTtlSeconds,
  });
  workShutdown = shutdownWork; // teardown can now reach the live session CLIs

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
            enqueueReground(job.id, job.prUrl, job.title, job.dirtiesPages, job.shas);
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
  const enqueueReground = (intentId, prUrl, title, dirtiesPages, shas) => {
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
      // THE COMMITS THAT SHIPPED — what changedFilesForShas resolves against.
      // Dropping this here was the whole 0.54.0/0.54.1 defect: the server sent
      // shas on every reground job, this function never stored them, and the
      // drain's `task.shas` was undefined on every job — so the re-ground
      // "revived" on 2026-08-22 retried three times against nothing and gave
      // up, on a console nobody reads, on every single ship.
      shas: Array.isArray(shas) ? shas : [],
    });
    void drainWiki();
  };

  // Changed files of a (merged) PR, for the re-ground prompt. Capped so a huge
  // PR can't blow up the prompt. prUrl was already validated before the merge.
  // WHICH FILES A SHIP CHANGED, read from the commits it landed.
  //
  // This asked `gh pr view <prUrl> --json files` until 2026-08-22, and `prUrl`
  // has been null by construction since dispatch was deleted on 2026-08-19 —
  // the server writes null and says so in a comment. Node threw on the null
  // argument, the catch below read it as "gh failed", and the re-ground retried
  // three times and gave up. Every post-ship re-ground for three months did
  // that silently, while the spec said ship re-grounds the wiki.
  //
  // Returns null when it learned NOTHING (no shas, or none of them resolvable),
  // which the caller still treats as retryable — distinct from a ship that
  // genuinely changed no files.
  const changedFilesForShas = (shas) => {
    if (!Array.isArray(shas) || shas.length === 0) return null;
    const files = new Set();
    for (const sha of shas.slice(0, 50)) {
      if (!/^[0-9a-f]{7,40}$/i.test(String(sha))) continue;
      try {
        const out = execFileSync(
          'git',
          ['show', '--name-only', '--pretty=format:', String(sha)],
          { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
        );
        for (const line of out.split('\n')) {
          const f = line.trim();
          if (f) files.add(f);
          if (files.size >= 60) break;
        }
      } catch {
        // One unreachable commit is not a failed re-ground — the ship merged
        // to main and the rest of the shas still name real files. Only an
        // EMPTY result is treated as "we learned nothing".
      }
      if (files.size >= 60) break;
    }
    return files.size ? [...files] : null;
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
            const files = changedFilesForShas(task.shas);
            if (files === null) {
              // gh failed (network/auth) — retry via the durable job a couple
              // of times before consuming it, so a transient outage doesn't
              // silently drop the re-ground.
              const n = (regroundAttempts.get(task.intentId) ?? 0) + 1;
              regroundAttempts.set(task.intentId, n);
              if (n < 3) {
                warn(`wiki re-ground for "${task.title}": no changed files resolved — will retry (${n}/3)`);
                groundedIntents.delete(task.intentId); // let the roster re-offer it
                continue;
              }
              warn(`wiki re-ground for "${task.title}": could not resolve changed files ${n} times — giving up (heals on the next full sweep)`);
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
            // The dedup was DAEMON-LIFETIME, which wedged a reopened card: its
            // second ship writes a fresh durable job, this Set still holds the
            // taskId, enqueueReground refuses it on every poll forever, and
            // the never-consumed job churns the wiki-writer lease until a
            // restart. The job is consumed now, so the guard has done its work;
            // a FUTURE ship of the same card is new work, not a duplicate.
            groundedIntents.delete(task.intentId);
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
      roster = await fetchRoster(buildHave(), livePreviewIds(), heldSessionIds());
    } catch (e) {
      if (e.auth) {
        fail(`${e.message} — credential revoked or invalid. Shutting down.`);
        teardown();
        // EXIT 0, for the same reason the commanded-stop path does: a revoked
        // credential is a terminal, asked-for-by-someone state, and a relaunch
        // can never fix it. Under `Restart=on-failure` a nonzero code has
        // systemd relaunch the daemon immediately — a restart loop hammering
        // dead-credential polls, fighting the Disconnect that revoked it, and
        // ending in a unit that reads as a crash rather than a kill.
        process.exit(0);
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
    // A COMMANDED STOP OUTRANKS AN UPDATE, and that ordering is the whole reason
    // this sits ABOVE the version signal rather than inside it. Both read the
    // same `roster.daemon` object, but `handleVersionSignal` can re-exec this
    // process into a newer build — so checked second, a machine somebody just
    // told to stop would come back up wearing a different version instead of
    // going away.
    const stopSignal = shouldStop(roster.daemon);
    if (stopSignal) {
      warn(
        stopSignal.reason
          ? `stopped by Flowviant — ${stopSignal.reason}`
          : 'stopped by Flowviant — no reason given.'
      );
      note('shutting down — stopping workers. Worktrees are kept: in-flight work resumes next run.');
      // FLUSH the settle queue first, bounded: a queued-but-undelivered report
      // is a COMPLETED turn whose side effects already happened, and dropping
      // it re-runs the whole turn on the next start — quota spent twice and
      // every card write doubled. This path is async (unlike the signal
      // handlers, which cannot await), so the stop can afford five seconds of
      // delivery before it obeys.
      try {
        await Promise.race([flushWorkReports(), sleep(5)]);
      } catch {
        /* undelivered reports re-run; delivering them was best-effort */
      }
      // teardown() is NOT optional on this path. Detached preview tunnels
      // survive this process BY DESIGN, so exiting without it strands a public
      // hostname pointed into a worktree until somebody reboots the box — which
      // is precisely the state a remote stop is usually being used to end. It
      // also kills the session CLIs and the wiki Claude, which would otherwise
      // keep editing worktrees and burning quota for a machine nobody is
      // watching any more.
      teardown();
      // EXIT 0, and this is load-bearing: the stop was ASKED FOR, so it is not
      // a failure. Under `Restart=on-failure` a nonzero code has systemd
      // relaunch the daemon immediately, fighting the very command that stopped
      // it; exit 0 reads as "the job is done" and leaves it down. The server's
      // honor window is what makes the other half work — a deliberate relaunch
      // minutes later comes up clean instead of stopping itself forever.
      process.exit(0);
    }
    // Keep the daemon current. Safe = no worker mid-task (true at startup, since
    // no workers are spawned yet). If it self-updates it re-execs into the new
    // version and this process becomes a proxy — stop the loop.
    if (roster.daemon) {
      // "No worker mid-task" must include the wiki runner: updating mid-sweep
      // re-execs the daemon, orphans the wiki Claude, and the fresh process
      // starts a second sweep racing it on the same vault. And it must include
      // SESSION work (workBusy — turns, ships, undelivered settle reports):
      // dispatch workers' children say nothing about the Workbench tabs, and a
      // re-exec mid-turn SIGTERMs the tab's CLI and settles a partial answer.
      const safeToUpdate =
        !wikiBusy &&
        !workBusy() &&
        [...workers.values()].every((w) => w.state.child == null);
      const updating = handleVersionSignal({
        latest: roster.daemon.latest,
        min: roster.daemon.min,
        autoUpdate: AUTO_UPDATE,
        safeToUpdate,
        teardown,
      });
      if (updating) return;
    }
    // Settle any turn/ship answers whose earlier report POST failed BEFORE
    // taking new work — the skip-if-pending guards make the ordering safe, but
    // delivering first keeps the tab honest a poll sooner.
    void flushWorkReports();
    processMergeJobs(roster.mergeJobs);
    processPatchRevertJobs(roster.patchRevertJobs);
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
    // A session another daemon on this credential is serving is NOT a closed
    // tab. Without this the daemon that lost the lease removes the worktree the
    // winner is working in — absence would mean "somebody else won" instead of
    // "the tab closed".
    retireWorkSessions(
      Array.isArray(roster.activeWorkSessions)
        ? roster.activeWorkSessions
        : roster.activeWorkSessions,
      roster.sessionsHeldElsewhere
    );
    // Diffs somebody has open and is waiting on. Project-scoped rather than
    // per-session: `git show` runs from the repo ROOT, which can see a closed
    // tab's branch and a shipped commit on main alike.
    processDiffJobs(roster.diffJobs);
    // Shares to open or tear down. CLAIMED before acted on — two daemons on one
    // credential are both handed this array, and both opening a tunnel strands
    // a public hostname nobody can settle.
    processPreviewJobs(roster.previewJobs);
    // …and what the SURVIVING ones hold: branch, ahead-of-base, diffstat.
    // Throttled inside, never awaited — a `git status` the human cannot run
    // themselves from a browser, relayed. After retirement so a directory that
    // just went away is not reported as a place.
    reportWorktrees(roster.activeWorkSessions);
    // Terminal-session presence, throttled + dedup'd inside; never awaited —
    // the daemon's own worktrees are carved out (a session the daemon spawned
    // is already a tab, not something to offer adopting).
    void maybeReportLocalSessions({ repoRoot, excludeDirs: [baseDir] });
    processCleanupJobs(roster.cleanupJobs);
    const rosterIds = new Set(roster.agents.map((a) => a.agentId));

    // Announce roster size only when it changes (not every poll).
    const sig = [...rosterIds].sort().join(',');
    if (sig !== rosterSig) {
      rosterSig = sig;
      // `agents` is permanently [] — the lanes it counted died with dispatch
      // and the array survives only as wire compat, so this runs once, on the
      // first poll. It used to point at the Cockpit, a surface deleted
      // 2026-08-04 that now redirects to the Board. Say what is actually true
      // instead: the machine is up, and work starts in a tab.
      info('Machine online. Open a tab in Flowviant → Workbench to start working.');
    }
    // Heartbeat so a quiet daemon visibly stays alive. Gated on REAL work —
    // `rosterIds` is built from `roster.agents`, which the server sends
    // permanently empty, so gating on it printed "waiting" once a minute even
    // while a tab's turn was running. `workBusy()` is the honest question: are
    // there session turns, ships or unsettled reports in flight?
    if (!workBusy() && Date.now() - idleBeatAt > 60_000) {
      idleBeatAt = Date.now();
      info('machine online — nothing running right now.');
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
      enqueueReground(rid, j.prUrl, j.title, j.dirtiesPages, j.shas);
    }
    void drainWiki();

    // Env sync tick: register/bootstrap/wrap/rotate/sync as the roster block
    // dictates (self-guarded — one operation at a time, errors retry next
    // poll). A fresh bundle rematerializes every SESSION worktree this daemon
    // holds — read off the sessions directory, the same fact retirement acts
    // on; the wiki worktree NEVER gets env (the cartographer doesn't need
    // secrets). This used to iterate the dispatch-era `workers` map, which
    // nothing has ever `.set()`, so a rotation reached no worktree at all.
    // Safe mid-turn by construction: materializeInto refuses to write anything
    // git does not ignore, so it cannot dirty a tree and block a ship.
    void handleRosterEnv(roster.env, { projectId: roster.project?.id }).then(({ changed }) => {
      if (!changed) return;
      for (const id of heldSessionIds()) {
        try {
          materializeInto(join(baseDir, 'sessions', id));
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
