/**
 * THE COMMAND AUDIT — the durable record of every `$ …` a tab's CLI ran on the
 * shared machine, batched to `/fleet/session-commands`.
 *
 * Split out of work.mjs's session turn (2026-09-26, SOLID F037). One per turn;
 * the lane feeds it the stream's activity and flushes it at settle. It carries
 * commands only, scrubbed, and a failed post drops the batch rather than
 * blocking the turn.
 */
import { FLEET_URL, FLEET_TOKEN, USER_AGENT } from './config.mjs';
import { scrub as envScrub } from './uplinkScrub.mjs';
import { fleetEndpoint } from './fleetWire.mjs';

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
export function createCommandAudit({ sessionId, turnId, runtime, cwd }) {
  const SESSION_COMMANDS_URL = fleetEndpoint('session-commands', FLEET_URL);
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
        sessionId,
        turnId,
        runtime,
        cwd,
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
  return { flushAudit, auditCommand };
}
