/**
 * WHAT EACH CLI TAKES OF THE REPO'S TOOLS, AND HOW A TURN IS PREPARED FOR IT
 * (2026-09-26, SOLID F064).
 *
 * One row per runtime: whether it can take MCP servers at all, which MCP
 * configurations it refuses (Codex takes no SSE), whether it takes the base
 * branch's skills, and the runner-specific filesystem work a turn needs
 * (Claude: a reviewed plugin carrying the base skills; Codex: an isolated
 * CODEX_HOME). Split out of projectTools.mjs, where a capability table sat
 * beside `runner === 'codex'` / `runner === 'claude'` branches in
 * prepareAgentTools and a second copy of the SSE rule in toolReadout, so a
 * new runtime or a transport change needed coordinated edits in three places.
 * prepareAgentTools, toolReadout and runtimeOfferings.mjs (the Codex MCP
 * report) all ask this table; the base-branch snapshot reader stays in
 * projectTools.mjs. projectTools.test.mjs pins every transport word to here.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

export const toml = (value) => JSON.stringify(String(value));

/** Keep personal Codex files, but do not copy its project trust grants. An
 * untrusted worktree's .codex/config.toml is ignored by Codex 0.156.1. */
function isolatedCodexHome(dir, env, worktree) {
  const source = resolve(env.CODEX_HOME || join(homedir(), '.codex'));
  const dest = join(dir, 'codex-home');
  mkdirSync(dest, { mode: 0o700 });
  if (existsSync(source)) {
    for (const name of readdirSync(source)) {
      if (name === 'config.toml') continue;
      symlinkSync(join(source, name), join(dest, name));
    }
  }
  const configPath = join(source, 'config.toml');
  const sourceConfig = existsSync(configPath) ? readFileSync(configPath, 'utf8') : '';
  const topLevel = sourceConfig.split(/^\s*\[/m, 1)[0];
  const personalDeveloperInstructions = /^\s*developer_instructions\s*=/m.test(topLevel);
  // These sections alone grant a checkout permission to supply project
  // settings. Keep every other personal setting, skill and session store.
  const lines = sourceConfig.split('\n');
  let inProject = false;
  let config = lines.filter((line) => {
    const header = /^\s*(?:\[\[([^\]]+)\]\]|\[([^\]]+)\])\s*(?:#.*)?$/.exec(line);
    if (header) {
      const section = header[1] ?? header[2];
      inProject = section === 'projects' || section.startsWith('projects.');
    }
    return !inProject;
  }).join('\n');
  if (worktree) {
    // Codex discovers these even in an untrusted project. Disable exactly the
    // worktree skill paths; the person's ~/.codex/skills and config remain.
    const worktreeSkills = [];
    for (const sourceDir of ['.agents/skills', '.codex/skills', '.claude/skills']) {
      const skillsDir = join(worktree, sourceDir);
      if (!existsSync(skillsDir)) continue;
      for (const name of readdirSync(skillsDir)) {
        const skill = join(skillsDir, name, 'SKILL.md');
        if (existsSync(skill)) worktreeSkills.push(skill);
      }
    }
    if (worktreeSkills.length && /^\s*skills\.config\s*=/m.test(config))
      throw new Error('Cannot isolate Codex project skills with inline skills.config');
    for (const skill of worktreeSkills) config += `\n[[skills.config]]\npath = ${toml(skill)}\nenabled = false\n`;
  }
  writeFileSync(join(dest, 'config.toml'), config, { mode: 0o600 });
  return { path: dest, personalDeveloperInstructions };
}

/** Claude takes the base branch's skills as a plugin written for this turn. */
function reviewedClaudePlugin(dir, snapshot) {
  if (!snapshot.skillFiles.length) return null;
  const pluginDir = join(dir, 'reviewed-plugin');
  mkdirSync(join(pluginDir, '.claude-plugin'), { recursive: true });
  writeFileSync(join(pluginDir, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'flowviant-reviewed', version: '1.0.0', description: 'Base-branch agent skills' }), { mode: 0o600 });
  for (const { path, body } of snapshot.skillFiles) {
    const dest = join(pluginDir, path.replace(/^\.claude\//, ''));
    mkdirSync(join(dest, '..'), { recursive: true });
    writeFileSync(dest, body, { mode: 0o600 });
  }
  return pluginDir;
}

/**
 * The table. `refuseMcp(config)` names why this runtime cannot take one MCP
 * configuration it otherwise could; `prepare(dir, snapshot, env, worktree)`
 * returns the runner-specific part of prepareAgentTools' result.
 */
const TOOL_RUNTIMES = {
  claude: {
    mcp: true,
    skills: true,
    refuseMcp: () => null,
    prepare: (dir, snapshot) => ({ pluginDir: reviewedClaudePlugin(dir, snapshot) }),
  },
  codex: {
    mcp: true,
    skills: true,
    refuseMcp: (config) => (config.type === 'sse' ? 'Codex cannot take SSE MCP' : null),
    prepare: (dir, _snapshot, env, worktree) => {
      const isolated = isolatedCodexHome(dir, env, worktree);
      return { codexHome: isolated.path, personalDeveloperInstructions: isolated.personalDeveloperInstructions };
    },
  },
  antigravity: { mcp: false, skills: false },
};

/** An unknown runner (or 'none', when no CLI is installed) takes nothing. */
const takesNothing = { mcp: false, skills: false };
const rowFor = (runner) => (Object.hasOwn(TOOL_RUNTIMES, runner) ? TOOL_RUNTIMES[runner] : takesNothing);

/** Pure mapping used before a future tool-attach gesture is offered. */
export function runnerToolCapabilities(runner) {
  const { mcp, skills } = rowFor(runner);
  return { mcp, skills };
}

/** Why `runner` cannot take this MCP configuration, or null when it can. The
 *  one answer both preparation (which drops it) and the readout (which says it)
 *  read. */
export function mcpRefusal(runner, config) {
  const row = rowFor(runner);
  if (!row.mcp) return runner === 'none' ? 'no installed CLI can take MCP' : `${runner} cannot take MCP`;
  return row.refuseMcp?.(config) ?? null;
}

/** Why `runner` cannot take the base branch's skills, or null when it can. */
export function skillsRefusal(runner) {
  if (rowFor(runner).skills) return null;
  return runner === 'none' ? 'no installed CLI can take instructions' : `${runner} cannot take instructions`;
}

/** The runner-specific files a turn needs, written under `dir`. */
export function prepareForRunner(runner, dir, snapshot, env, worktree) {
  return { pluginDir: null, codexHome: null, personalDeveloperInstructions: false, ...(rowFor(runner).prepare?.(dir, snapshot, env, worktree) ?? {}) };
}
