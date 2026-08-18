/**
 * WHICH CLI builds a task, and how you drive it.
 *
 * The daemon spoke exactly one runtime for its whole life, and that assumption
 * is spread thinner than it looks: `claude -p` argv in one place, but also a
 * `--mcp-config` file, an `--append-system-prompt`, a `stream-json` event schema
 * and a set of sentinel words the turn loop reads out of stdout. A second CLI is
 * not a different binary name — it is a different answer to each of those.
 *
 * So each runtime declares its own answers here, and everything else in the
 * daemon asks this module rather than knowing them.
 *
 * WHAT A RUNTIME MUST BE ABLE TO DO to build a Flowviant task at all:
 *   1. run headless from one prompt and exit,
 *   2. talk to the flowviant MCP server — this is the whole control plane, and a
 *      runtime that cannot reach it cannot claim work, report a blocker, attach
 *      a PR or complete, which is to say it cannot participate,
 *   3. act without asking permission per tool call (there is no terminal here),
 *   4. emit machine-readable progress, or the thread goes silent for the length
 *      of a build.
 * Claude Code and Codex both do all four. Antigravity does 1, 3 and 4 and is
 * declared below with the exact reason it cannot yet do 2.
 *
 * BUT ONLY A BUILD NEEDS ALL FOUR, and that qualifier was missing long enough to
 * cost Antigravity every capability it has. Requirement 2 is the CONTROL PLANE —
 * claiming, blockers, PRs, completing — and only a build uses it. A wiki turn
 * writes markdown the daemon syncs afterwards; a consult answers a question in
 * prose. Both already run with no MCP on every runtime, Claude included. So
 * drivability is per PROFILE (`canRun`), not one verdict per runtime, and a CLI
 * that cannot be handed a per-invocation MCP config is still a perfectly good
 * cartographer.
 *
 * WHAT THIS MODULE DELIBERATELY DOES NOT DO: pick. Which runtime runs a task is
 * decided in the app, by @mentioning it (CLAUDE.md: the @mention is the only
 * dispatch), and arrives on the brief. Detection here answers "what does this
 * machine HAVE" — activity, never capacity, and never a default we invented.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SAFE, MODEL, USER_AGENT } from './config.mjs';

/** Truncate for a one-line activity label. */
const oneLine = (s, n = 140) =>
  String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

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
      return { kind: 'bash', label: `$ ${oneLine(input.command, 60)}` };
    default:
      return null; // other tools: silent
  }
}

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
    case 'agent_message':
      return { kind: 'say', label: oneLine(item.text ?? item.message) };
    case 'reasoning':
      return { kind: 'think', label: oneLine(item.text) || 'thinking…' };
    case 'command_execution':
      return { kind: 'bash', label: `$ ${oneLine(item.command, 60)}` };
    case 'file_change': {
      // `changes` is a list of touched paths; the daemon counts distinct files,
      // so emit one activity per path rather than one for the batch.
      const first = (item.changes ?? [])[0] ?? {};
      const p = String(first.path ?? '');
      const tail = p.split('/').slice(-2).join('/');
      const verb = first.kind === 'add' ? '+' : first.kind === 'delete' ? '-' : '~';
      return { kind: 'write', path: p, label: `${verb} ${tail || 'file'}` };
    }
    case 'mcp_tool_call':
      return { kind: 'tool', label: `${item.server ?? 'mcp'}.${item.tool ?? ''}` };
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
function parseCodexLine(line, cwd) {
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
      const text =
        (item.item_type ?? item.type) === 'agent_message'
          ? `${item.text ?? item.message ?? ''}\n`
          : '';
      return { activity, text };
    }
    case 'turn.failed':
      return {
        activity: { kind: 'error', label: oneLine(ev.error?.message ?? 'turn failed') },
        text: '',
      };
    // A bare `error` event — the shape an auth failure arrives in ("401
    // Unauthorized: Missing bearer…", observed against 0.147.0 with no
    // credentials). It used to fall through to `default` and be dropped, which
    // meant a signed-out Codex produced an EMPTY turn: no sentinel, so the
    // driver nudged twice and reported `stalled`, and the thread said the agent
    // gave up rather than that the CLI is not signed in. The message goes into
    // `text` so it reaches the operator's console AND the usage-limit
    // classifier, which reads exactly this stream.
    case 'error':
      return {
        activity: { kind: 'error', label: oneLine(ev.message ?? 'error') },
        text: `${ev.message ?? ''}\n`,
      };
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
      return { kind: 'bash', label: `$ ${oneLine(p.CommandLine, 60)}` };
    case 'call_mcp_tool':
      return { kind: 'tool', label: `mcp.${p.ToolName ?? ''}` };
    default:
      return null;
  }
}

function parseAgyLine(line, cwd) {
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
    if (err) return { activity: { kind: 'error', label: oneLine(err) }, text: '' };
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
      activity: r.error ? { kind: 'error', label: oneLine(r.error) } : null,
      text: `${r.response ?? ''}${r.error ? `\n${r.error}` : ''}\n`,
    };
  }
  return null;
}

// ── The registry ───────────────────────────────────────────────────────────

/**
 * How each runtime is told about the flowviant MCP server.
 *
 * This is the part that differs most, and it is worth naming why it matters:
 * the token handed over here is a WORKER token scoped to one lane, minted fresh
 * and dropped at the end of the turn. Anything that forces a machine-wide config
 * file forces one shared token for every lane instead, which is a real downgrade
 * in blast radius — so a runtime that cannot take per-invocation config does not
 * get to run, rather than getting to run less safely.
 *
 * Claude takes a config file path (`--mcp-config`), so the token lands in a
 * 0600 temp file the caller deletes. Codex takes dotted `-c` overrides and can
 * read the bearer token from an ENV VAR (`bearer_token_env_var`), so its token
 * never touches disk at all — strictly better, and the reason Codex was the
 * first second-runtime rather than the easiest-looking one.
 */
function claudeMcp(token, mcpUrl) {
  const dir = mkdtempSync(join(tmpdir(), 'flowviant-mcp-'));
  const path = join(dir, 'mcp.json');
  writeFileSync(
    path,
    JSON.stringify({
      mcpServers: {
        flowviant: {
          type: 'http',
          url: mcpUrl,
          headers: { Authorization: `Bearer ${token}`, 'User-Agent': USER_AGENT },
        },
      },
    }),
    { mode: 0o600 }
  );
  return { dir, args: ['--mcp-config', path], env: {} };
}

function codexMcp(token, mcpUrl) {
  return {
    dir: null, // nothing written — the token rides in the environment
    args: [
      '-c',
      `mcp_servers.flowviant.url="${mcpUrl}"`,
      '-c',
      'mcp_servers.flowviant.bearer_token_env_var="FLOWVIANT_MCP_TOKEN"',
    ],
    env: { FLOWVIANT_MCP_TOKEN: token },
  };
}

export const RUNTIMES = {
  claude: {
    id: 'claude',
    label: 'Claude Code',
    vendor: 'Anthropic',
    bin: 'claude',
    install: 'npm i -g @anthropic-ai/claude-code',
    login: 'claude',
    /** The Agent-SDK live session (persistent, injectable mid-task) is Claude
     *  only — it is an Anthropic SDK, not a CLI contract. Everything else runs
     *  the subprocess path. */
    live: true,
    /**
     * Every profile, because every profile is DEFINED in its vocabulary: the
     * four `--allowedTools` lists in claude.mjs are what "build", "wiki",
     * "consult" and "plan" currently mean. That is a statement about where the
     * contract was written, not a claim that only Claude could ever satisfy it.
     */
    profiles: ['build', 'wiki', 'consult', 'plan'],
    mcp: claudeMcp,
    /**
     * Claude takes the operating contract as a real system prompt, which is the
     * strongest form of it available anywhere: `--append-system-prompt` sits
     * above the conversation rather than inside it.
     */
    args({ prompt, system, model, effort, resume, streamJson, perm, mcp = [], resultSchemaArgs = [], adoptResumeId }) {
      const a = [];
      // ADOPTION — the first turn of a tab born from a terminal session.
      // `--resume <id> --fork-session` finds the session globally (any cwd),
      // carries its full context, and writes the FORK natively into THIS cwd's
      // own store, leaving the original transcript untouched (measured on
      // 2.1.234). From turn 2 on the plain `--continue` below resumes the fork
      // where it now lives, so nothing downstream knows the tab was adopted.
      // INSTEAD of --continue, never alongside it: they are the same decision
      // ("what conversation is this?") answered two different ways.
      if (adoptResumeId) a.push('--resume', adoptResumeId, '--fork-session');
      else if (resume) a.push('--continue');
      a.push('-p', prompt, '--append-system-prompt', system);
      a.push(...mcp, ...resultSchemaArgs);
      a.push('--model', model || MODEL);
      if (effort) a.push('--effort', effort);
      if (streamJson) a.push('--output-format', 'stream-json', '--verbose');
      a.push(...perm);
      return a;
    },
    parse: null, // claude.mjs owns its own stream parser (unchanged)
  },

  codex: {
    id: 'codex',
    label: 'Codex',
    vendor: 'OpenAI',
    bin: 'codex',
    install: 'npm i -g @openai/codex',
    login: 'codex login',
    live: false,
    /**
     * BUILD AND CONSULT. See `args()` below for how consult is expressed — the
     * short version is that Codex keeps the promise at the kernel rather than in
     * a verb allowlist, and for a consult's actual threat (exfiltration driven
     * by an injected question) that is sufficient and arguably stronger.
     *
     * ALL THREE, and `wiki` is the one worth pausing on: Codex expresses it
     * MORE strictly than Claude does. A cartographer must read the repo and
     * write only the vault; Claude's WIKI_PERM cannot path-scope Write and says
     * so, leaning on the worktree reset as a backstop. Codex's permission
     * profiles enforce the same rule in the kernel — measured: repo readable,
     * vault writable, repo writes refused, network off.
     *
     * Enforcement was verified on Linux (bubblewrap + seccomp). macOS Seatbelt
     * and Windows are UNTESTED; if this daemon starts running there, re-verify
     * before trusting the consult posture on those platforms.
     */
    profiles: ['build', 'consult', 'wiki', 'plan'],
    mcp: codexMcp,
    /**
     * Codex has NO system-prompt flag. The contract therefore rides inside the
     * prompt, fenced and placed first, and this is a genuine weakening worth
     * stating plainly: a system prompt is a rule, and a prompt preamble is a
     * strong suggestion the model may drift from over a long turn. It is the
     * best available; AGENTS.md was the alternative and is worse, because it is
     * a FILE IN THE WORKTREE — one `git add -A` from being committed into the
     * user's repository, which is not a risk worth taking for a slightly
     * stickier instruction.
     *
     * `--skip-git-repo-check` is deliberately NOT passed: a task always builds
     * in a git worktree, and if it somehow is not one, failing loudly beats
     * silently editing files nobody can diff.
     *
     * THE PROMPT IS LAST, and that is load-bearing rather than tidy. Codex takes
     * it as a trailing POSITIONAL, so every flag — including the two `-c` MCP
     * overrides, which the caller hands in rather than appending — has to be
     * placed before it. Appending them after the positional is the kind of argv
     * that parses today and stops parsing on some future clap upgrade.
     */
    args({ prompt, system, model, effort, resume, resumeThreadId, profile = 'build', vaultDir, mcp = [], resultSchemaArgs = [], adoptResumeId }) {
      // Adoption resumes a conversation in ITS OWN CLI's store (claude forks,
      // agy moves) — codex has no adoptable store wired yet. Reaching here
      // with an adopt id is a wiring mistake upstream, and it fails loudly on
      // purpose: quietly dropping the flag would answer that session's held
      // context with a different brain.
      if (adoptResumeId) throw new Error("codex has no adoptable terminal store — an adopt id can't reach this builder");
      const a = ['exec'];
      // BY ID when the caller knows WHICH conversation this is — a Workbench
      // tab's held context, captured off thread.started and stored with its
      // worktree. `--last` resumes the machine's most recent codex conversation,
      // which is only safe on the dispatch path (one lane, one turn at a time,
      // in its own worktree); for a session it is a machine-global guess that
      // two tabs — or a tab plus a dispatch — would cross-resume.
      if (resumeThreadId) a.push('resume', resumeThreadId);
      else if (resume) a.push('resume', '--last');
      a.push('--json');
      if (model) a.push('--model', model);
      // Effort is a config value on Codex rather than a flag.
      if (effort) a.push('-c', `model_reasoning_effort="${effort}"`);

      if (profile === 'consult') {
        // A CONSULT, EXPRESSED THE ONLY WAY CODEX CAN EXPRESS IT — and it is a
        // different shape from Claude's, which is the whole reason `profile` is
        // a promise rather than a flag list.
        //
        // Claude gets a VERB allowlist: Read, Grep, Glob and a handful of
        // read-only Bash forms, with nothing that reaches the network. Codex has
        // no such thing — it has no file-read tool at all, so reading the repo
        // IS command execution (`cat`, `rg`). Removing the shell leaves the
        // model with exactly ["update_plan","request_user_input"], which cannot
        // answer a question about a codebase. You get both capabilities or
        // neither.
        //
        // So the promise is kept one layer down instead. `read-only` is
        // kernel-enforced (bubblewrap + seccomp on Linux): writes fail, and a
        // direct-IP connect fails with "Operation not permitted" — socket() is
        // denied, not merely DNS. An injected command still RUNS and still
        // cannot take the repository anywhere, which is the threat a consult
        // actually has: its prompt is steered by a question any project editor
        // can type. Arguably a stronger guarantee than the allowlist, being
        // below the agent rather than inside it.
        a.push('--sandbox', 'read-only');

        // THE HOLE THE SANDBOX DOES NOT COVER. `web_search` ships in `codex
        // exec`'s default tool list even without --search, and it executes
        // SERVER-SIDE at OpenAI — no local sandbox touches it. An injected turn
        // could pack repo contents into a query and egress them straight past
        // everything above. Both spellings, because the two config systems
        // disagree about which one is live.
        a.push('-c', 'tools.web_search=false', '-c', 'web_search="disabled"');

        // Sub-agents would be a second turn whose posture nobody here chose.
        a.push('-c', 'features.multi_agent=false', '-c', 'features.goals=false');

        // HERMETIC. Without these a user's ~/.codex/config.toml, a project
        // `.rules` execpolicy file, or their own MCP servers can widen a posture
        // we are asserting on their behalf — silently, and on the one turn whose
        // prompt comes from someone else's typing.
        a.push('--ignore-user-config', '--ignore-rules');
      } else if (profile === 'plan') {
        // A PLANNING SESSION. Read-only on the filesystem, exactly like a
        // consult — the writes it makes go through the control plane, not
        // through this box — so the kernel sandbox is the same one, and for the
        // same reason: this turn's prompt is steered by anything a project
        // editor can type.
        //
        // Everything the consult branch above closes stays closed, and the
        // reasoning is unchanged, so it is not restated: web_search egresses
        // server-side at OpenAI where no local sandbox reaches it, sub-agents
        // would be a turn whose posture nobody here chose, and a user's own
        // config or MCP servers must not widen a posture we are asserting on
        // their behalf.
        //
        // What differs from a consult is the ONE thing this profile exists for:
        // an MCP config IS passed, carrying the plan principal's token. That
        // token's whole tool set is the five plan tools — the server refuses
        // anything else on it — so the control plane being open here does not
        // widen what a hijacked turn could reach beyond the plan it is already
        // sitting in.
        a.push('--sandbox', 'read-only');
        a.push('-c', 'tools.web_search=false', '-c', 'web_search="disabled"');
        a.push('-c', 'features.multi_agent=false', '-c', 'features.goals=false');
        a.push('--ignore-user-config', '--ignore-rules');
      } else if (profile === 'wiki' && vaultDir) {
        // THE CARTOGRAPHER, AND THIS ONE IS STRICTER THAN CLAUDE'S.
        //
        // A wiki turn reads the whole repo and writes ONLY the vault. Claude
        // cannot actually express that: WIKI_PERM hands it Write/Edit and its own
        // comment admits "Write/Edit can't be path-scoped here; the worktree
        // reset is the backstop" — i.e. the cartographer CAN scribble on the
        // checkout and we clean up afterwards.
        //
        // Codex's permission profiles take a per-path filesystem map, so the
        // rule is enforced by the kernel instead of apologised for. Measured:
        // repo readable, vault writable, repo writes fail "Read-only file
        // system", and curl returns 000 — the network is off, which is the half
        // WIKI_PERM was really protecting (its comment: "Command execution is
        // the line: it enables network exfil").
        //
        // The table is set WHOLE rather than as a dotted key, and that is not
        // style: `-c permissions.wiki.filesystem."<path>"="write"` splits the
        // dotted path on the dots INSIDE the path, and every real vault lives
        // under `~/.flowviant/vaults/…`. It fails with "filesystem path must be
        // absolute", which reads like a path problem and is a parsing one.
        a.push('-c', 'permissions.flowviantwiki.extends=":read-only"');
        a.push('-c', `permissions.flowviantwiki.filesystem={"${vaultDir}"="write"}`);
        a.push('-P', 'flowviantwiki');
        a.push('--ignore-user-config', '--ignore-rules');
      } else {
        // The daemon's build posture, mapped: SAFE keeps writes inside the
        // workspace, the default lets the agent run its own tests and git
        // commands. Neither asks a human — there is no human on this end of the
        // pipe. Deliberately NOT hermetic: a build is work the user asked for by
        // @mentioning this CLI, and their own config is theirs to apply.
        a.push('--sandbox', SAFE ? 'workspace-write' : 'danger-full-access');
      }

      a.push(...mcp, ...resultSchemaArgs);
      a.push(`${system}\n\n---\n\n${prompt}`);
      return a;
    },
    parse: parseCodexLine,
    /** `codex exec --output-schema <file>` constrains the FINAL message to a
     *  JSON Schema. Only needed on the mediated path; the direct path reports
     *  through MCP tool calls, which are already structured. */
    resultSchema: (path) => ['--output-schema', path],
  },

  /**
   * DECLARED, NOT DRIVABLE — and this is now MEASURED rather than argued.
   *
   * The reason went wrong twice before it went right, so the evidence is written
   * down here in full. First it cited upstream antigravity-cli#60, which is about
   * `.antigravitycli/mcp_config.json` — the project-DISCOVERY folder — while
   * claiming it was about `.agents/`, the workspace-CUSTOMIZATION folder. Then,
   * on reading the docs (antigravity.google/docs/mcp describes `.agents/`, and
   * Google's own codelab creates it), this comment swung the other way and said
   * the blocker looked wrong. Both were reasoning from paperwork.
   *
   * THE TEST, run against agy 1.1.12, signed in, in a real git repo:
   * the SAME minimal stdio MCP server, declared two ways.
   *   • workspace `<worktree>/.agents/mcp_config.json` → the server process is
   *     NEVER SPAWNED. Not connected-and-failed: never launched. The model
   *     answers "NO_MCP".
   *   • global `~/.gemini/config/mcp_config.json` → spawns immediately and
   *     handshakes: server/discover, initialize, notifications/initialized,
   *     tools/list.
   * stdio deliberately, to remove every confound — no bearer token to reject,
   * no network, no TLS. The difference is the config LOCATION and nothing else.
   *
   * AND IT SURVIVES THE TRUST VARIABLE, which was the obvious objection: agy
   * keeps a `trustedWorkspaces` list in settings.json, a fresh per-task worktree
   * is not on it, and an untrusted folder demonstrably changes behaviour (the
   * model stops treating cwd as its workspace and works out of its own scratch
   * dir). Adding the worktree to `trustedWorkspaces` and re-running changed
   * nothing: the server still never spawned, the model still answered NO_MCP.
   * So the workspace config is not trust-gated, it is simply not read.
   *
   * So Antigravity's MCP config is machine-wide IN PRACTICE, and the original
   * blocker's conclusion stands even though its cited reason never did: every
   * lane on the box would share one worker token, which is exactly the blast
   * radius the per-lane token exists to prevent. That is why this stays
   * undrivable, and it is a property of the CLI rather than something we can
   * work around from here.
   *
   * A TRAP FOR WHOEVER RE-TESTS THIS: agy exposes MCP through a single generic
   * `call_mcp_tool` dispatcher, so per-server tools NEVER appear in the `init`
   * event's tools array even when a server is loaded correctly. Reading that
   * array tells you nothing. Watch the server process instead, or ask the model.
   *
   * FOUR MORE FACTS from the same session, each an independent obstacle:
   *   1. AUTH IS INTERACTIVE OAUTH (bubbletea TUI; needs a real /dev/tty), with
   *      no headless credential path. A signed-out `agy -p` prints a consent URL
   *      and then SITS until `--print-timeout` (default 5m) before erroring — so
   *      a lane on a signed-out agy burns five minutes per turn looking like a
   *      hang. Preflight cannot see it: `--version` succeeds while signed out.
   *   2. `--sandbox` IS A BOOLEAN ("terminal restrictions enabled"), not a mode
   *      selector — but a CONSULT POSTURE IS STILL EXPRESSIBLE, and this was
   *      recorded backwards here for a while. It does not come from `--sandbox`
   *      at all; it comes from headless mode's default. Any tool needing a
   *      permission that cannot be prompted for is AUTO-DENIED:
   *        "User denied permission to run command: <cmd>"
   *        "a tool required the 'command' permission that headless mode cannot
   *         prompt for, so it was auto-denied."
   *      Observed repeatedly, including for an entirely benign `pwd && ls -la`,
   *      and a local listener confirmed no egress in any run. Reads (list_dir,
   *      file reads) work throughout. So: NOT passing
   *      `--dangerously-skip-permissions` IS the consult posture, and passing it
   *      is the build posture — both per invocation, both harness-enforced
   *      rather than model-instructed. `--mode plan` is a separate, WEAKER thing:
   *      it steers behaviour and blocks workspace writes, but it is not what
   *      stops command execution.
   *      RESIDUAL RISK, and it has no fix from here: `permissions.allow` in the
   *      machine-wide settings.json is inherited, so a user who has allowed
   *      `command(...)` widens every consult on that box. Codex has
   *      `--ignore-user-config` for exactly this; agy has no equivalent.
   *   3. No `mcp` subcommand; `/mcp` is interactive-only.
   *   4. It attempts to INSTALL PLAYWRIGHT at startup (observed failing 404
   *      against playwright.azureedge.net). A daemon runtime that downloads and
   *      runs a browser driver is worth knowing before it goes on a machine the
   *      project leaves running.
   *
   * There is no npm package. `antigravity-cli` (0.0.1, "placeholder") and `agy`
   * (0.0.0, empty) on npm are SQUATS by unrelated accounts; the real channel is
   * the install script at antigravity.google, which is why `install` below says
   * to see the docs rather than naming an npm command.
   *
   * WHAT WOULD UNBLOCK IT: a per-invocation MCP flag or env var, or workspace
   * configs actually being honoured. Re-test with the two-location stdio probe
   * above — it is five minutes and it answers the question outright. Pin any
   * wiring to >= 1.1.10 (`--model`/`--effort` were ignored in headless before it;
   * `--output-format` arrived in 1.1.8).
   */
  antigravity: {
    id: 'antigravity',
    label: 'Antigravity',
    vendor: 'Google',
    bin: 'agy',
    install: 'see antigravity.google/docs/cli',
    login: 'agy',
    live: false,
    /** None, because it cannot reach the MCP server at all — see `blocked`. */
    /**
     * WIKI AND CONSULT, BUT NOT BUILD — and the split is the whole point of
     * making drivability per-profile rather than one verdict.
     *
     * Only a BUILD needs the MCP control plane: claiming, reporting a blocker,
     * attaching a PR, completing. A wiki turn writes markdown files that the
     * daemon syncs afterwards, and a consult answers a question in prose; BOTH
     * already run with no MCP at all on every runtime, Claude included. Gating
     * them on an MCP capability they never use was a test of the wrong thing,
     * and it is what kept Antigravity at zero for months.
     *
     * Build returns here when the mediated adapter lands (the daemon holds the
     * MCP connection and the CLI just returns schema-enforced JSON via
     * `--json-schema`), which needs no per-invocation MCP config from the vendor
     * at all.
     *
     * PLAN IS ABSENT ON PURPOSE, and NOT because a planning turn is beyond it —
     * it reads code as well as anything here. A plan session is a conversation
     * that makes many control-plane calls as it goes (spawn a slice, re-shape
     * it, drop it, rewrite the spec), and mediation turns a turn into ONE
     * schema-enforced form the daemon then applies. That shape fits a build,
     * whose outcome is a single structured result; it does not yet fit an
     * argument. Note that `canRun` would otherwise say yes via `mediated()` and
     * hand this runtime a job it cannot finish — declaring the profile is the
     * only thing standing between here and that. Mediated planning is a real
     * design (the session returns its writes as a batch), just not a built one.
     */
    profiles: ['build', 'wiki', 'consult'],
    mcp: null,
    args({ prompt, system, model, effort, resume, resumeConversationId, profile = 'build', vaultDir, resultSchemaArgs = [], adoptResumeId }) {
      const a = [];
      // WHICH CONVERSATION IS THIS — one decision, answered one way (the same
      // rule as Claude's --resume/--continue). By id when the caller knows:
      // `--conversation <id>` resumes globally, any cwd (measured on 1.1.12).
      // Adoption is the SAME argv because agy has no fork — the id in the db
      // is the identity (a renamed copy fails "trajectory not found",
      // measured), so adopting MOVES the conversation: the tab continues the
      // terminal session itself, appending to its one store. `--continue` is
      // the cwd-keyed fallback for a session whose id was never learned.
      if (adoptResumeId || resumeConversationId) a.push('--conversation', adoptResumeId || resumeConversationId);
      else if (resume) a.push('--continue');
      // No system-prompt flag, same weakening as Codex: the contract rides in
      // the prompt, fenced and first.
      a.push('-p', `${system}\n\n---\n\n${prompt}`);
      a.push('--output-format', 'stream-json');
      if (model) a.push('--model', model);
      if (effort) a.push('--effort', effort);
      a.push(...resultSchemaArgs);

      if (profile === 'wiki') {
        // THE CARTOGRAPHER, at the same bar WIKI_PERM sets for Claude — writes
        // allowed, network shut. Both halves measured on 1.1.12:
        //   • headless cannot prompt, so anything needing approval is
        //     auto-denied — including the file writes a wiki turn exists to
        //     make. `--dangerously-skip-permissions` is what grants them.
        //   • `--sandbox` blocks egress: with it, curl returned 400 and a local
        //     listener saw nothing; without it, 200 and the request arrived.
        // Upstream #36 warns these two cancel out (skip-permissions
        // auto-approving the sandbox-bypass prompt). It does NOT reproduce on
        // 1.1.12 — tested together, the write landed and the network stayed
        // shut. Re-check on upgrade: if it ever does cancel, this posture
        // silently becomes "wiki turn with internet", which is the one line
        // WIKI_PERM draws ("Command execution is the line: it enables network
        // exfil").
        if (vaultDir) a.push('--add-dir', vaultDir);
        a.push('--sandbox', '--dangerously-skip-permissions');
        // A sweep reads a whole repository; the 5m default would guillotine it.
        a.push('--print-timeout', '60m');
      } else if (profile === 'build') {
        // A BUILD WRITES, and headless auto-denies anything needing approval —
        // so without this every edit comes back "User denied permission" and the
        // turn reports failure having touched nothing. Caught only because an
        // end-to-end test had to add the flag by hand to work.
        //
        // NOT `--sandbox` here, unlike wiki: a build has to `git push` and run
        // `gh pr create`, so it needs the network by definition. The containment
        // is the worktree, as it is for every runtime.
        //
        // FLOWVIANT_SAFE HAS NO EXPRESSION ON THIS RUNTIME. Claude narrows to an
        // allowlist and Codex to `workspace-write`; agy's only per-invocation
        // control is this boolean, and its allow/deny engine is machine-wide.
        // So a SAFE-mode operator gets an agy build that is not actually
        // narrowed — which is why `mediatedSafeGap` is surfaced rather than
        // quietly ignored.
        a.push('--dangerously-skip-permissions');
        a.push('--print-timeout', '60m');
      } else if (profile === 'consult') {
        // NOTHING GRANTED, deliberately. The headless default IS the consult
        // posture: `run_command` comes back "User denied permission… headless
        // mode cannot prompt for it, so it was auto-denied", observed even for a
        // benign `pwd && ls -la`, with no egress in any run. Reads keep working,
        // which is all a consult needs. Passing --dangerously-skip-permissions
        // here would hand a question ANY project editor can type a shell.
        a.push('--print-timeout', '10m');
      }
      return a;
    },
    parse: parseAgyLine,
    /**
     * `--json-schema` enforces the shape of the final result — verified against
     * 1.1.12, which returned exactly the object asked for. This is what makes a
     * BUILD possible on a runtime that cannot be handed an MCP config: the CLI
     * stops needing to CALL anything and just returns a filled-in form, and the
     * daemon makes the control-plane calls on its behalf with the lane's own
     * per-lane token. Strictly better than parsing markers out of prose, which a
     * model can wrap in a code fence, truncate or hallucinate.
     */
    resultSchema: (path) => ['--json-schema', path],
    blocked:
      'its MCP config is machine-wide — a workspace .agents/mcp_config.json is never loaded (measured), so every lane would share one token',
  },
};

// DELETED: `DISPATCHABLE`, a `mcp && args` filter last described as "runtimes
// this daemon can actually put a task on". It had no importers left — `canRun`
// replaced it — but it was the exact predicate the per-profile split exists to
// correct, still exported under a name that invites reuse, and it answers FALSE
// for Antigravity on every job. The next caller to reach for the obvious-looking
// constant would have silently undone this release. `canRun(rt, profile)` /
// `drivableHere(rt)` below are the answers.

export const runtimeById = (id) => RUNTIMES[id] ?? RUNTIMES.claude;

/**
 * Can the worker this daemon is running actually DRIVE this runtime right now?
 *
 * `dispatchable` on a detection row answers "is the CLI installed"; this answers
 * "and can this process build with it", which is a different question and was
 * briefly a narrower one.
 *
 * THE HISTORY MATTERS, because the answer moved twice. Live mode became the
 * default and does not spawn a CLI at all — it drives the Anthropic Agent SDK
 * in-process — so for one release this returned false for every non-live runtime
 * under LIVE. That was honest rather than correct: a machine with Codex reported
 * it could not drive Codex, which was true of the worker as it then existed, and
 * `@codex` tasks visibly waited instead of being silently built by Claude.
 *
 * 0.40.0 made it wrong by making it unnecessary. `driveSubprocess` (live.mjs)
 * gives live mode a subprocess path for non-live runtimes, sharing the same
 * worktree prep, patch landing, checkpointing and teardown as the session path.
 * So the restriction is gone and this is back to "installed, and this module
 * knows how to spawn it" — which is what the registry's `live` flag always
 * described: not which runtimes can run, but which get a session instead of a
 * subprocess.
 *
 * LIVE is no longer read here. That is deliberate and load-bearing: this
 * predicate feeds both the roster report AND the claim, and if the two ever
 * disagree the daemon either claims work it cannot build or refuses work it can.
 */
/**
 * WHICH PROFILES NEED THE MCP CONTROL PLANE. Two do.
 *
 * A BUILD has to claim work, report a blocker, attach a PR and complete — that
 * is the control plane, and a runtime that cannot reach it cannot participate.
 * A WIKI turn writes markdown the daemon syncs afterwards. A CONSULT answers a
 * question in prose. Neither passes an MCP config on ANY runtime today, Claude
 * included — check the two call sites in fleet.mjs, they hand `runTurn` no
 * `mcpArgs` at all.
 *
 * A PLAN is the second one, and it is the reason the consult stopped being the
 * whole story: a planning session does not answer a question, it WRITES the plan
 * — spawns the slices, re-shapes them, drops them, maintains the spec. Every one
 * of those is a control-plane call, so a runtime that cannot reach MCP cannot
 * host a session, however well it reads code.
 *
 * Conflating them cost Antigravity every capability it has: `mcp && args` was
 * the single drivability test, so a machine-wide MCP config disqualified it from
 * two jobs that never open an MCP connection.
 */
const PROFILE_NEEDS_MCP = { build: true, wiki: false, consult: false, plan: true };

/**
 * A build needs the control plane, but NOT necessarily an MCP config of its own.
 * A runtime that can return schema-enforced output is driven MEDIATED: the
 * daemon holds the MCP connection with the lane's own token and makes the calls,
 * and the CLI just returns a filled-in form. So "can build" is "can reach the
 * control plane, by either route".
 */
export const mediated = (rt) => Boolean(rt && !rt.mcp && rt.resultSchema);

/**
 * A mediated runtime whose only permission control is all-or-nothing, so
 * FLOWVIANT_SAFE cannot narrow its BUILD. Surfaced rather than swallowed: an
 * operator who set SAFE asked for something we cannot give them here, and
 * silently running unnarrowed would be the daemon deciding that on their behalf.
 */
export const mediatedSafeGap = (rt) => SAFE && mediated(rt);

/** Can this runtime do this job on this machine? */
export const canRun = (rt, profile) =>
  Boolean(rt?.args) &&
  (rt.profiles ?? []).includes(profile) &&
  (!PROFILE_NEEDS_MCP[profile] || Boolean(rt.mcp) || mediated(rt));

/**
 * Reported on the roster poll and sent on every claim, so it answers the
 * DISPATCH question specifically: can an @mention of this runtime result in a
 * task being built? That is `build`, and build is the profile that needs MCP —
 * which is why a runtime can be undispatchable and still run wiki and consult.
 */
export const drivableHere = (rt) => canRun(rt, 'build');

/**
 * WHICH RUNTIME RUNS A JOB THAT NOBODY @MENTIONED.
 *
 * Building a task has an author: you @mentioned a CLI, and that is the only
 * dispatch in this product. The other turns have none — the wiki sweep, the
 * re-ground, the plan check, the quick edit and the consult are all started by
 * the daemon or the server, and until now every one of them took `runTurn`'s
 * default parameter value and ran Claude. That was not a decision; it was five
 * call sites omitting an argument, and it only looked correct while Claude was
 * the only runtime and preflight refused to start without it.
 *
 * A PROFILE is a promise about what is IMPOSSIBLE during the turn, not a flag
 * list — flag lists are per-vendor, promises are not, and the goal is that every
 * runtime behaves the same way predictably. A runtime declares the profiles it
 * can actually express; one that cannot express a profile does not get that job,
 * rather than getting it with weaker guarantees nobody wrote down.
 *
 * Claude first when it qualifies — not favouritism, and worth saying plainly:
 * these prompts were written and tuned against it, so it is the known-good
 * answer and anything else is a substitution. When it is absent, any runtime
 * that can express the profile runs the job, which is the whole point.
 */
export function pickRuntimeFor(profile, { detected } = {}) {
  const rows = detected ?? detectRuntimes();
  const ok = (id) =>
    canRun(RUNTIMES[id], profile) && Boolean(rows.find((d) => d.id === id)?.installed);
  if (ok('claude')) return 'claude';
  return Object.keys(RUNTIMES).find(ok) ?? null;
}

// ── Detection ──────────────────────────────────────────────────────────────

/**
 * Which of these is on this machine, asked at most once per DETECT_TTL_MS.
 *
 * `--version` rather than `which`: a binary on PATH that cannot execute (a
 * broken install, a wrong-arch download, a shell alias pointing at nothing) is
 * not a runtime you can dispatch to, and reporting it as one sends work into a
 * hole. 5s is generous for a version print and short enough that three missing
 * CLIs cannot stall a roster poll.
 *
 * Reported to the server on the roster poll so the app can stop saying "we have
 * not looked". It is a statement about THIS MACHINE and nothing else — no
 * account, no quota, no entitlement. Flowviant relays; it does not enforce.
 */
let detectedCache = null;
let detectedAt = 0;
// The cache EXPIRES rather than living for the process: pickRuntimeFor's whole
// premise is "a CLI can be installed while the daemon runs", and both it and
// the roster poll read this cache — a forever-cache made that comment a lie
// (nothing after preflight ever passed refresh, so a mid-run install was
// invisible until restart, to the server included). 5 minutes keeps the probes
// (3 sync --version execs) off the hot path while an install still surfaces on
// the next poll or job.
const DETECT_TTL_MS = 5 * 60 * 1000;
export function detectRuntimes({ refresh = false } = {}) {
  if (detectedCache && !refresh && Date.now() - detectedAt < DETECT_TTL_MS) return detectedCache;
  detectedAt = Date.now();
  detectedCache = Object.values(RUNTIMES).map((rt) => {
    let version = null;
    try {
      version = String(
        execFileSync(rt.bin, ['--version'], {
          timeout: 5000,
          stdio: ['ignore', 'pipe', 'ignore'],
        })
      )
        .trim()
        .split('\n')[0]
        .slice(0, 40);
    } catch {
      version = null;
    }
    return {
      id: rt.id,
      installed: version !== null,
      version,
      // Installed and drivable are different questions, and conflating them is
      // how a user ends up @mentioning something that silently never starts.
      // THREE questions, in fact — see `drivableHere`: the CLI can be installed,
      // and this module can know how to spawn it, and the worker this daemon is
      // running can still be unable to drive it.
      dispatchable: version !== null && drivableHere(rt),
      blocked: rt.blocked ?? null,
    };
  });
  return detectedCache;
}
