/**
 * WHICH MODEL A TURN ACTUALLY RAN ON, IN THE CLI'S OWN WORDS (2026-09-29).
 *
 * The owner: "how do users know which model of opus are they using on
 * flowviant? like opus 5, or opus 5.5". A pin reads as typed ("opus") or as
 * the machine default, and `opus` is an alias the CLI resolves on its own
 * cadence — so the only true answer is the one the CLI gives about the turn it
 * just ran. This file reads it; the settle bodies carry it as `model`; the app
 * shows it by name. A RELAY: nothing here maps an alias to a model or guesses.
 *
 * TWO SOURCES, ONE SHAPE:
 *
 *  · CLAUDE CODE says it on the stream. MEASURED on Claude Code 2.1.284,
 *    2026-09-29 (`claude -p "say hi" --model haiku --output-format
 *    stream-json --verbose`): the `system`/`init` event carries
 *    `model: "claude-haiku-4-5-20251001"`, and every top-level `assistant`
 *    event carries the same id as `message.model`. claudeStream.mjs hands both
 *    over; runTurn.mjs keeps the first valid one per spawn, so the init wins
 *    and the first reply is the fallback. A subagent's messages
 *    (`parent_tool_use_id` set) are not the turn's model and are not read; a
 *    synthetic error message says `<synthetic>`, which the shape refuses.
 *  · CODEX says it in a file. `codex exec --json` (0.156.1) puts no model on
 *    stdout — its ThreadEvent vocabulary is thread/turn/item lifecycle and
 *    token usage only — but the thread's rollout writes one `turn_context`
 *    line per turn whose `payload.model` is the model that turn resolved
 *    (`"model":"gpt-6-sol"`, beside `collaboration_mode.settings.model` and
 *    `effort`). After the child closes, runTurn.mjs asks
 *    `codexTurnModel` for the NEWEST `turn_context` — and only one written
 *    since the spawn, so a resumed thread whose turn died before its context
 *    was written never reports the previous turn's model as this one's.
 *
 * THREE STATES: a valid id is a measurement; null is "not measured" and the
 * settle carries no key at all. There is no empty value.
 *
 * THE SHAPE is the app's (`packages/shared/src/schemas/turnModel.ts` exports
 * `TURN_MODEL_MAX` and `TURN_MODEL_RE`; `scripts/check-app-parity.mjs` holds
 * them equal): the server re-applies it, so a looser copy here would only
 * have a model dropped at the boundary.
 */

import { open } from 'node:fs/promises';
import { codexRolloutFile } from './runtimeLimits.mjs';

/** The longest model id a settle carries. */
export const TURN_MODEL_MAX = 80;
/** One model id — the CLIs' own alphabet (`claude-opus-5-5`, `gpt-6-sol`,
 *  `us.anthropic.claude-…:0`, `org/model`). Anything else is not relayed. */
export const TURN_MODEL_RE = /^[A-Za-z0-9._:\-/]{1,80}$/;

/** A model id this daemon will relay, or null. */
export function turnModelOf(v) {
  return typeof v === 'string' && TURN_MODEL_RE.test(v) ? v : null;
}

/** Read backwards this much at a time… */
const ROLLOUT_CHUNK_BYTES = 256 * 1024;
/** …and no further than this: a turn's own lines past it are not searched. */
const ROLLOUT_MODEL_SCAN_MAX = 32 * 1024 * 1024;
/** A rollout stamp a little before the spawn still counts (clock rounding). */
const SINCE_SLACK_MS = 2_000;

/**
 * THE MODEL OF THE NEWEST `turn_context` IN A CODEX THREAD'S ROLLOUT, when it
 * was written at or after `since` (epoch ms); else null.
 *
 * Read BACKWARDS from the end in chunks, because the line sits at the START
 * of its turn and a single turn's rollout runs to megabytes (2.8 MB measured
 * for one agent turn). Only lines naming `"turn_context"` are parsed.
 * Best-effort from end to end: it never throws.
 */
export async function codexTurnModel(threadId, { since = 0, env = process.env } = {}) {
  let fh = null;
  try {
    const file = await codexRolloutFile(threadId, { env });
    if (!file) return null;
    fh = await open(file, 'r');
    const { size } = await fh.stat();
    let pos = size;
    // The bytes of a line whose start is in a chunk not read yet.
    let rest = Buffer.alloc(0);
    while (pos > 0 && size - pos < ROLLOUT_MODEL_SCAN_MAX) {
      const len = Math.min(ROLLOUT_CHUNK_BYTES, pos);
      pos -= len;
      const chunk = Buffer.alloc(len);
      await fh.read(chunk, 0, len, pos);
      let data = Buffer.concat([chunk, rest]);
      if (pos > 0) {
        const nl = data.indexOf(0x0a);
        if (nl < 0) {
          rest = data;
          continue;
        }
        rest = data.subarray(0, nl);
        data = data.subarray(nl + 1);
      }
      if (!data.includes('"turn_context"')) continue;
      const lines = data.toString('utf8').split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i].includes('"turn_context"')) continue;
        let ev;
        try {
          ev = JSON.parse(lines[i]);
        } catch {
          continue;
        }
        if (ev?.type !== 'turn_context') continue;
        // The NEWEST context decides, whatever it says: an older one is a
        // previous turn's.
        const at = Date.parse(ev.timestamp ?? '');
        if (!Number.isFinite(at) || at < since - SINCE_SLACK_MS) return null;
        return turnModelOf(ev.payload?.model);
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    await fh?.close().catch(() => {});
  }
}
