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
  // `design` and `research` (0.97.0) are Claude's alone: each is an
  // `--allowedTools` list with a PATH-SCOPED write (claudePosture.mjs), and neither
  // codex's sandbox modes nor agy's flags were measured to express "write
  // only this directory". A runtime that does not declare them is refused
  // such a card before spawn, in words — never handed a build turn instead.
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
  args({ prompt, system, model, effort, resume, streamJson, perm, profile = 'build', mcp = [], resultSchemaArgs = [], adoptResumeId, resumeThreadId, knowledgeDir, agentTools }) {
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
    if (agentTools) {
      // Keep personal settings, but never load the agent-editable project's
      // settings, hooks, skills or CLAUDE.md discovery. A resumed agent must
      // render the CURRENT base snapshot, not the first turn's prompt cache.
      a.push('--setting-sources', 'user', '--system-prompt-snapshot', 'off');
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
    a.push(...perm);
    return a;
  },
  parse: null, // claudeStream.mjs owns its own stream parser (unchanged)
};
