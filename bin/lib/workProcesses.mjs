/** Claims and execution for stopping a measured session process. */
import { FLEET_URL, FLEET_TOKEN, USER_AGENT, DAEMON_INSTANCE } from './config.mjs';
import { isSafePathSegment } from './git.mjs';
import { measureListeners } from './listeners.mjs';
import { measureProcesses, liveGroups, processesSupported } from './processes.mjs';
import { processAlive } from './procRegistry.mjs';

export function createWorkProcesses({ placeDir, reportPlaceWorktrees, state }) {
  const KILL_DONE_URL = FLEET_URL.replace(/\/agents\/?$/, '/kill-done');
  const KILL_CLAIM_URL = FLEET_URL.replace(/\/agents\/?$/, '/kill-claim');

  const { sessionGroups } = state;

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

  return { processKillJobs };
}
