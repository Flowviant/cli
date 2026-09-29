/**
 * THE WORK CREDENTIAL, ONE PER SESSION — minted, cached near its lease, and
 * the mint's three answers (a token, gone, held by another daemon).
 *
 * Split out of work.mjs (2026-09-26, SOLID F037). The session lane mints; the
 * retirement sweep drops a peer-held session's cache so the next turn goes
 * back through the mint (the one place the lease 409s a non-holder). Both hold
 * the same map, handed out by name.
 */
import {
  FLEET_URL,
  FLEET_TOKEN,
  USER_AGENT,
  REFRESH_BEFORE_SECONDS,
  DAEMON_INSTANCE,
} from './config.mjs';
import { fleetEndpoint } from './fleetWire.mjs';

export function createWorkSessionTokens({ getLeaseTtl }) {
  const WORK_TOKEN_URL = fleetEndpoint('work-token', FLEET_URL);
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

  return { workTokens, mintWorkToken };
}
