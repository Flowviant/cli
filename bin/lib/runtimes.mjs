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
    /**
     * Every profile, because every profile is DEFINED in its vocabulary: the
     * three `--allowedTools` lists in claude.mjs are what "build", "wiki" and
     * "consult" currently mean. That is a statement about where the contract was
     * written, not a claim that only Claude could ever satisfy it.
     */
    profiles: ['build', 'wiki', 'consult'],
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
    /**
     * BUILD AND CONSULT. See `args()` below for how consult is expressed — the
     * short version is that Codex keeps the promise at the kernel rather than in
     * a verb allowlist, and for a consult's actual threat (exfiltration driven
     * by an injected question) that is sufficient and arguably stronger.
     *
     * NOT 'wiki', and the reason is mundane rather than deep: the vault lives at
     * ~/.flowviant/vaults/<id>, OUTSIDE the worktree Codex would run in, so
     * `workspace-write` cannot reach it. It needs the vault path threaded down
     * to `args()` as `--add-dir` / `writable_roots`, which nothing passes yet.
     * Network is already denied by default in workspace-write, so the exfil half
     * of WIKI_PERM's reasoning is covered — this is a plumbing gap, not a
     * safety one.
     *
     * Enforcement was verified on Linux (bubblewrap + seccomp). macOS Seatbelt
     * and Windows are UNTESTED; if this daemon starts running there, re-verify
     * before trusting the consult posture on those platforms.
     */
    profiles: ['build', 'consult'],
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
    args({ prompt, system, model, effort, resume, profile = 'build', mcp = [] }) {
      const a = ['exec'];
      if (resume) a.push('resume', '--last');
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
      } else {
        // The daemon's build posture, mapped: SAFE keeps writes inside the
        // workspace, the default lets the agent run its own tests and git
        // commands. Neither asks a human — there is no human on this end of the
        // pipe. Deliberately NOT hermetic: a build is work the user asked for by
        // @mentioning this CLI, and their own config is theirs to apply.
        a.push('--sandbox', SAFE ? 'workspace-write' : 'danger-full-access');
      }

      a.push(...mcp);
      a.push(`${system}\n\n---\n\n${prompt}`);
      return a;
    },
    parse: parseCodexLine,
  },

  /**
   * DECLARED, NOT DRIVABLE — but NOT for the reason this comment used to give.
   *
   * THE OLD REASON WAS WRONG, and wrong about a filename. It said workspace-local
   * `.agents/mcp_config.json` is "read-but-ignored (upstream antigravity-cli#60)".
   * Issue #60 is titled "Project-local `.antigravitycli/mcp_config.json`
   * mcpServers is read but ignored" — a DIFFERENT directory. `.antigravitycli/`
   * is the CLI's project-DISCOVERY folder; `.agents/` is its workspace
   * CUSTOMIZATION folder. The reporter had put their config in the wrong place,
   * and we inherited their conclusion.
   *
   * `.agents/mcp_config.json` is the documented workspace path — antigravity.google
   * /docs/mcp, and Google's own codelab does `mkdir -p .agents` then verifies with
   * `/mcp` inside agy. A server entry takes `serverUrl` + `transport` + `headers`,
   * so a bearer token goes in as `{"Authorization": "Bearer <token>"}`. Since every
   * Flowviant task already builds in its OWN worktree, a workspace-local file IS a
   * per-lane token — the isolation the old comment called impossible, with no HOME
   * repointing, so the cached-credential objection dissolves with it.
   *
   * It stays undrivable because none of that is OBSERVED. `agy` is not installed
   * here, so the above is documentation. Three things are genuinely unknown and
   * one is likely fatal:
   *   (a) does the workspace file MERGE with the global one or OVERRIDE it?
   *       Undocumented; merge means a stale HOME entry still loads.
   *   (b) is workspace load gated on folder TRUST? CHANGELOG 1.1.0 fixed
   *       `.agents/hooks.json` not loading "after trusting a folder", and a fresh
   *       per-task worktree is an untrusted folder EVERY TIME. This is the most
   *       likely real blocker.
   *   (c) is it re-read per invocation?
   * The cheap check, once `agy` exists: drop a `.agents/mcp_config.json` in a
   * throwaway worktree, run `agy -p "hi" --output-format stream-json`, and read
   * the `tools` array in the `init` event — the flowviant tools appear or they
   * do not.
   *
   * TWO THINGS TO CARRY OVER WHEN IT IS WIRED:
   *   • The token must be LITERAL in the file — `${VAR}` is not expanded (upstream
   *     #233 asks for it). So a plaintext bearer lands on disk inside the
   *     worktree, which is the same `git add -A` exposure that got AGENTS.md
   *     rejected for Codex. It needs `.git/info/exclude` and a teardown scrub,
   *     and it is strictly worse than Codex's env-var hand-off.
   *   • PERMISSIONS ARE STILL MACHINE-WIDE. `~/.gemini/antigravity-cli/settings.json`
   *     holds the allow/ask/deny engine, and it is the only documented location.
   *     Even with MCP per-workspace, that is a real per-lane gap for `profiles`
   *     below: two lanes cannot hold different postures at once.
   *
   * Pin any wiring to agy >= 1.1.10 — `--model`/`--effort` were ignored in
   * headless before it, and `--output-format` only arrived in 1.1.8.
   *
   * OBSERVED against the real 1.1.12 binary (fetched from Google's bucket and
   * SHA512-verified; not installed). The MCP question is STILL open, because
   * answering it needs a signed-in session — but four other things are now facts
   * rather than documentation, and two of them are new obstacles:
   *
   *   1. AUTH IS INTERACTIVE OAUTH, with no headless credential path in `--help`.
   *      A signed-out `agy -p` prints a Google consent URL to stderr, waits, and
   *      then emits `{"event":"result","result":{"status":"ERROR","error":
   *      "authentication failed or timed out"}}`. It does not fail fast: it sits
   *      until `--print-timeout` (default 5m). A lane that picked up work on a
   *      signed-out agy would burn five minutes per turn looking like a hang.
   *      Preflight cannot detect this either — `--version` succeeds while
   *      signed out, same blind spot every runtime has here.
   *   2. `--sandbox` IS A BOOLEAN ("Run in a sandbox with terminal restrictions
   *      enabled"), not a mode selector. There is no `read-only` /
   *      `workspace-write` / `danger-full-access` axis like Codex's, so the
   *      posture for a `consult` cannot be expressed per invocation at all — it
   *      lives in the machine-wide permissions engine. That makes `profiles`
   *      harder here than for Codex, not easier.
   *   3. NO `mcp` SUBCOMMAND. `/mcp` is an interactive slash command, so the
   *      only headless window into which servers loaded is the `init` event of
   *      `--output-format stream-json` — which needs auth first. That is why
   *      the workspace-config question cannot be settled without a login.
   *   4. It tries to INSTALL PLAYWRIGHT on startup (observed failing with a 404
   *      against playwright.azureedge.net). A daemon runtime that downloads and
   *      runs a browser driver is a surprise worth knowing about before this is
   *      wired into a machine the project leaves running.
   *
   * To finish the test: sign in once (`agy` interactively, follow the consent
   * URL), then in a throwaway git worktree containing `.agents/mcp_config.json`
   * run `agy -p "list your tools" --output-format stream-json` and read the
   * `init` event's tools array.
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
    profiles: [],
    mcp: null,
    args: null,
    parse: null,
    blocked:
      'unverified: its workspace MCP config looks per-worktree (so per-lane), but nothing has tested whether a fresh untrusted worktree loads it',
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
  const ok = (id) => {
    const rt = RUNTIMES[id];
    return Boolean(
      rt &&
        drivableHere(rt) &&
        (rt.profiles ?? []).includes(profile) &&
        rows.find((d) => d.id === id)?.installed
    );
  };
  if (ok('claude')) return 'claude';
  return Object.keys(RUNTIMES).find(ok) ?? null;
}

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
