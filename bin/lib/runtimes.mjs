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
 * Codex `--json` emits JSONL of ThreadEvents. Returns `{ activity, text }` —
 * `text` accumulates the agent's own words, because the turn loop reads its
 * sentinels (NOTHING / BLOCKED:<id> / DONE) out of exactly that.
 */
function parseCodexLine(line, cwd) {
  let ev;
  try {
    ev = JSON.parse(line);
  } catch {
    return null; // not every line is JSON (warnings go to stderr, but be safe)
  }
  switch (ev.type) {
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
    default:
      return null; // thread.started / turn.started / item.started / item.updated
  }
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
    mcp: claudeMcp,
    /**
     * Claude takes the operating contract as a real system prompt, which is the
     * strongest form of it available anywhere: `--append-system-prompt` sits
     * above the conversation rather than inside it.
     */
    args({ prompt, system, model, effort, resume, streamJson, perm, mcp = [] }) {
      const a = [];
      if (resume) a.push('--continue');
      a.push('-p', prompt, '--append-system-prompt', system);
      a.push(...mcp);
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
    args({ prompt, system, model, effort, resume, perm: _perm, mcp = [] }) {
      const a = ['exec'];
      if (resume) a.push('resume', '--last');
      a.push('--json');
      if (model) a.push('--model', model);
      // Effort is a config value on Codex rather than a flag.
      if (effort) a.push('-c', `model_reasoning_effort="${effort}"`);
      // The daemon's posture, mapped: SAFE keeps writes inside the workspace,
      // the default lets the agent run its own tests and git commands. Neither
      // asks a human — there is no human on this end of the pipe.
      a.push('--sandbox', SAFE ? 'workspace-write' : 'danger-full-access');
      a.push(...mcp);
      a.push(`${system}\n\n---\n\n${prompt}`);
      return a;
    },
    parse: parseCodexLine,
  },

  /**
   * DECLARED, NOT DRIVABLE — and the reason is specific, not a shrug.
   *
   * `agy` has everything else this needs: `-p` for headless, `--output-format
   * stream-json`, `--model`, `--effort`, `--continue`, and
   * `--dangerously-skip-permissions`. What it has no per-invocation form of is
   * the MCP server: config lives at `~/.gemini/config/mcp_config.json`, the
   * workspace-local `.agents/mcp_config.json` is read-but-ignored (upstream
   * antigravity-cli#60), and the HOME-level file cannot be made per-lane —
   * pointing HOME elsewhere would take the cached credentials the headless mode
   * signs in with along with it.
   *
   * So running Antigravity today means one shared MCP token across every lane on
   * the machine, which is exactly the blast radius the per-lane token exists to
   * prevent. It is listed so `flowviant doctor` can say "installed, and here is
   * what is missing" rather than pretending we never looked — the same posture
   * the app's @ tray takes. When either the workspace config is fixed upstream
   * or a flag appears, this becomes an `mcp` function and a `parse`, and nothing
   * else in the daemon changes.
   */
  antigravity: {
    id: 'antigravity',
    label: 'Antigravity',
    vendor: 'Google',
    bin: 'agy',
    install: 'see antigravity.google/docs/cli',
    login: 'agy',
    live: false,
    mcp: null,
    args: null,
    parse: null,
    blocked: 'no per-invocation MCP config — its server list is machine-wide, so every lane would share one token',
  },
};

/** Runtimes this daemon can actually put a task on. */
export const DISPATCHABLE = Object.values(RUNTIMES).filter((r) => r.mcp && r.args);

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
export const drivableHere = (rt) => Boolean(rt.mcp && rt.args);

// ── Detection ──────────────────────────────────────────────────────────────

/**
 * Which of these is on this machine, asked once.
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
export function detectRuntimes({ refresh = false } = {}) {
  if (detectedCache && !refresh) return detectedCache;
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
