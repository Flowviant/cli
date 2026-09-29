/**
 * EVERY TURN SETTLES — the settle POSTs, the in-memory queue of reports that
 * could not be delivered yet, their per-poll retry and reject backoff, and
 * what a delivered ship report sets off.
 *
 * Split out of work.mjs (2026-09-26, SOLID F037). The queue is the skip-guard
 * that stops a side-effecting turn being re-run over a dropped 200, so its
 * delivery rules (ok / terminal / reject / retry) have exactly one home; the
 * session lane settles through `settleWorkTurn`, the ship lane through
 * `settleShip`, and the plan and check lanes through `postBestEffort`. The
 * attempts counter is the session lane's, handed in by name, because a
 * terminal delivery is what may forget it.
 */
import { FLEET_URL, FLEET_TOKEN, USER_AGENT } from './config.mjs';
import { git } from './git.mjs';
import { sweepMergedBranch } from './shipSweep.mjs';
import { note } from './ui.mjs';
import { fleetEndpoint } from './fleetWire.mjs';

export function createWorkReportQueue({
  repoRoot,
  baseRef,
  workAttempts,
  artifacts,
  landed,
  onRepoChanged,
  reportPlaceWorktrees,
  burstListeners,
}) {
  const WORK_DONE_URL = fleetEndpoint('work-turn-done', FLEET_URL);
  const SHIP_DONE_URL = fleetEndpoint('ship-done', FLEET_URL);
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

  return {
    pendingWorkReports,
    pendingShipReports,
    postBestEffort,
    REJECT_RETRY_MS,
    settleWorkTurn,
    settleShip,
    flushWorkReports,
    sweepMergedSessionBranch,
  };
}
