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
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import {
  FLEET_URL,
  FLEET_TOKEN,
  USER_AGENT,
  REFRESH_BEFORE_SECONDS,
  DAEMON_INSTANCE,
  MODEL,
} from './config.mjs';
import { git, gitRaw, splitNul, baseBranchName, isSafePathSegment } from './git.mjs';
import { createLandedObserver } from './landed.mjs';
import { listenersIn, measureListeners, listenersSupported } from './listeners.mjs';
import { measureProcesses, liveGroups, processesSupported } from './processes.mjs';
import { mutateRegistry, processAlive, readRegistry } from './procRegistry.mjs';
import { createPlaceLock } from './placeLock.mjs';
import { sweepMergedBranch } from './shipSweep.mjs';
import { mergeOutward as shipMergeOutward } from './shipMerge.mjs';
import { openTunnel } from './preview.mjs';
import { c, note, ok, warn } from './ui.mjs';
import { mcpFor, runTurn } from './claude.mjs';
import {
  SYSTEM_WORK,
  WORK_TURN_KICKOFF,
  SYSTEM_WORK_PLAIN,
  WORK_TURN_KICKOFF_PLAIN,
} from './prompts.mjs';
import { materializeInto, hasMaterialized, excludeInWorktree, scrub as envScrub } from './env.mjs';
import { detectRuntimes, canRun, recordSkills, toolEventOf, RUNTIMES } from './runtimes.mjs';

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
  // What arrived on base, whichever road it took — observed after every beat
  // that can move origin/<base>: the sweep's fetch, a ship's push, a PR merge
  // this daemon performed. See landed.mjs for the seeding and delivery rules.
  const landed = createLandedObserver({ repoRoot, baseRef });
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
  const GROUPS_DIR = join(homedir(), '.flowviant');
  const GROUPS_FILE = join(GROUPS_DIR, 'session-groups.json');
  const GROUPS_LOCK = join(GROUPS_DIR, 'session-groups.lock');

  const persistGroups = () => {
    const flat = [];
    for (const [sid, set] of sessionGroups)
      for (const pgid of set) flat.push({ sessionId: sid, pid: pgid, startedAt: Date.now() });
    try {
      mutateRegistry(GROUPS_DIR, GROUPS_FILE, GROUPS_LOCK, () => flat);
    } catch {
      /* best-effort: losing the file costs a restart's visibility, never a turn */
    }
  };

  try {
    for (const e of readRegistry(GROUPS_FILE)) {
      if (!e?.sessionId || !Number.isInteger(e?.pid)) continue;
      const set = sessionGroups.get(e.sessionId) ?? new Set();
      set.add(e.pid);
      sessionGroups.set(e.sessionId, set);
    }
  } catch {
    /* no registry yet — the ordinary first run */
  }

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
    if (!known || known.size === 0) return [];
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
      // already reject an unsafe segment; doing it here covers every consumer
      // (the preview-claim `placeDir` did not re-check). REPO_PLACE resolves to
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

  let lastWorktreeSweep = 0;
  /** Sessions this process has already tried to measure. See `reportWorktrees`. */
  const worktreeSeen = new Set();
  let lastWorktreeFetch = 0;
  let sweepingWorktrees = false;
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
    return {
      sessionId,
      ...d,
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
            git(['fetch', 'origin', '--quiet'], repoRoot);
          } catch {
            /* offline, or no remote — the numbers just age */
          }
          // The fetch may have moved the base tip — walk and report what
          // landed. Best-effort like everything in this sweep.
          void landed.observe().catch(() => {});
        }
        const reports = [];
        for (const id of activeIds.slice(0, 20)) {
          const r = sessionWorktreeReport(id);
          if (r) reports.push(r);
        }
        await postWorktrees(reports);
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
    if (!(await claimKill(id))) return;
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
      execFileSync('gh', ['auth', 'status'], { stdio: ['ignore', 'pipe', 'pipe'] });
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
    if (job.kind !== 'merge') {
      // OPEN: push, then create — or adopt a PR already open for the branch
      // (a re-delivery, or one the driver opened by hand).
      try {
        git(['push', '-u', 'origin', branch], existsSync(wt) ? wt : repoRoot);
      } catch (e) {
        await settlePr({ id, outcome: 'failed', detail: ghFirstLine(e) });
        return;
      }
      let url = null;
      try {
        url = execFileSync('gh', ['pr', 'view', branch, '--json', 'url', '--jq', '.url'], {
          cwd: repoRoot,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
          .toString()
          .trim();
      } catch {
        /* no PR open for the branch — create one */
      }
      if (!url) {
        try {
          const out = execFileSync(
            'gh',
            // `--fill` titles the PR from the branch's own commits — no model
            // call, nothing invented. baseBranchName, not baseRef: gh 422s on
            // a remote-tracking name like origin/main.
            ['pr', 'create', '--head', branch, '--base', baseBranchName(baseRef()), '--fill'],
            { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] }
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
    // MERGE: a MERGE COMMIT, never squash and never rebase — the cards'
    // receipts are commit shas, and a squash rewrites them off base, which
    // would orphan every receipt AND blind the landed walk's trailer read.
    // No --delete-branch: the local branch may be a live worktree's HEAD.
    try {
      execFileSync('gh', ['pr', 'merge', branch, '--merge'], {
        cwd: repoRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      const line = ghFirstLine(e);
      if (!/already merged/i.test(line)) {
        await settlePr({ id, outcome: 'failed', detail: line });
        return;
      }
    }
    await settlePr({ id, outcome: 'merged' });
    // The merge moved base on GitHub. Fetch and observe NOW, so the cards
    // close on this beat rather than the next 3-minute sweep — the same
    // re-measure-after-an-action rule the kill and ship paths keep.
    try {
      git(['fetch', 'origin', '--quiet'], repoRoot);
    } catch {
      /* offline — the sweep's next fetch carries it */
    }
    void landed.observe().catch(() => {});
    onRepoChanged();
  };
  const processPrJobs = (jobs) => {
    if (!Array.isArray(jobs) || jobs.length === 0) return;
    for (const job of jobs.slice(0, 5)) {
      const id = String(job?.id || '');
      if (!id || prWorking.has(id)) continue;
      if (!isSafePathSegment(String(job?.sessionId || ''))) continue;
      prWorking.add(id);
      void runPrJob(job)
        .catch(() => {})
        .finally(() => prWorking.delete(id));
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
    // mechanism as the materialized env files — the exclude file git actually
    // reads (env.mjs), which already skips lines it has written before, so
    // calling it per fetch is idempotent.
    excludeInWorktree(wt, ['.flowviant/']);
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
      // Synced env into the fresh worktree, exactly like a task checkout gets
      // (worktreeFor): a tab builds and runs dev servers here, and without the
      // bundle every session build was missing its .env while dispatched runs
      // got theirs. Only on creation — a live directory's env belongs to the
      // session, same as a resumed task tree. Ship's dirty-check is safe by
      // construction: materializeInto writes ONLY gitignored paths (it refuses
      // otherwise), and ignored files never appear in `git status --porcelain`.
      // Best-effort, like everywhere else — the session still builds; paths
      // that need secrets may 500.
      try {
        materializeInto(wt);
      } catch {
        /* best-effort */
      }
    } else if (!hasMaterialized(wt)) {
      // CREATION-ONLY NEEDED A SECOND CONDITION. The rule above is right about
      // a LIVE directory — its env belongs to the session and re-writing it
      // mid-flight is not ours to do — but "created" and "ever given a bundle"
      // are different events, and the gap between them is a whole daemon
      // restart: `handleRosterEnv` (which warms the encrypted cache) runs
      // AFTER `processWorkTurns` on the same poll, so a worktree made on the
      // first turn after a restart was materialized against an EMPTY bundle
      // and, being neither fresh nor covered by a bundle CHANGE, never
      // revisited. `materializeInto` now declines to record a pass it made in
      // ignorance (bundleVersion < 0), so this branch is what retries it —
      // once, on the next turn, and never again after it succeeds. Idempotent
      // by construction: identical bodies are not rewritten, so nothing
      // hot-restarts a dev server the driver is watching.
      try {
        materializeInto(wt);
      } catch {
        /* best-effort */
      }
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
   * The spawn lock: the pid of the CLI currently live in this worktree. A
   * restarted daemon must not put a second Claude into a directory the orphan
   * of its previous life is still editing — two CLIs appending to one held
   * conversation is exactly the incoherence workChains prevents in-process,
   * and the lock extends that guarantee across a restart. A dead pid is a
   * stale lock (removed here); a live one means "come back next poll".
   */
  const turnLockedByLivePid = (lockPath) => {
    if (!lockPath || !existsSync(lockPath)) return false;
    let pid = 0;
    try {
      pid = Number(readFileSync(lockPath, 'utf8').trim());
    } catch {
      /* unreadable — treat as stale */
    }
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
        return true; // signal 0 delivered — the process is alive
      } catch (e) {
        if (e.code === 'EPERM') return true; // alive, just not ours to signal
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
   * Live session-turn CLI children. The daemon's teardown SIGTERMs them: an
   * orphaned CLI keeps editing the session worktree and burning quota after
   * the daemon is gone. Each child's pid-lock is deliberately LEFT IN PLACE —
   * a CLI can trap SIGTERM to finish an in-flight request and outlive this
   * loop by seconds, and removing the lock in the same tick handed the
   * restarted daemon a green light to spawn a second CLI into the same held
   * context. turnLockedByLivePid already covers both outcomes: it waits while
   * the pid lives and clears the lock once it is dead.
   */
  const workChildren = new Map(); // child process -> lockPath | null
  const shutdownWork = () => {
    for (const [ch] of workChildren) {
      try {
        ch.kill('SIGTERM');
      } catch {
        /* best-effort */
      }
    }
    workChildren.clear();
  };

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

  const processWorkTurns = (jobs) => {
    for (const job of jobs ?? []) {
      if (!job || typeof job.id !== 'string' || !job.body || !job.sessionId) continue;
      if (workAnswering.has(job.id)) continue;
      // The turn already RAN and its answer sits in the delivery queue — never
      // run it again while the report is merely undelivered.
      if (pendingWorkReports.has(job.id)) continue;
      workAnswering.add(job.id);
      // Serialized by PLACE: two tabs sharing a worktree take turns in it
      // rather than editing the same files at the same time.
      const place = job.place || job.sessionId;
      // Remembered for every other beat — the sweep, ship, the preview
      // re-check — so they all ask the same directory this turn runs in.
      sessionPlaces.set(job.sessionId, place);
      // A READER: other turns in this place run alongside it. See `inPlace`.
      inPlace(place, false, async () => {
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
          const mcp = plainTab
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
            const turnArgs = {
              // A plain tab has no tools to name and no session id to pass —
              // its kickoff asks for one complete report instead of a stream.
              prompt: plainTab
                ? WORK_TURN_KICKOFF_PLAIN({
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
              // The adopt turn resumes the TERMINAL conversation by forking it
              // into this cwd (claude: --resume <id> --fork-session). After it
              // speaks once, the fork lives natively here and turn 2+ is the
              // ordinary --continue resume path, unchanged.
              ...(adopting ? { adoptResumeId: job.adopt.id } : {}),
              system: plainTab ? SYSTEM_WORK_PLAIN : SYSTEM_WORK,
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
                workChildren.set(ch, lockPath ?? null);
                // The CLI is spawned `detached`, so its pid IS its process
                // group id — and every process it starts inherits that, through
                // `nohup` and `setsid` alike. Remembered per SESSION rather
                // than per turn, because the whole point is the watcher that
                // outlives the turn that started it.
                if (ch.pid) noteSessionGroup(job.sessionId, ch.pid);
                if (lockPath && ch.pid) {
                  try {
                    writeFileSync(lockPath, String(ch.pid));
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
            if (!adopting && resume && !(out || '').trim())
              out = await runTurn({ ...turnArgs, resume: false });
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
          // The turn just changed the directory — say what it looks like now,
          // whether it succeeded or blew up (a failed turn can still have
          // written half a file, and the tab should show that honestly). NOT
          // awaited: this runs inside the session's chain, and a slow POST
          // would delay the next turn of that tab behind a readout.
          void reportPlaceWorktrees(job.sessionId).catch(() => {});
          burstListeners(job.sessionId);
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
            git(['fetch', 'origin', '--quiet'], repoRoot);
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
          // same fallback checkpointWip uses) so a bare machine doesn't fail
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
  const workBusy = () =>
    placeLocks.size > 0 ||
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
  };
}
