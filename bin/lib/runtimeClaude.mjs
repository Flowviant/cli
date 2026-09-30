/**
 * CLAUDE CODE, AS A RUNTIME — its registry row: argv, profiles, efforts, and
 * the per-invocation MCP config file it is handed.
 *
 * Split out of runtimes.mjs (2026-09-26, SOLID F045). Each vendor's argv moves
 * on its own vendor's release schedule, and a flag Claude Code renames is not
 * a reason to open Codex's or Antigravity's builder. The registry
 * (runtimes.mjs) assembles the rows and owns the rule that reads them
 * (`canRun`); what the `mcp` mint must guarantee is argued there, once, for
 * every vendor. Claude's own stream parser lives in claudeStream.mjs.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MODEL, USER_AGENT } from './config.mjs';
import { NO_SETTING_SOURCES, personalClaudeSettings, withPersonalSettings } from './claudePersonal.mjs';

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

export const CLAUDE_RUNTIME = {
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
   * four `--allowedTools` lists in claudePosture.mjs are what "build", "wiki",
   * "consult" and "plan" currently mean. That is a statement about where the
   * contract was written, not a claim that only Claude could ever satisfy it.
   */
  // `design` and `research` (0.97.0): each is an `--allowedTools` list with a
  // PATH-SCOPED write (claudePosture.mjs). `research` is Claude's alone;
  // `design` is Codex's too since 0.115.0 (2026-09-29), whose permission
  // profile was measured to write only the artifacts directory
  // (runtimeCodex.mjs `codexDesignFence`). agy's flags cannot express "write
  // only this directory" (runtimeAntigravity.mjs). A runtime that does not
  // declare a posture is refused such a card before spawn, in words — never
  // handed a build turn instead.
  profiles: ['build', 'wiki', 'consult', 'plan', 'design', 'research'],
  /**
   * THE EFFORTS THIS CLI SPELLS — the daemon's copy of the server's
   * `RUNTIME_EFFORTS` row, read by workBrain.mjs's `brainFor` so an effort a CLI
   * would refuse at spawn is DROPPED before argv (the turn then runs on the
   * CLI's own default). Claude Code's `--effort` takes all five. A copy, so
   * `scripts/check-app-parity.mjs` (the release gate; appParity.test.mjs)
   * fails when any runtime's row differs from the server's.
   */
  efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  mcp: claudeMcp,
  /**
   * Claude takes the operating contract as a real system prompt, which is the
   * strongest form of it available anywhere: `--append-system-prompt` sits
   * above the conversation rather than inside it.
   */
  args({ prompt, system, model, effort, resume, streamJson, perm, profile = 'build', mcp = [], resultSchemaArgs = [], adoptResumeId, resumeThreadId, knowledgeDir, agentTools, personalSettings }) {
    const a = [];
    // THREE ANSWERS TO ONE QUESTION — "what conversation is this?" — and they
    // are mutually exclusive, never combined.
    //
    // ADOPTION: `--resume <id> --fork-session` finds the session globally
    // (any cwd), carries its full context, and writes the FORK natively into
    // THIS cwd's own store, leaving the original transcript untouched
    // (measured on 2.1.234).
    //
    // BY ID: the conversation THIS TAB spoke under last time, learned from
    // the CLI's own `system.init` event and pinned per session. It exists
    // because `--continue` is CWD-KEYED, and a directory stopped being one
    // tab the day tabs moved into their driver's project folder — two tabs
    // sharing a directory both said `--continue` and both resumed whichever
    // conversation spoke most recently there, so tab B inherited tab A's
    // entire context and every turn after that ping-ponged between them.
    // Exactly the failure codex's own note warns about for `resume --last`,
    // arriving for Claude by a different route. An id is unambiguous wherever
    // the tab is standing.
    //
    // `--continue` is the LAST resort, and only where nothing better is
    // known.
    if (adoptResumeId) a.push('--resume', adoptResumeId, '--fork-session');
    else if (resumeThreadId) a.push('--resume', resumeThreadId);
    else if (resume) a.push('--continue');
    a.push('-p', prompt, '--append-system-prompt', system);
    /**
     * WHOSE SETTINGS A TURN READS (2026-09-29, claudePersonal.mjs).
     *
     * EVERY FENCED POSTURE READS NONE — every profile but `build`: an agent's
     * design and research cards, the pre-review, the planner, intake, the
     * wiki and the capture chat. Its permissions and hooks are its posture's
     * alone; of the person's file it keeps only the login and the model
     * defaults, folded into the posture's `--settings`. Keyed on `build`
     * rather than on a list of fenced names, so a posture added later is
     * fenced unless it is the build.
     *
     * THE BUILD POSTURE KEEPS THE PERSON'S OWN, on a code agent and on a
     * Terminal tab alike. `--dangerously-skip-permissions` already admits
     * everything, so no personal rule can widen it; what a personal file adds
     * there is the operator narrowing their own box (a deny rule held a
     * bypass turn, measured) and their own CLAUDE.md, skills and subagents,
     * which an empty source list would take away with no flag to keep them.
     * Codex's build is not hermetic either, for the same reason
     * (runtimeCodex.mjs). STATED, not closed: under FLOWVIANT_SAFE=1 the
     * build is a curated list, and the operator's own allow rules or
     * `defaultMode` can still widen it — two choices of the same operator on
     * their own box, and a personal allow is the only way a SAFE build runs a
     * tool its list does not name (`pnpm`, `cargo`, `make`). A code agent names `user` so the agent-editable
     * worktree's settings and hooks never load; a Terminal tab names nothing
     * and is the person's Claude Code, project files included. A resumed
     * agent renders the CURRENT base snapshot, not the first turn's cache.
     */
    const fenced = profile !== 'build';
    if (fenced) a.push(...NO_SETTING_SOURCES);
    else if (agentTools) a.push('--setting-sources', 'user');
    if (agentTools) {
      a.push('--system-prompt-snapshot', 'off');
      if (agentTools.pluginDir) a.push('--plugin-dir', agentTools.pluginDir);
    }
    // These fenced postures have no project MCP, even if Claude discovers a
    // .mcp.json in the agent's worktree. Build gets its reviewed base config
    // explicitly from the caller; the plan profile keeps its own principal.
    if (['consult', 'wiki', 'design', 'research'].includes(profile)) a.push('--strict-mcp-config');
    a.push(...mcp, ...resultSchemaArgs);
    a.push('--model', model || MODEL);
    if (effort) a.push('--effort', effort);
    if (streamJson) a.push('--output-format', 'stream-json', '--verbose');
    // The knowledge library (0.94.0) sits in the checkout, outside a
    // worktree's cwd: named as a readable directory so a curated profile
    // does not refuse the path the prompt just handed it. Before `perm`,
    // because `--allowedTools` is variadic and would swallow the flag.
    if (knowledgeDir) a.push('--add-dir', knowledgeDir);
    // `personalSettings` is the caller's copy when it has one (a test); a
    // turn reads the person's file here, at spawn, as the CLI would.
    a.push(...(fenced ? withPersonalSettings(perm, personalSettings ?? personalClaudeSettings()) : perm));
    return a;
  },
  parse: null, // claudeStream.mjs owns its own stream parser (unchanged)
};
