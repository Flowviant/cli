/**
 * THE TAB'S LIVE LINE — the CLI's own stdout relayed while a turn runs, and
 * the machine's one sentence when it defers a turn the tab is waiting on.
 *
 * Split out of work.mjs (2026-09-26, SOLID F037). Both ride
 * `/fleet/session-activity`, both are throttled decoration that must never
 * fail a turn, and both change for the same reason (what the tab shows while
 * nothing has settled). The session lane builds one narrator per turn and
 * clears the deferral clock when a turn actually starts.
 */
import { FLEET_URL, FLEET_TOKEN, USER_AGENT } from './config.mjs';
import { scrub as envScrub } from './uplinkScrub.mjs';
import { fleetEndpoint } from './fleetWire.mjs';

export function createWorkNarration() {
  const ACTIVITY_URL = fleetEndpoint('session-activity', FLEET_URL);
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

  return { makeNarrator, sayTurnDeferred, lastDeferSaid };
}
