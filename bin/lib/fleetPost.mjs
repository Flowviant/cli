/**
 * ONE DAEMON→SERVER POST THAT ANSWERS ONLY "WAS IT ACCEPTED" — the settle a
 * job lane sends when it is done (`patch-revert-done`, `cleanup-done`,
 * `reground-done`) and the machine telemetry beat (`/fleet/machine`).
 *
 * Split out of fleet.mjs (SOLID audit 2026-09-26, F038) because four lanes in
 * three modules share it — the job lanes (fleetJobs.mjs), the wiki runner
 * (wikiRunner.mjs) and the machine report (fleetReports.mjs) — and it was a
 * closure inside `runFleetDaemon` that only one of them could reach. It was
 * called `reportMergeOutcome` there, a name left over from the deleted
 * dispatch-era merge lane; the body is unchanged.
 *
 * A DAEMON→SERVER REPORT, so no floor: the report's presence is the
 * capability, and a lane that gets `false` back retries on its own beat.
 */

import { FLEET_TOKEN, USER_AGENT } from './config.mjs';

/** Returns whether the server actually accepted it. Callers that spend a
 *  Claude turn per attempt need to know: swallowing the failure silently made
 *  an unreachable endpoint look identical to a settled job, so the turn
 *  re-ran on every poll. */
export async function postToFleet(url, body) {
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
}
