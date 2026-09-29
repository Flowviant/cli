/**
 * CLAUDE CODE'S EVENT STREAM, READ — one line of `--output-format stream-json`
 * into feed activities, the answer text, the init facts and the turn's tokens.
 *
 * Split out of claude.mjs (SOLID 2026-09-26) because it changes when the CLI's
 * event schema changes, which is a different reason from a permission list or
 * a process's lifetime. Codex's and agy's readers, and the Claude tool
 * humanizers this loop calls, live in runtimeEvents.mjs; this is the stream
 * loop Claude's `parse: null` means.
 */

import { humanizeClaudeTool, THINK_MARKER } from './runtimeEvents.mjs';
import { turnModelOf } from './turnModel.mjs';

// Turn one Claude tool_use into a compact activity {kind, label}, or null for
// tools not worth surfacing. `kind:'read'` is what the file counter counts; a
// Write/Edit of a vault page is the "writing" signal. Used by wiki turns to
// stream exactly which files Claude is touching (daemon console + app cover).
//
// The body moved to runtimeEvents.mjs, beside Codex's equivalent, because they are
// the same job for two vendors and keeping them apart is how the two activity
// vocabularies drift. Re-exported under its original name: a dozen call sites
// know it, and none of them care where it lives.
export const humanizeToolUse = humanizeClaudeTool;

// Collapse whitespace + clip so a narration/thinking snippet is one tidy feed line.
const oneLine = (s, n = 160) => String(s).replace(/\s+/g, ' ').trim().slice(0, n);

/**
 * WHAT THIS TURN COST, IN THE CLI'S OWN NUMBERS (2026-09-19).
 *
 * The `result` event carries a `usage` object — `input_tokens`,
 * `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens` —
 * and this reads exactly those four and nothing else. A RELAY: nothing here
 * derives, estimates or prices anything.
 *
 * DELIBERATELY NOT `total_cost_usd`, which rides the same event. It is a
 * notional list price that a subscription operator did not pay, so relaying it
 * as "cost" would be the product asserting a figure nobody was charged — the
 * refusal the board's fix pass already made once against the mock's "1.4
 * spent". Tokens are measured; dollars are not.
 *
 * COERCED AND FLOORED, never trusted: a non-number, a NaN, an Infinity or a
 * negative reads as 0, because these are summed into a counter that only ever
 * goes up and one bad field must not poison the other three.
 *
 * Returns null when there is no usage object at all — the three-state rule
 * every readout here keeps: a turn that reported nothing charges nothing, and
 * that is not the same as a turn that reported zeros.
 */
export function usageFromResult(ev) {
  const u = ev?.usage;
  if (!u || typeof u !== 'object') return null;
  const n = (v) => {
    const x = Number(v);
    return Number.isFinite(x) && x > 0 ? Math.floor(x) : 0;
  };
  return {
    input: n(u.input_tokens),
    output: n(u.output_tokens),
    cacheCreate: n(u.cache_creation_input_tokens),
    cacheRead: n(u.cache_read_input_tokens),
  };
}

// Parse ONE line of `--output-format stream-json` NDJSON into feed activities.
// Surfaces the WHOLE turn — thinking, narration, AND every tool — so neither the
// daemon console nor the app cover goes dark while Claude reasons (Opus thinks in
// bursts before/between tools; emitting only tools left long silent gaps).
// Assistant text is also folded into `out` so the WIKI_DONE/REGROUND_DONE
// sentinels still match. A non-JSON line (a stray warning) is kept as raw text.
//
// `answerFromResult` narrows that last part for callers whose `out` IS the
// answer rather than a haystack to match sentinels in (a Workbench tab's turn):
// every intermediate text block still NARRATES, but only the final `result`
// event contributes text — otherwise the same sentences arrive twice, once as
// they stream and once in the result, and the tab posts the duplicate.
//
// EXPORTED FOR ITS TEST ONLY (2026-09-19), and the reason is worth stating: the
// `onUsage` threading through this function, `runTurn`'s options and `onLine`
// was four edits and NOT ONE of them was reachable from either suite — delete
// any one and both stay green, while the only symptom in production is a
// container that reports no spend, which is indistinguishable from an older
// daemon by design. A callback that is silent when it breaks has to be called
// directly by something.
export function handleStreamLine(line, { cwd, emit, onActivity, onToolEvent, appendText, answerFromResult, onInit, onUsage, onRateLimit, onModel }) {
  let ev;
  try {
    ev = JSON.parse(line);
  } catch {
    appendText(line + '\n');
    emit(line + '\n');
    return;
  }
  const push = (a) => {
    if (!a || !a.label) return;
    emit(a.label + '\n');
    onActivity?.(a);
  };
  if (ev.type === 'assistant' && Array.isArray(ev.message?.content)) {
    // THE MODEL THAT ANSWERED (2026-09-29, turnModel.mjs) — the fallback for an
    // init that named none. The turn's own messages only: a subagent's carry
    // `parent_tool_use_id`, and its model is not the turn's.
    if (ev.parent_tool_use_id == null) {
      const answered = turnModelOf(ev.message.model);
      if (answered) onModel?.(answered);
    }
    for (const b of ev.message.content) {
      if (b.type === 'thinking' || b.type === 'redacted_thinking') {
        /**
         * NO THINKING TEXT ARRIVES TODAY, AND THAT IS MEASURED (2026-09-16).
         *
         * This used to say the text is "usually redacted", which was a guess
         * doing the work of a fact. The fact: across three real transcripts, 93
         * thinking blocks, EVERY ONE of them carried an empty `thinking` — and
         * a live probe with MAX_THINKING_TOKENS set and
         * `--include-partial-messages` on returned an empty `thinking_delta`
         * and a complete block of length zero (signature only). So the CLI
         * emits the FACT that it reasoned and not a word of the reasoning, and
         * "show the full thinking" cannot be conjured from this stream.
         *
         * THE BRANCH BELOW EXISTS ANYWAY, and deliberately. The shape is the
         * whole point: when text is present it rides `full` UNCLIPPED, so the
         * day a CLI release starts emitting it, the trace carries the thought
         * whole with no daemon change and no version floor — the report's own
         * presence is the capability. Until then every block takes the marker
         * arm, and `trace.mjs` collapses a run of identical markers so the
         * absence reads as one quiet step rather than forty.
         */
        push(
          b.thinking
            ? { kind: 'think', label: `thinking: ${oneLine(b.thinking)}`, full: b.thinking }
            : { kind: 'think', label: THINK_MARKER }
        );
      } else if (b.type === 'text' && b.text?.trim()) {
        if (!answerFromResult) appendText(b.text + '\n');
        // `label` for the console and the pulse — one collapsed 160-char line,
        // byte-identical to what it has always printed. `full` for the trace:
        // a `say` is the agent NARRATING, several sentences at a time, and the
        // clip at 160 was landing mid-sentence on the one thing a person opens
        // the page to read.
        push({ kind: 'say', label: oneLine(b.text), full: b.text });
      } else if (b.type === 'tool_use') {
        push(humanizeToolUse(b.name, b.input || {}, cwd));
        // The STRUCTURED form of the same event, for the transcript's tool
        // cards — raw name + input, so the collector can keep what the
        // one-line humanizer drops (an Edit's counts, the plan's items).
        onToolEvent?.(b.name, b.input || {});
      }
    }
  } else if (ev.type === 'system' && ev.subtype === 'init') {
    // WHAT THIS MACHINE'S CLI CAN BE ASKED FOR BY NAME. The init event is the
    // CLI's OWN answer — it has already resolved personal skills, this repo's
    // skills, plugins and whatever the project settings enable or disable — so
    // reading it costs nothing and cannot drift the way a `~/.claude/skills`
    // scan of our own would. `skills` (rather than `slash_commands`) is the
    // deliberate narrowing: the 50-odd commands beside it are the CLI's own
    // interactive furniture (/clear, /model, /compact), and offering those in a
    // relayed tab would be an offer wired to nothing.
    //
    // Only ever REPORTED, never enforced. Flowviant does not decide what your
    // Claude can do; it relays what your Claude said it has.
    // `sessionId` rides along for one reason: a `-p` turn WRITES a transcript,
    // and `claudeSessions.mjs` offers the newest ended session per directory as
    // ADOPTABLE — so any headless turn we run for our own purposes would leave
    // a phantom untitled session in the `+` menu. The caller that needs to
    // clean up after itself cannot do so without this id.
    //
    // `mcpServers` (0.97.0) is the same kind of fact from the same event: the
    // MCP servers and claude.ai connectors the CLI mounted, each with its own
    // status (`needs-auth` above all — a sign-in that has to happen at this
    // box). Relayed raw; `recordMcpServers` (runtimeCapabilities.mjs) normalises it and
    // drops this daemon's own `flowviant` server.
    //
    // `model` (2026-09-29) is the model this turn RESOLVED — `opus` is an
    // alias, and this is the CLI naming what it chose. See turnModel.mjs.
    const resolved = turnModelOf(ev.model);
    if (resolved) onModel?.(resolved);
    if (Array.isArray(ev.skills) || typeof ev.session_id === 'string' || Array.isArray(ev.mcp_servers)) {
      onInit?.({
        skills: Array.isArray(ev.skills) ? ev.skills.map(String) : undefined,
        sessionId: typeof ev.session_id === 'string' ? ev.session_id : undefined,
        mcpServers: Array.isArray(ev.mcp_servers) ? ev.mcp_servers : undefined,
      });
    }
  } else if (ev.type === 'result') {
    /**
     * WHAT THE TURN SPENT, BEFORE ANYTHING ELSE IN THIS BRANCH.
     *
     * FIRED ON A FAILED RESULT TOO, and that ordering is the point: a turn that
     * hit a limit, ran out of permission or aborted still sent the requests it
     * sent, and a spend readout that quietly skipped every unhappy turn would
     * under-report exactly the runs somebody is looking at the number to
     * understand. `usageFromResult` returns null when the event carries no
     * usage at all, and a caller that passes no `onUsage` sees no change.
     */
    const usage = usageFromResult(ev);
    if (usage) onUsage?.(usage);
    // The final assistant text (carries WIKI_DONE / REGROUND_DONE).
    if (typeof ev.result === 'string') appendText(ev.result + '\n');
    else if (ev.is_error || ev.subtype) {
      // A result that carries no text is a FAILED turn (a limit, a refused
      // permission, an aborted run). Under `answerFromResult` this is the only
      // stdout that would have said so, and a caller whose `out` is the answer
      // must not report "no output" for a turn that explained itself.
      // `errors[]` FIRST, because it is where the real sentence is. Claude
      // Code reports a dead `--resume` id as
      // `{subtype:'error_during_execution', errors:['No conversation found
      // with session ID: …']}` — reading only `error`/`subtype` dropped that
      // and appended the literal string `error_during_execution`, which told
      // the driver nothing and hid the one phrase the caller needs to
      // recognise a lost conversation.
      const listed = Array.isArray(ev.errors)
        ? ev.errors.filter((e) => typeof e === 'string' && e.trim()).join('; ')
        : '';
      const msg = listed || ev.error?.message || ev.error || ev.subtype;
      appendText(`${typeof msg === 'string' ? msg : JSON.stringify(msg)}\n`);
    }
  } else if (ev.type === 'rate_limit_event') {
    /**
     * HOW CLOSE THE PLAN IS TO ITS LIMIT, IN THE CLI'S OWN NUMBERS (0.109.0).
     *
     * MEASURED on Claude Code 2.1.283, 2026-09-28: an ordinary turn carries
     * one (status `allowed` at 3% — not only near a threshold), BEFORE its
     * `result` line — `{status, resetsAt, rateLimitType, unifiedWindows:
     * {five_hour: {utilization, resetsAt}, seven_day: {…}}, …}`. It was
     * dropped by the fall-through until now. Handed over whole
     * (runtimeLimits.mjs reads it); it is not the model speaking, so it
     * appends no text and emits no activity.
     */
    if (ev.rate_limit_info && typeof ev.rate_limit_info === 'object') onRateLimit?.(ev.rate_limit_info);
  }
}
