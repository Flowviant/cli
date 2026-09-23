/**
 * Driving a coding CLI: the operating-contract system prompts, the permission
 * posture, and one headless turn. The hard rule baked into both prompts: there
 * is no interactive user — the only channel to a human is the blocker loop.
 *
 * `runTurn` used to BE `claude -p`, argv and all. The argv, the binary, the way
 * the MCP server is handed over and the shape of the event stream now come from
 * the runtime registry (runtimes.mjs), because those four things are exactly
 * what differs between one CLI and the next. What stays here is everything that
 * is about FLOWVIANT rather than about a vendor: the contract prompts, the
 * permission sets, the sentinel protocol, and the turn plumbing.
 */

import { spawn } from 'node:child_process';
import { SAFE } from './config.mjs';
import { runtimeById, humanizeClaudeTool, THINK_MARKER } from './runtimes.mjs';

// Every prompt/kickoff constant lives in prompts.mjs and is re-exported here:
// a dozen call sites import them from claude.mjs, and none of them care where
// the strings live.
export * from './prompts.mjs';

/**
 * PLAN — read the repo, write the plan, never the code.
 *
 * The read half is CONSULT_PERM verbatim: this turn's prompt is steered by
 * anything a project editor can type, so the same threat applies and the same
 * allowlist answers it. What is added is the control plane and NOTHING else —
 * `mcp__flowviant` is the plan principal's token, whose entire tool set is the
 * five plan tools (the server refuses anything else on it). So even a fully
 * hijacked turn's most destructive reachable act is dropping a slice from the
 * plan it is already in, which a human can see and undo in the thread.
 *
 * Note what is absent versus WIKI_PERM: Write, Edit, mkdir and rm. The
 * cartographer needs those because it authors files; a planner authors records
 * through an API, and there is no file on this machine it has any business
 * touching.
 */
const PLAN_PERM = [
  '--allowedTools',
  'mcp__flowviant',
  'Read',
  'Grep',
  'Glob',
  'Bash(ls:*)',
  'Bash(wc:*)',
  'Bash(head:*)',
  'Bash(cat:*)',
  'Bash(git log:*)',
  'Bash(git show:*)',
  'Bash(git diff:*)',
  'Bash(git rev-parse:*)',
];

// Unattended (default) skips prompts so the agent never stalls with no terminal;
// FLOWVIANT_SAFE=1 restricts to a curated toolset instead.
const PERM = SAFE
  ? [
      '--allowedTools',
      'mcp__flowviant',
      'Edit',
      'Write',
      'Read',
      'Grep',
      'Glob',
      'Bash(git:*)',
      'Bash(gh:*)',
      'Bash(npm:*)',
      'Bash(bun:*)',
    ]
  : ['--dangerously-skip-permissions'];

// Wiki turns are read-the-repo + write-the-vault ONLY — always curated, never
// --dangerously-skip-permissions: no gh, no push-capable git, no package
// managers, and nothing that can EXECUTE arbitrary commands — no `find`
// (-exec/-delete) and no `git grep` (-O<pager> runs a shell; the Grep tool
// covers search). Command execution is the line: it enables network exfil,
// which plain file writes never do. `rm` IS allowed: pruning a stale vault
// page requires a real file deletion (that's how the sync protocol learns of
// it), and the blast radius is bounded — the daemon resets the repo worktree
// after every wiki turn, and the vault has its own git history.
// (Write/Edit can't be path-scoped here; the worktree reset is the backstop.)
const WIKI_PERM = [
  '--allowedTools',
  'Read',
  'Grep',
  'Glob',
  'Edit',
  'Write',
  'Bash(ls:*)',
  'Bash(wc:*)',
  'Bash(head:*)',
  'Bash(cat:*)',
  'Bash(mkdir:*)',
  'Bash(rm:*)',
  'Bash(git status:*)',
  'Bash(git log:*)',
  'Bash(git show:*)',
  'Bash(git diff:*)',
  'Bash(git rev-parse:*)',
];

// A CONSULT reads and answers. Nothing else.
//
// It used to run on WIKI_PERM, whose comment two blocks up says the quiet part:
// Write/Edit "can't be path-scoped here; the worktree reset is the backstop".
// That is a fine trade for the cartographer, which exists to author files and
// gets reset after every turn. It is the wrong trade for a consult, whose prompt
// is steered by a question ANY project editor can write and which had no reset
// behind it — so a sentence in a chat box could reach Write, rm and mkdir on
// someone else's machine. The permission list is the enforcement; the prompt's
// "do not change anything" is only an instruction, and instructions are exactly
// what an injected question competes with.
const CONSULT_PERM = [
  '--allowedTools',
  'Read',
  'Grep',
  'Glob',
  'Bash(ls:*)',
  'Bash(wc:*)',
  'Bash(head:*)',
  'Bash(cat:*)',
  'Bash(git log:*)',
  'Bash(git show:*)',
  'Bash(git diff:*)',
  'Bash(git rev-parse:*)',
];

export const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));

// Sentinels must appear on their OWN line (the prompts require it). Substring
// matching falsely fired when an agent merely *mentioned* the word in prose
// (e.g. "I won't fabricate a BLOCKED:<id> line"), trapping the worker in a fake
// blocked loop. Anchor to a full line instead.
export const sawSentinel = (out, name) => new RegExp(`^\\s*${name}\\s*$`, 'm').test(out);
export const blockedId = (out) => {
  const m = out.match(/^\s*BLOCKED:(\S+)\s*$/m);
  return m ? m[1] : null;
};

/**
 * Hand a runtime the flowviant MCP server, however that runtime wants it.
 *
 * Returns `{ dir, args, env }`: `dir` is a temp directory to delete after the
 * turn (null when the runtime needed no file at all), `args` splice into argv,
 * `env` merges into the child's environment. The shape is identical for every
 * runtime precisely because the mechanism is not — Claude wants a JSON file
 * path, Codex wants two `-c` overrides and reads the token out of the
 * environment. Callers should not have to know which.
 */
export function mcpFor(runtimeId, token, mcpUrl) {
  const rt = runtimeById(runtimeId);
  if (!rt.mcp) throw new Error(`runtime '${rt.id}' cannot take an MCP server: ${rt.blocked}`);
  return rt.mcp(token, mcpUrl);
}

// Turn one Claude tool_use into a compact activity {kind, label}, or null for
// tools not worth surfacing. `kind:'read'` is what the file counter counts; a
// Write/Edit of a vault page is the "writing" signal. Used by wiki turns to
// stream exactly which files Claude is touching (daemon console + app cover).
//
// The body moved to runtimes.mjs, beside Codex's equivalent, because they are
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
export function handleStreamLine(line, { cwd, emit, onActivity, onToolEvent, appendText, answerFromResult, onInit, onUsage }) {
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
    // and `localSessions.mjs` offers the newest ended session per directory as
    // ADOPTABLE — so any headless turn we run for our own purposes would leave
    // a phantom untitled session in the `+` menu. The caller that needs to
    // clean up after itself cannot do so without this id.
    if (Array.isArray(ev.skills) || typeof ev.session_id === 'string') {
      onInit?.({
        skills: Array.isArray(ev.skills) ? ev.skills.map(String) : undefined,
        sessionId: typeof ev.session_id === 'string' ? ev.session_id : undefined,
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
  }
}

// One Claude Code turn. Output is captured (for sentinel detection) and streamed
// through, line-prefixed with the worker label so a fleet stays legible.
//
// `streamJson` switches to `--output-format stream-json` and parses the event
// stream: only the humanized tool activity reaches the console (a legible
// stream of `read …`, `grep …`, `+ node …`), assistant text is folded into the
// returned string for sentinel detection, and each activity is handed to
// `onActivity` so the caller can forward progress. Build-agent turns leave it
// off and keep the raw text passthrough + line sentinels.
export function runTurn({ prompt, resume, system, cwd, mcpConfig, mcpArgs, mcpEnv, runtime = 'claude', label, onSpawn, streamJson, answerFromResult, onActivity, onToolEvent, onInit, onUsage, onThreadId, wikiPerm, readOnly, planPerm, vaultDir, knowledgeDir, resultSchemaArgs, model, effort, adoptResumeId, resumeThreadId, resumeConversationId }) {
  return new Promise((resolve) => {
    const rt = runtimeById(runtime);
    if (!rt.args) {
      // Reached only if a brief names a runtime this daemon declares but cannot
      // drive. Fail as a turn with no sentinel — the loop already treats that as
      // "the protocol did not complete" and retries, rather than inventing a
      // completion for work that never started.
      console.error(`\nerror: cannot run '${rt.label}' — ${rt.blocked}`);
      resolve('');
      return;
    }
    // Pin the model — never inherit the user's global default (which for Claude
    // may be a 1M/long-context tier their subscription can't bill autonomous
    // work on). A per-task override (chosen in the app, validated server-side
    // against a fixed list before it ever reaches this argv) wins over the
    // machine pin; absent, the pin stands. Effort has no machine-level pin at
    // all: unset means the CLI's own default, the honest resting state.
    //
    // readOnly wins over wikiPerm: a consult must never inherit write tools.
    //
    // TWO FORMS OF THE SAME DECISION, and the redundancy is deliberate rather
    // than sloppy. `profile` is the NAME of the posture — a promise about what
    // must be impossible during the turn — and every runtime expresses it in its
    // own vocabulary: Claude as an `--allowedTools` verb list, Codex as a kernel
    // sandbox mode plus feature toggles. `perm` is Claude's expression, still
    // computed here only because those three arrays live in this file; it
    // collapses into the registry the day every runtime expresses every profile.
    // Both derive from the same branch, so they cannot disagree about which
    // posture a turn is running under.
    // `plan` is asked FIRST, above readOnly, because it is the narrower promise
    // of the two and a planning turn that fell through to 'consult' would lose
    // the control plane it exists to use — it would read the repo, decide what
    // the slices are, and have no way to write any of them down.
    const profile = planPerm ? 'plan' : readOnly ? 'consult' : wikiPerm ? 'wiki' : 'build';
    const args = rt.args({
      prompt,
      system,
      model,
      effort,
      resume,
      streamJson,
      profile,
      // Adopting a terminal session (work.mjs): Claude turns it into
      // `--resume <id> --fork-session` (a FORK — the original is untouched);
      // agy turns it into `--conversation <id>` (a MOVE — agy has no fork, the
      // tab continues the terminal conversation itself). Codex THROWS on it,
      // so a mis-wired adoption fails as a loud turn error rather than a
      // silent fresh conversation wearing an adopted session's name.
      adoptResumeId,
      // Only the wiki profile uses it, but it is passed unconditionally: a
      // runtime that can path-scope its writes needs to know WHERE the vault is,
      // and Claude — which cannot — simply ignores it.
      vaultDir,
      // THE PROJECT'S KNOWLEDGE LIBRARY (0.94.0), when this box holds one. It
      // lives in the CHECKOUT and a turn usually runs in a worktree, so the
      // prompt hands an absolute path OUTSIDE the cwd — and a curated Claude
      // profile (the capture chat's read-only list, `FLOWVIANT_SAFE=1`) may
      // refuse a read there. `--add-dir` says the directory is one it may read.
      // Only Claude's adapter uses it; codex's sandboxes read the filesystem
      // already, and agy's `--add-dir` is spent on the wiki vault.
      knowledgeDir,
      // Structured-output flags for the MEDIATED path. Handed to the adapter
      // rather than appended here for the same reason `mcp` is: Codex takes its
      // prompt as a trailing positional, so a flag after it is in the wrong
      // place.
      resultSchemaArgs,
      perm: planPerm ? PLAN_PERM : readOnly ? CONSULT_PERM : wikiPerm ? WIKI_PERM : PERM,
      // Handed to the adapter rather than appended here, because WHERE these go
      // is a property of the CLI: Codex reads its prompt as a trailing
      // positional, so a flag after it is a flag in the wrong place.
      // Wiki-vault turns are pure file work and pass neither — no MCP at all.
      mcp: mcpConfig ? ['--mcp-config', mcpConfig] : (mcpArgs ?? []),
      // Resuming a SPECIFIC held conversation by its own id (work.mjs, codex
      // sessions). Runtimes without a by-id resume ignore it and keep their
      // `resume` behavior unchanged.
      resumeThreadId,
      // agy's by-id resume (work.mjs, antigravity sessions): the conversation
      // id learned from the adopt hint or the cwd registry after a turn.
      resumeConversationId,
    });
    // Whatever this machine is signed in with, we use. We do NOT pick.
    //
    // This used to delete ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN to force
    // the subscription path, which was right when the daemon ran on a
    // developer's laptop: a key left in their shell would silently bill every
    // turn as raw API usage instead of the plan they were already paying for.
    // On a machine the project leaves running, an inherited org key is the
    // POINT — deleting it is the daemon overriding the credential its operator
    // deliberately configured.
    //
    // Which credential is correct, and whether an account may be shared, is
    // between the operator and the vendor. Flowviant does not detect it and does
    // not enforce it; it runs the CLI the ordinary way and relays what happens.
    const child = spawn(rt.bin, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      /**
       * ITS OWN PROCESS GROUP, so what the agent starts stays attributable.
       *
       * Everything the CLI spawns inherits this pgid and KEEPS it through
       * `nohup` and `setsid` — which is exactly when attribution by descendancy
       * fails, because reparenting to init breaks the ppid chain the moment a
       * process becomes long-running. `processes.mjs` reads the group; the
       * Workbench renders it.
       *
       * TEARDOWN IS DELIBERATELY UNCHANGED: `shutdownWork` still SIGTERMs this
       * CHILD and never the group. Signalling the group would kill the dev
       * server the driver started every time the daemon restarts — including
       * on an ordinary auto-update, unattended — which is the outcome the
       * deleted dev-run supervisor spent a whole registry avoiding. Flowviant
       * does not manage those processes; it reports them.
       *
       * Not `unref`'d: the daemon must still wait on this turn.
       */
      detached: true,
      // Only ADDS to the environment (the worker token, for runtimes that read
      // it from there). Never replaces it: the CLI's own credentials live in
      // this environment, and handing it a curated one signs it out.
      ...(mcpEnv ? { env: { ...process.env, ...mcpEnv } } : {}),
    });
    onSpawn?.(child);
    let out = '';
    const pfx = label ? `${label} ` : '';
    const emit = (s) => process.stdout.write(pfx ? s.replace(/\n/g, `\n${pfx}`) : s);

    // A runtime with its own parser is ALWAYS line-parsed — for Codex the JSONL
    // stream is the only output there is, so treating it as raw text would print
    // event objects at the operator and, worse, hand the sentinel matcher a
    // string containing every word the model reasoned about.
    const lineParsed = streamJson || Boolean(rt.parse);
    if (lineParsed) {
      let buf = '';
      const appendText = (t) => {
        out += t;
      };
      /** One line of the child's stdout, in whichever dialect it speaks. */
      const onLine = (line) => {
        if (!rt.parse)
          return handleStreamLine(line, { cwd, emit, onActivity, onToolEvent, appendText, answerFromResult, onInit, onUsage });
        const ev = rt.parse(line, cwd);
        if (!ev) return;
        // The conversation id, when the runtime announces one (codex's
        // thread.started). Purely additive: callers that pass no onThreadId —
        // every dispatch path — see zero behavior change.
        if (ev.threadId) onThreadId?.(ev.threadId);
        if (ev.text) appendText(ev.text);
        if (ev.activity) {
          emit(`${ev.activity.label}\n`);
          onActivity?.(ev.activity);
        }
      };
      child.stdout.on('data', (d) => {
        buf += d.toString();
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (line.trim()) onLine(line);
        }
      });
      // stderr is not JSON (warnings/errors) — pass through and keep for sentinels.
      child.stderr.on('data', (d) => {
        const s = d.toString();
        out += s;
        emit(s);
      });
      child.on('error', (e) => {
        if (e.code === 'ENOENT') {
          // A MISSING CLI FAILS THE TURN, NOT THE DAEMON. This called
          // process.exit(1), which was defensible while `claude` was the only
          // runtime and preflight refused to start without it — the process
          // could not reach here. Both halves of that are gone: preflight is now
          // fatal only when NOTHING is drivable, so a Codex-only machine starts
          // legitimately, and the wiki/plan-check/consult turns still ask for
          // Claude by default. On such a machine the first wiki sweep would have
          // killed the whole daemon, taking every in-flight build with it,
          // because one background job could not find one binary.
          console.error(`\nerror: '${rt.bin}' CLI not found on PATH. Install ${rt.label} first: ${rt.install}`);
          resolve('');
          return;
        }
        console.error(e);
        resolve(out);
      });
      child.on('close', () => {
        if (buf.trim()) onLine(buf);
        resolve(out);
      });
      return;
    }

    const onChunk = (d) => {
      const s = d.toString();
      out += s;
      emit(s);
    };
    child.stdout.on('data', onChunk);
    child.stderr.on('data', onChunk);
    child.on('error', (e) => {
      if (e.code === 'ENOENT') {
        // A MISSING CLI FAILS THE TURN, NOT THE DAEMON — same fix as the
        // line-parsed path above; this raw-output duplicate used to
        // process.exit(1) and take every in-flight worker down with it.
        console.error(`\nerror: '${rt.bin}' CLI not found on PATH. Install ${rt.label} first: ${rt.install}`);
        resolve('');
        return;
      }
      console.error(e);
      resolve(out);
    });
    child.on('close', () => resolve(out));
  });
}
