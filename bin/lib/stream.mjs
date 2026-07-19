/**
 * Fleet daemon push channel — the best-practice endgame for dispatch latency.
 *
 * Holds a hibernatable WebSocket open to the server. When a job lands (a wiki
 * regen, a dispatch, a merge request, an @mention), the server pushes a
 * `{type:'wake'}` frame and the daemon reconciles IMMEDIATELY — its normal
 * roster fetch — instead of waiting out the poll. That collapses pickup latency
 * from ≤RECONCILE_SECONDS to ~a round trip.
 *
 * The socket carries NO authority: it's a dumb nudge, the roster HTTP fetch is
 * the source of truth (notify-then-reconcile, à la k8s watch). So a dropped or
 * duplicate frame is harmless, and if the socket can't connect we reconnect with
 * backoff while the roster poll stays the fallback the entire time.
 *
 * Keepalive uses an APP-LEVEL "ping"/"pong" the server answers via its socket
 * auto-response — that proves liveness both ways WITHOUT waking the hibernated
 * Durable Object, so an idle connection stays cheap.
 */

import WebSocket from 'ws';
import { STREAM_URL, FLEET_TOKEN, USER_AGENT } from './config.mjs';
import { c, info, note, warn } from './ui.mjs';

const PING_MS = 30_000; // app-level ping cadence — NAT keepalive + liveness probe
const DEAD_AFTER_MS = 75_000; // no frame at all for this long → recycle the socket
const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 15_000]; // reconnect backoff, capped
const HANDSHAKE_TIMEOUT_MS = 15_000;

/**
 * Open the push channel and keep it open (auto-reconnecting) until close().
 *
 * @param {object}   opts
 * @param {(reasons: string[]) => void} opts.onWake  called on each wake frame
 * @param {() => boolean}               opts.isAlive daemon still running?
 * @returns {{ close: () => void }}
 */
export function connectStream({ onWake, isAlive }) {
  let ws = null;
  let attempt = 0;
  let pingTimer = null;
  let lastRxAt = 0;
  let closed = false;
  let announcedDown = false; // only warn once per outage, not per retry

  const clearPing = () => {
    if (pingTimer) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
  };

  const scheduleReconnect = () => {
    if (closed || !isAlive()) return;
    const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
    attempt += 1;
    setTimeout(open, delay);
  };

  const open = () => {
    if (closed || !isAlive()) return;
    try {
      ws = new WebSocket(STREAM_URL, {
        headers: { Authorization: `Bearer ${FLEET_TOKEN}`, 'User-Agent': USER_AGENT },
        handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
      });
    } catch (e) {
      // Bad URL / construction failure — treat as a disconnect and back off.
      scheduleReconnect();
      return;
    }

    ws.on('open', () => {
      attempt = 0;
      lastRxAt = Date.now();
      if (announcedDown) {
        announcedDown = false;
        info(c.dim('push channel reconnected — instant dispatch back on'));
      } else {
        note(c.dim('push channel connected — instant dispatch on'));
      }
      clearPing();
      pingTimer = setInterval(() => {
        // If we've heard nothing (not even a pong) for too long, the connection
        // is a zombie behind NAT — force it closed so 'close' triggers a
        // reconnect. Otherwise send the app-level ping (auto-answered server-side).
        if (Date.now() - lastRxAt > DEAD_AFTER_MS) {
          try {
            ws.terminate();
          } catch {
            /* already gone */
          }
          return;
        }
        try {
          ws.send('ping');
        } catch {
          /* send after close — 'close' handler will reconnect */
        }
      }, PING_MS);
    });

    ws.on('message', (data) => {
      lastRxAt = Date.now();
      const text = typeof data === 'string' ? data : data.toString('utf8');
      if (text === 'pong') return; // keepalive ack
      let msg = null;
      try {
        msg = JSON.parse(text);
      } catch {
        return; // ignore non-JSON noise
      }
      if (msg && msg.type === 'wake') {
        try {
          onWake?.(Array.isArray(msg.reasons) ? msg.reasons : []);
        } catch {
          /* never let a handler throw kill the socket */
        }
      }
    });

    ws.on('close', (code) => {
      clearPing();
      // 1008/4401-ish auth closes can't be fixed by retrying, but the roster
      // poll hits the same credential and exits the daemon cleanly — so we just
      // back off here and let that path own the shutdown. Keep it quiet.
      if (!announcedDown && !closed && isAlive()) {
        announcedDown = true;
        warn(c.dim(`push channel down (${code ?? '—'}) — falling back to polling, retrying`));
      }
      scheduleReconnect();
    });

    ws.on('error', () => {
      // 'error' is always followed by 'close' — do the reconnect there so we
      // don't double-schedule. Swallow to avoid an unhandled 'error' crash.
    });
  };

  open();

  return {
    close: () => {
      closed = true;
      clearPing();
      try {
        ws?.close();
      } catch {
        /* best-effort */
      }
    },
  };
}
