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
import { execFileSync, spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import {
  FLEET_URL,
  FLEET_TOKEN,
  USER_AGENT,
  REFRESH_BEFORE_SECONDS,
  DAEMON_INSTANCE,
  MACHINE_HOST,
  MODEL,
} from './config.mjs';
import {
  git,
  gitRaw,
  gitNet as gitNetIn,
  gitNetAsync,
  splitNul,
  baseBranchName,
  isSafePathSegment,
  excludeInWorktree,
} from './git.mjs';
import {
  isPublishRef,
  publishPushArgs,
  publishFetchArgs,
  publishDeleteArgs,
  publishErrorText,
} from './agentPublish.mjs';
import { createLandedObserver } from './landed.mjs';
import { listenersIn, measureListeners, listenersSupported } from './listeners.mjs';
import { measureProcesses, liveGroups, processesSupported } from './processes.mjs';
import {
  bootMark,
  mutateRegistry,
  processAlive,
  processStartTime,
  readRegistry,
  sameBoot,
} from './procRegistry.mjs';
import { createPlaceLock } from './placeLock.mjs';
import { parseProposal, parsePrecheck, parseTurnResult } from './agentPlan.mjs';
import { readStash, stashCard } from './agentCards.mjs';
import { sweepMergedBranch } from './shipSweep.mjs';
import { mergeOutward as shipMergeOutward } from './shipMerge.mjs';
import { openTunnel } from './preview.mjs';
import { c, note, ok, warn } from './ui.mjs';
import { mcpFor, runTurn } from './claude.mjs';
import {
  SYSTEM_WORK,
  SYSTEM_CAPTURE,
  WORK_TURN_KICKOFF,
  CAPTURE_TURN_KICKOFF,
  SYSTEM_WORK_PLAIN,
  WORK_TURN_KICKOFF_PLAIN,
  SYSTEM_PLAN,
  AGENT_PLAN_KICKOFF,
  SYSTEM_AGENT_FOR,
  agentTaskKindOf,
  unknownAgentTaskKind,
  SYSTEM_PRECHECK,
  AGENT_TASK_KICKOFF,
  AGENT_TASK_SPEC,
  AGENT_HUMAN_KICKOFF,
  AGENT_PRECHECK_KICKOFF,
  withProjectContext,
} from './prompts.mjs';
import { knowledgeDirFor, FLOWVIANT_OWN_PATHS } from './knowledge.mjs';
import {
  ARTIFACT_DIR,
  artifactTypeFor,
  changedArtifacts,
  createArtifactReporter,
  scanArtifacts,
  snapshotArtifacts,
} from './artifacts.mjs';
import { myPubB64, scrub as envScrub, secretIn as envSecretIn } from './env.mjs';
import {
  detectRuntimes,
  canRun,
  pickRuntimeFor,
  recordSkills,
  recordMcpServers,
  toolEventOf,
  removeProbeTranscript,
  CLAUDE_TOOL_PROSE_KINDS,
  RUNTIMES,
} from './runtimes.mjs';
import { createAdmission } from './admission.mjs';
import { makeTraceRelay } from './trace.mjs';

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
 * CLEAR THE ARTIFACTS DIRECTORY OF ANYTHING THAT IS NOT AN ARTIFACT, BEFORE
 * THE PROJECT'S CHECK RUNS OVER THE WORKTREE (2026-09-24).
 *
 * A design or research turn may write under `.flowviant/artifacts/` and
 * nowhere else — that posture's whole safety claim is that such a card
 * changes no repository file. But the check is the repo's own command, run
 * unattended in the same worktree the moment the queue empties, and a test
 * runner's DEFAULT discovery reaches into that directory: vitest collected and
 * ran `.flowviant/artifacts/pwn.test.js` with no include override. So a card
 * steered by text it read could plant a test and have the machine execute it,
 * before any person looked — and the directory is git-excluded, so the file
 * never appears in the diff a reviewer reads.
 *
 * What an artifact IS is already a closed list (`ARTIFACT_TYPES`), and the
 * scan only ever shows TOP-LEVEL regular files: anything else there is
 * nothing the product will show, so removing it before the check costs
 * nothing a person could see. Symlinks and subdirectories go whole; a
 * `.flowviant` that is not a real directory is left alone (that is the
 * repository's own content, not something a turn wrote). Returns the names
 * removed, for the log line.
 */
export function clearNonArtifacts(wt) {
  const removed = [];
  try {
    const parent = lstatSync(join(wt, '.flowviant'));
    if (parent.isSymbolicLink() || !parent.isDirectory()) return removed;
    const dir = join(wt, ARTIFACT_DIR);
    const st = lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) {
      rmSync(dir, { force: true, recursive: false });
      removed.push(ARTIFACT_DIR);
      return removed;
    }
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      let e;
      try {
        e = lstatSync(p);
      } catch {
        continue; // vanished between the list and the stat
      }
      const keep = e.isFile() && !name.startsWith('.') && artifactTypeFor(name) !== null;
      if (keep) continue;
      try {
        rmSync(p, { recursive: true, force: true });
        removed.push(name);
      } catch {
        /* best-effort — reported by omission */
      }
    }
  } catch {
    /* no artifacts directory — the ordinary case */
  }
  return removed;
}

/**
 * THE ENVIRONMENT THE PROJECT'S CHECK RUNS UNDER: the daemon's own, minus the
 * machine credential — the same rule `cliEnv` (claude.mjs) applies to a turn,
 * repeated here rather than imported so the check never depends on the CLI
 * module's spawn helpers. Nothing a check runs needs the credential the daemon
 * authenticates with; everything else is what the agent's own turn saw when it
 * ran the same tests.
 */
const CHECK_DROPPED_ENV = ['FLOWVIANT_MACHINE_TOKEN', 'FLOWVIANT_FLEET'];
export function checkEnv(env = process.env) {
  const out = { ...env };
  for (const k of CHECK_DROPPED_ENV) delete out[k];
  return out;
}

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
  const DIFF_DONE_URL = FLEET_URL.replace(/\/agents\/?$/, '/diff-done');
  const PREVIEW_CLAIM_URL = FLEET_URL.replace(/\/agents\/?$/, '/preview-claim');
  const KILL_DONE_URL = FLEET_URL.replace(/\/agents\/?$/, '/kill-done');
  const KILL_CLAIM_URL = FLEET_URL.replace(/\/agents\/?$/, '/kill-claim');
  const PREVIEW_DONE_URL = FLEET_URL.replace(/\/agents\/?$/, '/preview-done');
  const SESSION_COMMANDS_URL = FLEET_URL.replace(/\/agents\/?$/, '/session-commands');
  const ATTACHMENT_URL = FLEET_URL.replace(/\/agents\/?$/, '/attachment');
  const PR_CLAIM_URL = FLEET_URL.replace(/\/agents\/?$/, '/pr-claim');
  const PR_DONE_URL = FLEET_URL.replace(/\/agents\/?$/, '/pr-done');
  const AGENT_PLAN_CLAIM_URL = FLEET_URL.replace(/\/agents\/?$/, '/agent-plan-claim');
  const AGENT_PLAN_DONE_URL = FLEET_URL.replace(/\/agents\/?$/, '/agent-plan-done');
  const AGENT_PLAN_ACTIVITY_URL = FLEET_URL.replace(/\/agents\/?$/, '/agent-plan-activity');
  const AGENT_TURN_DONE_URL = FLEET_URL.replace(/\/agents\/?$/, '/agent-turn-done');
  const AGENT_ACTIVITY_URL = FLEET_URL.replace(/\/agents\/?$/, '/agent-activity');
  const AGENT_TRACE_URL = FLEET_URL.replace(/\/agents\/?$/, '/agent-trace');
  const AGENT_PARKED_URL = FLEET_URL.replace(/\/agents\/?$/, '/agent-parked');
  const AGENT_CHECK_DONE_URL = FLEET_URL.replace(/\/agents\/?$/, '/agent-check-done');
  const AGENT_PRECHECK_URL = FLEET_URL.replace(/\/agents\/?$/, '/agent-precheck');
  const AGENT_MERGE_CLAIM_URL = FLEET_URL.replace(/\/agents\/?$/, '/agent-merge-claim');
  const AGENT_MERGE_DONE_URL = FLEET_URL.replace(/\/agents\/?$/, '/agent-merge-done');
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
   * COMMIT DIFFS, on request — the one PULL-shaped thing this daemon does.
   *
   * Everything else here is a push: the machine knows something and says it.
   * A patch cannot work that way, because most are never opened and pushing
   * every one would be storage and bandwidth for nothing. So the server leaves
   * a job on the roster and this drains it.
   *
   * RUN FROM THE REPO ROOT, never a session worktree. A tab can be closed and
   * its directory gone, but `session/<id>` outlives the tab and after a ship
   * the commit is on main — the root checkout can see all of it, and a
   * worktree can see only its own branch.
   *
   * Every failure is REPORTED rather than swallowed: "no such commit on this
   * machine" is a real answer, and a viewer spinning forever is the worst thing
   * this can do. The one thing never sent is a guess — an empty patch would
   * tell a reader the commit changed nothing.
   */
  const MAX_PATCH_BYTES = 256 * 1024;
  const servedDiffs = new Set();
  const postDiff = async (body) => {
    try {
      await fetch(DIFF_DONE_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${FLEET_TOKEN}`,
          'User-Agent': USER_AGENT,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(30_000),
        body: JSON.stringify(body),
      });
    } catch {
      /* the row stays pending and expires; the next click re-requests */
    }
  };
  // ── SESSION PREVIEWS ──────────────────────────────────────────────────────
  //
  // Share the dev server the DRIVER is already running in their tab, behind a
  // generated password, on a quick tunnel. This daemon never starts an app: the
  // deleted live-preview feature ran a repo-declared command through a shell,
  // and that is the reason it is deleted. Here the human runs their own server,
  // `listenersIn` notices it, and this only ever wraps a port that measurement
  // already named for that session.
  //
  // CLAIM BEFORE ACTING. Two daemons legitimately share one fleet credential —
  // the case `machineDaemonsDisagree` exists because it happens, and the 0.51.2
  // instance lock is blind to an OLDER peer — so both are handed the same job
  // array. Both opening a tunnel leaves a public hostname alive that nobody
  // owns and nobody can tear down, because only the lease holder can settle the
  // row. `processDiffJobs` gets away without this because running `git show`
  // twice costs nothing.
  const livePreviews = new Map(); // sessionId -> { port, url, stop }
  const previewClaiming = new Set(); // sessionIds mid-claim on this tick

  const postPreview = async (body) => {
    try {
      await fetch(PREVIEW_DONE_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${FLEET_TOKEN}`,
          'User-Agent': USER_AGENT,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(30_000),
        body: JSON.stringify({ ...body, instance: DAEMON_INSTANCE }),
      });
    } catch {
      /* the row stops being confirmed and reads as ended — which is true */
    }
  };

  const claimPreview = async (sessionId) => {
    try {
      const res = await fetch(PREVIEW_CLAIM_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${FLEET_TOKEN}`,
          'User-Agent': USER_AGENT,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(15_000),
        body: JSON.stringify({ sessionId, instance: DAEMON_INSTANCE }),
      });
      const j = await res.json().catch(() => null);
      return j?.data?.claimed === true;
    } catch {
      return false; // could not claim → do nothing at all. The other daemon may have.
    }
  };

  /** Tear one down here, and say so. `reason` is why, stored server-side rather
   *  than inferred: "the origin stopped listening" and "the owner pressed Stop"
   *  are different sentences to a teammate holding a phone. */
  const stopPreview = async (sessionId, reason) => {
    const live = livePreviews.get(sessionId);
    livePreviews.delete(sessionId);
    if (live) {
      try {
        live.stop();
      } catch {
        /* best-effort */
      }
    }
    // Confirm only a teardown we actually PERFORMED. The stop job is a
    // broadcast — every daemon on the credential gets it — and the one holding
    // nothing used to answer instantly, flipping the row to 'ended' so the
    // real holder was never told to stop and its tunnel outlived every
    // surface. (The server drops mismatched confirms too; this is the copy on
    // the component that can be published ahead of a deploy.) A stop for a
    // tunnel whose daemon crashed resolves server-side: an unanswered 'ending'
    // row reads as over once it goes stale.
    if (live) await postPreview({ sessionId, ended: true, endedReason: reason });
  };

  const processPreviewJobs = (jobs) => {
    if (!Array.isArray(jobs) || jobs.length === 0) return;
    for (const job of jobs.slice(0, 5)) {
      const sessionId = String(job?.sessionId || '');
      const port = Number(job?.port);
      if (!isSafePathSegment(sessionId)) continue;

      if (job?.action === 'stop') {
        if (previewClaiming.has(sessionId)) continue;
        previewClaiming.add(sessionId);
        void stopPreview(sessionId, 'stopped').finally(() => previewClaiming.delete(sessionId));
        continue;
      }

      if (!Number.isInteger(port) || port <= 0 || port > 65535) continue;

      // VALIDATE THE MEMBERS-GATE TRIPLE AT THE BOUNDARY, the way sessionId and
      // port already are — one place doing the check is one deploy away from
      // being zero places. A malformed value is DROPPED rather than errored and
      // the share opens password-only: a gate is never degraded to open, but it
      // is also never left un-opened over a field we could not read.
      const secret = /^[A-Za-z0-9_-]{32,128}$/.test(String(job?.secret ?? ''))
        ? String(job.secret)
        : null;
      const shareId = isSafePathSegment(String(job?.shareId ?? '')) ? String(job.shareId) : null;
      let authorizeUrl = null;
      try {
        const u = new URL(String(job?.authorizeUrl ?? ''));
        if (u.protocol === 'https:') authorizeUrl = u.toString();
      } catch {
        /* not a URL — password-only, which is honest */
      }
      // All three or none: two of the three is a gate that cannot bounce.
      const gateOk = Boolean(secret && shareId && authorizeUrl);

      // Already serving exactly this. Re-opening would replace a working URL
      // somebody may be looking at right now.
      //
      // NOTE this key is (session, port) and NOT the secret. Rotating a secret
      // under a LIVE share is deliberately unsupported: `requestPreview`
      // early-returns on a live row of the same port, so a new secret only ever
      // arrives with a genuinely new row, by which time this map has been
      // cleared. Anyone adding rotation must widen the key first.
      if (livePreviews.get(sessionId)?.port === port) continue;
      if (previewClaiming.has(sessionId)) continue;
      previewClaiming.add(sessionId);

      void (async () => {
        try {
          if (!(await claimPreview(sessionId))) return; // somebody else has it
          const wt = placeDir(sessionId);
          // RE-VALIDATE the attribution here, not just the liveness. The server
          // checked this port against a report up to a minute old; more
          // importantly, checking `listenersIn` again is what keeps the answer
          // to "whose port is this" on the machine that can actually see it.
          const measured = listenersIn(wt).some((l) => l.port === port);
          if (!measured) {
            await postPreview({
              sessionId,
              error: `nothing is listening on port ${port} in this worktree.`,
            });
            return;
          }
          // Replace anything this session already had — one tab, one door.
          const prev = livePreviews.get(sessionId);
          if (prev) {
            try {
              prev.stop();
            } catch {
              /* best-effort */
            }
            livePreviews.delete(sessionId);
          }
          const t = await openTunnel({
            port,
            log: (m) => note(`preview ${sessionId.slice(0, 8)}: ${m}`),
            // The origin died under a live tunnel. cloudflared happily outlives
            // a dead dev server and the gate answers a dead origin with 502, so
            // without this the app would print "live" over a 502.
            onDead: () => {
              livePreviews.delete(sessionId);
              void postPreview({ sessionId, ended: true, endedReason: 'origin_gone' });
            },
            // ATTRIBUTION rides the probe, not just the open: a freed default
            // port (5173…) rebound by any other process on the box would keep
            // a bare TCP probe green, and the share's URL+password would serve
            // a worktree nobody consented to publish.
            stillServing: async () => listenersIn(wt).some((l) => l.port === port),
            ...(gateOk ? { grantSecret: secret, shareId, authorizeUrl } : {}),
            // The gate closed itself after repeated failed passwords. Stored,
            // so the incident is visible — and the entry is dropped so the
            // owner can re-share the port without restarting the daemon.
            onAbuse: () => {
              livePreviews.delete(sessionId);
              void postPreview({ sessionId, ended: true, endedReason: 'abuse' });
            },
            // cloudflared died AFTER publishing (quick tunnels get dropped).
            // Without this the daemon kept heartbeating a hostname that 530s.
            onTunnelGone: () => {
              livePreviews.delete(sessionId);
              void postPreview({
                sessionId,
                error: 'the tunnel dropped — share it again to reopen.',
              });
            },
          });
          if (t.error) {
            await postPreview({ sessionId, error: t.error });
            return;
          }
          livePreviews.set(sessionId, { port, url: t.url, stop: t.stop });
          // The gate we ACTUALLY installed, so the app never asserts a door
          // nobody observed. An older server ignores the field.
          await postPreview({
            sessionId,
            url: t.url,
            user: t.user,
            password: t.password,
            gate: t.gateMode,
          });
        } finally {
          previewClaiming.delete(sessionId);
        }
      })();
    }
  };

  /** The sessionIds this machine is still serving — sent on the poll so the
   *  server can tell a live share from one whose machine went away. Silence
   *  must never read as "live". */
  /**
   * The daemon's own shape check on an argv the server parsed.
   *
   * Deliberately a SHAPE check and not a re-parse: the server owns the policy
   * (which argv[0] are allowed, the install refusal, the length caps) and the
   * machine owns the refusal to EXECUTE something malformed. It is duplicated
   * rather than imported because this package ships standalone and cannot
   * depend on the monorepo — the mirror is small, and `devCommand.ts` is where
   * the real rules live.
   */
  const isPlausibleDevArgv = (argv) =>
    Array.isArray(argv) &&
    argv.length > 0 &&
    argv.length <= 8 &&
    argv.every((a) => typeof a === 'string' && a.length > 0 && a.length <= 200) &&
    !argv.some((a) => /[&|;<>`$(){}*?~\\]/.test(a));

  // ── DEV RUNS ARE DELETED (2026-08-26) ─────────────────────────────────
  //
  // The machine no longer starts application processes. It never learned to
  // decide what "run dev" means for a stack nobody enumerated — `rojo serve`
  // and `rbxtsc -w` are both correct for one Roblox repo and neither could
  // clear the server's argv0 allowlist, and widening that list is a code change
  // per ecosystem forever.
  //
  // Nothing downstream is lost, because SHARING NEVER DEPENDED ON US STARTING
  // IT. `listenersIn` attributes a listening socket to a place by the cwd of
  // the process holding it, so a server the driver's own agent started in the
  // tab is measured exactly like one this file used to spawn. The web renders
  // that measured list and a person picks which port to share.
  //
  // Gone with it: `devServer.mjs`, `devResolve.mjs`, the four `/fleet/dev-run-*`
  // endpoints, the claim lease, the orphan registry at ~/.flowviant/devruns.json
  // and its adopt-across-re-exec dance. If supervision is ever wanted back it
  // returns as "supervise this process", never as "run dev".

  const livePreviewIds = () => [...livePreviews.keys()];

  /**
   * The tab closed (or the server stopped listing it). Ordered BEFORE
   * `retireWorkSessions`, and that ordering is load-bearing: `git worktree
   * remove` under a running dev server reintroduces the stale-server bug — on
   * Linux the process keeps serving bytes from open file handles in a directory
   * that no longer exists, which shows a human the wrong thing without erroring
   * anywhere.
   */
  const retirePreviews = (activeIds) => {
    // Same guard `retireWorkSessions` keeps: a roster response missing the
    // field is an older server, not a close, and must not tear down every live
    // share at once.
    if (!Array.isArray(activeIds)) return;
    const live = new Set(activeIds);
    for (const sessionId of [...livePreviews.keys()]) {
      if (live.has(sessionId)) continue;
      if (previewClaiming.has(sessionId)) continue;
      previewClaiming.add(sessionId);
      void stopPreview(sessionId, 'tab_closed').finally(() => previewClaiming.delete(sessionId));
    }
  };

  /** Daemon shutdown. Detached tunnels survive our exit by design, so leaving
   *  them would strand a public hostname until the box rebooted — the exact
   *  case `reapOrphanPreviews` exists to clean up after an UNgraceful death. */
  const shutdownPreviews = () => {
    for (const [, live] of livePreviews) {
      try {
        live.stop();
      } catch {
        /* best-effort */
      }
    }
    livePreviews.clear();
  };

  // ── stopping one measured process ────────────────────────────────────────
  //
  // The driver points at a row the MACHINE reported and says stop. Flowviant
  // never picks the target, never sweeps, never signals anything on its own
  // initiative, and never signals a GROUP — teardown deliberately SIGTERMs the
  // CLI child and not its group precisely so an unattended auto-update cannot
  // take the driver's dev server with it, and a control that signalled groups
  // would hand that outcome back one click at a time.
  //
  // WHY THIS EXISTS AT ALL, since "ask your Claude to kill it" looks like it
  // already covers it. It does not, and it fails hardest in the case that
  // motivates it: every tab one person owns shares ONE place, the cross-process
  // turn lock is per-place and deliberately un-scoped, so while any other tab
  // of yours is mid-turn a new turn does not spawn — it warns and waits. If the
  // runaway process you want stopped is being held by a turn that is hung, the
  // turn that would kill it never runs. (Two more: FLOWVIANT_SAFE=1 — which the
  // README recommends on a shared box — has no kill, pkill, lsof or ss in its
  // allowlist; and under the README's own top hardening tip, a daemon on its
  // own OS user, the operator's dev server is EPERM to the agent.)
  //
  // A PID IS NOT AN IDENTITY, and this is the whole safety argument. Pids are
  // recycled, the row the browser is looking at is up to a sweep old, and the
  // instance lock already learned this the expensive way — its own comment says
  // "a looser version of this check SIGTERMed one". So the pid the server sends
  // is a REQUEST, never an authority: this re-derives attribution from the
  // kernel immediately before signalling, and refuses unless the pid is STILL
  // in one of this tab's process groups or STILL holding a socket in this
  // tab's place. A recycled pid belonging to something else fails that, which
  // is the property a start-time witness would have bought at the cost of
  // another wire field.
  //
  // CLAIMED, not read, for the reason `processPreviewJobs` states: two daemons
  // legitimately share one credential and both are handed the same array.
  // Signalling twice is survivable; signalling twice with a recycle in between
  // is the failure this whole comment is about.
  const killing = new Set(); // job ids in flight on this tick

  const postKill = async (body) => {
    try {
      await fetch(KILL_DONE_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${FLEET_TOKEN}`,
          'User-Agent': USER_AGENT,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(30_000),
        body: JSON.stringify({ ...body, instance: DAEMON_INSTANCE }),
      });
    } catch {
      /* unsettled, and the server expires it — the asker is told, never spun */
    }
  };

  const claimKill = async (id) => {
    try {
      const res = await fetch(KILL_CLAIM_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${FLEET_TOKEN}`,
          'User-Agent': USER_AGENT,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(15_000),
        body: JSON.stringify({ id, instance: DAEMON_INSTANCE }),
      });
      const j = await res.json().catch(() => null);
      return j?.data?.claimed === true;
    } catch {
      return false; // the peer may hold it; doing nothing is the safe answer
    }
  };

  /**
   * Is this pid, RIGHT NOW, one of the things we told the browser about for
   * this session? Two lanes, matching the two lists a row can come from.
   *
   * Deliberately re-measured rather than read from anything cached: a cache is
   * exactly as old as the report the browser is acting on, and staleness is the
   * hazard.
   */
  const killTargetOk = (sessionId, pid) => {
    const groups = sessionGroups.get(sessionId);
    if (groups && groups.size) {
      const alive = liveGroups(groups);
      const rows = measureProcesses(alive)?.rows ?? [];
      if (rows.some((r) => r.pid === pid)) return true;
    }
    const wt = placeDir(sessionId);
    if (wt) {
      try {
        if (measureListeners(wt).rows.some((r) => r.pid === pid)) return true;
      } catch {
        /* unmeasurable → not verified → refused, which is the safe direction */
      }
    }
    return false;
  };

  /**
   * How long to watch for the process to actually go before answering.
   *
   * SIGTERM is a REQUEST, not an event: a dev server traps it and tears down
   * its children, which takes a beat. Answering the instant the signal returns
   * would report "signalled" over a process that is about to die, and the
   * surface would then offer Force stop on something already on its way out.
   *
   * Four seconds is long enough for the ordinary teardown and short enough that
   * a person is still looking at the row. Past it the honest answer is that the
   * signal landed and the thing is still there — which is a real state, and the
   * one where escalating actually means something.
   */
  const KILL_GRACE_MS = 4000;

  const waitForExit = async (pid) => {
    const until = Date.now() + KILL_GRACE_MS;
    while (Date.now() < until) {
      if (!processAlive(pid)) return true;
      await new Promise((r) => setTimeout(r, 200));
    }
    return !processAlive(pid);
  };

  const runKill = async (job) => {
    const id = String(job.id);
    const sessionId = String(job.sessionId || '');
    const pid = Number(job.pid);
    const signal = job.signal === 'KILL' ? 'SIGKILL' : 'SIGTERM';

    /**
     * CLAIM FIRST, EVEN FOR THE ANSWERS THAT SIGNAL NOTHING.
     *
     * `unsupported` and `not_found` cost nothing to produce, which is exactly
     * why they must be leased: two daemons on one credential are handed the
     * same job, and the one holding NOTHING reaches these branches without
     * measuring anything or making a round trip — so it would answer first,
     * settle the row, and the machine that could actually have signalled would
     * find the job already closed and never touch the process. The person reads
     * "the pid is no longer one of this tab's", which is a real sentence, over a
     * watcher that is still running.
     *
     * The server enforces holder-only settles again (it briefly accepted these
     * two unclaimed, which is the bug above), so an unclaimed post here would
     * simply be dropped. One extra round trip on a path nobody is waiting on.
     */
    if (!(await claimKill(id))) return;
    if (!processesSupported()) {
      await postKill({ id, outcome: 'unsupported' });
      return;
    }
    if (!killTargetOk(sessionId, pid)) {
      // Not a lie and not a failure: the process is genuinely no longer one of
      // this tab's, which is the common case when somebody clicks a row that
      // has since exited. The asker gets that sentence rather than a spinner —
      // and the RE-MEASURE below is what takes the stale row off their screen,
      // since a row you can click for something already gone is the readout
      // being behind, not the person being wrong.
      await postKill({ id, outcome: 'not_found' });
      await remeasureAfterKill(sessionId);
      return;
    }
    try {
      process.kill(pid, signal);
      // WHAT HAPPENED, not what we did. "We sent a signal" is a fact about us;
      // "it stopped" is a fact about the machine, and the machine is standing
      // right here able to check. Reporting the weaker word would also make the
      // Force stop offer wrong for the whole window, since escalating only
      // means something while the process is genuinely still there.
      const gone = await waitForExit(pid);
      await postKill({ id, outcome: gone ? 'stopped' : 'signalled', signal });
    } catch (e) {
      // EPERM is the daemon-on-its-own-user posture doing exactly what it is
      // for. Report it as its own word: "we may not" and "it was gone" are
      // different sentences and the surface says which.
      await postKill({ id, outcome: e?.code === 'ESRCH' ? 'not_found' : 'error', detail: String(e?.code || e) });
    }
    await remeasureAfterKill(sessionId);
  };

  /**
   * THE LIST THE PERSON IS LOOKING AT WAS MEASURED BEFORE ANY OF THIS.
   *
   * Without this the row survives the thing it describes: the panel renders the
   * last sweep's `listening`, the sweep is on a SIXTY-SECOND beat, and the
   * reported outcome sits next to a port row still claiming to be live. The
   * first person to use it said exactly that — "i clicked stop on the listening
   * but its still running… then it finally disappears".
   *
   * The rule it was missing is one this file already keeps everywhere else: an
   * action that changes what the machine would measure must cause a new
   * measurement. A turn settling does it; a kill did not. `reportSessionWorktree`
   * is the un-throttled per-session path built for precisely this and it was
   * being called from exactly one place.
   *
   * Never awaited by the caller's answer path: the outcome is posted first, so
   * a slow re-measure can delay the list but never the sentence.
   */
  const remeasureAfterKill = async (sessionId) => {
    try {
      await reportPlaceWorktrees(sessionId);
    } catch {
      /* the 60s sweep still carries it — this only makes it prompt */
    }
  };

  const processKillJobs = (jobs) => {
    if (!Array.isArray(jobs) || jobs.length === 0) return;
    for (const job of jobs.slice(0, 5)) {
      const id = String(job?.id || '');
      const pid = Number(job?.pid);
      // Bounded at the boundary the same way sessionId and port already are.
      // pid 1 is init and is never something a tab started; a signal there
      // would ask the kernel to shut the box down.
      if (!id || killing.has(id)) continue;
      if (!Number.isInteger(pid) || pid <= 1 || pid > 4_294_967_295) continue;
      if (!isSafePathSegment(String(job?.sessionId || ''))) continue;
      killing.add(id);
      void runKill(job).finally(() => killing.delete(id));
    }
  };

  // ── PR-mode jobs (projects.mergeMode === 'pr') ──────────────────────────
  // 'open' = push the session's branch and open a PR; 'merge' = merge it.
  // Both under the operator's own `gh` credential from the daemon's inherited
  // env — the same posture the dispatch-era merge path took, and the same one
  // claude.mjs documents for turns. LEASED like a kill: two daemons pushing
  // one branch would open two PRs. NOTHING here closes a card — done is
  // observed by the landed walk when the merge reaches base.
  const prWorking = new Set();
  const ghFirstLine = (e) =>
    ((e?.stderr?.toString?.() || e?.message || 'failed').split('\n').find((l) => l.trim()) ||
      'failed')
      .slice(0, 400);
  const PR_URL_RE = /^https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/\d+$/;
  const claimPr = async (id) => {
    try {
      const res = await fetch(PR_CLAIM_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${FLEET_TOKEN}`,
          'User-Agent': USER_AGENT,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(15_000),
        body: JSON.stringify({ id, instance: DAEMON_INSTANCE }),
      });
      const j = await res.json().catch(() => null);
      return j?.data?.claimed === true;
    } catch {
      return false; // could not claim → do nothing. The other daemon may have.
    }
  };
  const settlePr = async (body) => {
    try {
      await fetch(PR_DONE_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${FLEET_TOKEN}`,
          'User-Agent': USER_AGENT,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(20_000),
        body: JSON.stringify({ ...body, instance: DAEMON_INSTANCE }),
      });
    } catch {
      /* the row expires into an honest no_answer; the re-request is the retry */
    }
  };
  const runPrJob = async (job) => {
    const id = String(job.id);
    if (!(await claimPr(id))) return;
    // gh present and authenticated, or the honest 'unsupported' — its own
    // outcome because "the machine cannot do this at all" and "GitHub said
    // no" read differently to the person who asked.
    try {
      // TIMED OUT, like every other `gh` call. `execFileSync` blocks the whole
      // event loop, so a hung `gh` — an expired token whose refresh hits a
      // black hole, a credential helper waiting on a keyring prompt that has
      // no terminal — stops the roster poll, every in-flight settle, the
      // worktree sweep and the deploy heartbeat (whose 3-minute staleness
      // window then re-queues a deploy this daemon is still running). The
      // AGENT merge path was given exactly these timeouts in 0.77.1; this
      // copy, forty lines of the same logic, was missed.
      execFileSync('gh', ['auth', 'status'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 20_000,
      });
    } catch (e) {
      const missing = e?.code === 'ENOENT';
      await settlePr({
        id,
        outcome: 'unsupported',
        detail: missing
          ? 'the GitHub CLI (gh) is not installed on this machine'
          : 'gh is not authenticated on this machine — run `gh auth login` there',
      });
      return;
    }
    // The branch is whatever the session's own worktree HEAD says — the same
    // resolution ship uses, for the same reason (the branch is where the
    // driver left it, not where we put it).
    const sessionId = String(job.sessionId);
    const place = placeOf(sessionId);
    const wt = place === REPO_PLACE ? repoRoot : join(baseDir, 'sessions', place);
    let branch = `session/${sessionId}`;
    let detached = false;
    if (existsSync(wt)) {
      try {
        branch = git(['symbolic-ref', '--short', 'HEAD'], wt);
      } catch {
        detached = true;
      }
    }
    if (detached) {
      await settlePr({
        id,
        outcome: 'failed',
        detail: 'the session is on a detached HEAD — no branch to push',
      });
      return;
    }
    // NEVER the base branch. A checkout-place tab (the operator's, at N=1)
    // commonly stands on base, and pushing it would BE the direct push this
    // mode exists to replace — on an unprotected repo the work lands with no
    // PR and the observer closes the cards as landed, PR mode silently
    // defeated by its own open job.
    const baseName = baseBranchName(baseRef());
    if (branch === baseName) {
      await settlePr({
        id,
        outcome: 'failed',
        detail: `the session is on the base branch (${baseName}) — nothing to open a pull request from; work on a branch first`,
      });
      return;
    }
    const pushCwd = existsSync(wt) ? wt : repoRoot;
    /** Adopt only an OPEN PR. gh's branch finder falls back to the most recent
     *  MERGED/CLOSED PR when no open one exists, and adopting a dead PR turns
     *  every later delivery on a long-lived session branch into a silent
     *  black hole ('opened'/'merged' over work that never moves). */
    /** …and ONLY ONE THAT TARGETS THE PROJECT'S BASE. A PR somebody opened by
     *  hand into another branch (`staging`, to try it there) was adopted as
     *  this delivery's PR, and Approve then merged the unreviewed branch INTO
     *  that branch — the ancestry check afterwards blamed "an older PR". The
     *  agent merge path has refused this since it shipped; this is the same
     *  guard, measured the same way: refused only on a MEASURED mismatch, an
     *  absent field adopts as before. Returns `{ url, base }` or null. */
    const openPr = () => {
      try {
        const j = JSON.parse(
          execFileSync('gh', ['pr', 'view', branch, '--json', 'url,state,baseRefName'], {
            cwd: repoRoot,
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: 30_000,
          }).toString()
        );
        if (j?.state !== 'OPEN' || typeof j?.url !== 'string') return null;
        return {
          url: j.url.trim(),
          base: typeof j?.baseRefName === 'string' ? j.baseRefName : null,
        };
      } catch {
        return null; // no PR for the branch at all
      }
    };
    const otherBase = (pr) =>
      pr && pr.base && pr.base !== baseName
        ? `the open pull request for ${branch} targets ${pr.base}, not ${baseName} — retarget or close it, then try again`
        : null;
    if (job.kind !== 'merge') {
      // OPEN: push, then create — or adopt a PR already OPEN for the branch
      // (a re-delivery, or one the driver opened by hand).
      try {
        gitNetIn(['push', '-u', 'origin', branch], pushCwd, 120_000);
      } catch (e) {
        await settlePr({ id, outcome: 'failed', detail: ghFirstLine(e) });
        return;
      }
      const existing = openPr();
      const wrongBase = otherBase(existing);
      if (wrongBase) {
        await settlePr({ id, outcome: 'failed', detail: wrongBase });
        return;
      }
      let url = existing?.url ?? null;
      if (!url) {
        try {
          const out = execFileSync(
            'gh',
            // `--fill` titles the PR from the branch's own commits — no model
            // call, nothing invented. baseBranchName, not baseRef: gh 422s on
            // a remote-tracking name like origin/main.
            ['pr', 'create', '--head', branch, '--base', baseName, '--fill'],
            { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 }
          )
            .toString()
            .trim();
          url = out.split('\n').filter(Boolean).pop() ?? null;
        } catch (e) {
          await settlePr({ id, outcome: 'failed', detail: ghFirstLine(e) });
          return;
        }
      }
      await settlePr({
        id,
        outcome: 'opened',
        ...(url && PR_URL_RE.test(url) ? { prUrl: url } : {}),
      });
      return;
    }
    // MERGE: push FIRST — GitHub merges the REMOTE PR tip, and the quiz the
    // reviewer just passed fingerprinted the LOCAL worktree, so merging
    // without a push would land a stale tip while the observer closed the
    // cards over commits that never reached base. Then a MERGE COMMIT, never
    // squash and never rebase — the cards' receipts are commit shas, and a
    // squash rewrites them off base, which would orphan every receipt AND
    // blind the landed walk's trailer read.
    // No --delete-branch: the local branch may be a live worktree's HEAD.
    // THE BASE IS RE-ASKED BEFORE THE MERGE, never trusted from the open step:
    // somebody can retarget a PR between Deliver and Approve, and `gh pr merge
    // <branch>` merges whichever open PR the branch has, into whatever it
    // targets now.
    const wrongBase = otherBase(openPr());
    if (wrongBase) {
      await settlePr({ id, outcome: 'failed', detail: wrongBase });
      return;
    }
    try {
      gitNetIn(['push', 'origin', branch], pushCwd, 120_000);
    } catch (e) {
      await settlePr({ id, outcome: 'failed', detail: ghFirstLine(e) });
      return;
    }
    try {
      execFileSync('gh', ['pr', 'merge', branch, '--merge'], {
        cwd: repoRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 120_000,
      });
    } catch (e) {
      const line = ghFirstLine(e);
      if (!/already merged/i.test(line)) {
        await settlePr({ id, outcome: 'failed', detail: line });
        return;
      }
    }
    // VERIFY before settling 'merged': modern gh exits 0 on an
    // already-MERGED PR, so a dead PR from an earlier delivery reads as
    // success while this branch's newest commits sit unmerged. The branch
    // tip being an ancestor of base is the fact 'merged' claims — check it,
    // with one short retry for the fetch racing GitHub's merge commit.
    const tipSha = (() => {
      try {
        return git(['rev-parse', branch], pushCwd);
      } catch {
        return null;
      }
    })();
    const tipOnBase = () => {
      if (!tipSha) return false;
      try {
        git(['merge-base', '--is-ancestor', tipSha, baseRef()], repoRoot);
        return true;
      } catch {
        return false;
      }
    };
    let merged = false;
    for (let attempt = 0; attempt < 2 && !merged; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 2000));
      try {
        gitNet(['fetch', 'origin', '--quiet'], 60_000);
      } catch {
        /* offline — the check below answers from what we have */
      }
      merged = tipOnBase();
    }
    if (!merged) {
      await settlePr({
        id,
        outcome: 'failed',
        detail:
          'GitHub reports a merge, but this branch\'s newest commits are not on the base branch — the PR that merged was an older one. Deliver again to open a fresh pull request.',
      });
      return;
    }
    await settlePr({ id, outcome: 'merged' });
    // The merge moved base. Observe NOW, so the cards close on this beat
    // rather than the next 3-minute sweep — the same re-measure-after-an-
    // action rule the kill and ship paths keep. (The fetch already ran in
    // the verify loop above.)
    void landed.observe().catch(() => {});
    onRepoChanged();
  };
  const processPrJobs = (jobs) => {
    if (!Array.isArray(jobs) || jobs.length === 0) return;
    for (const job of jobs.slice(0, 5)) {
      const id = String(job?.id || '');
      const sid = String(job?.sessionId || '');
      if (!id || !isSafePathSegment(sid)) continue;
      // Keyed by SESSION, not job id: a deliver-time open and an approve-time
      // merge for one session must run in order (the roster offers them FIFO;
      // running them concurrently would merge before the push-and-create).
      if (prWorking.has(sid)) continue;
      prWorking.add(sid);
      void runPrJob(job)
        .catch(() => {})
        .finally(() => prWorking.delete(sid));
    }
  };

  const processDiffJobs = (jobs) => {
    if (!Array.isArray(jobs) || jobs.length === 0) return;
    for (const job of jobs.slice(0, 5)) {
      const sha = String(job?.sha || '').toLowerCase();
      // A sha becomes a `git` argument. The server validates too; one place
      // doing this check is one deploy away from being zero places.
      if (!/^[0-9a-f]{7,64}$/.test(sha)) continue;
      // In-flight guard, not a cache: the server stops offering a sha the
      // moment it settles, so this only stops the SAME poll's job being
      // started twice while its `git show` is still running.
      if (servedDiffs.has(sha)) continue;
      servedDiffs.add(sha);
      void (async () => {
        try {
          let patch = '';
          const files = [];
          try {
            // `--format=` so the body is pure diff: the subject, author and
            // date already reached the card on the worktree sweep, and
            // repeating them inside the patch would put a second copy above
            // every hunk.
            patch = git(['show', '--patch', '--format=', sha], repoRoot);
          } catch (e) {
            await postDiff({ sha, error: String(e?.message || e).slice(0, 500) });
            return;
          }
          try {
            const raw = git(['show', '--numstat', '--format=', sha], repoRoot);
            for (const line of raw.split('\n')) {
              if (!line.trim()) continue;
              const [a, d, ...rest] = line.split('\t');
              const path = rest.join('\t');
              if (!path) continue;
              const binary = a === '-' || d === '-';
              files.push({
                path: path.slice(0, 300),
                added: binary ? 0 : Number(a) || 0,
                deleted: binary ? 0 : Number(d) || 0,
                ...(binary ? { binary: true } : {}),
              });
            }
          } catch {
            /* a header without counts still beats no diff */
          }
          const truncated = Buffer.byteLength(patch, 'utf8') > MAX_PATCH_BYTES;
          await postDiff({
            sha,
            // Cut on a LINE boundary: half a hunk header renders as garbage,
            // and the viewer says the patch was truncated either way.
            patch: truncated
              ? patch.slice(0, MAX_PATCH_BYTES).replace(/\n[^\n]*$/, '\n')
              : patch,
            files: files.slice(0, 200),
            truncated,
          });
        } finally {
          servedDiffs.delete(sha);
        }
      })();
    }
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
  const safeUploadName = (raw) => {
    const base = String(raw ?? '')
      .split(/[\\/]/)
      .pop()
      .replace(/[^A-Za-z0-9._-]/g, '_')
      .replace(/^[.-]+/, '')
      .slice(0, 80);
    return base || 'attachment';
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

  // Ship — a session's branch merging to main, on the human's word.
  //
  // --no-ff, NEVER squash: every delivered card carries commit shas as its
  // receipts, and a squash would point them all at commits that no longer
  // exist on main. Sequence: idempotency FIRST (a re-offered job after a lost
  // report recovers its receipts and re-reports — it must never re-merge, and
  // never be refused by checks that judge a merge this job already made).
  // Then two paths. A LIVE session: re-open the worktree if it was retired,
  // defer while a turn's CLI holds it, refuse a dirty worktree
  // (auto-committing someone's mid-thought state is not shipping, it is
  // guessing), refuse a worktree that left its own branch, fold main INTO the
  // branch first so conflicts surface where the session can resolve them,
  // then merge THE RESOLVED TIP outward through a throwaway worktree so
  // nobody's checkout moves — receipts and merged ref are the same sha by
  // construction. An ENDED session (absent from the roster's
  // activeWorkSessions): the BRANCH is the session now — nobody can commit,
  // discard, or resolve anything in its directory, so the checks whose
  // remedies address a live tab don't apply; merge the tip directly through
  // the throwaway, and a conflict fails honestly. Every exit reports
  // ship-done exactly once — except a deliberate deferral, re-offered next
  // poll; a ship that failed silently leaves the human believing their work
  // is on main.
  const processShipJobs = (jobs, activeIds) => {
    // Field absent (older server) = no liveness signal: treat every session
    // as live, which keeps the stricter checks.
    const liveIds = Array.isArray(activeIds) ? new Set(activeIds) : null;
    for (const job of jobs ?? []) {
      if (!job || typeof job.sessionId !== 'string') continue;
      if (shipping.has(job.sessionId)) continue;
      // The merge already LANDED and only the report is owed — flushing
      // delivers it; re-running the ship would misread its own success.
      if (pendingShipReports.has(job.sessionId)) continue;
      shipping.add(job.sessionId);
      // A WRITER, keyed by PLACE: ship folds and merges with git in this
      // directory, and no CLI running here can coordinate with that. Keyed by
      // place rather than by session id, which is what this used to do while
      // turns keyed on the place — so the two never shared a lock and the
      // guarantee in this comment was not actually held. `shipping` (above)
      // keeps overlapping polls from queueing the same job twice.
      inPlace(placeOf(job.sessionId), true, async () => {
        let settled = false;
        let deferred = false;
        const done = async (payload) => {
          if (settled) return;
          settled = true;
          await settleShip(job.sessionId, payload);
        };
        try {
          if (!isSafePathSegment(job.sessionId)) {
            await done({ ok: false, error: 'invalid session id' });
            return;
          }
          note(`${c.cyan('ship')} ${c.dim(`— "${job.sessionName || job.sessionId}"`)}`);
          /**
           * WHAT IS ACTUALLY CHECKED OUT — not what we named it at birth.
           *
           * Ship used to compute `session/<id>` and then REFUSE if HEAD had
           * moved: "ask it to return to its session branch, then ship again".
           * That refusal is the thing this product says it never does — it had
           * no reason of its own beyond bookkeeping, and in a terminal
           * `git checkout -b` breaks nothing, which is the whole standard this
           * surface is held to.
           *
           * The bug it was written for was real and is fixed properly here
           * rather than frozen out: ship once merged the branch NAME while
           * logging HEAD, so receipts named commits that never landed on main.
           * That was TWO SOURCES OF TRUTH, not branch switching. There is one
           * now, and it is the worktree's own HEAD.
           *
           * Resolved BEFORE the idempotency check below, and that ordering is
           * load-bearing: `session/<id>` can still exist, stale and already an
           * ancestor of base, while the real work sits on the branch that was
           * checked out afterwards. Asking the old name first would answer
           * "already merged — nothing new to ship" over unshipped commits.
           *
           * A directory that is gone (a retired or closed tab) cannot be asked,
           * so the recorded name is the fallback — the one case where the name
           * is the only thing there is.
           */
          // The session's PLACE — the directory it actually works in.
          const shipPlace = placeOf(job.sessionId);
          const wt = shipPlace === REPO_PLACE ? repoRoot : join(baseDir, 'sessions', shipPlace);
          let branch = `session/${job.sessionId}`;
          let detached = false;
          if (existsSync(wt)) {
            try {
              branch = git(['symbolic-ref', '--short', 'HEAD'], wt);
            } catch {
              detached = true;
            }
          }
          // THE ONE REFUSAL LEFT, and it is not policy. A detached HEAD names
          // no branch, so there is nothing to merge and nothing to record —
          // that is an ambiguity in git, not a rule of ours.
          if (detached) {
            await done({
              ok: false,
              error:
                'this session is on a detached HEAD — no branch to ship. Ask it to check out a branch, then ship again',
            });
            return;
          }
          let branchExists = true;
          try {
            git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], repoRoot);
          } catch {
            branchExists = false;
          }
          // "Nothing to ship" is a statement about the BRANCH. A retired
          // directory is not a missing session — retirement promises that
          // committed work survives, and ship re-attaches below to keep it.
          if (!existsSync(wt) && !branchExists) {
            await done({
              ok: false,
              error: 'nothing to ship — this session has no branch on this machine',
            });
            return;
          }
          try {
            gitNet(['fetch', 'origin', '--quiet'], 60_000);
          } catch {
            /* offline fetch — merge against what we have */
          }
          const ancestorOfBase = (ref) => {
            try {
              git(['merge-base', '--is-ancestor', ref, baseRef()], repoRoot);
              return true;
            } catch {
              return false;
            }
          };
          // The machine may have no git identity, and a merge COMMIT needs
          // one. Prefer the user's own config; fall back to the daemon's (the
          // same fallback ship's merge keeps) so a bare machine doesn't fail
          // the fold with "Please tell me who you are".
          let idEnv = null;
          try {
            git(['config', 'user.email'], repoRoot);
          } catch {
            idEnv = {
              GIT_AUTHOR_NAME: 'Flowviant',
              GIT_AUTHOR_EMAIL: 'daemon@flowviant.com',
              GIT_COMMITTER_NAME: 'Flowviant',
              GIT_COMMITTER_EMAIL: 'daemon@flowviant.com',
            };
          }
          const gitMerge = (args, cwd) =>
            execFileSync('git', args, {
              cwd,
              encoding: 'utf8',
              stdio: ['ignore', 'pipe', 'pipe'],
              ...(idEnv ? { env: { ...process.env, ...idEnv } } : {}),
            });
          // Receipts for a range: --no-merges, because fold commits describe
          // plumbing, not work.
          const logCommits = (range) =>
            git(['log', range, '--no-merges', '--format=%H%x09%s'], repoRoot)
              .split('\n')
              .filter(Boolean)
              .map((l) => {
                const [sha, ...rest] = l.split('\t');
                return { sha, subject: envScrub(rest.join('\t')).slice(0, 200) };
              });
          // Merge outward through a throwaway worktree so no checkout moves.
          // The throwaway dies on EVERY exit — success, conflict or throw —
          // or the next ship of this session trips over its corpse.
          // Carry the tip out onto base and push it. See `shipMerge.mjs` for
          // the throwaway-worktree shape, the one retry when two people ship at
          // once, and why the operator's own branch is fast-forwarded after.
          const mergeOutward = (tip, count) =>
            shipMergeOutward({
              tip,
              count,
              branch,
              label: job.sessionName || job.sessionId.slice(0, 8),
              git,
              gitMerge,
              repoRoot,
              tmpDir: join(baseDir, 'ship', job.sessionId),
              baseRef,
              workingTree: placeWtFor(shipPlace)?.wt ?? null,
              warn,
            });
          // Idempotency: base already contains the branch tip. A re-offered
          // job after a lost report lands here — never a re-merge, and never
          // "nothing to ship" AS A FAILURE for work that in fact shipped. The
          // receipts must not die with the lost report: the --no-ff merge
          // commit that carried the tip in holds it as its SECOND parent, so
          // the original commit list is recoverable — settling with none
          // would silently skip the reconciliation backstop for this branch.
          if (branchExists && ancestorOfBase(branch)) {
            const tip = git(['rev-parse', branch], repoRoot);
            let commits = [];
            try {
              const m = git(['log', baseRef(), '--merges', '--format=%H %P', '-n', '500'], repoRoot)
                .split('\n')
                .map((l) => l.trim().split(' '))
                .find((p) => p.length >= 3 && p[2] === tip);
              if (m) commits = logCommits(`${m[1]}..${tip}`);
            } catch {
              /* recovery is best-effort — an ok ship with no receipts beats a false failure */
            }
            await done({
              ok: true,
              commits,
              note: `${baseBranchName(baseRef())} already contains this session's branch — nothing new to merge`,
            });
            ok(`${c.cyan('ship')} ${c.dim('— already on main; nothing new to merge')}`);
            return;
          }
          const ended = liveIds ? !liveIds.has(job.sessionId) : false;
          if (ended) {
            // The tab is closed: no turn can commit, discard, or resolve
            // anything in the directory, so a dirty worktree must not strand
            // the branch's committed work in review forever. Ship the TIP.
            if (!branchExists) {
              await done({
                ok: false,
                error: 'nothing to ship — this session has no branch on this machine',
              });
              return;
            }
            const tip = git(['rev-parse', branch], repoRoot);
            const commits = logCommits(`${baseRef()}..${tip}`);
            if (commits.length === 0) {
              await done({
                ok: false,
                error: 'nothing to ship — no commits on the session branch',
              });
              return;
            }
            try {
              mergeOutward(tip, commits.length);
            } catch (e) {
              const detail = `${e?.stdout ?? ''}\n${e?.stderr ?? ''}\n${e?.message ?? ''}`;
              if (/conflict/i.test(detail)) {
                await done({
                  ok: false,
                  error:
                    'conflicts with main — the tab is closed, so open a new session from this branch to resolve them, then ship again',
                });
              } else {
                const line = envScrub(
                  String(detail)
                    .split('\n')
                    .find((l) => l.trim()) ?? 'git merge failed'
                );
                await done({ ok: false, error: `the merge failed: ${line.slice(0, 300)}` });
              }
              return;
            }
            await done({ ok: true, commits });
            ok(`${c.cyan('ship')} ${c.dim(`— ${commits.length} commit${commits.length === 1 ? '' : 's'} on main`)}`);
            return;
          }
          const dir = placeWtFor(shipPlace);
          if (!dir) {
            await done({
              ok: false,
              error: 'the session worktree could not be opened on this machine',
            });
            return;
          }
          // A live CLI is in this worktree — a restarted daemon's orphan
          // mid-turn (in-process the chain serializes, but the lock is the
          // only guarantee that survives a crash). Folding under it would
          // rewrite HEAD inside a held conversation; defer like the turn
          // path, and the job re-offers next poll.
          if (turnLockedByLivePid(sessionMetaPath(dir.wt, 'flowviant-turn.lock'))) {
            warn(
              `a turn is still running in "${job.sessionName || job.sessionId}" — ship waits for it`
            );
            deferred = true;
            return;
          }
          if (git(['status', '--porcelain'], dir.wt) !== '') {
            await done({
              ok: false,
              error:
                'the session has uncommitted changes — ask it to commit or discard them first',
            });
            return;
          }
          // NO "return to your session branch" GUARD. `branch` was read from
          // this worktree's HEAD above, so the fold, the tip and the receipts
          // below all name the same thing by construction — which is what the
          // old guard was really protecting, and it protected it by refusing
          // instead of by measuring.
          // Fold main into the branch FIRST: conflicts land here, in the
          // session's own worktree, where the next turn can resolve them.
          try {
            gitMerge(['merge', '--no-edit', baseRef()], dir.wt);
          } catch (e) {
            const detail = `${e?.stdout ?? ''}\n${e?.stderr ?? ''}\n${e?.message ?? ''}`;
            // NEVER leave the session mid-merge: a MERGE_HEAD left behind puts
            // every later turn inside someone else's half-finished merge.
            try {
              git(['merge', '--abort'], dir.wt);
            } catch {
              /* nothing in progress */
            }
            if (/conflict/i.test(detail)) {
              await done({
                ok: false,
                error: 'conflicts with main — ask the session to resolve them, then ship again',
              });
            } else {
              // An honest error beats a fabricated conflict — the human can
              // only fix what they are told about.
              const line = envScrub(
                String(detail)
                  .split('\n')
                  .find((l) => l.trim()) ?? 'git merge failed'
              );
              await done({ ok: false, error: `the merge failed: ${line.slice(0, 300)}` });
            }
            return;
          }
          // Resolve the EXACT sha to merge, then compute the receipts from it:
          // one X for both, so the ledger can never carry receipts for commits
          // that did not land.
          const tip = git(['rev-parse', branch], repoRoot);
          const commits = logCommits(`${baseRef()}..${tip}`);
          if (commits.length === 0) {
            // Post-fold this is nearly unreachable (a zero-commit branch is an
            // ancestor of base, settled above) — but if the branch's commits
            // all exist on main already, say so truthfully.
            if (ancestorOfBase(tip)) {
              await done({ ok: true, commits: [], note: 'already merged — nothing new to ship' });
            } else {
              await done({
                ok: false,
                error: 'nothing to ship — no commits on the session branch',
              });
            }
            return;
          }
          mergeOutward(tip, commits.length);
          await done({ ok: true, commits });
          ok(`${c.cyan('ship')} ${c.dim(`— ${commits.length} commit${commits.length === 1 ? '' : 's'} on main`)}`);
        } catch (e) {
          warn(`ship failed: ${e?.message ?? e}`);
          await done({
            ok: false,
            error: envScrub(String(e?.message ?? 'the merge failed')).slice(0, 500),
          });
        } finally {
          if (!settled && !deferred) {
            // Belt over braces: NO exit path may leave the ship unreported —
            // a deferral is the one deliberate exception, re-offered next poll.
            await done({ ok: false, error: 'the ship did not complete — check the daemon log' });
          }
          shipping.delete(job.sessionId);
        }
      });
    }
  };

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
  // ── AGENT PLAN JOBS: the Deploy press ──────────────────────────────────────
  //
  // Somebody selected cards and pressed Deploy. This turn works out HOW THE
  // WORK SHOULD BE SPLIT across agents and stops — a person edits what it
  // proposes on the board, and ACCEPTING is what spawns anything. Nothing here
  // creates a worktree, a branch or a card.
  //
  // READ-ONLY IN THE CHECKOUT. `readOnly: true` selects CONSULT_PERM (Read,
  // Grep, Glob and a few `git` reads — no Write, no Edit, no mkdir, no rm) and
  // NO MCP is passed at all, so this turn has no control plane to reach even if
  // the repository it reads tries to steer it. The proposal comes back as the
  // turn's final message rather than through a tool, which is exactly what lets
  // that permission set be this narrow.
  //
  // It takes the checkout's place lock as a READER, beside the operator's own
  // tabs. It writes nothing, so a writer lock would only starve real work.
  const planning = new Set(); // press ids in flight on this tick

  const postAgentPlan = async (body) => {
    try {
      await fetch(AGENT_PLAN_DONE_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${FLEET_TOKEN}`,
          'User-Agent': USER_AGENT,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(30_000),
        body: JSON.stringify({ ...body, instance: DAEMON_INSTANCE }),
      });
    } catch {
      /* unsettled, and the server expires it — the asker is told, never spun */
    }
  };

  /**
   * WHAT THE PLANNER IS DOING, RELAYED — the agent turn's narration channel,
   * on a PRESS instead of an agent.
   *
   * This turn was already streaming and the daemon was already reading it:
   * `streamJson` humanizes every read, grep, command and thought and prints
   * it behind `[plan]` on the operator's terminal. Every one of those lines
   * was then thrown away, so a Deploy press said "planning" on the board and
   * nothing else for as long as it took — which on an overnight queue is the
   * whole night. Forwarding the CLI's own tail costs nothing that is not
   * already being computed.
   *
   * IT IS THE CLI'S WORDS, OR THE MACHINE'S — never a stage, a percentage or
   * an estimate of how far along a model is. Flowviant relays.
   *
   * SCRUBBED AND CAPPED HERE rather than at each call site, so a phase marker
   * added later cannot skip either. Fire-and-forget with every failure
   * swallowed: narration is a readout, and it must never fail or delay the
   * turn it describes. A daemon that never calls this is a machine that has
   * not narrated, which is the only thing an absent line can mean.
   */
  const postAgentPlanActivity = async (planId, line) => {
    const text = envScrub(String(line ?? '')).slice(0, 400);
    if (!text) return;
    try {
      await fetch(AGENT_PLAN_ACTIVITY_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${FLEET_TOKEN}`,
          'User-Agent': USER_AGENT,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(15_000),
        body: JSON.stringify({ planId, line: text }),
      });
    } catch {
      /* a readout — losing a line costs nothing */
    }
  };

  /**
   * A WEDGED PLANNING CLI IS STOPPED AT FIFTEEN MINUTES.
   *
   * `runTurn` has no timer of its own. A CLI that hangs — a login prompt
   * nobody is there to answer, a model client stalled on a socket — therefore
   * runs until something else kills it, holding `planning`, which is what
   * blocks every auto-update on this machine, and spending whatever the
   * operator's account is charged for a live session.
   *
   * FIFTEEN because the server fails a claimed press at THIRTY (its
   * `PLAN_JOB_TTL_MS`, measured from `claimedAt`): half of that leaves this
   * side — the only side that knows the CLI is still running — time to stop it
   * and have its settle land, instead of the press expiring into a sentence
   * that blames a machine which never spoke. Nothing legitimate is cut off
   * either way: this turn reads a card selection and writes nothing, and the
   * shape of it is minutes.
   */
  const PLAN_TURN_TIMEOUT_MS = 15 * 60_000;

  const claimAgentPlan = async (id) => {
    try {
      const res = await fetch(AGENT_PLAN_CLAIM_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${FLEET_TOKEN}`,
          'User-Agent': USER_AGENT,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(15_000),
        body: JSON.stringify({ id, instance: DAEMON_INSTANCE }),
      });
      const j = await res.json().catch(() => null);
      return j?.data?.claimed === true;
    } catch {
      return false; // the peer may hold it; doing nothing is the safe answer
    }
  };

  /**
   * What a live agent has already TOUCHED, measured here rather than sent.
   *
   * The server could have shipped a copy of this, and deliberately does not:
   * these are directories on THIS machine, and a server-side copy would be a
   * second, staler source of truth for a fact the daemon is standing on top of.
   *
   * Uncommitted work AND commits against base, because a planner asking "will
   * these collide" cares about both — a file this agent has already rewritten
   * and merged into its own branch collides exactly as hard as one it is
   * editing now.
   */
  const agentChangedFiles = (placeId) => {
    if (!placeId || !isSafePathSegment(placeId)) return [];
    const wt = join(baseDir, 'sessions', placeId);
    if (!existsSync(wt)) return [];
    const out = new Set();
    for (const args of [
      ['diff', '--name-only', 'HEAD'],
      ['diff', '--name-only', `${baseRef()}...HEAD`],
      ['ls-files', '--others', '--exclude-standard'],
    ]) {
      /**
       * `git()` THROWS; it does not return a non-string.
       *
       * The guard below was `if (typeof r !== 'string') continue`, which is a
       * value `execFileSync` can never produce — so every one of these calls
       * was effectively unguarded. And this runs over the LIVE AGENTS a plan
       * job carries, which include agents still in `planning`: they have no
       * worktree yet, so `git diff` in a directory that does not exist exits
       * non-zero and throws straight out of `runAgentPlan` — after the press
       * has been claimed and before the try/finally below. The press then sat
       * `planning` until its expiry, having spent nothing and explained
       * nothing, on what would be an ordinary second Deploy.
       *
       * An agent whose files cannot be read contributes none. That is the
       * honest answer and it is what the planner should be told.
       */
      let r;
      try {
        r = git(args, wt);
      } catch {
        continue;
      }
      if (typeof r !== 'string') continue;
      for (const line of r.split('\n')) {
        const f = line.trim();
        if (f) out.add(f);
        if (out.size >= 60) return [...out];
      }
    }
    return [...out];
  };

  /** See `runAgentTurn` — the admission reservation, released the moment the
   *  planner's CLI exists. */
  const runAgentPlan = async (job, releaseSlot = () => {}) => {
    const id = String(job.id);
    const tasks = Array.isArray(job.tasks) ? job.tasks : [];
    // CLAIM BEFORE ANYTHING — including before the cheap refusal below.
    //
    // The settle is rejected unless the caller HOLDS the lease, so posting an
    // error first meant the server discarded it and the press sat open forever,
    // holding its cards out of Deploy. That is the opposite of the ordering a
    // kill keeps (refuse cheaply, then claim) and it is because these two
    // lanes settle differently: a kill's settle does not check a lease for the
    // not-found case, and a plan's always does.
    if (!(await claimAgentPlan(id))) return;
    if (tasks.length === 0) {
      // The press named cards the doc no longer has. A real answer, and one the
      // board can explain, rather than a turn that plans nothing.
      await postAgentPlan({ id, error: 'those cards are no longer on the board' });
      return;
    }

    /**
     * WHICH CLI PLANS. `pickRuntimeFor('consult')`, the same picker every other
     * turn nobody @mentioned already uses — Claude when it is here (the prompts
     * were written against it), otherwise whatever can express the profile.
     *
     * Deliberately NOT the project's runtime order: that order is about AGENTS,
     * which hold a conversation across many turns and whose value is that held
     * context. A planner runs once and reads; it takes what the machine has.
     */
    const rt = pickRuntimeFor('consult');
    if (!rt) {
      await postAgentPlan({ id, error: 'no CLI on this machine can run a read-only turn' });
      return;
    }

    /**
     * ONE LINE AT A TIME, AT MOST ONE EVERY TWO SECONDS — the throttle the
     * agent turn's narration keeps, for the same reason: a turn emits hundreds
     * of lines and only the latest is ever rendered. Held per RUN rather than
     * in a map keyed by press, because one press is one turn and there is
     * nothing for the clock to outlive.
     */
    let lastPlanBeat = 0;
    const narrate = (line) => {
      const now = Date.now();
      if (now - lastPlanBeat < 2_000) return;
      lastPlanBeat = now;
      void postAgentPlanActivity(id, line);
    };
    /**
     * THE MACHINE'S OWN VOICE, for the moments only this side can see — the
     * CLI process actually starting, and this press waiting its turn for the
     * checkout. Both are FACTS measured here, not a reading of the model's
     * progress, and both are invisible from a browser: a press held behind a
     * ship's writer lock looks exactly like a press whose CLI is thinking.
     *
     * Never dropped by the throttle above — these are moments, not a stream —
     * and they stamp its clock so the next model line does not overwrite one
     * the instant it lands.
     */
    const say = (line) => {
      lastPlanBeat = Date.now();
      void postAgentPlanActivity(id, line);
    };
    const liveAgents = (Array.isArray(job.liveAgents) ? job.liveAgents : []).map((a) => ({
      id: String(a?.id ?? ''),
      name: String(a?.name ?? ''),
      status: String(a?.status ?? ''),
      // Belt: `agentChangedFiles` is defensive internally, but it resolves a
      // place first and this whole block sits outside the try below.
      changedFiles: (() => {
        try {
          return agentChangedFiles(a?.placeId);
        } catch {
          return [];
        }
      })(),
    }));

    let out = '';
    /** REMOVED IN A `finally`. `workChildren` is what `workBusy()` counts, and
     *  a leaked entry keeps the daemon permanently "busy" — which blocks every
     *  auto-update from that moment on, silently, until a restart. */
    let planChild = null;
    let planTimer = null;
    /**
     * THE PLANNER'S OWN CONVERSATION, so its transcript can be removed.
     *
     * `claude -p` in the CHECKOUT writes `~/.claude/projects/<checkout>/<id>.jsonl`,
     * and the checkout is exactly where the operator runs their own terminal
     * Claude. Left behind, every Deploy press became the newest ENDED session
     * there: it displaced the operator's real conversation from the `+` adopt
     * menu (one row per directory), offered to fork a read-only planner into a
     * build tab, and was what their own `claude --continue` resumed. The
     * pre-review and the skills probe delete theirs for the same reason.
     */
    let planSession = null;
    /** The cap fired: the CLI was still running when this machine stopped it. */
    let wedged = false;
    // Said BEFORE the lock is asked for, because a reader only waits when a
    // writer holds the checkout or is queued ahead of it — which is exactly
    // this condition, read one line before we join the queue.
    const busy = placeLocks.get(REPO_PLACE);
    if (busy && (busy.writing || busy.waiters.some((w) => w.write)))
      say('waiting for the checkout — a ship or another turn on this machine is holding it');
    try {
      await inPlace(REPO_PLACE, false, async () => {
        /**
         * THE CAP RESOLVES THE WAIT ITSELF rather than waiting for `close`
         * after the kill — the shape the project check's timeout already
         * keeps. A SIGKILLed process whose stdio a grandchild still holds can
         * be slow to emit `close`, or never emit it, and this promise is what
         * holds the claimed press open.
         */
        let stopWaiting = () => {};
        const capped = new Promise((r) => {
          stopWaiting = r;
        });
        const turn = runTurn({
          prompt: AGENT_PLAN_KICKOFF({
            tasks,
            liveAgents,
            agentCap: Number.isInteger(job.agentCap) && job.agentCap > 0 ? job.agentCap : 3,
          }),
          system: SYSTEM_PLAN,
          // READ-ONLY, and no MCP: `mcpArgs` is omitted entirely rather than
          // passed empty, so there is no control plane on this turn at all.
          readOnly: true,
          cwd: repoRoot,
          runtime: rt,
          streamJson: true,
          answerFromResult: true,
          label: c.cyan('[plan]'),
          // The CLI's own tail, forwarded to the press. Same rule as an agent
          // turn's: throttled, overwritten rather than appended, and never
          // awaited by the turn.
          onActivity: (a) => {
            if (a?.label) narrate(String(a.label));
          },
          onInit: (i) => {
            if (typeof i.sessionId === 'string' && i.sessionId.trim())
              planSession = i.sessionId.trim();
          },
          onSpawn: (ch) => {
            planChild = ch;
            // No id: a Deploy press is not a task, and the snapshot's per-task
            // rows must not invent one. It still COUNTS against the machine's
            // ceiling — see liveTurnCount.
            workChildren.set(ch, null);
            releaseSlot();
            say(`${RUNTIMES[rt]?.label ?? rt} started on this machine`);
            /**
             * ARMED AT THE SPAWN, not at the claim: time spent waiting for the
             * checkout is not a wedged CLI, and a press that never got to run
             * is what the server's own clock is for.
             *
             * The CHILD, never its group — the rule teardown keeps. A
             * read-only planning turn starts no dev server, so there is
             * nothing behind it worth signalling and everything to lose by
             * signalling somebody else's.
             */
            planTimer = setTimeout(() => {
              wedged = true;
              try {
                ch.kill('SIGKILL');
              } catch {
                /* already gone */
              }
              stopWaiting('');
            }, PLAN_TURN_TIMEOUT_MS);
            planTimer.unref?.();
          },
        });
        out = await Promise.race([turn, capped]);
      });
    } catch (e) {
      await postAgentPlan({ id, error: envScrub(String(e?.message || e)).slice(0, 500) });
      return;
    } finally {
      if (planTimer) clearTimeout(planTimer);
      if (planChild) workChildren.delete(planChild);
      // On EVERY exit, after the kill and on a delay — the transcript is the
      // child's file, and removing it while the child is still dying races a
      // recreate. The pre-review's own shape.
      if (planSession) setTimeout(() => removeProbeTranscript(repoRoot, planSession), 750).unref?.();
    }

    if (wedged) {
      // NEVER LEAVE A CLAIMED PRESS UNREPORTED — the belt the merge lane wears
      // beneath this one. The machine's own words, because the machine is the
      // only side that knows: the server would have expired this press in
      // another fifteen minutes with a sentence blaming a daemon that had in
      // fact answered.
      await postAgentPlan({
        id,
        error: 'the planning turn ran past fifteen minutes on this machine and was stopped',
      });
      return;
    }

    const proposal = parseProposal(out);
    if (!proposal) {
      await postAgentPlan({
        id,
        // The CLI's own words when it has any — a turn that explained why it
        // could not plan is far more use than "planning failed".
        error: out.trim()
          ? `the plan did not come back as JSON: ${envScrub(out).slice(0, 300)}`
          : 'the planning turn produced no output — the CLI may be signed out',
      });
      return;
    }
    await postAgentPlan({ id, proposal, sessionRef: repoRoot });
  };

  const processAgentPlanJobs = (jobs) => {
    if (!Array.isArray(jobs) || jobs.length === 0) return;
    // ONE AT A TIME, and the cap is 1 rather than 5: a planning turn is a real
    // model call, and a machine handed three at once would run three CLIs to
    // answer questions nobody asked in that order.
    for (const job of jobs.slice(0, 1)) {
      const id = String(job?.id || '');
      if (!id || planning.has(id)) continue;
      /**
       * BEFORE THE CLAIM, and that ordering is the whole point: `runAgentPlan`
       * claims the press as its first act, and a claimed press must be settled
       * or it sits open holding its cards out of Deploy. NOT claiming is how
       * this lane declines — the press stays queued, the server offers it
       * again next poll, and nobody is told their Deploy failed.
       */
      const hold = admit('churn');
      if (hold) {
        note(`${c.cyan('plan')} ${c.dim(`— holding off: ${hold.reason}`)}`);
        continue;
      }
      // One press a tick, so this lane cannot burst on its own — but the slot
      // it is about to take has to be visible to the agent-turn lane that runs
      // moments later in the same reconcile. See admission.mjs.
      const releaseSlot = admit.reserve();
      planning.add(id);
      void runAgentPlan(job, releaseSlot).finally(() => {
        releaseSlot();
        planning.delete(id);
      });
    }
  };

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

  /**
   * DID THE ACCOUNT HIT A LIMIT?
   *
   * Deliberately a LITERAL MATCH on the few sentences the CLIs actually print,
   * and the matched line is relayed VERBATIM. It is a trigger, not a
   * classifier: nothing here decides what an error "means" or writes a sentence
   * of its own, because the product's own rule is that it relays and never
   * infers. The honest limit is that a phrasing nobody listed reads as an
   * ordinary failed turn — which lands the agent in Stuck with the CLI's words
   * attached, and is a perfectly survivable second-best.
   */
  const LIMIT_PHRASES = [
    /usage limit reached/i,
    /rate limit/i,
    /you've reached your .* limit/i,
    /quota exceeded/i,
    /insufficient_quota/i,
  ];
  const limitLine = (text) => {
    for (const line of String(text ?? '').split('\n')) {
      const t = line.trim();
      if (t && LIMIT_PHRASES.some((re) => re.test(t))) return envScrub(t).slice(0, 300);
    }
    return null;
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
       * Deferring costs the job nothing: it is unleased, the server re-offers
       * it on the next poll, and no attempt is consumed. Settling it would be
       * the opposite — it would send the agent to Stuck over a turn this
       * machine never ran.
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

  // ── THE PROJECT'S OWN CHECK, and the MERGE ─────────────────────────────────
  //
  // The check runs in the agent's own worktree the moment its queue empties, so
  // a reviewer knows before they start reading whether they are reviewing
  // working code. It LABELS the review row; it never blocks it.
  //
  // IT IS THE REPO'S COMMAND, DECLARED IN THE REPO. `.flowviant/check.json`,
  // beside `deploy.json`, because a check travels with the code and changes
  // with it — a setting in the app would go stale the first time somebody
  // renamed a script. An absent file is a MEASURED answer ('none'), not a nag:
  // plenty of projects have no single command that means "is this alright".
  //
  // It runs through a shell, and that is no wider than what already happens in
  // that directory: every turn in this worktree spawns a CLI with build
  // permissions, so a repository that can run arbitrary code during a turn can
  // run it here too. What this is NOT is the deleted dev-run supervisor —
  // nothing here resolves a command, guesses a stack, or starts a server.
  const CHECK_TIMEOUT_MS = 10 * 60_000;
  const CHECK_OUTPUT_CAP = 4000;

  const readCheckCommand = () => {
    try {
      const raw = readFileSync(join(repoRoot, '.flowviant', 'check.json'), 'utf8');
      const cfg = JSON.parse(raw);
      const cmd = typeof cfg?.command === 'string' ? cfg.command.trim() : '';
      return cmd ? cmd.slice(0, 500) : null;
    } catch {
      return null; // absent, unreadable or not JSON — all mean "no check"
    }
  };

  const postCheck = async (body) => {
    try {
      await fetch(AGENT_CHECK_DONE_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${FLEET_TOKEN}`,
          'User-Agent': USER_AGENT,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(30_000),
        body: JSON.stringify(body),
      });
    } catch {
      /* the row simply keeps its previous answer, which is null the first time */
    }
  };

  const runCheck = async (agentId, wt) => {
    const cmd = readCheckCommand();
    const headSha = (git(['rev-parse', 'HEAD'], wt) || '').trim() || undefined;
    if (!cmd) {
      await postCheck({ agentId, status: 'none', ...(headSha ? { headSha } : {}) });
      return;
    }
    const cleared = clearNonArtifacts(wt);
    if (cleared.length)
      warn(
        `agent ${agentId}: removed ${cleared.length} non-artifact file(s) from ${ARTIFACT_DIR} before the check — ${cleared.slice(0, 5).join(', ')}`
      );
    const out = await new Promise((resolve) => {
      let text = '';
      let done = false;
      const finish = (status) => {
        if (done) return;
        done = true;
        resolve({ status, text });
      };
      let child;
      try {
        // DETACHED, so the child's pid is its PROCESS GROUP. A check is almost
        // always a shell that spawns the real runner, and signalling the shell
        // alone leaves the runner holding the worktree — and this place's
        // WRITER lock — for as long as it likes.
        //
        // AND WITHOUT THE MACHINE CREDENTIAL. The check is the repo's command
        // run with nobody watching, and it inherited `FLOWVIANT_MACHINE_TOKEN`
        // — so anything the check executes (a test a turn wrote, a
        // dependency's postinstall) could read the credential the whole
        // machine authenticates with. It is `checkEnv()`, the environment the
        // agent's own turn ran under (`cliEnv`'s rule), NOT `childEnv`'s
        // allowlist: the agent runs these same tests in its turn, and a check
        // stripped of `JAVA_HOME`, `DATABASE_URL` or the rest of the operator's
        // shell would FAIL where the agent's own run passed — a "Check failed"
        // the product manufactured and then relayed as the project's verdict.
        // The planted-file path is closed by `clearNonArtifacts` above.
        child = spawn(cmd, {
          cwd: wt,
          shell: true,
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: checkEnv(),
        });
        /**
         * …AND IT IS TRACKED, so a stop or a takeover takes it with them.
         *
         * A check is a full test or build run in the agent's worktree, and it
         * was the one long-lived child the daemon spawned without telling its
         * own teardown about it. `shutdownWork` signalled the CLI children and
         * left this one — so restarting the daemon, or a same-repo takeover,
         * orphaned a running test suite inside a worktree the sweep may then
         * try to remove. The ten-minute timer would eventually kill it, but by
         * then it belongs to no daemon and nothing on any surface names it.
         *
         * Registered for a GROUP kill: with `shell: true` the child is
         * `/bin/sh`, and signalling it leaves the runner it started behind —
         * which is the process actually holding the worktree. See
         * `groupKillChildren` for why this one is exempt from the
         * never-signal-the-group rule.
         */
        workChildren.set(child, agentId);
        groupKillChildren.add(child);
      } catch (e) {
        // TEXT BEFORE FINISH: `finish` captures `text` by value into the
        // resolved object, so assigning afterwards threw the spawn error away
        // and the surface showed an empty failure.
        text = String(e?.message || e);
        finish('failed');
        return;
      }
      /**
       * The TAIL, not the head: a failing check says why at the end. And
       * SCRUBBED BEFORE IT IS CUT, which is the order that matters.
       *
       * It used to slice first: `text = (text + buf).slice(-CAP)`, with a
       * single `envScrub` at the very end. `envScrub` replaces EXACT full
       * values, so any credential straddling either boundary — the rolling
       * window's, or a chunk's — was already cut in half by the time it was
       * looked at, matched nothing, and the surviving tail was written to
       * `agent.checkOutput` and shown to every member of the project. A failing
       * integration test that dumps its environment is an ordinary way to reach
       * that, and the partial is enough where the prefix of the key is a
       * publicly known constant.
       *
       * Scrubbing on every chunk fixes both straddles at once: the accumulated
       * text always holds the previous kept tail plus the whole new chunk, so a
       * value split across chunks is whole here, and a value near the window
       * edge is redacted before anything is discarded. Bounded work — the
       * string is never longer than the cap plus one chunk.
       *
       * The one case it cannot cover is a secret LONGER than the cap itself,
       * which can never sit in the window whole. The final scrub below stays as
       * the second pass over what actually ships.
       */
      const keep = (buf) => {
        text = envScrub(text + buf.toString()).slice(-CHECK_OUTPUT_CAP);
      };
      child.stdout?.on('data', keep);
      child.stderr?.on('data', keep);
      const timer = setTimeout(() => {
        try {
          // The GROUP, not the child: killing the shell leaves whatever it
          // started running, which is the thing actually taking ten minutes.
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          try {
            child.kill('SIGKILL');
          } catch {
            /* already gone */
          }
        }
        text += '\n[flowviant] the check ran past ten minutes and was stopped';
        // RESOLVE HERE TOO. Waiting for 'close' after a kill is the shape that
        // hangs: if the group is already gone the event never arrives, and this
        // promise holds the place's writer lock forever.
        finish('failed');
      }, CHECK_TIMEOUT_MS);
      child.on('error', (e) => {
        clearTimeout(timer);
        workChildren.delete(child);
        text += String(e?.message || e);
        finish('failed');
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        workChildren.delete(child);
        finish(code === 0 ? 'passed' : 'failed');
      });
    });
    await postCheck({
      agentId,
      status: out.status,
      output: envScrub(out.text).slice(-CHECK_OUTPUT_CAP),
      ...(headSha ? { headSha } : {}),
    });
  };

  // ── THE AI PRE-REVIEW ──────────────────────────────────────────────────────
  //
  // A FRESH Claude reads the branch before the human does. The owner asked for
  // it in these words: "before having the user manually check, can we have the
  // daemon … spawn an agent to review the work so basically we get an ai to look
  // at the review before a human looks at it for a double check."
  //
  // IT IS NOT THE AGENT CHECKING ITSELF. `runTurn` is called with no `resume`,
  // so there is no conversation to inherit: an agent that spent four turns
  // arguing itself into a design defends that design, and asked whether its work
  // meets the card it answers from the very context that produced the work. The
  // reviewer stands IN the agent's worktree because it needs the code and the
  // diff, under `readOnly` (CONSULT_PERM — Read, Grep, Glob and a few git reads)
  // with NO MCP passed at all, so there is no control plane on this turn even if
  // the repository it reads tries to steer it.
  //
  // IT LABELS AND NEVER BLOCKS — the check's own law, one function up. Approve,
  // the per-card verdicts and the ship quiz do not know this exists. Every exit
  // below POSTS NOTHING, and the server renders an absent precheck as nothing:
  // a failed, timed-out, skipped or unparseable read leaves the human's review
  // exactly as it was before this feature existed. Ignorance never withholds.
  //
  // NO VERSION FLOOR. This is a daemon→server report on a NEW endpoint, so an
  // older daemon simply never posts, and an older SERVER 404s — which `postPre`
  // treats as delivered-and-done for the agent-trace reason stated there.
  //
  // IT RIDES THE BEAT THE CHECK ALREADY OWNS (`runReviewEntry`), AFTER it: the
  // check is a local command and this is a model call, so the cheap answer lands
  // on the row first and a wedged reviewer cannot delay it.
  /**
   * FIVE MINUTES, and `runTurn` has no timer of its own.
   *
   * Half the planner's cap, because this turn is strictly smaller — it reads one
   * branch's diff and answers, where a planner reads a repository to decide
   * whether a batch of work collides. And it is HELD INSIDE THE PLACE WRITER
   * LOCK by the beat it rides, so every minute here is a minute the agent's next
   * turn (or its merge) is waiting: a generous cap on a label would be spending
   * the work's time on a note about the work.
   */
  const PRECHECK_TIMEOUT_MS = 5 * 60_000;
  /** Commit subjects handed to the reviewer. A bound on the prompt, not on the
   *  branch — the reviewer reads the diff itself, and the log is context. */
  const PRECHECK_LOG_LINES = 80;

  /**
   * ONE PRE-REVIEW, POSTED.
   *
   * Resolves TRUE for a permanent refusal as well as a success, and that is
   * deliberate — the `postAgentTrace` rule, for the same reason: a server with
   * no such route 404s this body and will 404 every retry of it, so re-sending
   * would be a wedge wearing a retry's clothes. A NETWORK error resolves false
   * and is retried ONCE, because unlike a trace batch this body cost a whole
   * model call and losing it to a blip means the operator paid for a label
   * nobody ever sees.
   *
   * THE RETRY IS NOT A GUARANTEE THAT THE FIRST ATTEMPT FAILED, and since the
   * body started carrying `usage` (0.90.0) that matters. The `catch` below
   * takes the 30-second `AbortSignal` with everything else, so a server that
   * was merely SLOW — and committed — receives this identical body twice. The
   * store was always idempotent; the token counts riding it were not, and a
   * timed-out-but-committed post added them twice. The SERVER closes that: its
   * write refuses a body whose text already sits on the row, so a re-send
   * stores the same reading and charges nothing for it. Nothing here needs to
   * change, and nothing here may start assuming a thrown fetch means the
   * server never saw this.
   */
  const postPre = async (body) => {
    try {
      const res = await fetch(AGENT_PRECHECK_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${FLEET_TOKEN}`,
          'User-Agent': USER_AGENT,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(30_000),
        body: JSON.stringify(body),
      });
      return (
        res.ok ||
        (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429)
      );
    } catch {
      return false; // a blip — worth one more attempt at a model call's answer
    }
  };

  /**
   * THE BRANCH'S OWN COMMITS, subject + trailers, and the card ids they name.
   *
   * MEASURED, never asserted — the same reason `commitsBetween` exists. The
   * trailer ids are what let the prompt say "N earlier cards' specs are not on
   * this box" honestly: the difference between the cards this branch claims and
   * the specs this disk holds is a fact, and a box that adopted the agent
   * mid-run is exactly the case where it is non-zero.
   *
   * IT CANNOT THROW. `baseRef()` is free text an owner typed and may name no
   * ref at all; an unreadable range costs the reviewer its context, never the
   * review-entry beat it is standing in.
   */
  const branchLog = (wt) => {
    let out;
    try {
      out = git(['log', '--format=%s%n%b%n--', `${baseRef()}..HEAD`, '--not', baseRef()], wt);
    } catch {
      return { text: '', taskIds: [] };
    }
    if (typeof out !== 'string') return { text: '', taskIds: [] };
    const taskIds = new Set();
    for (const m of out.matchAll(/^\s*Flowviant-Task:\s*(\S+)\s*$/gm)) {
      taskIds.add(m[1].slice(0, 64));
    }
    const text = out
      .split('\n')
      .filter((l) => l.trim())
      .slice(0, PRECHECK_LOG_LINES)
      .join('\n');
    return { text, taskIds: [...taskIds] };
  };

  const runPrecheck = async (agentId, wt, agentName) => {
    /**
     * WHICH CLI READS. `pickRuntimeFor('consult')` — the same picker the scratch
     * planner uses, and for the same reason: this prompt was written against
     * Claude, and a machine with no read-only-capable runtime simply does not
     * produce a precheck. Nothing is posted and nothing is said on the row.
     */
    const rt = pickRuntimeFor('consult');
    if (!rt) return;
    /**
     * THE PRESSURE GUARD, at the spawn, exactly as every other unattended lane
     * asks it. `churn` and never `interactive`: nobody is watching this, and a
     * label is the first thing that should not be started on a box that is
     * struggling. Deferring here does NOT queue anything — there is no job and
     * no re-offer — so a precheck skipped under pressure is simply a precheck
     * that did not happen, which is what absence already means.
     */
    const hold = admit('churn');
    if (hold) {
      note(`${c.cyan('pre-review')} ${c.dim(`— skipped: ${hold.reason}`)}`);
      return;
    }
    const releaseSlot = admit.reserve();

    // THE HEAD THE READING BELONGS TO, taken BEFORE the turn — the
    // `checkFingerprint` shape, so a commit landing after this voids it rather
    // than letting an old reading label a branch it never saw. Optional: an
    // unreadable head costs the staleness comparison, not the precheck.
    let headSha = null;
    try {
      headSha = (git(['rev-parse', 'HEAD'], wt) || '').trim() || null;
    } catch {
      headSha = null;
    }

    const stash = readStash(sessionMetaPath(wt, 'flowviant-agent-cards', agentId));
    const log = branchLog(wt);
    /** Cards the BRANCH names that this box has no spec for. Measured, not
     *  guessed — see agentCards.mjs on why a stash is per-box. */
    const held = new Set(stash.map((s) => s.taskId));
    const missingSpecs = log.taskIds.filter((id) => !held.has(id)).length;

    let out = '';
    let child = null;
    let timer = null;
    /** The cap fired: the CLI was still running when this machine stopped it. */
    let wedged = false;
    /**
     * WHAT THE READING SPENT — the agent-turn lane's own relay, on the one
     * other lane that charges an AGENT (2026-09-19).
     *
     * It rides the agent and never a card link: a pre-review belongs to no card
     * (the same reason `workChildren` gets a null task id below), so the four
     * counters it adds to are the container's alone. That is also why an
     * agent's links can never sum to its total, and the schema says so.
     *
     * A WEDGED OR UNPARSEABLE READING POSTS NOTHING AT ALL, so it charges
     * nothing either — which under-reports a turn that really did spend. That
     * is the honest direction: there is no row to put it on, and inventing a
     * settle to carry a number would be a post whose only content is a bill.
     */
    let usage = null;
    /**
     * THE CONVERSATION THIS READING SPEAKS UNDER — held for exactly one reason:
     * to DELETE the transcript it leaves behind (review, 2026-09-17).
     *
     * This is the first thing in the daemon to run a second `claude -p` inside
     * an AGENT's worktree, and the agent's own resume is `--continue`, which is
     * CWD-KEYED — the invariant `runAgentTurn` states in words ("ONE AGENT IS
     * ONE DIRECTORY, so the CLI's own cwd-keyed resume is exactly right here").
     * Leaving this turn's `~/.claude/projects/<munged-cwd>/<id>.jsonl` in place
     * makes the read-only stranger the newest conversation in that directory,
     * so the agent's NEXT turn — a send-back's re-queued card, a merge-resolve,
     * a human's typed answer — resumes "you are a SECOND reviewer… YOU ARE
     * READ-ONLY" instead of its own four-turn context, under build permissions.
     * That is the 0.69.0 Workbench cross-resume and codex's `resume --last`,
     * arriving a third time by a third route.
     *
     * `removeProbeTranscript` is exported for precisely this and already serves
     * the skills probe and the dev-command resolver.
     */
    let preSession = null;
    try {
      /**
       * THE CAP RESOLVES THE WAIT ITSELF rather than waiting for `close` after
       * the kill — the shape the project check and the planner both keep. A
       * SIGKILLed process whose stdio a grandchild still holds can be slow to
       * emit `close`, or never emit it, and this promise is inside the place's
       * writer lock.
       */
      let stopWaiting = () => {};
      const capped = new Promise((r) => {
        stopWaiting = r;
      });
      const turn = runTurn({
        prompt: AGENT_PRECHECK_KICKOFF({
          agentName,
          cards: stash.map((s) => s.prompt).join('\n---\n'),
          missingSpecs,
          commits: log.text,
          diffCommand: `git diff ${baseRef()}...HEAD`,
        }),
        system: SYSTEM_PRECHECK,
        // READ-ONLY, and no MCP: `mcpArgs` is omitted entirely rather than
        // passed empty, so there is no control plane on this turn at all.
        readOnly: true,
        cwd: wt,
        runtime: rt,
        // NO `resume`, AND THAT IS THE FEATURE. A resumed turn would be the
        // agent grading its own homework out of its own context; this is a
        // stranger reading a diff.
        streamJson: true,
        answerFromResult: true,
        label: c.cyan('[pre-review]'),
        // The id the CLI reports at `system.init` — harvested off the stream
        // this turn already parses, no probe and no extra spawn. Held only so
        // the `finally` below can delete this turn's transcript; see
        // `preSession`.
        onInit: (i) => {
          if (typeof i.sessionId === 'string' && i.sessionId.trim())
            preSession = i.sessionId.trim();
        },
        // The CLI's own count for this reading. Set, never accumulated: one
        // turn is one `result` event, and the adding-up is the server's.
        onUsage: (u) => {
          usage = u;
        },
        onSpawn: (ch) => {
          child = ch;
          // No task id: a pre-review belongs to no card, and the machine
          // snapshot's per-task rows must not invent one. It still COUNTS
          // against the machine's ceiling — see liveTurnCount.
          workChildren.set(ch, null);
          releaseSlot();
          // ARMED AT THE SPAWN, not at entry: time spent getting here is not a
          // wedged CLI. The CHILD and never its group — a read-only turn starts
          // no server, so there is nothing behind it worth signalling and
          // everything to lose by signalling somebody else's.
          timer = setTimeout(() => {
            wedged = true;
            try {
              ch.kill('SIGKILL');
            } catch {
              /* already gone */
            }
            stopWaiting('');
          }, PRECHECK_TIMEOUT_MS);
          timer.unref?.();
        },
      });
      out = await Promise.race([turn, capped]);
    } catch {
      return; // a label may never fail the beat it rides
    } finally {
      if (timer) clearTimeout(timer);
      if (child) workChildren.delete(child);
      releaseSlot();
      /**
       * DELETE THIS READING'S TRANSCRIPT, on EVERY exit — settled, wedged and
       * killed, or thrown — because every one of them leaves the file behind
       * and the agent's `--continue` reads the newest one in the directory.
       *
       * AFTER the kill and ON A DELAY, the skills probe's own shape: the
       * transcript is the CHILD's file, so removing it while the child is still
       * dying races a recreate. Unref'd — it must not hold the process open.
       */
      if (preSession) setTimeout(() => removeProbeTranscript(wt, preSession), 750).unref?.();
    }

    // A WEDGED READING POSTS NOTHING. There is no row to settle and nobody
    // waiting on an answer, so the honest record is that no pre-review exists —
    // the same silence a machine that never ran one leaves.
    if (wedged) {
      note(`${c.cyan('pre-review')} ${c.dim('— ran past five minutes and was stopped')}`);
      return;
    }

    /**
     * SCRUBBED ON THE WAY OUT, every string — AND SCRUBBED BEFORE IT IS CUT,
     * which is the order that matters and the reason `envScrub` rides INTO the
     * parser rather than being applied to what comes back out.
     *
     * This turn read the repository with `cat` and `git show` in a worktree
     * holding the project's materialized dev secrets, and its answer is about to
     * be stored and rendered to every member of the project. `scrub` replaces
     * EXACT full values, so a note capped first and scrubbed second hands the
     * scrub a credential already cut in half: it matches nothing and the
     * surviving prefix ships. The check's output lane learned exactly that the
     * expensive way, and this lane relearned it in review (2026-09-17) — see
     * `parsePrecheck`, which now caps only what it has already redacted.
     */
    const result = parsePrecheck(out, envScrub);

    /**
     * A QUOTA LIMIT SKIPS THE PRE-REVIEW AND PARKS NOTHING — AND A LIMIT IS
     * ONLY A LIMIT WHEN THE READING PRODUCED NOTHING.
     *
     * `limitLine` is a literal phrase match over the CLI's whole output, and
     * under `answerFromResult` that output IS the reviewer's answer — so a
     * pre-review OF rate-limiting code, or any triage that quotes the phrase,
     * read as a quota failure and threw a perfectly good reading away. The
     * agent-turn lane fixed this exact false positive once (`const limit = res
     * ? null : limitLine(out)`); gating on "nothing parsed" is what makes the
     * match mean what it says.
     *
     * And when it IS a limit, nothing parks. `postAgentParked` stops EVERY
     * agent on the project, because the CLI login is shared — the right answer
     * when the thing that hit the limit was somebody's actual work, the wrong
     * one here: parking a whole fleet because a LABEL could not be written
     * would let an optional readout take the product's primary lane down. The
     * branch is still reviewable; it just has no note on it.
     */
    if (!result) {
      if (limitLine(out)) {
        note(`${c.cyan('pre-review')} ${c.dim('— skipped: the CLI reported a limit')}`);
      }
      // UNPARSEABLE POSTS NOTHING. A half-read triage is a plausible-looking
      // paragraph nobody wrote, rendered on the surface where somebody decides
      // whether a branch reaches main — see parsePrecheck.
      return;
    }

    const body = {
      agentId,
      ...(headSha ? { headSha } : {}),
      ...(usage ? { usage } : {}),
      cards: result.cards.map((cd) => ({
        taskId: cd.taskId,
        verdict: cd.verdict,
        ...(cd.note ? { note: cd.note } : {}),
      })),
      ...(result.overall ? { overall: result.overall } : {}),
    };
    // ONE RETRY, and only for a network error — see `postPre`. A permanent
    // refusal is an older server, and asking it again changes nothing.
    if (!(await postPre(body))) await postPre(body);
  };

  /**
   * REVIEW ENTRY — everything this machine does the moment an agent's queue
   * empties, in one place.
   *
   * It exists so the two readings cannot drift apart at the three call sites
   * that own this beat (the settle reply, the held body's re-POST, and the
   * stale-merge re-read after base is folded in). Each of those used to call
   * `runCheck` directly; a second thing to run at the same moment is a second
   * thing three call sites can forget.
   *
   * THE CHECK FIRST, ALWAYS. It is a local command whose answer the board wants
   * on the row immediately; the pre-review is a model call that may take
   * minutes. Ordering them the other way would put a label behind a label.
   *
   * NEITHER MAY THROW PAST THIS POINT. Both are optional readouts and both run
   * INSIDE the place's writer lock on a path whose callers settle real work —
   * `runAgentMerge` in particular reports a claimed merge after this returns.
   */
  const runReviewEntry = async (agentId, wt, agentName) => {
    try {
      await runCheck(agentId, wt);
    } catch {
      /* the row keeps its previous check answer, which is null the first time */
    }
    try {
      await runPrecheck(agentId, wt, agentName);
    } catch {
      /* no pre-review is posted, and absence renders nothing */
    }
  };

  // ── THE MERGE ──────────────────────────────────────────────────────────────
  //
  // LEASED, because two `git merge --no-ff` and two pushes over one branch is
  // the loudest duplicate this system can produce. It reuses `mergeOutward`
  // verbatim — the same throwaway-worktree merge, the same once-only retry when
  // two people land at the same moment — because an agent's branch is not
  // special: it is a branch, and this repo already knows how to land one.
  //
  // A SUCCESS CLOSES NOTHING. Done stays OBSERVED: the merge reaches base, the
  // landed observer's own fetch sees it, and the cards close there.
  const agentMerges = new Set(); // agent ids in flight on this tick

  const claimAgentMerge = async (agentId) => {
    try {
      const res = await fetch(AGENT_MERGE_CLAIM_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${FLEET_TOKEN}`,
          'User-Agent': USER_AGENT,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(15_000),
        body: JSON.stringify({ agentId, instance: DAEMON_INSTANCE }),
      });
      const j = await res.json().catch(() => null);
      return j?.data?.claimed === true;
    } catch {
      return false; // the peer may hold it; doing nothing is the safe answer
    }
  };

  const postAgentMerge = async (body) => {
    try {
      await fetch(AGENT_MERGE_DONE_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${FLEET_TOKEN}`,
          'User-Agent': USER_AGENT,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(30_000),
        body: JSON.stringify({ ...body, instance: DAEMON_INSTANCE }),
      });
    } catch {
      /* the lease lapses and the job is re-offered — a merge is idempotent
         against an already-merged branch, which mergeOutward detects */
    }
  };

  /**
   * A merge COMMIT needs a git identity and the machine may have none. Prefer
   * the operator's own config; fall back to the daemon's, the same fallback
   * ship's merge keeps, so a bare machine does not fail the fold with
   * "Please tell me who you are".
   */
  const gitMerge = (args, cwd) => {
    let idEnv = null;
    try {
      git(['config', 'user.email'], repoRoot);
    } catch {
      idEnv = {
        GIT_AUTHOR_NAME: 'Flowviant',
        GIT_AUTHOR_EMAIL: 'daemon@flowviant.com',
        GIT_COMMITTER_NAME: 'Flowviant',
        GIT_COMMITTER_EMAIL: 'daemon@flowviant.com',
      };
    }
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(idEnv ? { env: { ...process.env, ...idEnv } } : {}),
    });
  };

  const runAgentMerge = async (job) => {
    const agentId = String(job.agentId);
    const place = String(job.placeId || '');
    if (!isSafePathSegment(place)) {
      // Before the claim, and before `report` exists — this one is not covered
      // by the belt below because there is nothing yet to be un-reported.
      await postAgentMerge({ agentId, ok: false, detail: 'the agent has no worktree here' });
      return;
    }
    if (!(await claimAgentMerge(agentId))) return;

    /**
     * NO EXIT PATH MAY LEAVE A CLAIMED MERGE UNREPORTED — the same belt the
     * ship path carries, and this function did not.
     *
     * Every branch below reports, but an UNEXPECTED throw reports nothing:
     * several `git()` calls in here are bare, and `git()` is `execFileSync`,
     * which throws on any non-zero exit. The agent then sits in `merging`,
     * which refuses Stop and refuses an answer, until an expiry fires — with
     * nothing anywhere saying what went wrong.
     */
    let reported = false;
    /**
     * THE PUBLISHED REF DIES WHEN THE WORK LANDS (0.86.0) — recorded here,
     * retired in the tail below.
     *
     * A `flowviant/*` branch exists so the work survives the box that cut it.
     * Once the commits are on base that job is done, and one ref per agent
     * forever is a branch list nobody wants to read. The server sends the ref
     * only when it heard about a real push, so this never deletes a name we
     * merely composed — and `publishDeleteArgs` refuses anything outside the
     * prefix, because `:refs/heads/<x>` is the most destructive argv in this
     * file.
     *
     * ONLY ON SUCCESS. A failed merge keeps its branch — that is the whole
     * point of the branch — and stopping or declining an agent deletes nothing
     * anywhere: durability is what this feature is, and a ref whose work never
     * landed is the case it exists for. It is recorded in `report` rather than
     * at the three success sites so a fourth one cannot forget it.
     */
    let landedRef = null;
    const report = async (body) => {
      reported = true;
      if (body?.ok === true) landedRef = job.publishedRef ?? null;
      await postAgentMerge(body);
    };

    // A WRITER on the place, exactly as a ship is. It folds base in and pushes
    // with git in that directory, and no CLI can coordinate with something it
    // does not know exists.
    try {
      await inPlace(place, true, async () => {
      const wt = join(baseDir, 'sessions', place);
      if (!existsSync(wt)) {
        await report({ agentId, ok: false, detail: 'the worktree is gone' });
        return;
      }
      try {
        gitNet(['fetch', 'origin', '--quiet'], 60_000);
      } catch {
        /* offline — the merge fails honestly below */
      }
      // STALE means base moved under this branch while it sat in review. Fold
      // base IN first so the merge that follows is against what is actually
      // there; a conflict here is the same conflict the merge would hit, found
      // one step earlier and in the agent's own directory where it can be
      // resolved.
      if (job.stale) {
        try {
          gitMerge(['merge', '--no-edit', baseRef()], wt);
        } catch (e) {
          await report({
            agentId,
            ok: false,
            detail: envScrub(String(e?.message || e)).slice(0, 2000),
          });
          return;
        }
        // The branch changed, so the previous check — and the previous
        // pre-review — answered about a different tree. Re-read it before
        // anything merges: a failed merge sends the agent BACK to review, which
        // is a review-entry beat like any other, and a stale reading standing
        // over a rebased branch is exactly what `precheckSha` exists to void.
        await runReviewEntry(agentId, wt, job.agentName);
      }
      // `git()` THROWS on a non-zero exit, and `symbolic-ref` exits non-zero on
      // a detached HEAD — so the guard below was unreachable and the throw
      // escaped the claimed merge, leaving it unsettled until its lease lapsed.
      let branch = '';
      try {
        branch = (git(['symbolic-ref', '--quiet', '--short', 'HEAD'], wt) || '').trim();
      } catch {
        branch = '';
      }
      if (!branch) {
        // A detached HEAD names no branch, so there is nothing to merge and
        // nothing to record. An ambiguity in git, not a rule of ours.
        await report({ agentId, ok: false, detail: 'this worktree is on a detached HEAD' });
        return;
      }
      const tip = (git(['rev-parse', 'HEAD'], wt) || '').trim();
      const countOut = git(['rev-list', '--count', `${baseRef()}..HEAD`], wt);
      const count = Number((countOut || '0').trim()) || 0;
      if (count === 0) {
        // Already on base — an idempotent re-offer, or an agent that changed
        // nothing. Reported as a SUCCESS: the branch's work is on base, which
        // is what the caller is asking about.
        await report({ agentId, ok: true, sha: tip || undefined });
        return;
      }
      /**
       * THIS PROJECT MERGES THROUGH A PULL REQUEST.
       *
       * PR mode existed for sessions and was simply not honoured for agents:
       * nothing read the project's merge mode on this path and the direct
       * merge below ran unconditionally. On the repos PR mode exists FOR —
       * branch protection refuses a direct push of a merge commit — every
       * agent approval failed at the push and came back to review carrying
       * git's refusal, forever.
       *
       * PUSH, CREATE, MERGE, in that order, and each step's reasoning is the
       * session PR job's: push first because GitHub merges the REMOTE tip;
       * `--fill` titles from the branch's own commits so nothing is invented;
       * `--merge` and never squash, because the cards' receipts are commit
       * shas and a squash rewrites them off base, orphaning every receipt and
       * blinding the landed observer's trailer read. Adopt only an OPEN PR:
       * gh's branch finder falls back to the most recent merged one, and
       * adopting a dead PR would report success over work that never moves.
       */
      if (job.prMode) {
        try {
          // EVERY `gh` CALL IS TIMED OUT. `execFileSync` blocks the daemon's
          // whole event loop, and this one runs INSIDE the place writer lock —
          // so a `gh` that hangs (an expired token prompting, a network black
          // hole, a hung credential helper) stops every turn on the machine,
          // not merely this merge, and holds the lock while it does.
          execFileSync('gh', ['auth', 'status'], {
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: 20_000,
          });
        } catch (e) {
          await report({
            agentId,
            ok: false,
            detail:
              e?.code === 'ENOENT'
                ? 'this project merges through pull requests, and the GitHub CLI (gh) is not installed on this machine'
                : `this project merges through pull requests, and gh is not signed in here: ${ghFirstLine(e)}`,
          });
          return;
        }
        const prBase = baseBranchName(baseRef());
        if (branch === prBase) {
          await report({
            agentId,
            ok: false,
            detail: `this agent is on the base branch (${prBase}) — there is nothing to open a pull request from`,
          });
          return;
        }
        /**
         * THE PULL REQUEST'S HEAD IS THE PUBLISHED REF, when there is one
         * (0.86.0).
         *
         * Pushing `session/a-<uuid>` here and reviewing THAT would defeat the
         * whole feature on exactly the projects it is most for: the owner asked
         * for "control over what branch the agents are working on", and a PR
         * mode project is one where people read branches in a host UI. Worse, it
         * leaves TWO refs per agent — the uuid one nothing ever deletes, and the
         * readable one the cleanup below retires — so the survivor is the opaque
         * name this feature exists to replace.
         *
         * ONLY when the local branch really is this agent's own. If somebody
         * checked something else out in the worktree, `session/<place>` is not
         * what is being merged and pushing it under the published name would put
         * work on that ref that nobody approved; the plain push of the checked
         * out branch is the honest fallback.
         */
        const ownBranch = branch === `session/${place}`;
        const head =
          ownBranch && isPublishRef(job.publishedRef) ? job.publishedRef : branch;
        try {
          if (head === branch) {
            gitNetIn(['push', '-u', 'origin', branch], wt, 120_000);
          } else {
            // The same lease discipline the publish lane keeps, and TIMED like
            // every other network call on this path: `git()` has no timeout, and
            // this one runs inside the place writer lock.
            const seen = agentRemoteAt.get(place);
            gitNet(
              publishPushArgs(place, head, seen?.ref === head ? seen.sha : null),
              120_000
            );
            agentPublished.set(place, { ref: head, sha: tip });
            agentRemoteAt.set(place, { ref: head, sha: tip });
          }
        } catch (e) {
          // SCRUBBED. Every other failure on this path relays `gh`'s own words,
          // but a push writes the REMOTE URL to stderr and a remote can carry a
          // token in its userinfo — so this one line is the only place on the
          // agent merge path that can leak a credential into a stored,
          // team-visible `mergeError`.
          await report({ agentId, ok: false, detail: envScrub(ghFirstLine(e)) });
          return;
        }
        let prUrl = null;
        try {
          const j = JSON.parse(
            execFileSync('gh', ['pr', 'view', head, '--json', 'url,state,baseRefName'], {
              cwd: repoRoot,
              stdio: ['ignore', 'pipe', 'pipe'],
              timeout: 30_000,
            }).toString()
          );
          if (j?.state === 'OPEN' && typeof j?.url === 'string') {
            // Adoptable only when it points at the project's own base. A PR
            // somebody opened by hand against another branch would otherwise
            // be merged INTO that branch, and the ok settle would claim work
            // reached base that landed somewhere else entirely. Refused only
            // on a MEASURED mismatch — an absent field adopts as before.
            if (typeof j?.baseRefName === 'string' && j.baseRefName !== prBase) {
              await report({
                agentId,
                ok: false,
                detail: `the open pull request for ${head} targets ${j.baseRefName}, not ${prBase} — retarget or close it, then approve again`,
              });
              return;
            }
            prUrl = j.url.trim();
          }
        } catch {
          /* no PR for this branch at all — created below */
        }
        if (!prUrl) {
          try {
            const out = execFileSync(
              'gh',
              // baseBranchName, not baseRef: gh 422s on a remote-tracking name.
              ['pr', 'create', '--head', head, '--base', prBase, '--fill'],
              { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 }
            )
              .toString()
              .trim();
            prUrl = out.split('\n').filter(Boolean).pop() ?? null;
          } catch (e) {
            await report({ agentId, ok: false, detail: ghFirstLine(e) });
            return;
          }
        }
        try {
          execFileSync('gh', ['pr', 'merge', head, '--merge'], {
            cwd: repoRoot,
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: 120_000,
          });
        } catch (e) {
          const line = ghFirstLine(e);
          // Already merged is a SUCCESS: a re-offered job, or somebody merged
          // it in the browser. The observer closes the cards either way.
          if (!/already merged/i.test(line)) {
            await report({
              agentId,
              ok: false,
              detail:
                prUrl && PR_URL_RE.test(prUrl) ? `${line} — the pull request is at ${prUrl}` : line,
            });
            return;
          }
        }
        // VERIFY before reporting ok: modern gh exits 0 on an already-MERGED
        // PR, and on a repo with a merge queue or auto-merge it exits 0 after
        // ENQUEUEING — in both, "merged" is a claim about the future. The tip
        // being an ancestor of base is the fact `ok` asserts, and the server
        // closes every delivered card on this sha the moment it hears it — so
        // measure it, with one short retry for the fetch racing GitHub's
        // merge commit. The same guard the session PR path carries.
        const tipOnBase = () => {
          try {
            git(['merge-base', '--is-ancestor', tip, baseRef()], repoRoot);
            return true;
          } catch {
            return false;
          }
        };
        let landedOnBase = false;
        for (let attempt = 0; attempt < 2 && !landedOnBase; attempt++) {
          if (attempt > 0) await new Promise((r) => setTimeout(r, 2000));
          try {
            gitNet(['fetch', 'origin', '--quiet'], 60_000);
          } catch {
            /* offline — the check below answers from what we have */
          }
          landedOnBase = tipOnBase();
        }
        if (!landedOnBase) {
          await report({
            agentId,
            ok: false,
            detail:
              "GitHub accepted the merge, but this branch's tip is not on the base branch — a merge queue may still be running it, or the PR that merged was an older one. Approve again once it lands." +
              (prUrl && PR_URL_RE.test(prUrl) ? ` The pull request is at ${prUrl}.` : ''),
          });
          return;
        }
        // THE TIP, not the merge commit GitHub made: the tip identifies the
        // state we asked to be merged, which is what the receipt is for — the
        // cards themselves close when the landed observer sees the commits
        // arrive on base.
        await report({ agentId, ok: true, sha: tip });
        onRepoChanged();
        landed.observe();
        return;
      }
      try {
        shipMergeOutward({
          tip,
          count,
          branch,
          label: job.agentName || place.slice(0, 12),
          git,
          gitMerge,
          repoRoot,
          tmpDir: join(baseDir, 'ship', place),
          baseRef,
          workingTree: wt,
          warn,
        });
      } catch (e) {
        await report({
          agentId,
          ok: false,
          detail: envScrub(String(e?.message || e)).slice(0, 2000),
        });
        return;
      }
      await report({ agentId, ok: true, sha: tip });
      onRepoChanged();
      landed.observe();
      });
    } finally {
      if (!reported) {
        // Belt over braces. A merge this daemon claimed and cannot account for
        // is a FAILURE, said out loud, so the agent goes back to Review with a
        // reason instead of waiting out an expiry that blames nobody.
        await postAgentMerge({
          agentId,
          ok: false,
          detail: 'the merge did not complete — check the daemon log',
        }).catch(() => {});
      }
      /**
       * …AND THE RETIREMENT IS TAIL WORK, OUTSIDE THE PLACE LOCK — the same
       * placement the turn's publish argues for, for the same reason.
       *
       * `gitNet` is `execFileSync`: it blocks the whole event loop for up to its
       * timeout, and inside `inPlace(place, true, …)` it would hold this
       * agent's WRITER lock through a remote's bad day, with the merge already
       * settled and nothing left that the delay serves. This block is PAST the
       * lock: `inPlace` has returned (or thrown) before a `finally` runs.
       *
       * IN THE `finally` rather than after it, so a throw between the ok settle
       * and the end of the locked block cannot strand the ref. `landedRef` is
       * set only by a reported success, so there is nothing here to run on any
       * other path — and a remote that refuses the delete only warns: the merge
       * is the thing that matters, and a landed branch must not become a failed
       * approval.
       *
       * The record goes with the ref. `agentPublished` is what the SWEEP
       * republishes from, so leaving the entry behind would let the next sweep
       * push the ref straight back — an orphan no later merge job can ever
       * carry, and therefore one nothing can delete.
       */
      if (landedRef) {
        agentPublished.delete(place);
        agentRemoteAt.delete(place);
        const args = publishDeleteArgs(landedRef);
        if (args) {
          try {
            gitNet(args, 60_000);
          } catch (e) {
            warn(
              `agent ${agentId}: the published branch ${landedRef} could not be deleted — ${publishErrorText(envScrub(e?.stderr?.toString?.() || e?.message || ''))}`
            );
          }
        }
      }
    }
  };

  const processAgentMergeJobs = (jobs) => {
    if (!Array.isArray(jobs) || jobs.length === 0) return;
    for (const job of jobs.slice(0, 2)) {
      const id = String(job?.agentId || '');
      if (!id || agentMerges.has(id)) continue;
      agentMerges.add(id);
      void runAgentMerge(job).finally(() => agentMerges.delete(id));
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
