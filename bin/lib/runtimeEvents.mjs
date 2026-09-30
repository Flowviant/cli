/**
 * WHAT EACH CLI'S STREAM SAID, IN THE DAEMON'S VOCABULARY — the event parsers.
 *
 * Split out of runtimes.mjs (2026-09-26, SOLID F045). The registry answers "how
 * do you drive this CLI"; this file answers "what did its output mean", and the
 * two change for different reasons: a vendor renaming an event or a tool is an
 * edit here, a vendor renaming a flag is an edit to the registry. Claude's tool
 * calls (the one-line activity and the structured tool event), Codex's JSONL
 * ThreadEvents and Antigravity's stream-json all live here, beside the
 * `label`/`full` convention and the thinking marker every one of them speaks.
 *
 * Pure: no state, no I/O. The registry hands `parseCodexLine` and
 * `parseAgyLine` to its adapters as their `parse`; claudeStream.mjs owns Claude's
 * own stream loop and calls `humanizeClaudeTool`/`toolEventOf` from it.
 */

/** Truncate for a one-line activity label. */
const oneLine = (s, n = 140) =>
  String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/**
 * `label` IS THE READOUT; `full` IS THE RELAY (2026-09-16) — the convention
 * every prose activity in this daemon follows, stated once here because three
 * parsers produce one and three consumers read them.
 *
 * `label` is one collapsed, clamped line, because its first two consumers are a
 * terminal console and a one-line pulse that is overwritten every two seconds,
 * and neither can show a paragraph. The turn TRACE is a third consumer with the
 * opposite need: it is scrollback, and clipping a sentence at 140 characters
 * there is the product summarizing its own agent.
 *
 * So a prose activity may ALSO carry `full`: the text EXACTLY as the CLI
 * emitted it, uncollapsed and unclipped. Nothing derives it and nothing but the
 * trace reads it — `label` is untouched, so the console and the pulse are
 * byte-identical to before. Absent means there was no fuller text than the
 * label (a tool line, a bare thinking marker), and the trace falls back to the
 * label — which is what every pre-0.87.0 daemon does for everything.
 *
 * THE MARKER BELOW IS THE label-ONLY CASE, and one definition with four
 * readers: claudeStream.mjs writes it, this file's codex parser falls back to it, and
 * TWO collapses key on it — `trace.mjs` for the turn trace, `wikiRunner.mjs`
 * for the wiki sweep's feed. A collapse keyed on a string typed out four times would
 * silently stop collapsing the first time somebody reworded one of them, and a
 * collapse that stops collapsing fails no test — it just fills a feed.
 *
 * It exists at all because the CLIs do not hand over the thinking itself:
 * measured 2026-09-16 across three real transcripts, 93 thinking blocks, every
 * one of them empty (signature only), and a live probe with MAX_THINKING_TOKENS
 * and `--include-partial-messages` returned an empty `thinking_delta` and a
 * zero-length complete block. So the marker is the honest whole of what is
 * known — "it is reasoning, not hung" — and the day text does arrive it rides
 * `full` and this marker is simply not used.
 */
export const THINK_MARKER = 'thinking…';

const shortPath = (p, cwd) => {
  const s = String(p ?? '');
  return cwd && s.startsWith(cwd) ? s.slice(cwd.length).replace(/^\//, '') : s;
};

// ── Claude Code ────────────────────────────────────────────────────────────

/**
 * Tool-call → one line of activity. Claude's tool names, unchanged from when
 * this lived in claude.mjs; `kind` is the daemon's own vocabulary and every
 * runtime's parser must speak it (`read` is what the wiki file counter counts,
 * `write` carries `path` so distinct pages can be counted).
 */
export function humanizeClaudeTool(name, input = {}, cwd = '') {
  switch (name) {
    case 'Read':
      return { kind: 'read', label: `read ${shortPath(input.file_path, cwd)}` };
    case 'Write':
    case 'Edit': {
      const p = String(input.file_path ?? '');
      const tail = p.split('/').slice(-2).join('/');
      return { kind: 'write', path: p, label: `${name === 'Write' ? '+ page' : '~ page'} ${tail}` };
    }
    case 'Grep':
      return {
        kind: 'search',
        label: `grep ${JSON.stringify(input.pattern ?? '')}${input.path ? ` in ${shortPath(input.path, cwd)}` : ''}`,
      };
    case 'Glob':
      return { kind: 'glob', label: `glob ${input.pattern ?? ''}` };
    case 'LS':
      return { kind: 'list', label: `ls ${shortPath(input.path ?? '.', cwd)}` };
    case 'Bash':
      // `command` rides beside the display label, VERBATIM (capped): the label
      // is a 60-char readout for a console and the rail, and truncation is
      // fine there — but the admin's command audit exists to answer "what
      // actually ran on our box", and an ellipsis is exactly where the part
      // that matters would hide.
      return {
        kind: 'bash',
        command: String(input.command ?? '').slice(0, 2000),
        label: `$ ${oneLine(input.command, 60)}`,
      };
    case 'TodoWrite': {
      // The CLI's own todo list — the plan the transcript's PLAN card renders.
      // The label narrates the change ("plan: 2 of 5 — cut over /api/session");
      // the structured items ride through toolEventOf below.
      const todos = Array.isArray(input.todos) ? input.todos : [];
      if (todos.length === 0) return null;
      const done = todos.filter((t) => t?.status === 'completed').length;
      const active = todos.find((t) => t?.status === 'in_progress');
      return {
        kind: 'plan',
        label: `plan: ${done} of ${todos.length}${active?.content ? ` — ${oneLine(active.content, 60)}` : ''}`,
      };
    }
    default:
      return null; // other tools: silent
  }
}

/** Count '\n' without materializing a split — a Write's content can be a
 *  multi-MB generated file, and `split('\n')` re-allocates all of it as line
 *  strings on the synchronous stream path the narrator and wake socket share.
 *  Numbers cannot leak, so counting runs on the RAW string. */
export function countLines(s) {
  const str = String(s ?? '');
  if (!str) return 0;
  let n = 1;
  let i = -1;
  while ((i = str.indexOf('\n', i + 1)) !== -1) n++;
  return n;
}

/** How much raw string the scrubber sees before any cap is applied. A secret
 *  can only surface in the first ~capped chars of a field; giving the scrub a
 *  window this much larger means a secret would have to be longer than the
 *  window minus the cap to straddle out of it — no real credential is. */
const SCRUB_WINDOW = 8_192;

/**
 * Tool-call → ONE STRUCTURED EVENT for the transcript's tool cards — the
 * relay's durable form, where `humanizeClaudeTool` above is its one-line live
 * form. Same source (the CLI's own tool_use input), zero inference: every
 * field is something the CLI emitted, and a tool this doesn't know renders as
 * nothing rather than as a guess.
 *
 * Wire vocabulary (compact keys — this rides a 1.5s-throttled POST):
 *   t: read|edit|write|grep|glob|bash|task|plan
 *   p: path (worktree-relative)   q: pattern/description   c: command
 *   a/d: line counts added/deleted (from the input's own strings)
 *   dl: a few "-/+" prefixed preview lines of an Edit
 *   items: the plan's todos, x = text, s = done|active|open
 *
 * SCRUB BEFORE CAP — the order is load-bearing (review, 2026-09-01). The
 * caller passes its `envScrub`; every string is scrubbed over a bounded
 * window FIRST and capped LAST, because the reverse order had two failures:
 * a secret straddling the cap boundary was cut into a prefix the
 * exact-substring scrub could no longer match (a partial credential on the
 * wire), and a scrub REPLACEMENT that grew a string past the cap tripped the
 * server's field limits. `scrub` defaults to identity so this stays testable
 * without a vault.
 */
export function toolEventOf(name, input = {}, cwd = '', scrub = (s) => s) {
  // Window → scrub → cap. The window bounds what a multi-MB input costs; the
  // cap is applied AFTER the scrub so a replacement cannot overflow it.
  const clean = (v, cap) => scrub(String(v ?? '').slice(0, SCRUB_WINDOW)).slice(0, cap);
  const rel = (p) => clean(shortPath(p, cwd), 300);
  // The first k lines of a side, from a scrubbed bounded prefix — never a
  // full split of the raw string.
  const firstLines = (s, k) =>
    scrub(String(s ?? '').slice(0, SCRUB_WINDOW)).split('\n', k).slice(0, k);
  switch (name) {
    case 'Read':
      return { t: 'read', p: rel(input.file_path) };
    case 'Write':
      return { t: 'write', p: rel(input.file_path), a: countLines(input.content) };
    case 'Edit': {
      const oldS = String(input.old_string ?? '');
      const newS = String(input.new_string ?? '');
      // A MINI-DIFF, not the diff: the first lines of each side, enough to
      // recognise the change at a glance. The real diff lives in git.
      const dl = [
        ...firstLines(oldS, 2).map((l) => `- ${l}`),
        ...firstLines(newS, 3).map((l) => `+ ${l}`),
      ].map((l) => l.slice(0, 160));
      return { t: 'edit', p: rel(input.file_path), a: countLines(newS), d: countLines(oldS), dl };
    }
    case 'Grep':
      return {
        t: 'grep',
        q: clean(input.pattern, 200),
        ...(input.path ? { p: rel(input.path) } : {}),
      };
    case 'Glob':
      return { t: 'glob', q: clean(input.pattern, 200) };
    case 'Bash':
      return { t: 'bash', c: clean(input.command, 200) };
    case 'Task':
      return { t: 'task', q: clean(input.description, 200) };
    case 'TodoWrite': {
      const todos = Array.isArray(input.todos) ? input.todos.slice(0, 20) : [];
      const items = todos
        .map((td) => ({
          x: clean(td?.content, 120),
          s: td?.status === 'completed' ? 'done' : td?.status === 'in_progress' ? 'active' : 'open',
        }))
        .filter((i) => i.x);
      return items.length ? { t: 'plan', items } : null;
    }
    default:
      return null;
  }
}

/**
 * THE ACTIVITY KINDS `toolEventOf` ALSO ANSWERS — the dedupe rule, stated once.
 *
 * A Claude tool call goes down BOTH paths in claudeStream.mjs: `humanizeClaudeTool`
 * makes a one-line activity and `toolEventOf` makes a structured event, from
 * the same `tool_use`. A consumer taking both — the agent turn's trace — would
 * otherwise render every read twice, once as a sentence and once as a card.
 *
 * It is the KINDS the structured builder answers, not every tool kind: `LS`
 * produces a `list` activity and no tool event, so dropping `list` would delete
 * it from the trace entirely. And it is only safe to apply on the runtimes
 * whose stream reaches `onToolEvent` at all — codex and agy have their own
 * parsers, never call it, and would go silent. Both halves are pinned in
 * trace.test.mjs, because the two functions are edited independently and the
 * failure is invisible: a dropped prose line looks exactly like a quiet turn.
 */
export const CLAUDE_TOOL_PROSE_KINDS = new Set([
  'read',
  'write',
  'search',
  'glob',
  'bash',
  'plan',
]);

// ── Codex ──────────────────────────────────────────────────────────────────

/**
 * Codex item → activity, in the daemon's vocabulary.
 *
 * The event names and item types below are not guesses: they were read off the
 * shipped 0.147 binary (`ThreadStarted`/`TurnCompleted`/`ItemCompleted`, items
 * `agent_message` / `reasoning` / `command_execution` / `file_change` /
 * `mcp_tool_call` / `web_search` / `todo_list`). Unknown item types return null
 * and stay silent rather than printing a raw JSON blob into someone's console.
 */
function humanizeCodexItem(item = {}, cwd = '') {
  switch (item.item_type ?? item.type) {
    // `full` rides beside the label wherever the item carries more than the
    // label can hold — see the `label`/`full` note above. Codex is the runtime
    // that actually SENDS reasoning text today, so its `think` is the one place
    // in this daemon where a real thought reaches the trace whole.
    case 'agent_message': {
      const text = String(item.text ?? item.message ?? '');
      return { kind: 'say', label: oneLine(text), ...(text ? { full: text } : {}) };
    }
    case 'reasoning': {
      const text = String(item.text ?? '');
      return {
        kind: 'think',
        label: oneLine(text) || THINK_MARKER,
        ...(text.trim() ? { full: text } : {}),
      };
    }
    case 'command_execution':
      return {
        kind: 'bash',
        command: String(item.command ?? '').slice(0, 2000),
        label: `$ ${oneLine(item.command, 60)}`,
      };
    case 'file_change': {
      // `changes` is a list of touched paths; the daemon counts distinct files,
      // so emit one activity per path rather than one for the batch.
      const first = (item.changes ?? [])[0] ?? {};
      const p = String(first.path ?? '');
      const tail = p.split('/').slice(-2).join('/');
      const verb = first.kind === 'add' ? '+' : first.kind === 'delete' ? '-' : '~';
      return { kind: 'write', path: p, label: `${verb} ${tail || 'file'}` };
    }
    case 'mcp_tool_call': {
      // A FAILED CALL KEEPS ITS OWN WORDS (2026-09-29), beside a label that is
      // unchanged: codex-cli 0.156.1 closes a call it would not run as
      // `status: "failed"`, `error.message` "MCP tool call requires approval,
      // but approval policy is never" (measured), and the tab lane says so
      // in words (codexRelay.mjs) instead of leaving a chat that staged nothing.
      const error = String(item.error?.message ?? '');
      return { kind: 'tool', label: `${item.server ?? 'mcp'}.${item.tool ?? ''}`, ...(error ? { error } : {}) };
    }
    case 'web_search':
      return { kind: 'search', label: `search ${oneLine(item.query, 60)}` };
    default:
      return null;
  }
}

/**
 * Codex `--json` emits JSONL of ThreadEvents. Returns `{ activity, text,
 * threadId }` — `text` accumulates the agent's own words, because the turn
 * loop reads its sentinels (NOTHING / BLOCKED:<id> / DONE) out of exactly
 * that; `threadId` surfaces once, off the lifecycle event, for callers that
 * need to resume THIS conversation later (runTurn's onThreadId).
 */
export function parseCodexLine(line, cwd) {
  let ev;
  try {
    ev = JSON.parse(line);
  } catch {
    return null; // not every line is JSON (warnings go to stderr, but be safe)
  }
  switch (ev.type) {
    // The conversation's own id, announced before any item (`ThreadStarted` on
    // the shipped 0.147 binary, like the measured events below). Surfaced so a
    // SESSION turn can resume this exact thread next time: `resume --last` is
    // a machine-global guess, and on a box running two tabs — or a tab plus a
    // dispatch — it resumes someone else's conversation. No activity and no
    // text: nothing here is the model speaking.
    case 'thread.started':
      return { activity: null, text: '', threadId: String(ev.thread_id ?? '') || null };
    case 'item.completed': {
      const item = ev.item ?? {};
      const activity = humanizeCodexItem(item, cwd);
      // Only the agent's MESSAGES are sentinel-bearing text. Reasoning is not:
      // a model that muses "I could output NOTHING here" must not end the turn.
      const isMessage = (item.item_type ?? item.type) === 'agent_message';
      const text = isMessage ? `${item.text ?? item.message ?? ''}\n` : '';
      // `answer` is the SAME message, surfaced alone: `text` accumulates every
      // message plus every error and stderr line, so a caller that needs "what
      // the agent said LAST" (the agent lane's final JSON object) cannot recover
      // it from `out`. Claude's stream has this for free under
      // `answerFromResult`; codex needed it said.
      return { activity, text, ...(isMessage ? { answer: String(item.text ?? item.message ?? '') } : {}) };
    }
    // THE TURN'S OWN TOKEN COUNT (2026-09-24). `codex exec --json` closes a
    // turn with `turn.completed` carrying `usage` — the codex twin of Claude's
    // `result.usage`, and until now dropped on the floor, so a codex agent
    // reported no spend at all. Mapped onto the daemon's four counters:
    // OpenAI's `input_tokens` INCLUDES the cached part, Claude's excludes it,
    // so the cached share is subtracted out rather than counted twice. Codex
    // has no cache-creation figure; zero is what it reported, not a guess.
    // Output already includes reasoning tokens on OpenAI's side.
    case 'turn.completed': {
      const u = ev.usage;
      if (!u || typeof u !== 'object') return null;
      const n = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.floor(Number(v)) : 0);
      const cached = n(u.cached_input_tokens);
      return {
        activity: null,
        text: '',
        // `usageFromResult`'s shape (claudeStream.mjs), so every consumer of
        // `onUsage` reads one vocabulary whichever CLI counted it.
        usage: {
          input: Math.max(0, n(u.input_tokens) - cached),
          output: n(u.output_tokens),
          cacheCreate: 0,
          cacheRead: cached,
        },
      };
    }
    case 'turn.failed': {
      // An error is prose too, and the sentence that explains a failed turn is
      // routinely longer than a 140-char label — a stack-shaped message loses
      // its cause exactly where somebody is reading to find it.
      //
      // THE LABEL KEEPS ITS OWN `??`, not `msg || …`, and the difference is one
      // input: an EXPLICITLY EMPTY message. `??` lets `''` through as an empty
      // label, which every consumer swallows (`if (!label)`); `||` would print
      // "turn failed" and fire a pulse where this daemon printed nothing. That
      // may well be the better readout, but it is a change to the console and
      // the pulse, and `full` shipped on the promise that neither moved — so it
      // is argued for on its own day, not smuggled in beside a relay field.
      const msg = String(ev.error?.message ?? '');
      return {
        activity: {
          kind: 'error',
          label: oneLine(ev.error?.message ?? 'turn failed'),
          ...(msg.trim() ? { full: msg } : {}),
        },
        // THE FAILURE'S OWN WORDS REACH `text` (2026-09-24), the rule the bare
        // `error` arm below already keeps. This returned '' — so a codex turn
        // that failed on a usage limit handed the limit matcher nothing, the
        // agent landed in Stuck as "produced no output", and every other codex
        // agent kept spending into the same wall.
        text: msg.trim() ? `${msg}\n` : '',
      };
    }
    // A bare `error` event — the shape an auth failure arrives in ("401
    // Unauthorized: Missing bearer…", observed against 0.147.0 with no
    // credentials). It used to fall through to `default` and be dropped, which
    // meant a signed-out Codex produced an EMPTY turn: no sentinel, so the
    // driver nudged twice and reported `stalled`, and the thread said the agent
    // gave up rather than that the CLI is not signed in. The message goes into
    // `text` so it reaches the operator's console AND the usage-limit
    // classifier, which reads exactly this stream.
    case 'error': {
      // Same split as the arm above: `??` for the label (untouched behaviour),
      // `msg` for the relay field only.
      const msg = String(ev.message ?? '');
      return {
        activity: {
          kind: 'error',
          label: oneLine(ev.message ?? 'error'),
          ...(msg.trim() ? { full: msg } : {}),
        },
        text: `${ev.message ?? ''}\n`,
      };
    }
    default:
      return null; // turn.started / item.started / item.updated
  }
}

// ── Antigravity ────────────────────────────────────────────────────────────

/**
 * `agy --output-format stream-json` emits `{event: init|step_update|result}`.
 * Tool names read off a live 1.1.12 session rather than guessed.
 */
function humanizeAgyTool(name, p = {}, cwd = '') {
  const path = p.TargetFile ?? p.AbsolutePath ?? p.DirectoryPath ?? p.File ?? '';
  const tail = String(path).split('/').slice(-2).join('/');
  switch (name) {
    case 'view_file':
    case 'read_resource':
      return { kind: 'read', label: `read ${shortPath(path, cwd)}` };
    case 'write_to_file':
    case 'replace_file_content':
    case 'multi_replace_file_content':
      return {
        kind: 'write',
        path: String(path),
        label: `${name === 'write_to_file' ? '+ page' : '~ page'} ${tail || 'file'}`,
      };
    case 'grep_search':
      return { kind: 'search', label: `grep ${oneLine(p.Query ?? p.SearchTerm ?? '', 60)}` };
    case 'find_by_name':
      return { kind: 'glob', label: `find ${oneLine(p.Pattern ?? '', 60)}` };
    case 'list_dir':
      return { kind: 'list', label: `ls ${shortPath(path, cwd)}` };
    case 'run_command':
      return {
        kind: 'bash',
        command: String(p.CommandLine ?? '').slice(0, 2000),
        label: `$ ${oneLine(p.CommandLine, 60)}`,
      };
    case 'call_mcp_tool':
      return { kind: 'tool', label: `mcp.${p.ToolName ?? ''}` };
    default:
      return null;
  }
}

export function parseAgyLine(line, cwd) {
  let ev;
  try {
    ev = JSON.parse(line);
  } catch {
    return null;
  }
  if (ev.event === 'step_update') {
    const su = ev.step_update ?? {};
    const ti = su.tool_info;
    if (!ti) return null;
    const err = ti.error?.message;
    // Same rule as codex's error lines: the label is the console's, `full` is
    // the trace's, and a tool error's message is exactly the kind of sentence a
    // 140-char clamp cuts the cause out of.
    if (err)
      return {
        activity: { kind: 'error', label: oneLine(err), full: String(err) },
        text: '',
      };
    // Each tool is reported twice — once ACTIVE, once DONE — so only the
    // terminal state emits, otherwise every action appears in the thread twice.
    if (su.state && su.state !== 'DONE') return null;
    return { activity: humanizeAgyTool(ti.name, ti.parameters ?? {}, cwd), text: '' };
  }
  if (ev.event === 'result') {
    const r = ev.result ?? {};
    // The final answer is the ONLY sentinel-bearing text: agy has no incremental
    // assistant-message event, so a turn's whole verdict arrives here at once.
    return {
      activity: r.error
        ? { kind: 'error', label: oneLine(r.error), full: String(r.error) }
        : null,
      text: `${r.response ?? ''}${r.error ? `\n${r.error}` : ''}\n`,
    };
  }
  return null;
}
