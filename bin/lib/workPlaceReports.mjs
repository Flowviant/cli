/**
 * THE WORKTREE READOUT — what each place looks like (diff, listeners,
 * processes, title, box, publication), reported after a settle, in a decaying
 * burst while a dev server binds, and in a throttled rotating sweep over every
 * live session.
 *
 * Split out of work.mjs (2026-09-26, SOLID F037). Every trigger (a settle, a
 * ship, a kill, the poll) asks for a measurement and nothing else; this
 * module owns what a measurement IS and when the sweep runs, so a new field
 * on `/fleet/session-worktrees` is one edit here. A daemon→server report, so
 * none of it needs a version floor.
 */
import { readFileSync } from 'node:fs';
import { FLEET_URL, FLEET_TOKEN, USER_AGENT, MACHINE_HOST } from './config.mjs';
import { gitNetAsync, isSafePathSegment } from './git.mjs';
import { measureListeners, listenersSupported } from './listeners.mjs';
import { processesSupported } from './processes.mjs';
import { titleForSession } from './claudeSessions.mjs';
import { worktreeDiff } from './worktreeDiff.mjs';
import { myPubB64 } from './boxIdentity.mjs';
import { fleetEndpoint } from './fleetWire.mjs';
import { REPO_PLACE } from './workPlaces.mjs';

export function createWorkPlaceReports({
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
}) {
  const WORKTREES_URL = fleetEndpoint('session-worktrees', FLEET_URL);
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

  return { reportSessionWorktree, reportPlaceWorktrees, burstListeners, reportWorktrees };
}
