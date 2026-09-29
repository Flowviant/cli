/**
 * ONE TURN'S TOOL LOG — the collector behind the transcript's tool cards.
 *
 * Split out of work.mjs's session turn (2026-09-26, SOLID F037) as pure logic:
 * it folds the CLI's own tool events into the capped, collapsed shape the
 * server stores, and nothing else. A fresh log per turn; the lane reads
 * `toolLog` for the live beat and the settle, and feeds `pushToolEvent` from
 * the stream. Tested directly (workToolLog.test.mjs).
 */
import { toolEventOf } from './runtimeEvents.mjs';
import { scrub as envScrub } from './uplinkScrub.mjs';

/**
 * THE TURN'S TOOL LOG — the structured relay behind the transcript's
 * tool cards. Same source as the narrator (the CLI's own tool_use
 * events), zero inference; scrubbed AT COLLECTION so every copy that
 * leaves the machine — live beat and settle alike — is already clean.
 *
 * Shape rules, applied here because the collector is the one writer:
 *   · consecutive identical read/grep/glob/bash/task events collapse
 *     into one row with a count (n);
 *   · consecutive edits of ONE file merge, summing counts, keeping
 *     the newest preview;
 *   · the PLAN is a single event — a new TodoWrite replaces the old
 *     plan at the current position, so the log shows the latest plan
 *     where it last changed rather than five stale copies;
 *   · capped at the newest 60 NON-PLAN rows, with the shed counted
 *     call-for-call (`dropped += n`) — scrollback semantics, the
 *     same trade the transcript itself makes; the plan is exempt,
 *     because it is current state rather than scrollback.
 */
export function createToolLog(cwd) {
  const toolLog = { ev: [], dropped: 0 };
  const pushToolEvent = (name, input) => {
    // envScrub rides INTO the builder, which scrubs over a bounded
    // window BEFORE its caps — scrubbing after the cut both leaked a
    // boundary-straddling secret's prefix and grew a capped field
    // past the server's limits (review, 2026-09-01).
    const e = toolEventOf(name, input, cwd, envScrub);
    if (!e) return;
    if (e.t === 'plan') {
      const i = toolLog.ev.findIndex((x) => x.t === 'plan');
      if (i >= 0) toolLog.ev.splice(i, 1);
      toolLog.ev.push(e);
    } else {
      const last = toolLog.ev[toolLog.ev.length - 1];
      const sameKey =
        last &&
        last.t === e.t &&
        last.p === e.p &&
        last.q === e.q &&
        last.c === e.c;
      if (sameKey && (e.t === 'edit' || e.t === 'write')) {
        last.n = (last.n ?? 1) + 1;
        last.a = (last.a ?? 0) + (e.a ?? 0);
        last.d = (last.d ?? 0) + (e.d ?? 0);
        if (e.dl) last.dl = e.dl;
      } else if (sameKey) {
        last.n = (last.n ?? 1) + 1;
      } else {
        toolLog.ev.push(e);
      }
    }
    // The cap evicts the oldest NON-plan row: the plan is current
    // state, not scrollback — the one card the fold keeps out — and a
    // shed collapsed row counts its repeats, so "N steps" never
    // understates what the cut removed.
    while (toolLog.ev.length > 60) {
      const i = toolLog.ev.findIndex((x) => x.t !== 'plan');
      if (i < 0) break; // only the plan left; it stays
      const [shed] = toolLog.ev.splice(i, 1);
      toolLog.dropped = Math.min(1_000_000, toolLog.dropped + (shed?.n ?? 1));
    }
  };
  return { toolLog, pushToolEvent };
}
