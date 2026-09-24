/**
 * Work sessions — the Workbench tabs, daemon side.
 *
 * A tab is a held coding-CLI session (Claude or codex — the server names the
 * brain per tab, and the pin holds it) with BUILD permissions in a PERSISTENT
 * worktree on its own `session/<id>` branch. Nothing here is detached and
 * nothing is ever reset — uncommitted state between turns IS the session, and
 * blowing it away would be closing the human's editor mid-thought. (Plan
 * worktrees are the deliberate opposite: reset at base every turn.)
 *
 * Everything the loop guarantees lives here: per-session turn/ship chains,
 * per-session work credentials, the settle-every-turn contract, the ship
 * executor, and worktree retirement. Split out of fleet.mjs mechanically —
 * the daemon's reconcile loop constructs one manager per run and feeds it
 * roster jobs; the only state it borrows from the loop is read through the
 * two getters (the MCP URL and the lease TTL can change with any poll).
 */

import { createWorkProcesses } from './workProcesses.mjs';
import { createWorkAgentMerges } from './workAgentMerges.mjs';
import { createWorkAgentTurns } from './workAgentTurns.mjs';
export { clearNonArtifacts, checkEnv } from './workAgentReview.mjs';
import { createWorkAgentReview } from './workAgentReview.mjs';
import { createWorkAgentPlans } from './workAgentPlans.mjs';
import { createWorkShipper } from './workShip.mjs';
import { createWorkPullRequests } from './workPullRequests.mjs';
import { createWorkPreviews } from './workPreviews.mjs';
import { createWorkDiffs } from './workDiffs.mjs';
import {
  existsSync,
  rmSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  realpathSync,
  statSync,
  lstatSync,
  mkdirSync,
  cpSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import {
  FLEET_URL,
  FLEET_TOKEN,
  USER_AGENT,
  REFRESH_BEFORE_SECONDS,
  DAEMON_INSTANCE,
  MACHINE_HOST,
} from './config.mjs';
import {
  git,
  gitRaw,
  gitNet as gitNetIn,
  gitNetAsync,
  splitNul,
  isSafePathSegment,
  excludeInWorktree,
} from './git.mjs';
import {
  publishPushArgs,
  publishFetchArgs,
  publishErrorText,
} from './agentPublish.mjs';
import { createLandedObserver } from './landed.mjs';
import { measureListeners, listenersSupported } from './listeners.mjs';
import { measureProcesses, liveGroups, processesSupported } from './processes.mjs';
import {
  bootMark,
  mutateRegistry,
  processStartTime,
  readRegistry,
  sameBoot,
} from './procRegistry.mjs';
import { createPlaceLock } from './placeLock.mjs';
import { sweepMergedBranch } from './shipSweep.mjs';
import { c, note, ok, warn } from './ui.mjs';
import { mcpFor, runTurn } from './claude.mjs';
import {
  SYSTEM_WORK,
  SYSTEM_CAPTURE,
  WORK_TURN_KICKOFF,
  CAPTURE_TURN_KICKOFF,
  SYSTEM_WORK_PLAIN,
  WORK_TURN_KICKOFF_PLAIN,
  withProjectContext,
} from './prompts.mjs';
import { knowledgeDirFor, FLOWVIANT_OWN_PATHS } from './knowledge.mjs';
import {
  createArtifactReporter,
  snapshotArtifacts,
} from './artifacts.mjs';
import { myPubB64, scrub as envScrub, secretIn as envSecretIn } from './env.mjs';
import {
  detectRuntimes,
  canRun,
  recordSkills,
  recordMcpServers,
  toolEventOf,
  RUNTIMES,
} from './runtimes.mjs';
import { createAdmission } from './admission.mjs';

/** The place id meaning "the checkout", not a worktree. Must match the
 *  server's REPO_PLACE — it is a wire value, not a local convention. */
const REPO_PLACE = 'repo';
import {
  isTerminalSessionLive,
  isAgyConversationLive,
  titleForSession,
} from './localSessions.mjs';
import { worktreeDiff } from './worktreeDiff.mjs';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';

/**
 * The spawn lock: the pid of the CLI currently live in this worktree. A
 * restarted daemon must not put a second Claude into a directory the orphan
 * of its previous life is still editing — two CLIs appending to one held
 * conversation is exactly the incoherence workChains prevents in-process,
 * and the lock extends that guarantee across a restart. A dead pid is a
 * stale lock (removed here); a live one means "come back next poll".
 *
 * …AND A PID IS ONLY THE HOLDER WHILE IT IS STILL THE SAME PROCESS.
 *
 * The lock outlives a reboot or a daemon killed mid-turn, and pids are
 * recycled. Two readings treated a stranger as the holder and wedged every
 * turn and ship in the place until somebody deleted the file by hand: EPERM
 * was read as "alive, just not ours" — but the lock only ever holds a CLI this
 * daemon spawned under its own uid, so a pid we may not signal is by
 * definition not ours, i.e. stale — and a recycled pid of our OWN uid
 * answered signal 0 like the CLI it replaced. The lock now records the
 * process's start time beside the pid (`pid:start`); a live pid whose start
 * time differs is a different process. A lock with no start time (written by
 * an older daemon) keeps the old signal-0 reading, minus EPERM.
 */
export const turnLockedByLivePid = (lockPath) => {
  if (!lockPath || !existsSync(lockPath)) return false;
  let pid = 0;
  let start = null;
  try {
    const raw = readFileSync(lockPath, 'utf8').trim();
    const cut = raw.indexOf(':');
    pid = Number(cut < 0 ? raw : raw.slice(0, cut));
    start = cut < 0 ? null : raw.slice(cut + 1) || null;
  } catch {
    /* unreadable — treat as stale */
  }
  if (Number.isInteger(pid) && pid > 0) {
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = true; // signal 0 delivered — a process of OUR uid holds the pid
    } catch {
      /* ESRCH: gone. EPERM: another uid's process — never our CLI. Stale. */
    }
    if (alive) {
      const now = start ? processStartTime(pid) : null;
      // Unmeasurable start time is "cannot tell", which keeps the lock.
      if (!start || !now || now === start) return true;
    }
  }
  try {
    rmSync(lockPath, { force: true }); // dead holder — clear the stale lock
  } catch {
    /* best-effort */
  }
  return false;
};

/**
 * A RESUME THAT FOUND NO CONVERSATION, in the CLI's own words.
 *
 * "Produced nothing" was the only signal the retry backstop had, and it is not
 * the signal these failures give: Claude Code answers a dead `--resume` id with
 * a result event carrying `errors: ['No conversation found with session ID: …']`
 * AND writes the same line to stderr, so `out` is non-empty, the backstop never
 * fired, and the turn SETTLED SUCCESSFULLY with the error as its answer. Every
 * later message in that tab replied the same way — the marker file still held
 * the dead id, nothing rewrote it (that only happens when an init event is
 * seen, and there is none), and no surface offered a way to clear it. A tab
 * bricked forever by its own CLI pruning its history, which it does on its own
 * schedule.
 *
 * Matched on the CLI's phrasing rather than a code, because neither runtime
 * gives one. Deliberately narrow: it must not swallow a rate limit or a
 * permission refusal, both of which are real answers that should stand.
 */
const RESUME_LOST = [
  /no conversation found/i,
  /no session found/i,
  /session .{0,80}not found/i,
  /conversation .{0,80}not found/i,
  /thread .{0,80}not found/i,
  /trajectory not found/i,
];
/**
 * …BUT ONLY WHEN THE CLI SAID IT, NOT WHEN THE REPLY DID (2026-09-24).
 *
 * Under `answerFromResult` a SUCCESSFUL turn's `out` is Claude's reply, and the
 * patterns above were tested against all of it — so "the session cookie was not
 * found because SameSite dropped it" threw away a real answer and re-ran the
 * same message in a fresh, context-free conversation, whose init id then
 * re-pinned the tab: the first run's edits and commits had already happened,
 * the second repeated or misread them, and the tab's history was gone for good.
 * Web debugging talk says "session … not found" all day.
 *
 * So the text alone is never the evidence. Claude Code emits `system.init` on
 * EVERY turn that reached a conversation, and a dead `--resume` id fails before
 * one is emitted — so for Claude, a lost conversation is the phrase AND no init
 * event. Codex and agy give no such marker to this caller, so for them the
 * phrase must BE the reply: a short line, the shape a CLI error takes, never a
 * paragraph that happens to contain it.
 */
export const RESUME_LOST_MAX_CHARS = 400;
export const resumeConversationLost = (text, { runtime = 'claude', sawInit = false } = {}) => {
  const t = String(text || '').trim();
  if (!t || !RESUME_LOST.some((re) => re.test(t))) return false;
  if (runtime === 'claude') return !sawInit;
  return t.length <= RESUME_LOST_MAX_CHARS;
};

/**
 * The shape a per-tab model name must have before it rides argv as
 * `--model <name>`. Conservative for the same reason the codex thread id is
 * (below): it comes off the wire and lands in a child process's arguments —
 * alphanumerics plus dot/dash/underscore, at most 40 characters, and NEVER a
 * leading dash, which is an argv that parses as a flag.
 */
const WORK_MODEL_RE = /^[a-zA-Z0-9._][a-zA-Z0-9._-]{0,39}$/;

/** The five efforts the CLIs actually accept. A literal set rather than a
 *  pattern: there is no such thing as an effort we haven't heard of, and the
 *  server's own union is exactly this list. */
const WORK_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

/**
 * WHICH BRAIN, AT WHICH EFFORT — the tab's own pick, off the roster.
 *
 * Absent is the resting state and it must stay genuinely absent: every tab ran
 * with no `--model` and no `--effort` until now, so a job that names neither
 * has to produce the byte-identical argv it produced yesterday — Claude falling
 * back to the machine's MODEL pin, codex and agy to their own defaults. Hence
 * an object with the key MISSING rather than one holding null: a null would
 * reach the builders as a value and Claude's `model || MODEL` is the only one
 * that would survive it.
 *
 * A value that fails its guard is DROPPED, not passed through and not an error.
 * The honest outcome of "the server named a model this machine can't spell" is
 * the machine's own default — a turn that runs — rather than a flag no CLI
 * understands and a tab that fails every message.
 */
/**
 * THE ONE SENTENCE A PLAN TURN'S SYSTEM PROMPT GAINS (0.97.0), composed here
 * rather than in prompts.mjs because it is a MODIFIER on whichever contract
 * the tab runs, not a contract of its own.
 *
 * The enforcement is not this sentence — it is `--permission-mode plan`, under
 * which the CLI itself refuses every write (claude.mjs, PLAN_MODE_PERM). What
 * the sentence buys is the ANSWER: the plain contract above it says "edit
 * freely, commit", and a turn told only that would spend itself discovering
 * refusals. It also says not to reach for `ExitPlanMode` (measured: disabled
 * under `-p`, and the probe turn then asked the person to leave plan mode
 * themselves) — leaving plan mode is the person's switch in the tab.
 */
export const PLAN_TURN_SENTENCE =
  'THIS IS A PLANNING TURN: the person switched this tab to plan mode, so read what you need, decide, and answer with the plan itself as your reply — change nothing (the CLI refuses every write this turn, whatever the mechanics above say about editing, committing or artifacts), and do not try to leave plan mode; they switch it off in the tab when they want the plan carried out.';

function brainFor(job) {
  const out = {};
  const model = typeof job?.model === 'string' ? job.model.trim() : '';
  if (model && WORK_MODEL_RE.test(model)) out.model = model;
  const effort = typeof job?.effort === 'string' ? job.effort.trim() : '';
  if (effort && WORK_EFFORTS.has(effort)) out.effort = effort;
  return out;
}

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
   * cartographer, which lives in fleet.mjs's own closure. A callback for the
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
  const WORK_TOKEN_URL = FLEET_URL.replace(/\/agents\/?$/, '/work-token');
  const WORK_DONE_URL = FLEET_URL.replace(/\/agents\/?$/, '/work-turn-done');
  const SHIP_DONE_URL = FLEET_URL.replace(/\/agents\/?$/, '/ship-done');
  const ACTIVITY_URL = FLEET_URL.replace(/\/agents\/?$/, '/session-activity');
  const WORKTREES_URL = FLEET_URL.replace(/\/agents\/?$/, '/session-worktrees');
  const SESSION_COMMANDS_URL = FLEET_URL.replace(/\/agents\/?$/, '/session-commands');
  const ATTACHMENT_URL = FLEET_URL.replace(/\/agents\/?$/, '/attachment');
  // What arrived on base, whichever road it took — observed after every beat
  // that can move origin/<base>: the sweep's fetch, a ship's push, a PR merge
  // this daemon performed. See landed.mjs for the seeding and delivery rules.
  const landed = createLandedObserver({ repoRoot, baseRef });
  /**
   * THE ARTIFACT RELAY (2026-09-22, 0.94.0) — what a turn wrote under
   * `.flowviant/artifacts/`, uploaded after it. One reporter for the life of
   * the manager so its held bodies survive from one beat to the next; see
   * artifacts.mjs for the snapshot rule, the bounds and the delivery shape.
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
  const workAnswering = new Set(); // turn ids currently queued/running here
  const workAttempts = new Map(); // turn id -> completed runTurn attempts
  const MAX_WORK_TRIES = 3;
  const shipping = new Set(); // sessionIds with a ship queued/running here
  const { placeLocks, inPlace } = createPlaceLock();

  /**
   * WHICH PROCESS GROUPS EACH TAB HAS STARTED.
   *
   * A turn's CLI is spawned `detached`, so its pid is a process-group id and
   * everything the agent starts inherits it — through `nohup` and `setsid`,
   * which is precisely where attribution by ppid falls apart. Kept per SESSION
   * and not per turn: the point of the feature is the watcher that outlives the
   * turn that started it.
   *
   * PRUNED ON EVERY READ against the kernel, which is not housekeeping. A pgid
   * is a pid and pids are recycled, so an un-pruned set would eventually
   * attribute a stranger's process to a tab that has been closed for a week.
   */
  const sessionGroups = new Map(); // sessionId -> Set<pgid>

  /**
   * …AND IT SURVIVES A RESTART, which it did not until 2026-08-27.
   *
   * This map used to live only in this closure. The processes it tracks
   * OUTLIVE the daemon on purpose — `shutdownWork` SIGTERMs the CLI child and
   * never the group, precisely so an unattended auto-update does not kill the
   * driver's dev server — so every daemon restart left a live watcher running
   * with nothing left that knew whose it was. The tab reported `[]`, the web
   * read that as "looked, found none", and the Running section went dark until
   * some later turn happened to open a new group.
   *
   * That is not a small bug: AUTO_UPDATE is on by default, so it fired on every
   * release, on every machine. And it broke the three-state rule this file
   * states in its own header — the honest answer after a restart was "we have
   * forgotten", and `[]` is not that. Persisting is what makes `[]` true again,
   * which is why the fix is a disk write and not a fourth state.
   *
   * `procRegistry` is the right home and was sitting unused: it was built for
   * exactly this ("the daemon spawns things that outlive it… the successor has
   * to find them"), was orphaned when the dev-run system was deleted, and
   * already does the atomic write, the stale-lock recovery, the entry cap and
   * the dead-pid TTL. Its prune is deliberately LOOSE here — it keeps an entry
   * whose leader is gone, because the leader is the CLI and it exits at the end
   * of every turn while the watcher it started keeps running. `liveGroups` is
   * the real prune, on every read, against the kernel.
   */
  /*
   * THREE RULES THE FIRST CUT BROKE (2026-09-24), each a way the file named a
   * group that was not this tab's, or forgot one that was:
   *
   *  - ONE FILE PER REPO, not per OS user. Each daemon rewrote the shared file
   *    with only its own groups, so two daemons on one box (project A in one
   *    checkout, B in another) erased each other's entries and A's watcher
   *    was forgotten at A's next restart. The instance lock already makes a
   *    repo one daemon, so the repo is the right owner. The pre-2026-09-24
   *    shared file is not read: its entries carry no boot, so no rule below
   *    could believe them anyway.
   *  - AN ENTRY IS BELIEVED ONLY IN THE BOOT THAT WROTE IT. After a reboot the
   *    remembered pgid belongs to whatever the kernel handed it to next — the
   *    operator's shell, another project's children — and the Running list
   *    relayed that group's command lines as this tab's and `killTargetOk`
   *    accepted a Stop on them.
   *  - ONLY LIVE GROUPS ARE WRITTEN, each with the time it was FIRST seen.
   *    Every persist used to restamp every entry with `Date.now()`, so the
   *    registry's 7-day TTL never applied to anything, and dead entries (one per
   *    agent turn, recorded under a key nothing read) filled the 32-entry cap
   *    and pushed a tab's live watcher off the end.
   */
  const GROUPS_DIR = join(homedir(), '.flowviant');
  const GROUPS_KEY = createHash('sha256').update(String(repoRoot)).digest('hex').slice(0, 16);
  const GROUPS_FILE = join(GROUPS_DIR, `session-groups-${GROUPS_KEY}.json`);
  const GROUPS_LOCK = join(GROUPS_DIR, `session-groups-${GROUPS_KEY}.lock`);
  const groupFirstSeen = new Map(); // pgid -> ms first recorded
  const BOOT = bootMark();

  const persistGroups = () => {
    const flat = [];
    for (const [sid, set] of sessionGroups) {
      for (const pgid of liveGroups(set)) {
        if (!groupFirstSeen.has(pgid)) groupFirstSeen.set(pgid, Date.now());
        flat.push({ sessionId: sid, pid: pgid, startedAt: groupFirstSeen.get(pgid), boot: BOOT });
      }
    }
    const kept = new Set(flat.map((e) => e.pid));
    for (const g of groupFirstSeen.keys()) if (!kept.has(g)) groupFirstSeen.delete(g);
    try {
      mutateRegistry(GROUPS_DIR, GROUPS_FILE, GROUPS_LOCK, () => flat);
    } catch {
      /* best-effort: losing the file costs a restart's visibility, never a turn */
    }
  };

  try {
    for (const e of readRegistry(GROUPS_FILE)) {
      if (!e?.sessionId || !Number.isInteger(e?.pid)) continue;
      if (!sameBoot(e.boot, BOOT)) continue; // another boot's pgid names a stranger now
      const set = sessionGroups.get(e.sessionId) ?? new Set();
      set.add(e.pid);
      sessionGroups.set(e.sessionId, set);
      if (Number(e.startedAt) > 0) groupFirstSeen.set(e.pid, Number(e.startedAt));
    }
  } catch {
    /* no registry yet — the ordinary first run */
  }

  /** Forget the groups of every id the roster no longer names — a closed tab,
   *  a finished agent. Nothing reports or stops a group for an id that is not
   *  live, so holding it only grows the map for the life of the process. */
  const pruneSessionGroups = (activeIds) => {
    const live = new Set(activeIds);
    let changed = false;
    for (const id of [...sessionGroups.keys()]) {
      if (live.has(id)) continue;
      sessionGroups.delete(id);
      changed = true;
    }
    if (changed) persistGroups();
  };

  const noteSessionGroup = (sessionId, pgid) => {
    if (!sessionId || !pgid) return;
    const set = sessionGroups.get(sessionId) ?? new Set();
    if (set.has(pgid)) return;
    set.add(pgid);
    sessionGroups.set(sessionId, set);
    persistGroups();
  };

  /** This tab's live processes, or null where the machine cannot look. */
  const sessionProcesses = (sessionId) => {
    if (!processesSupported()) return null;
    const known = sessionGroups.get(sessionId);
    // The SHAPE `measureProcesses` returns — a bare `[]` here has no `.rows`,
    // so the report's `processes` key came out undefined and was dropped from
    // the JSON: "looked and found none" arrived as "never looked".
    if (!known || known.size === 0) return { rows: [], total: 0 };
    const alive = liveGroups(known);
    // Only touch the disk when the set actually MOVED. This runs on every
    // sweep, for every live tab, forever; an unconditional write would be a
    // file rewrite a minute for the life of the daemon to restate what is
    // already there — the same reasoning the auto-name relay uses for its
    // unchanged-title check.
    const changed = alive.size !== known.size;
    if (alive.size === 0) sessionGroups.delete(sessionId);
    else sessionGroups.set(sessionId, alive);
    if (changed) persistGroups();
    return measureProcesses(alive, { scrub: envScrub });
  };

  /** Every process group this machine is tracking, across every tab — what a
   *  kill request is checked against before anything is signalled. */
  const allKnownGroups = () => {
    const all = new Set();
    for (const set of sessionGroups.values()) for (const g of set) all.add(g);
    return all;
  };


  /**
   * EVERY turn settles — the work loop's prime contract. A pending turn nobody
   * answers holds one of the tab's slots until the server expires it (24h);
   * silence is the worst outcome. So a report that cannot be DELIVERED right
   * now is queued in memory and retried at the top of every poll, and a turn
   * whose finished answer sits in that queue is never re-run — a session turn
   * has side effects (edits, commits, cards), and a dropped 200 must not apply
   * them twice.
   */
  const pendingWorkReports = new Map(); // turnId -> work-turn-done body
  const pendingShipReports = new Map(); // sessionId -> ship-done body
  /** POST a settle body. Four outcomes, and the split between the last two is
   *  load-bearing:
   *   - 'ok' — delivered.
   *   - 'terminal' — the EXPLICIT per-endpoint statuses under which the server
   *     will never re-offer the job (403 not this fleet's session, 404 unknown
   *     turn, 409 ship already settled). Only these may drop the report AND
   *     the attempts counter: they are the statuses where forgetting is safe
   *     because the job is gone server-side too.
   *   - 'reject' — any OTHER 4xx (a 400 from deploy skew, an edge/WAF rule):
   *     the server refused this BODY, but the job row may still be pending and
   *     riding every poll. The report must stay QUEUED — it is the skip-guard
   *     that stops the turn being re-run with all its side effects — but
   *     re-POSTing a body the server just refused every poll is spam, so
   *     delivery backs off. Treating this as terminal once re-ran whole
   *     non-idempotent CLI turns in a loop; treating it as plain retry
   *     hammered a refused body forever.
   *   - 'retry' — network errors, 408, 429 and 5xx: nothing was decided. */
  const postSettle = async (url, body, terminalStatuses) => {
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
      if (res.ok) return 'ok';
      if (terminalStatuses.includes(res.status)) return 'terminal';
      if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429)
        return 'reject';
      return 'retry';
    } catch {
      return 'retry';
    }
  };

  /** Retry-After, in ms — seconds or an HTTP-date — capped so one bad or
   *  hostile header cannot stall a caller for an hour. Falls back to the
   *  caller's own backoff when the header is absent or unparseable. */
  const retryAfterMs = (res, fallbackMs) => {
    const h = res?.headers?.get?.('retry-after');
    if (h == null) return fallbackMs;
    const secs = Number(h);
    if (Number.isFinite(secs)) return Math.max(0, Math.min(secs * 1000, 60_000));
    const at = Date.parse(h);
    return Number.isFinite(at) ? Math.max(0, Math.min(at - Date.now(), 60_000)) : fallbackMs;
  };

  /**
   * A best-effort settle POST, AWAITED INLINE by a caller with no per-poll
   * queue of its own to retry from — unlike `postSettle` above, whose callers
   * requeue a 'retry'/'reject' outcome themselves. Bounded attempts: 408/429
   * retry honouring Retry-After, 5xx retries on a short fixed backoff, and
   * any OTHER 4xx is the server's considered answer — retrying it would just
   * spend the same refusal again, so it counts as delivered, the existing
   * trace convention. A network error retries the same way and is then
   * swallowed: unsettled, and the server expires the job so the asker is
   * told, never spun.
   */
  const postBestEffort = async (url, body, { attempts = 4, timeoutMs = 30_000 } = {}) => {
    for (let i = 0; i < attempts; i += 1) {
      let res;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${FLEET_TOKEN}`,
            'User-Agent': USER_AGENT,
            'Content-Type': 'application/json',
          },
          signal: AbortSignal.timeout(timeoutMs),
          body: JSON.stringify(body),
        });
      } catch {
        if (i === attempts - 1) return false;
        await new Promise((r) => setTimeout(r, 2_000 * (i + 1)));
        continue;
      }
      if (res.ok) return true;
      if (res.status === 408 || res.status === 429) {
        if (i === attempts - 1) return false;
        await new Promise((r) => setTimeout(r, retryAfterMs(res, 2_000 * (i + 1))));
        continue;
      }
      if (res.status >= 500) {
        if (i === attempts - 1) return false;
        await new Promise((r) => setTimeout(r, 2_000 * (i + 1)));
        continue;
      }
      return true; // any other 4xx — the server's considered answer
    }
    return false;
  };

  /** How long a REJECTED report sits out before re-offering its body — long
   *  enough that a deploy-skew 400 costs a handful of POSTs a day, short
   *  enough that a server fix picks the report up the same morning. */
  const REJECT_RETRY_MS = 10 * 60 * 1000;
  const reportBackoff = new Map(); // turnId|sessionId -> earliest next attempt
  const settleWorkTurn = async (turnId, payload) => {
    const body = { turnId, ...payload };
    const r = await postSettle(WORK_DONE_URL, body, [403, 404]);
    if (r === 'retry' || r === 'reject') {
      pendingWorkReports.set(turnId, body);
      if (r === 'reject') reportBackoff.set(turnId, Date.now() + REJECT_RETRY_MS);
    } else {
      pendingWorkReports.delete(turnId);
      workAttempts.delete(turnId);
      reportBackoff.delete(turnId);
    }
    return r;
  };
  const settleShip = async (sessionId, payload) => {
    const body = { sessionId, ...payload };
    const r = await postSettle(SHIP_DONE_URL, body, [403, 409]);
    if (r === 'retry' || r === 'reject') {
      pendingShipReports.set(sessionId, body);
      if (r === 'reject') reportBackoff.set(sessionId, Date.now() + REJECT_RETRY_MS);
    } else {
      pendingShipReports.delete(sessionId);
      reportBackoff.delete(sessionId);
      // The report has landed, so the idempotency path no longer needs the
      // branch to exist. See `sweepMergedSessionBranch`.
      sweepMergedSessionBranch(sessionId);
      // AND THE DIFFSTAT IS NOW WRONG BY DEFINITION. A ship folds base in,
      // merges the tip out and deletes the branch, so a fresh measurement reads
      // `ahead: 0` with an empty diffstat — and without this the rail keeps
      // rendering the ENTIRE pre-ship diff while the transcript two hundred
      // pixels away says "Shipped to main". The ship button re-arms over a
      // branch that is already merged. Same rule the kill path just learned:
      // an action that changes what the machine would measure must cause a new
      // measurement, and the 60s sweep is not that.
      void reportPlaceWorktrees(sessionId).catch(() => {});
      burstListeners(sessionId);
      // …and the REPO picture changed too: the session branch is gone and base
      // moved. Without this the Repository block keeps counting a branch the
      // ship just deleted.
      onRepoChanged();
      // The ship's push moved the local origin/<base> ref — observe now, so
      // the landed report (and anything trailered a ship carried) lands on
      // this beat rather than the next 3-minute fetch.
      void landed.observe().catch(() => {});
    }
    return r;
  };
  /**
   * THE TAB'S LIVE NARRATION — the terminal's own stdout, relayed.
   *
   * A turn used to be a spinner: the tab said "working…" for minutes and the
   * only thing that ever appeared was the finished reply. The CLI is printing
   * the whole time (thinking, reads, greps, commands), so the honest fix is to
   * FORWARD that, not to invent a progress model on the server. Flowviant
   * relays; it does not narrate on its own behalf.
   *
   * Best-effort by construction: throttled to one POST per window (a turn can
   * emit hundreds of lines), never awaited by the turn, and every failure is
   * swallowed. A spinner must never be able to fail a build. The server clears
   * the line at settle, so a daemon killed mid-turn cannot leave one stuck.
   */
  const ACTIVITY_MIN_MS = 1_500;
  const ACTIVITY_KEEP = 4; // the last few lines — a tail, not a log
  /** `turnId` scopes the narration to the turn that produced it: a POST
   *  already on the wire when the turn settles must not re-stamp a "working…"
   *  line over the finished reply — the server drops narration for a turn
   *  that is no longer pending. (A session-level pending count can't tell the
   *  settled turn's stale line from the queued NEXT turn's fresh one.) */
  const makeNarrator = (sessionId, turnId, getTools) => {
    const recent = [];
    let lastSent = 0;
    let dirty = false;
    let timer = null;
    let sending = false;
    let stopped = false;
    const send = async () => {
      if (sending || stopped) return;
      sending = true;
      dirty = false;
      lastSent = Date.now();
      const lines = recent.slice(-ACTIVITY_KEEP);
      try {
        await fetch(ACTIVITY_URL, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${FLEET_TOKEN}`,
            'User-Agent': USER_AGENT,
            'Content-Type': 'application/json',
          },
          signal: AbortSignal.timeout(10_000),
          body: JSON.stringify({
            sessionId,
            turnId,
            lines,
            // The structured tool log so far, riding the same throttled beat.
            // Same lifecycle as the lines: overwritten as the turn moves,
            // cleared server-side at settle. Absent until something ran.
            ...(getTools ? { tools: getTools() } : {}),
          }),
        });
      } catch {
        /* narration is decoration — a dropped line is not an incident */
      }
      sending = false;
      if (dirty && !stopped) schedule();
    };
    const schedule = () => {
      if (timer || stopped) return;
      const wait = Math.max(0, ACTIVITY_MIN_MS - (Date.now() - lastSent));
      timer = setTimeout(() => {
        timer = null;
        void send();
      }, wait);
      timer.unref?.(); // never hold the process open for a spinner
    };
    return {
      line(label) {
        // Scrub, like every string that leaves this machine: a narration line
        // is the CLI's own stdout — a command echoing an env var, a read of a
        // config file — and it rides the same uplink the final answer does.
        const s = envScrub(String(label ?? ''))
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 200);
        if (!s || stopped) return;
        recent.push(s);
        if (recent.length > ACTIVITY_KEEP * 2) recent.shift();
        dirty = true;
        schedule();
      },
      stop() {
        stopped = true;
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
      },
    };
  };

  /**
   * WHERE EACH TAB IS STANDING, and what it holds — the readout a human would
   * get by running `git status` in the session's directory, which is the one
   * thing they cannot do from a browser.
   *
   * Two triggers, both cheap: right after a turn settles (the moment the diff
   * changed) and a throttled sweep over every live session (a human editing in
   * the worktree, a build writing files, a ship landing). Best-effort like the
   * narrator: never awaited by a turn, every failure swallowed.
   */
  const WORKTREE_SWEEP_MS = 60_000;
  /** How often the sweep refreshes `origin/<base>` before measuring. The
   *  behind-count is the whole point of the readout — "someone pushed while you
   *  were working" — and without a fetch it would only ever count what this
   *  machine already happened to have. Rarer than the sweep because a fetch is
   *  network, and a teammate's push being visible within three minutes is the
   *  same promise the rest of the product makes. */
  const WORKTREE_FETCH_MS = 3 * 60_000;
  /**
   * WHERE EACH SESSION WORKS, learned from the turns we are handed.
   *
   * Every other beat — the worktree sweep, ship, the preview re-check — has to
   * ask the SAME directory the turn ran in, and only the turn job carries
   * `place`. Caching it here is what keeps them agreeing without a second
   * server→daemon field: a session absent from this map has never run a turn,
   * and its own id is the right answer for that case anyway (it is the default
   * place, and a session with no turn has no worktree either).
   *
   * A tab standing in the CHECKOUT is the case this exists for: its directory
   * is not `sessions/<id>` and never will be, so a sweep that assumed the
   * default would measure a directory that does not exist and report nothing —
   * which is exactly why "I still do not see a preview URL" was true of a tab
   * opened in the checkout.
   */
  const sessionPlaces = new Map();
  const placeOf = (sessionId) => sessionPlaces.get(sessionId) ?? sessionId;
  /**
   * Places straight off the roster, so a tab is measured the moment it EXISTS
   * rather than after somebody types into it.
   *
   * Learning only from turn jobs meant a tab nobody had spoken to yet was
   * measured at `sessions/<id>` — a directory that does not exist for a tab
   * working in the checkout — so it reported no branch, no diffstat and no
   * ports, and every control reading those had nothing to render.
   *
   * The roster is authoritative and turn jobs still agree with it; a session
   * the server does not name keeps whatever a turn taught, and failing that its
   * own id, which is the pre-places default.
   */
  /**
   * WHERE EACH TAB WORKS — and it has to be able to UNLEARN.
   *
   * This only ever set. Combined with a server that omitted null places, a tab
   * moved from the checkout back to its own worktree simply stopped being
   * mentioned, and this map kept the old value forever. `placeDir` decides
   * where a turn is SPAWNED and where the worktree is measured, so the browser
   * said "its own worktree" while the CLI went on working in the checkout, and
   * the tab reported the checkout's listeners as its own. That is the exact
   * confusion the whole places feature exists to prevent.
   *
   * An explicit `null` now means "its own worktree" and DELETES the entry.
   * Absence of the whole map still means "an older server said nothing", which
   * is the only thing absence can safely mean.
   */
  const learnPlaces = (map) => {
    if (!map || typeof map !== 'object') return;
    for (const [sid, place] of Object.entries(map)) {
      // VALIDATE AT THE TRUST BOUNDARY. `placeDir` joins this value straight
      // into `sessions/<place>` and it is the directory a turn is SPAWNED in
      // and a preview port is measured against — the security boundary for the
      // whole preview feature. The server resolves place to an enum (never a
      // path), but a server bug or compromise sending `../../etc` would
      // otherwise point a session's measured directory anywhere on the box and
      // defeat the port attribution. `sessionWorktreeReport` and `placeWtFor`
      // already reject an unsafe segment; checking at the intake covers the
      // consumers that do not (the preview-claim `placeDir` did not re-check).
      // NOT the only writer: `processWorkTurns` stores a turn job's place too,
      // and keeps the same check — validating one intake and not the other is
      // one deploy away from validating neither. REPO_PLACE resolves to
      // repoRoot, so it is allowed through despite not being a path segment.
      if (typeof place === 'string' && place && (place === REPO_PLACE || isSafePathSegment(place)))
        sessionPlaces.set(sid, place);
      // null / '' / an unsafe value: the server is telling us this tab is in its
      // OWN worktree (or is malformed). Falling back to the default requires
      // forgetting, not ignoring.
      else sessionPlaces.delete(sid);
    }
  };
  /** The DIRECTORY a session works in. Every path that used to build
   *  `sessions/<id>` by hand goes through here, or a tab in the checkout gets
   *  measured against a directory that does not exist. */
  const placeDir = (sessionId) => {
    const place = placeOf(sessionId);
    return place === REPO_PLACE ? repoRoot : join(baseDir, 'sessions', place);
  };

  // ── PUBLISHING AN AGENT'S BRANCH ───────────────────────────────────────────
  //
  // The server names the target (`agentTurnJobs[].publishTo`) and this machine
  // pushes to it. Two laws hold the whole lane up:
  //
  // A PUSH NEVER BLOCKS OR FAILS A TURN. It is tail work after the settle, it
  // is try/catch'd like every sweep, and a failure is REPORTED in git's own
  // words rather than thrown. An agent whose remote push fails has still done
  // its work, still committed it, and still settled.
  //
  // THE SERVER LEARNS OF A PUSH ONLY BY BEING TOLD. Nothing here composes a
  // name: an absent `publishTo` is a project that has publishing off, or a
  // server older than this daemon, and in both the honest behaviour is to push
  // nothing and report nothing. Absence keeps one meaning.
  /**
   * WHAT THIS MACHINE LAST DID WITH EACH AGENT'S BRANCH, by place —
   * `{ ref, sha }` for a push that landed, `{ ref, error, at, tried }` for one
   * that did not. Mutually exclusive by construction, which is what makes the
   * report's two keys mutually exclusive without a second rule.
   *
   * Process-local on purpose: it is a record of what THIS daemon pushed, so a
   * restart re-pushes once and re-reports — a push of the same sha to the same
   * ref is a no-op at the remote, and re-learning beats trusting a file about
   * something a rebase can invalidate.
   */
  const agentPublished = new Map();
  /**
   * WHAT THIS PROCESS HAS SEEN AT EACH AGENT'S REMOTE REF — `{ ref, sha }`, and
   * the ONLY input to the push's lease.
   *
   * It is deliberately NOT `agentPublished`: that map is the REPORT record (what
   * this machine pushed, and what the server may be told), while this one is an
   * observation of the REMOTE's own position, which a box also gets by FETCHING
   * a ref it never pushed. A box that fetch-continues an agent has seen the ref
   * and must be able to lease against it; a box that has seen nothing pushes
   * with no force flag at all.
   *
   * Process-local for the same reason the record beside it is: a restart has
   * observed nothing, and an unforced push is the honest thing to do about that
   * — it lands, or it refuses and says so.
   */
  const agentRemoteAt = new Map();
  /** A failed push retries on the next sweep, but not FOREVER at sweep cadence:
   *  a remote that refuses (no credentials on this box, a protected prefix)
   *  would otherwise cost a blocking network call per agent per minute for the
   *  life of the daemon. A moved branch always retries immediately — the
   *  throttle is on repeating the SAME attempt, never on new work. */
  const PUBLISH_RETRY_MS = 5 * 60_000;
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
  /** The tip of an agent's local branch, or null when this box does not hold it
   *  — which is a perfectly ordinary state (the begun-guard's whole subject) and
   *  means there is nothing to publish, never that a push failed. */
  const agentBranchSha = (place) => {
    try {
      return (
        git(['rev-parse', '--verify', '--quiet', `refs/heads/session/${place}`], repoRoot) || null
      );
    } catch {
      return null;
    }
  };
  /**
   * PUSH ONE AGENT'S BRANCH TO THE NAME THE SERVER GAVE IT.
   *
   * Returns TRUE when the recorded state CHANGED, because the caller's next act
   * is a worktree report and a report that says what the last one said is a
   * write per minute restating a fact. The rule this serves is the one every
   * settle keeps: an action that changes what the machine would measure must
   * cause a new measurement — and only then.
   *
   * Never throws.
   */
  const publishAgentBranch = async (place, target) => {
    const sha = agentBranchSha(place);
    if (!sha) return false;
    const prev = agentPublished.get(place);
    if (prev?.ref === target && prev.sha === sha) return false; // already there
    if (
      prev?.ref === target &&
      prev.error &&
      prev.tried === sha &&
      Date.now() - (prev.at ?? 0) < PUBLISH_RETRY_MS
    )
      return false; // the same attempt failed moments ago
    // THE LEASE IS THIS PROCESS'S OWN LAST SIGHTING of that ref, and nothing
    // else — never git's remote-tracking ref, which this daemon's own sweep
    // fetch refreshes (the argument is in `publishPushArgs`). An expectation
    // recorded against a DIFFERENT ref is no expectation for this one.
    const seen = agentRemoteAt.get(place);
    // A ref that is not the server's shape never reaches argv. Silent, because
    // a refusal here is a feature not happening on this turn, not a failure of
    // it — and a `publishError` about a value we declined to use would be this
    // machine reporting on a push it never attempted.
    const args = publishPushArgs(place, target, seen?.ref === target ? seen.sha : null);
    if (!args) return false;
    try {
      gitNet(args, 60_000);
      agentPublished.set(place, { ref: target, sha });
      agentRemoteAt.set(place, { ref: target, sha });
      return true;
    } catch (e) {
      const error = publishErrorText(envScrub(e?.stderr?.toString?.() || e?.message || ''));
      agentPublished.set(place, { ref: target, error, at: Date.now(), tried: sha });
      // A repeat of a failure already reported is not news; the server's stored
      // sentence is already this one.
      return !(prev?.error === error && prev.ref === target);
    }
  };
  /**
   * BRING A PUBLISHED BRANCH BACK DOWN — the other half of the durability
   * promise, and the only thing that lets an agent's work outlive its box.
   *
   * Reached from ONE place: the begun-guard's refusal arm, where this machine
   * has just MEASURED that it holds neither the agent's worktree nor its branch.
   * The server only sends `publishedRef` when it heard about a real push, so
   * this is not a guess at a remote branch — it is a fetch of one a machine
   * reported writing.
   *
   * ── WHAT IT RECOVERS, AND WHAT IT CANNOT ──
   *
   * COMMITS COME BACK. The CONVERSATION DOES NOT: the CLI's held context lives
   * in the box that ran it and nothing here transports it. The turn kickoff
   * re-prompts from the card, which is the honest continuation — an agent that
   * picks up its own commits and re-reads its own card, never one that remembers
   * the argument. Nothing this returns may be phrased as if it did.
   *
   * THREE ANSWERS, because two would lie. `null` is "there was nothing to try"
   * (no ref, or one whose shape this machine will not put in argv), and it must
   * leave the existing refusal EXACTLY as it was — a sentence about a fetch
   * nobody attempted is worse than the plain refusal. `{ ok: false, why }` is a
   * measured failure, relayed in git's own words. `{ ok: true }` is only ever
   * returned after re-reading the ref: a fetch that exits 0 having created
   * nothing would otherwise walk straight into `placeWtFor` cutting a fresh
   * branch off base — the context-free redo the guard above exists to prevent,
   * wearing this feature's name.
   */
  const fetchPublishedBranch = (place, ref) => {
    const args = publishFetchArgs(ref, place);
    if (!args) return null;
    try {
      gitNet(args, 120_000);
    } catch (e) {
      return {
        ok: false,
        why: publishErrorText(envScrub(e?.stderr?.toString?.() || e?.message || '')),
      };
    }
    const sha = agentBranchSha(place);
    if (!sha) return { ok: false, why: 'the fetch reported nothing and left no local branch' };
    // WHAT THIS PROCESS HAS NOW SEEN AT THAT REMOTE REF. A fetch is an
    // observation of the remote's own position, and for a box that continues an
    // agent it never started it is the ONLY one it will ever have — without it
    // this box's first push would carry no lease and would have to go unforced.
    // It is not a `publishAgentBranch` record: this machine pushed nothing, so
    // the server is told nothing.
    agentRemoteAt.set(place, { ref, sha });
    return { ok: true };
  };

  let lastWorktreeSweep = 0;
  /** Sessions this process has already tried to measure. See `reportWorktrees`. */
  const worktreeSeen = new Set();
  let lastWorktreeFetch = 0;
  let sweepingWorktrees = false;
  /**
   * WHERE THE NEXT SWEEP STARTS.
   *
   * A safety valve with a rotation, and the rotation is the load-bearing half.
   * The sweep used to take `activeIds.slice(0, 20)` — a silent truncation of a
   * list the server builds tabs-first and agent places LAST, so on a project
   * with twenty live tabs no agent was EVER measured: no branch diff, no head
   * sha, and none of their trailered commits ever reached a card. Permanently,
   * because the same twenty won every pass.
   *
   * Chunking removes the cut for any realistic project (see below). The cursor
   * is what makes the residual cap fair rather than arbitrary: past it, the
   * places that missed one sweep are the ones that lead the next.
   */
  let worktreeCursor = 0;
  const postWorktrees = async (reports) => {
    if (!reports.length) return;
    try {
      await fetch(WORKTREES_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${FLEET_TOKEN}`,
          'User-Agent': USER_AGENT,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(20_000),
        body: JSON.stringify({ reports }),
      });
    } catch {
      /* a readout — the next sweep carries it */
    }
  };
  const sessionWorktreeReport = (sessionId) => {
    // The session's PLACE, not its name: a tab in the checkout is measured in
    // the checkout, and a tab sharing another tab's worktree is measured there.
    const place = placeOf(sessionId);
    if (place !== REPO_PLACE && !isSafePathSegment(place)) return null;
    const wt = placeDir(sessionId);
    const d = worktreeDiff(wt, baseRef());
    if (!d) return null;
    // WHAT IS LISTENING in this worktree, attributed by the CWD of the process
    // holding the socket. It rides the sweep the daemon already makes rather
    // than taking a beat of its own, exactly as the commit trailers do — and
    // like them it needs no version floor, because it is a daemon→server report
    // on an endpoint that already exists. An older server ignores the key.
    //
    // The browser NEVER names a directory and never names a port this did not
    // report: ports are global to a box and a worktree is not, so this
    // measurement is the security boundary for the whole preview feature.
    // `listeningSupported` says whether this machine can measure AT ALL, which
    // is a different fact from finding nothing. Windows reports nothing and a
    // failed scan reports nothing, and both were indistinguishable from an idle
    // worktree — harmless while the only consumer needed a NON-empty array, and
    // a permanent `Starting…` the moment a Run dev offer hangs off an empty one.
    // …AND WHAT IT IS RUNNING, attributed by PROCESS GROUP rather than by cwd.
    // A watcher (`rbxtsc -w`, `tsc --watch`) holds no socket and touches no
    // file for minutes, so it was invisible from a browser in a way it never is
    // in a terminal. Same rules as `listening` beside it: a daemon→server
    // report on an endpoint that already exists, so NO version floor, and
    // `processesSupported` keeps "cannot look" (Windows) apart from "looked and
    // found none", which renders differently.
    const proc = sessionProcesses(sessionId);
    // THE NAME CLAUDE ALREADY GAVE THIS CONVERSATION, relayed.
    //
    // Claude Code titles its own sessions; a Flowviant tab was born "session 3"
    // and stayed that way unless somebody renamed it by hand, so a strip of
    // eight tabs said nothing about any of them. The title is not ours to
    // invent — reading it is the same relay this whole file does, and asking
    // a model for one would be a second brain, which the product forbids.
    //
    // Only CLAUDE tabs have one here: the id is the one the CLI reported at
    // `system.init` and pinned per tab, so a codex or agy tab simply has no
    // marker and reports no title. No runtime check is needed for that — the
    // absent marker IS the check.
    //
    // No version floor: a daemon→server report on an endpoint that already
    // exists, so an older daemon sends no key and the server leaves the name
    // exactly as it found it.
    let title = null;
    try {
      const marker = sessionMetaPath(wt, 'flowviant-claude-session', sessionId);
      if (marker) title = titleForSession(wt, readFileSync(marker, 'utf8').trim());
    } catch {
      /* no marker yet — this tab has not spoken, or is not Claude */
    }
    // The TOTAL rides beside the capped rows, because a list silently cut at
    // twelve answers "what is running in here" with a number that is not true.
    // `wrangler dev` alone opens nine, so the old cap of eight was already
    // dropping a row on an ordinary stack with nothing on the wire to say so.
    const lis = measureListeners(wt);
    /**
     * WHICH BOX MEASURED THIS — on an agent's report only.
     *
     * The server stores it on the agent row so a LATER turn can be checked
     * against the box that actually holds the work: an agent's branch and its
     * conversation exist on one machine's disk until somebody approves it, and
     * two boxes on one credential can both be offered its turns. The daemon
     * reports what it is; the server does the comparing.
     *
     * A daemon→server report on an endpoint that already exists, so no floor —
     * an older daemon sends no key and the agent is left UNATTRIBUTED, which is
     * a third state the server reads as "nobody said" rather than as "not this
     * box". `envpub` is the identity for the same reason the poll uses it: it is
     * durable per box, and the hostname beside it is only a label for a person
     * to read. Absent when the keypair is unreadable — that machine is exempt
     * from arbitration entirely, which is the fail-open direction.
     *
     * TABS GET NOTHING. A tab's place is shared by design and its work is a
     * human's own directory; attributing one would be a fact with no reader.
     */
    const pub = sessionId.startsWith('a-') && sessionId.length > 2 ? myPubB64() : null;
    /**
     * …AND WHAT THIS MACHINE PUSHED OF IT (0.86.0).
     *
     * The ONE road by which the server learns a push happened: it composes the
     * target name and sends it, and stores nothing until a machine reports
     * back. So an unreported push renders nothing and no surface can name a ref
     * nobody can pull — the same "never assert what you did not observe" rule
     * the box id beside it keeps.
     *
     * NO KEY AT ALL until a target arrives, which is what lets absence keep its
     * one meaning: an older server, or a project with publishing off, leaves
     * the agent reading as never published rather than as failed.
     *
     * Mutually exclusive without a rule of its own, because the state it reads
     * holds a sha or an error and never both.
     */
    const pushed = sessionId.startsWith('a-') ? agentPublished.get(sessionId) : null;
    return {
      sessionId,
      ...d,
      ...(pub ? { box: { id: pub, name: MACHINE_HOST } } : {}),
      ...(pushed?.sha ? { published: { ref: pushed.ref, sha: pushed.sha } } : {}),
      ...(pushed?.error ? { publishError: pushed.error } : {}),
      listening: lis.rows,
      listeningTotal: lis.total,
      listeningSupported: listenersSupported(),
      ...(proc === null ? {} : { processes: proc.rows, processesTotal: proc.total }),
      processesSupported: processesSupported(),
      ...(title ? { title } : {}),
    };
  };
  /** One session, now. */
  const reportSessionWorktree = async (sessionId) => {
    const r = sessionWorktreeReport(sessionId);
    if (r) await postWorktrees([r]);
  };

  /**
   * …AND EVERY OTHER TAB STANDING IN THE SAME DIRECTORY.
   *
   * One tab is not one directory any more. Since tabs moved into the driver's
   * own folder, every tab a person owns resolves to the SAME place — so a turn
   * in tab A changed the directory tab B is also describing, and only tab A was
   * re-measured. Tab B went on rendering its pre-turn `+A −D` for up to a
   * minute, which makes the tab strip visibly disagree with itself about one
   * directory. That is the "why are two tabs showing one dev server" confusion
   * the places readout exists to END, arriving through the diffstat instead.
   *
   * It fires on EVERY turn, every ship and every stop, which is what made this
   * the most-hit instance of the rule and the least visible: nothing is wrong
   * on the tab you are looking at.
   *
   * Bounded by the live set the roster last handed us, and the reports go in
   * ONE post — the endpoint is already batched, and a tab per request would
   * turn a five-tab place into five round trips on every settle.
   */
  const reportPlaceWorktrees = async (sessionId) => {
    const place = placeOf(sessionId);
    const ids = [sessionId];
    // `worktreeSeen` is the roster's own live set, pruned to `activeWorkSessions`
    // on every sweep — so this can never report a tab that has closed, and it
    // needs no second source of truth about which tabs exist.
    for (const id of worktreeSeen) {
      if (id !== sessionId && placeOf(id) === place) ids.push(id);
    }
    const reports = ids.map(sessionWorktreeReport).filter(Boolean);
    if (reports.length) await postWorktrees(reports);
  };

  /**
   * THE FIRST MINUTE AFTER A SETTLE — when "run the dev server" actually binds.
   *
   * The settle-time report fires the moment the reply lands, but a dev server
   * the agent just started usually takes a few more seconds to open its socket
   * (vite boots, next compiles). It therefore missed the settle measurement and
   * waited the full 60s sweep — up to a minute of "nothing is running here"
   * over a server that was already up, which is the slowest link in the whole
   * "ask for dev → see the preview" chain. Asked directly: "how do we make it
   * more responsive when the user prompts claude to run dev to waiting for it
   * to appear on the preview?"
   *
   * A DECAYING BURST, and it re-CHECKS before it re-REPORTS: each beat walks
   * /proc for the place's listeners (purely local, no git, no network) and only
   * when the PORT SET actually changed does the full place report run and post.
   * A settle where nothing ever binds costs five /proc walks and zero posts; a
   * dev server that binds at +7s is on the wire at +9 instead of +60. The burst
   * for a place restarts on its next settle, so overlapping turns cannot stack
   * timers, and every timer is unref'd — a readout must never hold the process
   * open.
   *
   * This also serves the OPPOSITE transition for free: a stopped dev server
   * (the panel's Stop, a ctrl-C in a terminal) vanishes from the port set the
   * same way it appeared, so the preview's "origin gone" story starts in
   * seconds too.
   */
  const LISTEN_BURST_DELAYS_MS = [4_000, 9_000, 16_000, 30_000, 55_000];
  const listenBursts = new Map(); // place -> timers[]
  const listenSignature = (wt) => {
    try {
      const l = measureListeners(wt);
      return l.rows.map((r) => r.port).sort((a, b) => a - b).join(',');
    } catch {
      return '';
    }
  };
  const burstListeners = (sessionId) => {
    try {
      const place = placeOf(sessionId);
      for (const t of listenBursts.get(place) ?? []) clearTimeout(t);
      const wt = placeDir(sessionId);
      // Captured alongside the settle report, so only a CHANGE after this
      // moment triggers a post — the settle report already said the rest.
      let last = listenSignature(wt);
      const timers = LISTEN_BURST_DELAYS_MS.map((d) =>
        setTimeout(() => {
          try {
            const sig = listenSignature(wt);
            if (sig === last) return;
            last = sig;
            void reportPlaceWorktrees(sessionId).catch(() => {});
          } catch {
            /* a readout — the sweep still carries it */
          }
        }, d)
      );
      for (const t of timers) t.unref?.();
      listenBursts.set(place, timers);
    } catch {
      /* never let the burst break a settle */
    }
  };
  /** Every live session, throttled — called from the reconcile loop. */
  /**
   * A SESSION NOBODY HAS MEASURED YET JUMPS THE SWEEP (2026-08-26).
   *
   * The throttle is GLOBAL, not per-session, so a tab opened one second after a
   * sweep waited the remaining fifty-nine for its first measurement — and until
   * it lands there is no branch, no directory and no listeners anywhere in the
   * product, because every one of those readouts is gated on a measurement and
   * renders nothing rather than inventing a state. Asked directly: "how come it
   * takes a while for a new session to show branch and worktree and listeners
   * after i create a new tab."
   *
   * ATTEMPTED, never MEASURED, is what is remembered. A session whose directory
   * cannot be read yet — a pre-places daemon that has not cut one, a worktree
   * mid-creation — would otherwise be "unmeasured" on every poll and force a
   * full sweep each time. Recording the attempt bounds it at exactly one extra
   * sweep per session, ever, after which the normal cadence carries it.
   */
  const reportWorktrees = (activeIds) => {
    if (!Array.isArray(activeIds) || activeIds.length === 0) return;
    if (sweepingWorktrees) return;
    const firstSight = activeIds.some((id) => !worktreeSeen.has(id));
    if (!firstSight && Date.now() - lastWorktreeSweep < WORKTREE_SWEEP_MS) return;
    // Bounded to LIVE sessions: a long-running daemon must not accumulate a
    // uuid per tab anyone has ever opened. Pruning also means a reopened tab is
    // measured immediately again, which is the same answer for the same reason.
    const live = new Set(activeIds);
    for (const id of worktreeSeen) if (!live.has(id)) worktreeSeen.delete(id);
    for (const id of activeIds) worktreeSeen.add(id);
    // The publish record is bounded the same way and for the same reason: an
    // agent the roster has stopped naming is done, its ref is the server's
    // business now (the merge lane deletes it when the work lands), and a
    // long-running daemon must not accumulate a row per agent that ever ran.
    for (const id of agentPublished.keys()) if (!live.has(id)) agentPublished.delete(id);
    for (const id of agentRemoteAt.keys()) if (!live.has(id)) agentRemoteAt.delete(id);
    pruneSessionGroups(activeIds);
    sweepingWorktrees = true;
    lastWorktreeSweep = Date.now();
    void (async () => {
      try {
        // Refresh the base before measuring, so "3 new on main" means what a
        // person thinks it means. Throttled, best-effort, and never fatal: an
        // offline machine reports the counts it can still compute.
        if (Date.now() - lastWorktreeFetch >= WORKTREE_FETCH_MS) {
          lastWorktreeFetch = Date.now();
          try {
            // ASYNC and TIMED: this runs every three minutes with nobody
            // watching, and a synchronous fetch against a remote that prompts
            // on /dev/tty or a connection gone half-open froze the whole
            // daemon — no polls, no settles, no lease renewals — until it
            // returned. See `gitNetAsync`.
            await gitNetAsync(['fetch', 'origin', '--quiet'], repoRoot);
          } catch {
            /* offline, no remote, or timed out — the numbers just age */
          }
          // The fetch may have moved the base tip — walk and report what
          // landed. Best-effort like everything in this sweep.
          void landed.observe().catch(() => {});
        }
        /**
         * MEASURED IN CHUNKS, not truncated to one.
         *
         * The server's endpoint takes twenty entries per request, and this read
         * that bound as "measure twenty places" — so everything past the
         * twentieth was silently never measured, and the server builds that
         * list with agent places at the END. A project with twenty live tabs
         * therefore measured no agent at all: their review pane showed no
         * branch diff, `checkIsStale` had no head to compare against, and their
         * commits never reached the cards they name.
         *
         * The cap on a REQUEST is not a cap on the WORK. Several requests of
         * twenty cost several round trips and each is validated per entry
         * exactly as before, so no contract changes and no floor is needed.
         *
         * `SWEEP_MAX_PLACES` is a bound on the MACHINE — each place costs a
         * `git diff`, a listener scan and a process scan — and the cursor
         * rotates so a project past it still measures everything, just across
         * successive sweeps instead of one.
         */
        const SWEEP_MAX_PLACES = 60;
        const CHUNK = 20;
        const total = activeIds.length;
        const start = total > SWEEP_MAX_PLACES ? worktreeCursor % total : 0;
        const take = Math.min(total, SWEEP_MAX_PLACES);
        // Rotated slice, so the tail of a long list leads the next sweep rather
        // than never being reached.
        const order = Array.from({ length: take }, (_, i) => activeIds[(start + i) % total]);
        worktreeCursor = total > SWEEP_MAX_PLACES ? (start + take) % total : 0;
        const reports = [];
        for (const id of order) {
          /**
           * KEEP A PUBLISHED BRANCH CURRENT, not merely born.
           *
           * A settle publishes what the turn just wrote, which covers almost
           * everything — but a branch also moves without a turn: the stale
           * path folds base in before a merge, and an operator can commit in
           * the agent's worktree by hand. Without this the remote ref would sit
           * at whatever the last turn left and the durability claim would be
           * quietly false for exactly the branches somebody is working on.
           *
           * ONLY where a target is already known. Nothing here composes a name,
           * so an agent this process has never been told to publish is
           * untouched — and the sha compare inside makes the resting cost of
           * this loop one `rev-parse` per agent.
           */
          const known = agentPublished.get(id);
          if (known?.ref) await publishAgentBranch(id, known.ref);
          const r = sessionWorktreeReport(id);
          if (r) reports.push(r);
        }
        // One POST per chunk. Awaited in sequence rather than fired together:
        // this runs on the machine's own poll beat and a burst of parallel
        // writes to the same rows buys nothing.
        for (let i = 0; i < reports.length; i += CHUNK) {
          await postWorktrees(reports.slice(i, i + CHUNK));
        }
      } finally {
        sweepingWorktrees = false;
      }
    })();
  };

  /**
   * FILES THE HUMAN ATTACHED, brought to where a CLI can read them.
   *
   * A screenshot in a chat bubble is useless to an agent; a path is not. So the
   * turn's attachments are downloaded into `.flowviant/uploads/` inside the
   * session's own worktree and the prompt is handed the relative paths.
   *
   * `.flowviant/` rather than the repo proper, and gitignored-or-not it is
   * never committed by us: these are the human's inputs to a conversation, not
   * project files. The name is re-sanitized HERE even though the server already
   * did it — this string becomes a path on someone's machine, and one place
   * doing that check is one deploy away from being zero places.
   */
  const UPLOAD_DIR = '.flowviant/uploads';
  const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
  // `safeFileName`, verbatim (apps/api/src/routes/sessionsAttachments.routes.ts):
  // THE EXTENSION SURVIVES A CUT (2026-09-24). A bare `slice(0, 80)` used to
  // truncate an over-long name mid-extension; an over-long stem is now cut
  // and an 8-hex FNV-1a hash of the WHOLE sanitised name is appended before
  // the extension — stable, at most 80 characters, and idempotent over its
  // own output, so re-applying it to what the server already sanitized is a
  // no-op and the two sides never disagree about the cut.
  const safeUploadFnv1a8 = (s) => {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
  };
  const SAFE_UPLOAD_EXT_RE = /^[A-Za-z0-9]{1,10}$/;
  const safeUploadName = (raw) => {
    const clean = String(raw ?? '')
      .split(/[\\/]/)
      .pop()
      .replace(/[^A-Za-z0-9._-]/g, '_')
      .replace(/^[.-]+/, '');
    if (!clean) return 'attachment';
    if (clean.length <= 80) return clean;
    const dot = clean.lastIndexOf('.');
    const ext = dot > 0 && SAFE_UPLOAD_EXT_RE.test(clean.slice(dot + 1)) ? clean.slice(dot + 1) : '';
    const stem = ext ? clean.slice(0, dot) : clean;
    const tag = `-${safeUploadFnv1a8(clean)}`;
    const room = 80 - tag.length - (ext ? ext.length + 1 : 0);
    return `${stem.slice(0, room)}${tag}${ext ? `.${ext}` : ''}`;
  };
  /** @returns relative paths written, in the order the human attached them. */
  const fetchAttachments = async (wt, attachments) => {
    if (!Array.isArray(attachments) || attachments.length === 0) return [];
    const dir = join(wt, UPLOAD_DIR);
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      return [];
    }
    // "Never committed by us" has to be true for GIT, not just for this code:
    // an untracked `.flowviant/` makes the whole worktree dirty, which refuses
    // every ship, exempts the tree from closed-tab retirement forever, and
    // shows the human's own uploads in the rail as session changes. Same
    // mechanism the materialized env files used until the vault was deleted —
    // the exclude file git actually reads (git.mjs, where the helper moved when
    // env.mjs shrank), which already skips lines it has written before, so
    // calling it per fetch is idempotent. NARROWED 2026-09-23 to the paths
    // this daemon writes (`FLOWVIANT_OWN_PATHS`, knowledge.mjs says why): the
    // whole-directory line also hid a repo's own new `.flowviant/check.json`
    // from its agent's `git add -A`.
    excludeInWorktree(wt, FLOWVIANT_OWN_PATHS);
    const written = [];
    for (const a of attachments.slice(0, 8)) {
      if (!a?.id || typeof a.id !== 'string' || !/^[0-9a-f-]{8,64}$/i.test(a.id)) continue;
      if (Number(a.size) > ATTACHMENT_MAX_BYTES) continue;
      try {
        const res = await fetch(`${ATTACHMENT_URL}/${a.id}`, {
          headers: { Authorization: `Bearer ${FLEET_TOKEN}`, 'User-Agent': USER_AGENT },
          signal: AbortSignal.timeout(60_000),
        });
        if (!res.ok) continue;
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.byteLength === 0 || buf.byteLength > ATTACHMENT_MAX_BYTES) continue;
        // Collisions are real (two screenshots both named Screenshot.png), and
        // silently overwriting one with the other loses a file the human sent.
        let name = safeUploadName(a.name);
        if (existsSync(join(dir, name))) {
          const dot = name.lastIndexOf('.');
          const stem = dot > 0 ? name.slice(0, dot) : name;
          const ext = dot > 0 ? name.slice(dot) : '';
          name = `${stem}-${String(a.id).slice(0, 6)}${ext}`;
        }
        writeFileSync(join(dir, name), buf);
        written.push(`${UPLOAD_DIR}/${name}`);
      } catch {
        /* one file failing must not fail the turn — the prompt lists what
           actually arrived, so the agent never chases a path that isn't there */
      }
    }
    return written;
  };

  let flushingReports = false;
  const flushWorkReports = async () => {
    // Held artifact uploads ride this beat too — the settle retry's own shape —
    // and are never awaited: a readout's retry must not hold a settle's.
    void artifacts.retryPending().catch(() => {});
    if (flushingReports) return;
    if (pendingWorkReports.size === 0 && pendingShipReports.size === 0) return;
    flushingReports = true;
    try {
      for (const [id, body] of [...pendingWorkReports]) {
        // A rejected body sits out its backoff; the queued entry itself stays
        // — it is the skip-guard against re-running a turn whose side effects
        // already happened.
        if ((reportBackoff.get(id) ?? 0) > Date.now()) continue;
        const r = await postSettle(WORK_DONE_URL, body, [403, 404]);
        if (r === 'reject') reportBackoff.set(id, Date.now() + REJECT_RETRY_MS);
        else if (r !== 'retry') {
          pendingWorkReports.delete(id);
          workAttempts.delete(id);
          reportBackoff.delete(id);
        }
      }
      for (const [id, body] of [...pendingShipReports]) {
        if ((reportBackoff.get(id) ?? 0) > Date.now()) continue;
        const r = await postSettle(SHIP_DONE_URL, body, [403, 409]);
        if (r === 'reject') reportBackoff.set(id, Date.now() + REJECT_RETRY_MS);
        else if (r !== 'retry') {
          pendingShipReports.delete(id);
          reportBackoff.delete(id);
          // Delivered late is still delivered — same sweep as the immediate
          // path, and it must be here too or a report that needed a retry
          // would leave its branch behind forever.
          sweepMergedSessionBranch(id);
        }
      }
    } finally {
      flushingReports = false;
    }
  };

  /**
   * The work credential, ONE PER SESSION. The server binds each minted token
   * to the sessionId in the mint body and the MCP layer refuses it for any
   * other session, so a process-wide token would fail every tab but the one
   * that minted it. Cached per session, re-minted near expiry (the endpoint
   * rotates on every mint; per-session chaining means no turn is in flight
   * for the session when its next turn mints). 404 means the server no longer
   * holds that session for this fleet — a fact for the turn to settle with,
   * not a retry.
   */
  const workTokens = new Map(); // sessionId -> { token, mintedAt }
  const mintWorkToken = async (sessionId, force = false) => {
    const cached = workTokens.get(sessionId);
    const freshEnoughS = getLeaseTtl() - REFRESH_BEFORE_SECONDS;
    if (cached && !force && (Date.now() - cached.mintedAt) / 1000 < freshEnoughS)
      return { token: cached.token };
    try {
      const res = await fetch(WORK_TOKEN_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${FLEET_TOKEN}`,
          'User-Agent': USER_AGENT,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(30_000),
        // The instance is what CLAIMS the session lease server-side. Two
        // daemons share one fleet credential, so the token cannot say which of
        // us is serving this tab — and the mint is the moment that matters:
        // there is one work-token row per session and minting ROTATES it, so a
        // second mint revokes the first daemon's live secret mid-turn.
        body: JSON.stringify({ sessionId, instance: DAEMON_INSTANCE }),
      });
      if (res.status === 404) return { gone: true };
      // 409 — another daemon on this credential holds the session. Not ours to
      // serve and not a retry: stand down and let the holder answer.
      if (res.status === 409) return { heldElsewhere: true };
      if (!res.ok) return null;
      const token = (await res.json().catch(() => null))?.data?.token ?? null;
      if (!token) return null;
      workTokens.set(sessionId, { token, mintedAt: Date.now() });
      return { token };
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
  /**
   * WHERE A SESSION WORKS — its PLACE, which is a directory on a branch.
   *
   * A session used to BE a worktree: one tab, one directory, cut at birth and
   * retired at close. That binding was never an isolation guarantee — a turn
   * runs with permissions skipped, so the worktree is a starting directory and
   * not a fence, and any agent could always `cd` into another one. The product
   * was asserting an invariant it did not have.
   *
   * So a session now REFERENCES a place rather than being one. Many sessions
   * may name the same place; a session may name the repo checkout itself; and
   * `session/<own-id>` is simply the DEFAULT place, cut fresh at first turn,
   * which is why an absent `place` behaves exactly as every existing tab does.
   *
   * `'repo'` IS NOT A DIRECTORY NAME AND MUST NOT BECOME ONE. It resolves to
   * the checkout the daemon already serves — never created, never retired,
   * because it is not ours to remove. The value reaching here is a server-side
   * enum, never a browser-supplied path: `sessions.routes.ts` resolves it the
   * same way adoption resolves a cwd, and for the same reason.
   */
  const placeWtFor = (placeId, baseAt) => {
    if (placeId === REPO_PLACE) {
      // The checkout. `fresh: false` on purpose — nothing was opened, so no
      // caller may treat this as a newly-cut branch.
      return { wt: repoRoot, fresh: false };
    }
    if (!isSafePathSegment(placeId)) return null;
    const sessionId = placeId;
    const wt = join(baseDir, 'sessions', sessionId);
    const fresh = !existsSync(wt);
    if (fresh) {
      const branch = `session/${sessionId}`;
      // `baseAt` is the adoption override: a tab born from a terminal session
      // branches from THAT checkout's HEAD, because the conversation being
      // resumed was had against those commits — putting it on the project base
      // would hand it a repo state it has never seen. Everything else is
      // unchanged, the attach fallback included: a surviving branch already
      // chose its base, and re-basing it here would move committed work.
      const at = baseAt || baseRef();
      try {
        git(['worktree', 'add', '-b', branch, wt, at], repoRoot);
      } catch {
        git(['worktree', 'prune'], repoRoot);
        // A directory and a branch just stopped existing. The Repository block
        // would otherwise keep listing both until its own 60s scan came round.
        onRepoChanged();
        try {
          // The branch may already exist (a retired directory's work) — attach.
          git(['worktree', 'add', wt, branch], repoRoot);
        } catch {
          try {
            git(['worktree', 'add', '-b', branch, wt, at], repoRoot);
          } catch {
            return null;
          }
        }
      }
      // NOTHING IS MATERIALIZED INTO A FRESH WORKTREE ANY MORE (2026-09-21),
      // and nothing replaced it.
      //
      // Two blocks stood here: one that wrote the decrypted vault bundle into a
      // newly-created worktree, and a second that retried on the next turn for
      // the restart window where the bundle had not warmed yet. The vault is
      // deleted — the owner: "no i dont want it" — so Flowviant holds no secret
      // for this project and has nothing to write.
      //
      // WHAT THE SOURCE OF A WORKTREE'S ENV IS NOW: the repo's own `.env`
      // files, wherever the repo puts them. A worktree branches from the
      // checkout, and a gitignored `.env` is by definition not in a fresh one —
      // which is the ordinary behaviour of `git worktree add`, the same thing a
      // person gets typing it themselves, and the operator's problem to solve
      // the way they already solve it (a symlink, a `direnv`, a copy in a
      // setup script). This product no longer claims otherwise, and the claim
      // is what was worth deleting: a promise that every session tab comes up
      // with the team's secrets is only kept while a vault exists to keep it.
      //
      // The CLI child still inherits the daemon's own environment exactly as it
      // always did (claude.mjs spawns with `{...process.env}`), so anything
      // exported in the shell the daemon was started from is present here.
    }
    return { wt, fresh };
  };

  /**
   * A file in the worktree's PRIVATE git dir (…/.git/worktrees/<name>). It
   * travels with the worktree, dies with `git worktree remove`, and is
   * invisible to `git status` — so nothing stored here can ever make the
   * session look dirty (a dirty tree refuses ships). A marker file in the
   * working tree itself would show up as an untracked path and block every
   * ship of an otherwise-clean session.
   */
  /**
   * A file beside the worktree's git dir, holding something about ONE TAB.
   *
   * `scope` is the session id and is NOT optional for anything per-tab. These
   * markers were named bare — `flowviant-codex-thread`, `flowviant-agy-
   * conversation` — which was unambiguous while one directory meant one tab.
   * The day tabs moved into their driver's project folder, every tab there
   * started reading and writing ONE marker: tab B would resume tab A's codex
   * thread, and the last turn to finish would overwrite the id for both.
   *
   * The turn LOCK is deliberately still un-scoped — it guards the directory
   * against a second CLI, which is a property of the place and not of a tab.
   */
  const sessionMetaPath = (wt, name, scope) => {
    try {
      const safe = scope && /^[A-Za-z0-9_-]{1,64}$/.test(String(scope)) ? `-${scope}` : '';
      return join(git(['rev-parse', '--absolute-git-dir'], wt), `${name}${safe}`);
    } catch {
      return null;
    }
  };

  /**
   * Carry a terminal checkout's DIRTY state into a fresh adopt worktree. The
   * source is strictly READ-ONLY — nothing here writes to it, because it is
   * the human's own checkout and adoption promises to leave it exactly as the
   * closed terminal did. Tracked changes travel as one binary patch staged
   * through the worktree's PRIVATE git dir (invisible to status, dies with the
   * tree); untracked files are copied one by one, skipping anything over 5MB.
   *
   * Returns '' or ONE bracketed line for the turn's prompt: a carry problem is
   * the AGENT's to explain to the user, never a reason to fail the adoption —
   * the conversation is the thing being adopted, and it resumes either way.
   */
  const carryDirtyState = (srcCwd, wt, sessionId) => {
    const problems = [];
    try {
      // A Buffer, not utf8: a `--binary` patch (and a hunk from a non-UTF-8
      // text file) must round-trip byte-exact or the apply corrupts what it
      // carries. 64MB of headroom — a dirtier tree than that fails the read
      // here and is SAID, below, rather than half-applied.
      const patch = execFileSync('git', ['diff', 'HEAD', '--binary'], {
        cwd: srcCwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 64 * 1024 * 1024,
      });
      if (patch.length) {
        const patchPath = sessionMetaPath(wt, 'flowviant-adopt.patch', sessionId);
        if (!patchPath) throw new Error('no private git dir to stage the patch in');
        try {
          writeFileSync(patchPath, patch);
          git(['apply', '--whitespace=nowarn', patchPath], wt);
        } finally {
          try {
            rmSync(patchPath, { force: true });
          } catch {
            /* best-effort — the private git dir dies with the worktree anyway */
          }
        }
      }
    } catch {
      problems.push(
        'their uncommitted TRACKED changes did not carry over (they are still in the terminal checkout, untouched)'
      );
    }
    try {
      const skipped = [];
      for (const rel of splitNul(
        gitRaw(['ls-files', '--others', '--exclude-standard', '-z'], srcCwd)
      )) {
        try {
          const from = join(srcCwd, rel);
          // lstat, not stat: a symlink is carried as itself, and its own size
          // is what the 5MB budget judges — never the file it points at.
          if (lstatSync(from).size > 5 * 1024 * 1024) {
            skipped.push(rel);
            continue;
          }
          const to = join(wt, rel);
          mkdirSync(dirname(to), { recursive: true });
          cpSync(from, to);
        } catch {
          skipped.push(rel);
        }
      }
      if (skipped.length) {
        problems.push(
          `${skipped.length} untracked file${skipped.length === 1 ? '' : 's'} did not carry (over 5MB or unreadable): ${skipped.slice(0, 5).join(', ')}${skipped.length > 5 ? ', …' : ''}`
        );
      }
    } catch {
      problems.push(
        'untracked files could not be listed in the terminal checkout, so none were carried'
      );
    }
    return problems.length
      ? `[ADOPTION NOTE from the daemon — tell the user plainly at the start of your reply: ${problems.join('; ')}.]`
      : '';
  };

  /**
   * WHICH CLI drives this session — picked ONCE, on the first turn, and pinned
   * in the worktree's meta dir. The held context belongs to the CLI that made
   * it: `--continue` under a different binary is a different brain wearing the
   * session's half-finished state (the dispatch path pins heldRuntime for the
   * same reason). If the pinned CLI has left the machine, the turn settles
   * honestly instead of substituting. A retired-and-reattached directory has
   * no marker and no held context either, so re-picking there is correct.
   *
   * THE SERVER'S WORD COMES FIRST. A tab is created AS a runtime's tab
   * (`job.runtime`; null/absent = Claude, which is what every tab ran on until
   * now), so on the first turn a named runtime IS the pick — never a
   * preference the machine may override. And a named runtime that DISAGREES
   * with an existing pin is an identity change mid-life: something upstream
   * now calls this tab a different brain's, and the only honest move is to
   * settle the turn and say so ({ mismatch }), because a held context must
   * never be answered by a different brain.
   *
   * Returns { id } | { id: null } (nothing installed) | { missing: label } |
   * { unsupported: label } (a runtime no session can run on) |
   * { mismatch: { pin, runtime } } (labels, for the caller's sentence).
   *
   * SESSION-CAPABLE means rt.mcp is truthy — the session tools ride a real
   * per-invocation MCP config — OR the runtime runs tabs PLAIN (Antigravity):
   * no MCP at all, no cards, no streaming; the final answer is delivered by
   * the daemon's own report and ship-time reconciliation keeps the ledger
   * whole. `pickRuntimeFor('build')` is still the WRONG question here — it
   * says yes to the mediated DISPATCH path without saying how a tab would
   * speak, and a session pinned by it once threw in mcpFor on every turn.
   */
  const sessionCapable = (rid) =>
    (Boolean(RUNTIMES[rid]?.mcp) || rid === 'antigravity') && canRun(RUNTIMES[rid], 'build');
  const sessionRuntime = (wt, jobRuntime, sessionId) => {
    // SCOPED: two tabs standing in one directory may run different CLIs, and an
    // unscoped pin would hand the second one the first one's runtime.
    const marker = sessionMetaPath(wt, 'flowviant-runtime', sessionId);
    let pinned = null;
    if (marker && existsSync(marker)) {
      try {
        pinned = readFileSync(marker, 'utf8').trim() || null;
      } catch {
        /* unreadable marker — re-pin below */
      }
    }
    if (pinned && RUNTIMES[pinned]) {
      if (jobRuntime && jobRuntime !== pinned) {
        return {
          mismatch: {
            pin: RUNTIMES[pinned].label || pinned,
            runtime: RUNTIMES[jobRuntime]?.label || jobRuntime,
          },
        };
      }
      // A pin that names a non-session-capable runtime is settled honestly by
      // the caller, not silently re-picked: re-picking would hand the held
      // context to a different brain, which is the exact substitution the pin
      // exists to prevent.
      if (!sessionCapable(pinned)) return { unsupported: RUNTIMES[pinned].label || pinned };
      const installed = detectRuntimes().find((r) => r.id === pinned)?.installed;
      return installed ? { id: pinned } : { missing: RUNTIMES[pinned].label || pinned };
    }
    // First turn, and the server named the brain: that IS the pick, gated the
    // same two ways as a pin — not session-capable and not installed both
    // settle honestly via the caller's existing paths, never substituted.
    if (jobRuntime) {
      if (!sessionCapable(jobRuntime))
        return { unsupported: RUNTIMES[jobRuntime]?.label || jobRuntime };
      const installed = detectRuntimes().find((r) => r.id === jobRuntime)?.installed;
      if (!installed) return { missing: RUNTIMES[jobRuntime]?.label || jobRuntime };
      if (marker) {
        try {
          writeFileSync(marker, jobRuntime);
        } catch {
          /* best-effort — an unpinnable session just re-picks next turn */
        }
      }
      return { id: jobRuntime };
    }
    // The fresh pick — Claude first when it qualifies, for the reason
    // pickRuntimeFor gives: the prompts were tuned against it. DELIBERATELY
    // NARROWER than sessionCapable: a PLAIN tab (Antigravity — no cards, no
    // streaming) is a degraded mode someone CHOOSES, so it is honored only
    // when the server names it, never handed out as a default.
    const rows = detectRuntimes();
    const okFor = (rid) =>
      Boolean(RUNTIMES[rid]?.mcp) &&
      sessionCapable(rid) &&
      Boolean(rows.find((r) => r.id === rid)?.installed);
    const id = okFor('claude') ? 'claude' : (Object.keys(RUNTIMES).find(okFor) ?? null);
    if (!id) return { id: null };
    if (marker) {
      try {
        writeFileSync(marker, id);
      } catch {
        /* best-effort — an unpinnable session just re-picks next turn */
      }
    }
    return { id };
  };

  /**
   * The shape a codex thread id must have before it is written to disk or —
   * decisive — pushed into argv as `resume <id>`. Conservative on purpose:
   * alphanumeric plus dash/underscore, never a leading dash (an argv that
   * parses as a flag), never whitespace. Anything else is dropped and the
   * session simply runs fresh in its own worktree.
   */
  const CODEX_THREAD_RE = /^[0-9a-zA-Z][0-9a-zA-Z_-]{7,63}$/;

  /** agy conversation ids are plain UUIDs (the db filename IS the identity —
   *  measured: a renamed copy fails "trajectory not found"). Guarded the same
   *  way as the codex id: it rides in argv as `--conversation <id>`. */
  const AGY_CONV_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  /** agy's own cwd registry — {cwd → the conversation that ran there LAST}.
   *  Read once, right after a fresh agy turn, to learn the id the turn just
   *  created; from then on the tab's marker is the identity and this registry
   *  is never consulted again (a dispatch sharing the machine may overwrite
   *  the cwd's entry between turns). */
  const agyRegistryLookup = (cwd) => {
    try {
      const raw = readFileSync(
        join(homedir(), '.gemini', 'antigravity-cli', 'cache', 'last_conversations.json'),
        'utf8'
      );
      const map = JSON.parse(raw);
      if (!map || typeof map !== 'object') return null;
      // agy keys by the cwd as IT resolved it — try our literal path and its
      // realpath, so a symlinked home doesn't orphan the lookup.
      let keys = [cwd];
      try {
        keys.push(realpathSync(cwd));
      } catch {
        /* the literal alone, then */
      }
      for (const k of keys) {
        const id = map[k];
        if (typeof id === 'string' && AGY_CONV_RE.test(id)) return id;
      }
      return null;
    } catch {
      return null;
    }
  };

  /**
   * Live session-turn CLI children. The daemon's teardown SIGTERMs them: an
   * orphaned CLI keeps editing the session worktree and burning quota after
   * the daemon is gone. Each child's pid-lock is deliberately LEFT IN PLACE —
   * a CLI can trap SIGTERM to finish an in-flight request and outlive this
   * loop by seconds, and removing the lock in the same tick handed the
   * restarted daemon a green light to spawn a second CLI into the same held
   * context. turnLockedByLivePid already covers both outcomes: it waits while
   * the pid lives and clears the lock once it is dead.
   *
   * THE VALUE IS THE ID THE CHILD SERVES, and it used to be the pid-lock path —
   * which nothing in this file has ever read. A write-only value is not free:
   * the machine snapshot's per-task RSS (`/fleet/machine`) is the one readout
   * that answers "which task is holding nine gigabytes", and it was being built
   * from the dispatch-era `workers` map, which nothing has `.set()` since that
   * lane was deleted — so the column its own server handler calls the
   * load-bearing half of the report had never been populated once. This map is
   * the only place that knows both the pid and whose work it is, so it carries
   * both. `null` where there is no id to name (a Deploy press is not a task).
   */
  const workChildren = new Map(); // child process -> sessionId | agentId | null
  /**
   * Children whose whole PROCESS GROUP must go, not just the child.
   *
   * The standing rule is the opposite — teardown SIGTERMs the CLI child and
   * never its group, precisely so an unattended auto-update does not kill the
   * driver's dev server, which a turn started INTO the CLI's group. That rule
   * is about the CLI's group and stays.
   *
   * A project CHECK is a different group entirely: the daemon spawns it itself,
   * `detached` with `shell: true`, so its group holds the check command and
   * nothing else — no dev server of anybody's. And `shell: true` is exactly
   * what makes signalling only the child useless: a compound command like
   * `npm run lint && npm test` leaves `/bin/sh` as the child, so SIGTERM killed
   * the shell and the test runner underneath it carried on holding the
   * worktree — and that place's WRITER lock — through every stop, takeover and
   * auto-update. The check's own ten-minute timer already kills `-child.pid`
   * for this reason; teardown simply did not.
   */
  const groupKillChildren = new Set();
  const shutdownWork = () => {
    for (const [ch] of workChildren) {
      try {
        if (groupKillChildren.has(ch) && ch.pid) process.kill(-ch.pid, 'SIGTERM');
        else ch.kill('SIGTERM');
      } catch {
        // A group that has already gone, or a pid that is no longer a leader.
        try {
          ch.kill('SIGTERM');
        } catch {
          /* best-effort */
        }
      }
    }
    workChildren.clear();
    groupKillChildren.clear();
  };

  /**
   * HOW MANY CLIs THIS MACHINE IS RUNNING RIGHT NOW — the number
   * `MAX_CONCURRENT` is a ceiling on, and the thing that had no counter.
   *
   * Every lane, because the bound is on the BOX and not on a lane: session
   * turns, an agent's turn, a Deploy press's planner, a project check — all of
   * them land in `workChildren` — plus whatever the caller reports on top of it
   * (the wiki cartographer, which fleet.mjs owns).
   *
   * THE PROJECT CHECK COUNTS, deliberately. It is not a model turn, but it is a
   * full test or build run in a worktree, which is exactly the kind of process
   * this ceiling exists to stop stacking. Nothing gates a check, so counting it
   * cannot deadlock: it only ever delays the NEXT spawn.
   */
  const liveTurnCount = () => {
    const extra = Number(extraLiveTurns() ?? 0);
    return workChildren.size + (Number.isFinite(extra) && extra > 0 ? extra : 0);
  };

  /** The live turn children with the id each one serves — what the machine
   *  snapshot charges its per-task RSS to. Children with no id (the planner)
   *  are still counted above; they just have nothing to be charged TO. */
  const liveTurns = () => {
    const out = [];
    for (const [ch, id] of workChildren) if (ch?.pid) out.push({ id: id ?? null, pid: ch.pid });
    return out;
  };

  /**
   * WHETHER TO START ONE MORE. See admission.mjs for the whole argument: a
   * runaway bound on a machine, read at the spawn, surfaced only as the
   * machine's own measured sentence at the thing that is waiting, and never a
   * reason to settle a job — a deferred job is re-offered next poll.
   */
  const admit = createAdmission({ liveTurnCount });

  /**
   * Retire the worktrees of sessions the server says are CLOSED.
   *
   * `activeWorkSessions` on the roster is the list of this fleet's LIVE
   * sessions; a directory whose id is absent belongs to a tab its owner
   * closed, and the directory — never the branch: committed work survives on
   * `session/<id>`, and ship re-attaches to it — is returned to disk. NEVER
   * by count: the old cap-12 retirement destroyed live sessions on shared
   * machines. When the roster omits the field entirely (older server),
   * absence of signal is not a close — retire nothing.
   */
  /** Every session this daemon currently has a worktree for — what renews our
   *  lease on the poll. Read off the directory rather than a map, so it is the
   *  same fact retirement acts on. */
  const heldSessionIds = () => {
    const dir = join(baseDir, 'sessions');
    try {
      return readdirSync(dir).filter(isSafePathSegment).slice(0, 50);
    } catch {
      return [];
    }
  };

  /** The pre-places name, kept so every existing caller reads unchanged: a
   *  session's own id IS its default place. */
  const sessionWtFor = (sessionId, baseAt) => placeWtFor(sessionId, baseAt);

  /** See `shipSweep.mjs`. Bound to this manager's repo, base and report queue. */
  const sweepMergedSessionBranch = (sessionId) =>
    sweepMergedBranch(sessionId, {
      git,
      repoRoot,
      baseRef: baseRef(),
      note,
      // The report queue is consulted at CALL time, never captured — a sweep
      // scheduled while a report was outstanding must still see it land.
      isReportPending: (id) => pendingShipReports.has(id),
    });

  const retireWorkSessions = (activeIds, heldElsewhere) => {
    if (!Array.isArray(activeIds)) return;
    // Sessions ANOTHER daemon on this credential is serving. They are absent
    // from activeWorkSessions for us and present for them, and removing their
    // worktree would pull the directory out from under a running turn. Absence
    // means "the tab closed"; this is the one other thing it can mean.
    const peers = new Set(Array.isArray(heldElsewhere) ? heldElsewhere : []);
    // A peer-held session's CACHED work token is a claim-bypass: the mint is
    // the one place the session lease 409s a non-holder, and a token younger
    // than ~23h skips the mint entirely — so a daemon that lost a lease would
    // run the next turn anyway, editing the worktree while every MCP call
    // 401s (the peer's mint rotated the secret). Dropping the cache forces
    // the next turn through the mint, where the 409 stands it down.
    for (const id of peers) workTokens.delete(id);
    const dir = join(baseDir, 'sessions');
    if (!existsSync(dir)) return;
    let ids;
    try {
      ids = readdirSync(dir);
    } catch {
      return;
    }
    const live = new Set(activeIds);
    let removed = 0;
    for (const id of ids) {
      if (live.has(id)) continue;
      if (peers.has(id)) continue; // another daemon's tab — not ours to retire
      /**
       * A HARD STOP REACHES THE CLI HERE, and this is the whole of it.
       *
       * `stopAgent` marked the agent abandoned in D1 and nothing on the wire
       * told the machine, so the CLI went on working, editing the worktree and
       * spending the operator's quota — while the confirm dialog said the agent
       * was stopped. It also never got cleaned up, because the check below
       * skips any place whose lock is held and a running turn holds it: a
       * stopped agent mid-turn kept its directory forever.
       *
       * No new wire field and no version floor: an abandoned agent simply drops
       * out of `activeWorkSessions` (that list is built from LIVE statuses), so
       * the server ALREADY says everything needed. Absence means "nothing here
       * is live any more", and the honest response to that is to stop what we
       * are running in it and then take the directory.
       *
       * SIGTERM the CHILD, never its group — the rule teardown keeps, so an
       * unattended sweep cannot take the driver's dev server with it. The lock
       * is released when the child exits, so the removal happens on the next
       * pass rather than this one.
       */
      const running = agentChildren.get(id);
      if (running) {
        try {
          running.kill('SIGTERM');
        } catch {
          /* already gone */
        }
        agentChildren.delete(id);
      }
      // Asked of the PLACE, not the session: the lock is keyed by directory,
      // and a session sharing one with a busy peer is not ours to retire
      // either — its worktree is the peer's working directory.
      if (placeLocks.has(placeOf(id)) || shipping.has(id)) continue; // still draining here
      const wt = join(dir, id);
      try {
        // Uncommitted work is the human's — a resource sweep does not outrank
        // it, closed tab or not. (The non-force remove would refuse anyway;
        // the explicit check keeps the intent legible.)
        if (git(['status', '--porcelain'], wt) !== '') continue;
        git(['worktree', 'remove', wt], repoRoot); // non-force
        workTokens.delete(id);
        removed++;
        // NOW the branch can be judged. While this worktree existed the branch
        // was checked out in it, so `git branch -d` refused on every earlier
        // attempt — a tab that shipped and then closed would otherwise leave
        // its merged branch behind forever, which is the common case.
        // Unshipped work still refuses here: `-d` is what decides.
        sweepMergedSessionBranch(id);
      } catch {
        /* not cleanly removable — leave it */
      }
    }
    if (removed) {
      try {
        git(['worktree', 'prune'], repoRoot);
      } catch {
        /* best effort */
      }
    }
  };

  /**
   * TELL THE TAB IT IS WAITING ON THE BOX, not on its Claude.
   *
   * A deferred turn is invisible from a browser: the composer says "working…"
   * and the machine simply does not spawn, which looks exactly like a slow
   * model. So the deferral rides the narration channel the turn would have used
   * anyway — the turn is still pending, so the server accepts the line — and
   * says the measured reason and what happens next. The machine's own voice,
   * for a moment only this side can see; the same shape the planner's "waiting
   * for the checkout" already keeps.
   *
   * ONCE PER SESSION PER WINDOW, because the roster re-offers the same turn on
   * every poll and restating an unchanged sentence every ten seconds is a POST
   * loop, not a readout. The clock is cleared the moment a turn for that session
   * actually starts, so the next stall speaks immediately rather than inheriting
   * a window from an unrelated one.
   */
  const DEFER_SAY_MS = 30_000;
  const lastDeferSaid = new Map(); // sessionId -> ms
  const sayTurnDeferred = (sessionId, turnId, reason) => {
    const now = Date.now();
    if (now - (lastDeferSaid.get(sessionId) ?? 0) < DEFER_SAY_MS) return;
    lastDeferSaid.set(sessionId, now);
    void fetch(ACTIVITY_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${FLEET_TOKEN}`,
        'User-Agent': USER_AGENT,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({
        sessionId,
        turnId,
        lines: [`Deferred — ${reason}. The machine retries on its next poll.`],
      }),
    }).catch(() => {
      /* a readout — a dropped line is not an incident */
    });
  };

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
              answer: `this session runs on ${rt.unsupported}, which cannot drive a Workbench tab on this machine — open a new tab`,
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
          // context. The id was captured off thread.started (runtimes.mjs) and
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
          const brain = brainFor(job);
          // Attempts count RUNS: the infra refusals above consumed nothing and
          // settled on their own terms.
          workAttempts.set(job.id, tries + 1);
          let out;
          let seenThreadId = null; // codex's conversation id, off thread.started
          let seenClaudeSession = null; // claude's own conversation id, off system.init
          const spawned = []; // this turn's children, for the teardown registry
          /**
           * THE TURN'S TOOL LOG — the structured relay behind the transcript's
           * tool cards. Same source as the narrator (the CLI's own tool_use
           * events), zero inference; scrubbed AT COLLECTION so every copy that
           * leaves the machine — live beat and settle alike — is already clean.
           *
           * Shape rules, applied here because the collector is the one writer:
           *   · consecutive identical read/grep/glob/bash/task events collapse
           *     into one row with a count (n);
           *   · consecutive edits of ONE file merge, summing counts, keeping
           *     the newest preview;
           *   · the PLAN is a single event — a new TodoWrite replaces the old
           *     plan at the current position, so the log shows the latest plan
           *     where it last changed rather than five stale copies;
           *   · capped at the newest 60 NON-PLAN rows, with the shed counted
           *     call-for-call (`dropped += n`) — scrollback semantics, the
           *     same trade the transcript itself makes; the plan is exempt,
           *     because it is current state rather than scrollback.
           */
          const toolLog = { ev: [], dropped: 0 };
          const pushToolEvent = (name, input) => {
            // envScrub rides INTO the builder, which scrubs over a bounded
            // window BEFORE its caps — scrubbing after the cut both leaked a
            // boundary-straddling secret's prefix and grew a capped field
            // past the server's limits (review, 2026-09-01).
            const e = toolEventOf(name, input, dir.wt, envScrub);
            if (!e) return;
            if (e.t === 'plan') {
              const i = toolLog.ev.findIndex((x) => x.t === 'plan');
              if (i >= 0) toolLog.ev.splice(i, 1);
              toolLog.ev.push(e);
            } else {
              const last = toolLog.ev[toolLog.ev.length - 1];
              const sameKey =
                last &&
                last.t === e.t &&
                last.p === e.p &&
                last.q === e.q &&
                last.c === e.c;
              if (sameKey && (e.t === 'edit' || e.t === 'write')) {
                last.n = (last.n ?? 1) + 1;
                last.a = (last.a ?? 0) + (e.a ?? 0);
                last.d = (last.d ?? 0) + (e.d ?? 0);
                if (e.dl) last.dl = e.dl;
              } else if (sameKey) {
                last.n = (last.n ?? 1) + 1;
              } else {
                toolLog.ev.push(e);
              }
            }
            // The cap evicts the oldest NON-plan row: the plan is current
            // state, not scrollback — the one card the fold keeps out — and a
            // shed collapsed row counts its repeats, so "N steps" never
            // understates what the cut removed.
            while (toolLog.ev.length > 60) {
              const i = toolLog.ev.findIndex((x) => x.t !== 'plan');
              if (i < 0) break; // only the plan left; it stays
              const [shed] = toolLog.ev.splice(i, 1);
              toolLog.dropped = Math.min(1_000_000, toolLog.dropped + (shed?.n ?? 1));
            }
          };
          const narrator = makeNarrator(job.sessionId, job.id, () =>
            toolLog.ev.length > 0 ? toolLog : undefined
          );


          // THE COMMAND AUDIT — every `$ …` the CLI's stream reports, batched
          // to the server verbatim so an admin can read what actually ran on
          // this box. Same events the narrator renders and forgets; this is
          // the durable copy, and it carries ONLY commands — no prose, no
          // thinking, no file reads (the session stays private; what executed
          // on the shared machine is the machine's own fact to relay).
          // Flushed mid-turn every 25 so a long turn is not one giant loss on
          // a kill, and again at settle. Best-effort: a failed post drops the
          // batch rather than blocking the turn — the surface says it is the
          // machine's report, not a syscall trace.
          const auditBatch = [];
          const flushAudit = () => {
            if (auditBatch.length === 0) return;
            const commands = auditBatch.splice(0, auditBatch.length);
            void fetch(SESSION_COMMANDS_URL, {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${FLEET_TOKEN}`,
                'User-Agent': USER_AGENT,
                'Content-Type': 'application/json',
              },
              signal: AbortSignal.timeout(30_000),
              body: JSON.stringify({
                sessionId: job.sessionId,
                turnId: job.id,
                runtime: rt.id,
                cwd: dir.wt,
                commands,
              }),
            }).catch(() => {
              /* best-effort — the audit records what reached it */
            });
          };
          const auditCommand = (a) => {
            if (a?.kind !== 'bash' || !a.command) return;
            // Scrubbed like every other string that leaves this box (the
            // narrator label, the settle answer, commit subjects, ship/merge
            // lines, the per-tab process report). A command line is exactly
            // where a secret leaks — `curl -H "authorization: <token>"`,
            // `PGPASSWORD=… psql` — and the audit is stored 30 days and rendered
            // in the admin view, so the one uplink that omitted scrub was the
            // one most likely to carry a plaintext secret.
            auditBatch.push({ command: envScrub(a.command), at: new Date().toISOString() });
            if (auditBatch.length >= 25) flushAudit();
          };
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
              planPerm: captureTab,
              // `--permission-mode plan` INSTEAD of the build posture — never
              // beside `--dangerously-skip-permissions`, which silently wins
              // (claude.mjs, PLAN_MODE_PERM). Present only on a plan turn.
              ...(planTurn ? { planMode: true } : {}),
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
              // What this CLI says it can be asked for by name. Harvested off
              // the init event the stream already carries — no probe, no scan,
              // no extra spawn — and reported on the next roster poll so the
              // composer can autocomplete a `/`. See runtimes.mjs for why it is
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
              resume &&
              (!(out || '').trim() ||
                resumeConversationLost(out, { runtime: rt.id, sawInit: Boolean(seenClaudeSession) }))
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
            ...(toolLog.ev.length > 0 ? { tools: toolLog } : {}),
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

  /**
   * KEEP EACH PERSON'S MANUAL WORKTREE FRESH.
   *
   * Every teammate's Workbench tabs share one directory of their own on a
   * branch of their own — which is not a preference, it is what git allows:
   * two worktrees cannot have the same branch checked out, so "everyone works
   * on main" is only true for the machine's OPERATOR, whose place is the
   * checkout itself. Everyone else needs a branch, and a branch left alone
   * drifts behind main until the first thing they do in a new tab is a merge
   * they did not ask for.
   *
   * FAST-FORWARD ONLY, and that is the whole safety argument. If their branch
   * has no commits of its own it simply catches up, which is the ordinary case
   * and the one worth automating. The moment it HAS diverged, this stops and
   * leaves it exactly as it is: their commits are theirs, a rebase would
   * rewrite them under somebody who is not looking, and a merge would put a
   * commit in their history that they did not make. Their own Claude can fold
   * base in whenever they ask it to.
   *
   * Guarded three ways: a DIRTY tree is left alone (uncommitted work outranks
   * freshness), a place with a live lock is skipped (a turn is standing in it),
   * and the whole thing is silent — nothing here reports, warns or blocks.
   */
  const freshenManualPlaces = () => {
    let dir;
    try {
      dir = readdirSync(join(baseDir, 'sessions'));
    } catch {
      return; // no worktrees yet
    }
    for (const place of dir) {
      // Only a PERSON's manual place. An agent's own worktree (`a-<id>`) is
      // deliberately not touched: its branch is the reviewable unit, and
      // moving it under a review would change what somebody is deciding about.
      if (!place.startsWith('u-') || !isSafePathSegment(place)) continue;
      if (placeLocks.has(place)) continue;
      const wt = join(baseDir, 'sessions', place);
      try {
        if (git(['status', '--porcelain'], wt).trim() !== '') continue;
        git(['merge', '--ff-only', baseRef()], wt);
      } catch {
        /* diverged, or something else is going on in there. Leave it. */
      }
    }
  };

  const state = {
    shipping,
    pendingShipReports,
    workChildren,
    placeLocks,
    groupKillChildren,
    agentPublished,
    agentRemoteAt,
    sessionGroups,
  };

  const { processDiffJobs } = createWorkDiffs({
    repoRoot,
  });

  const { processPreviewJobs, livePreviewIds, retirePreviews, shutdownPreviews } = createWorkPreviews({
    placeDir,
  });

  const { processPrJobs } = createWorkPullRequests({
    placeOf,
    REPO_PLACE,
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
    REPO_PLACE,
    repoRoot,
    baseDir,
    gitNet,
    baseRef,
    placeWtFor,
    turnLockedByLivePid,
    sessionMetaPath,
    state,
  });

  const { processAgentPlanJobs, planning } = createWorkAgentPlans({
    postBestEffort,
    baseDir,
    baseRef,
    REPO_PLACE,
    inPlace,
    repoRoot,
    admit,
    state,
  });

  const { runReviewEntry } = createWorkAgentReview({
    repoRoot,
    postBestEffort,
    baseRef,
    admit,
    sessionMetaPath,
    state,
  });

  const { processAgentTurnJobs, settleAgentTurns, agentTurns, agentChildren, agentReported } = createWorkAgentTurns({
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
    state,
  });

  const { processKillJobs } = createWorkProcesses({
    placeDir,
    reportPlaceWorktrees,
    state,
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
    // the loop so the lanes fleet.mjs owns — the wiki cartographer — ask the
    // same question, and so the machine snapshot can charge memory to the work
    // holding it.
    admit,
    liveTurns,
    liveTurnCount,
    processAgentPlanJobs,
    processAgentTurnJobs,
    // Only the displacement stand-down calls this — see its comment. Exported
    // rather than hooked into `shutdownWork` because the signal handlers cannot
    // await, and a settle that is not awaited is a settle that did not happen.
    settleAgentTurns,
    processAgentMergeJobs,
    freshenManualPlaces,
  };
}
