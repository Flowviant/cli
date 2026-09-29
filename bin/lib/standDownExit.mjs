/**
 * THE ONE WAY A STANDING-DOWN DAEMON LEAVES: AFTER ITS DEPLOYS HAVE REPORTED.
 *
 * ── A STAND-DOWN LETS AN IN-FLIGHT DEPLOY FINISH AND REPORT (owner ruling
 *    2026-09-26) ──
 *
 * The stand-downs are Ctrl+C (SIGINT), a service manager's or a takeover's
 * SIGTERM, a commanded stop, a displaced box, a removed box and a revoked
 * credential. Every one of them used to reach `process.exit` straight after
 * the teardown. The deploy's command survived (it runs in its own process
 * group, deployRunner.mjs, and only its timeout kills that group), but the
 * process that held the claim did not — so its outcome was never posted, the
 * heartbeat stopped, and three minutes later the server handed the same
 * irreversible job out again.
 *
 * So the exit waits. The teardown still runs first and in full (tabs, the
 * wiki, previews — none of those is a deploy), and it closes the work lanes
 * before it kills anything (standDownGate.mjs): no CLI turn or check starts
 * again, and a turn it killed never hands its output back, so it settles
 * nothing and retries nothing, exactly as when `process.exit` followed on the
 * same tick. The roster loop stops taking work (fleet.mjs checks
 * `leave.leaving()` at the top of every tick and after every await in it, so a
 * signal mid-tick ends the tick too), and a deploy claim answered after the
 * stand-down began is not run (deploy.mjs). What stays alive is only the
 * deploy lane: the command, its heartbeat and its report. While it waits:
 *
 *  - the instance lock stays HELD and is marked draining, so a takeover waits
 *    for it and a `flowviant stop` says so — neither signals it (instance.mjs
 *    reads the mark BEFORE it signals);
 *  - `busy` keeps being written to the daemon state file, and the lock's mark
 *    is read into `status --json` as `draining`, so the tray shows the box as
 *    working until the outcome lands. A `draining` machine event says so at
 *    once: the `stopped` event the stand-down already sent must not leave the
 *    tray reading the box as idle;
 *  - the report still goes out if the credential was rotated under it (a
 *    Disconnect, which the app now refuses while a deploy is in flight): the
 *    API's own refusal is said in words by the lease, never thrown.
 *
 * A SIGTERM while waiting changes nothing — a service manager, a takeover or
 * `flowviant stop` asking again is the same stand-down asked twice. Only a
 * person at the terminal can insist: a SECOND Ctrl+C leaves at once, after
 * one best-effort post that settles each deploy as `unknown` ("outcome
 * unknown: operator left mid-deploy"), so the server marks it terminal and
 * never hands it out again. Nothing here ever kills the deploy; that is the
 * timeout's alone.
 *
 * STATED RESIDUALS (no code answers them):
 *  - A service manager. No unit file is shipped or documented (checked
 *    2026-09-26). A unit that runs this daemon must set `KillMode=mixed` (the
 *    stop's SIGTERM goes to the daemon alone, not to the deploy command in its
 *    cgroup) and `TimeoutStopSec=2100` (35 minutes, above the deploy's
 *    30-minute timeout); systemd's defaults SIGTERM the command itself and
 *    SIGKILL the whole group after 90 s.
 *  - An older daemon's takeover or `flowviant stop` does not read the draining
 *    mark and SIGKILLs a newer draining daemon after its 20 s grace; the
 *    report is then lost and the server requeues the job, as before this
 *    ruling, until the release carrying this has spread.
 *  - A SIGKILL (or a second Ctrl+C whose `unknown` post does not land) loses
 *    the outcome the same way.
 *  - A deploy claim still on the wire when a second Ctrl+C leaves gets no
 *    `unknown` post (nothing was run, and this process has no job to settle);
 *    if the server granted it, its stale sweep hands it out again after three
 *    minutes, which is right, because nothing ran.
 *
 * Every dependency is injected, so the wait can be driven without a process to
 * exit; fleet.mjs builds the live one.
 */

export const DRAIN_BUSY_BEAT_MS = 30_000;
/** How long a second Ctrl+C waits for its `unknown` post before it leaves
 *  anyway — a person insisting is not kept waiting on the network. */
export const ABANDON_POST_MS = 5_000;

/**
 * @param {object} deps
 * @param {() => number}   deps.inFlight     how many deploys this process holds
 * @param {() => string[]} deps.labels       what they deploy, `target → env`
 * @param {() => Promise<void>} deps.settled resolves once every one reported
 * @param {() => Promise<void>} deps.abandon settle each as `unknown` (deploy.mjs)
 * @param {(what: string) => void} deps.markDraining  mark the instance lock
 * @param {(what: string) => void} [deps.announce]    the `draining` machine event
 * @param {() => void} deps.reportBusy       write `busy` to the state file
 * @param {(code: number) => void} deps.exit
 * @param {{ note: (m: string) => void, warn: (m: string) => void }} deps.log
 * @returns {((code: number, opts?: { signal?: 'SIGINT' | 'SIGTERM' | null }) => Promise<void>)
 *   & { leaving: () => boolean, drained: () => Promise<void> }}
 */
export function createLeave({
  inFlight,
  labels,
  settled,
  abandon = async () => {},
  markDraining,
  announce = () => {},
  reportBusy,
  exit,
  log,
  beatMs = DRAIN_BUSY_BEAT_MS,
  abandonMs = ABANDON_POST_MS,
}) {
  let waiting = null;
  let interrupts = 0;
  let gone = false;
  const exitOnce = (code) => {
    if (gone) return;
    gone = true;
    exit(code);
  };
  leave.leaving = () => waiting != null;
  /** Resolves when the stand-down has finished waiting (at once when none began). */
  leave.drained = () => waiting ?? Promise.resolve();
  return leave;
  function leave(code, { signal = null } = {}) {
    if (signal === 'SIGINT') interrupts++;
    if (waiting) {
      // A SIGTERM or a second roster command while draining is the same
      // stand-down asked again and changes nothing. Only a person at the
      // terminal insists, and only with a SECOND Ctrl+C.
      if (signal !== 'SIGINT' || gone) return waiting;
      if (interrupts < 2) {
        log.note('still waiting for the deploy to report. Ctrl+C again leaves now, without its outcome.');
        return waiting;
      }
      log.warn(
        'leaving without seeing the deploy end — its command keeps running on this box; ' +
          'the app is told its outcome is unknown, so it is never run again.'
      );
      const bounded = new Promise((r) => {
        const t = setTimeout(r, abandonMs);
        t.unref?.();
      });
      Promise.race([Promise.resolve().then(abandon).catch(() => {}), bounded]).then(() => exitOnce(code));
      return waiting;
    }
    if (inFlight() === 0) {
      waiting = Promise.resolve();
      exitOnce(code);
      return waiting;
    }
    const n = inFlight();
    const what = labels().join(', ');
    log.note(
      `waiting for ${n === 1 ? 'a deploy' : `${n} deploys`} (${what}) to finish and report before stopping — ` +
        `the command is not stopped.${signal === 'SIGINT' ? ' Ctrl+C again leaves now, without its outcome.' : ''}`
    );
    try {
      markDraining(what);
    } catch {
      /* a lock we cannot mark still drains; an older daemon's takeover may force it */
    }
    try {
      announce(what);
    } catch {
      /* a local readout must never interrupt a stand-down */
    }
    const beat = () => {
      try {
        reportBusy();
      } catch {
        /* a local readout must never interrupt a stand-down */
      }
    };
    beat();
    const timer = setInterval(beat, beatMs);
    timer.unref?.();
    waiting = settled().then(
      () => {
        clearInterval(timer);
        if (gone) return;
        beat();
        log.note(`${n === 1 ? 'the deploy is' : 'the deploys are'} done — stopping.`);
        exitOnce(code);
      },
      () => {
        clearInterval(timer);
        exitOnce(code);
      }
    );
    return waiting;
  }
}
