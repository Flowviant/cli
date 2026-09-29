/**
 * AN AGENT TURN'S WIRE: the settle and its held body, the trace, the pulse and
 * the park — every POST the agent-turn lane makes, and nothing that decides
 * what goes in one.
 *
 * Split out of workAgentTurns.mjs (SOLID F036, 2026-09-26). Report delivery is
 * its own vocabulary — which status counts as delivered, which refusal backs
 * off, how long a finished body is held and what clock ages it — and it
 * changes for reasons that have nothing to do with how a CLI is run or what a
 * turn decided. The lane (workAgentTurns.mjs), the run
 * (workAgentTurnExecution.mjs) and the stand-down all post through here, so a
 * settle has exactly one door and one held-body map.
 *
 * Daemon→server reports, every one of them: no version floor, and a permanent
 * 4xx is the server saying it will never take the body (see each POST).
 */
import { FLEET_URL, FLEET_TOKEN, USER_AGENT } from './config.mjs';
import { fleetEndpoint } from './fleetWire.mjs';

export function createAgentTurnReports({ REJECT_RETRY_MS }) {
  const AGENT_TURN_DONE_URL = fleetEndpoint('agent-turn-done', FLEET_URL);
  const AGENT_TRACE_URL = fleetEndpoint('agent-trace', FLEET_URL);
  const AGENT_ACTIVITY_URL = fleetEndpoint('agent-activity', FLEET_URL);
  const AGENT_PARKED_URL = fleetEndpoint('agent-parked', FLEET_URL);

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

  /** Returns the server's reply, because it carries ONE instruction the machine
   *  can act on immediately: `review: true` means the agent's queue just
   *  emptied, so run the project's own check in the worktree we are already
   *  standing in. A job lane for that would need a claim, a floor and a settle
   *  to say something this reply already can. */
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

  const postAgentParked = async (reason, runtime) => {
    try {
      await fetch(AGENT_PARKED_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${FLEET_TOKEN}`,
          'User-Agent': USER_AGENT,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(15_000),
        // `runtime` scopes the park to that CLI's agents; a server that does
        // not know the key parks every agent, which is what it always did.
        body: JSON.stringify({ reason, ...(runtime ? { runtime } : {}) }),
      });
    } catch {
      /* the next turn will hit the same limit and try again */
    }
  };

  /**
   * THE ROSTER IS THE HELD BODIES' CLOCK: an offered turn is still pending
   * server-side and worth retrying; one the roster stopped naming was settled
   * or expired, and holding its body past a generous grace would grow this map
   * for the life of the process. The server's own expiry is the true bound —
   * the grace only covers its POST racing a final offer.
   */
  const pruneHeldReports = (list) => {
    if (!agentReported.size) return;
    const offered = new Set(list.map((j) => String(j?.id || '')));
    const now = Date.now();
    for (const [id, held] of agentReported) {
      if (offered.has(id)) held.at = now;
      else if (now - held.at > AGENT_REPORT_GRACE_MS) {
        agentReported.delete(id);
        agentRejectedUntil.delete(id);
      }
    }
  };

  return {
    postAgentTurn,
    postAgentTrace,
    postAgentActivity,
    postAgentParked,
    pruneHeldReports,
    agentReported,
    agentRejectedUntil,
  };
}
