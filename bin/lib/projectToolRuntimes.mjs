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

import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

export const toml = (value) => JSON.stringify(String(value));

/**
 * ONE LINK PER PERSONAL ENTRY, MADE OR MENDED IN PLACE (2026-09-29). A home
 * that outlives its turn is refreshed rather than rebuilt, so it must end up
 * exactly what a fresh build would link: a link already right stays, a link
 * pointing anywhere else is re-pointed, and a real file or directory standing
 * where a personal entry belongs — Codex rewrote a link by rename, or made its
 * own before the person's existed — gives way to the link, because the
 * personal copy is the one login and the one store (one login per CLI). A
 * racing refresh that made the same link first is not an error.
 */
function linkPersonalEntry(target, link) {
  let st = null;
  try { st = lstatSync(link); } catch { /* absent: link it */ }
  if (st?.isSymbolicLink() && readlinkSync(link) === target) return;
  if (st) rmSync(link, { recursive: true, force: true }); // never follows a link
  try {
    symlinkSync(target, link);
  } catch (error) {
    if (error?.code !== 'EEXIST' || readlinkSync(link) !== target) throw error;
  }
}

/**
 * Keep personal Codex files, but do not copy its project trust grants. An
 * untrusted worktree's .codex/config.toml is ignored by Codex 0.156.1.
 *
 * `dest` IS REFRESHED IN PLACE, NEVER ASSUMED EMPTY (2026-09-29). An agent's
 * home is kept between its turns (prepareAgentTools' `codexHome`), because
 * Codex's shared thread index (`state_5.sqlite`, reached through the link)
 * records each rollout under the CODEX_HOME in force, unresolved: a home that
 * died with its turn left the agent's pinned thread pointing into a deleted
 * directory, and the next card's `resume <id>` failed "no rollout found".
 * So every personal entry is (re)linked, every link whose entry left the
 * personal home is dropped, config.toml is rewritten whole each turn (the
 * worktree's skills can change between turns), and what Codex made here
 * itself under a name the person has not got is kept.
 */
function isolatedCodexHome(dest, env, worktree) {
  const source = resolve(env.CODEX_HOME || join(homedir(), '.codex'));
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

  // The home itself, only once the config is decided: a refused turn touches
  // nothing here. A home that is not a real directory is not ours to write
  // through — a link standing here would carry what follows somewhere else.
  try { if (!lstatSync(dest).isDirectory()) rmSync(dest, { force: true }); } catch { /* absent */ }
  mkdirSync(dest, { recursive: true, mode: 0o700 });
  chmodSync(dest, 0o700);
  const personal = existsSync(source) ? readdirSync(source).filter((name) => name !== 'config.toml') : [];
  for (const name of personal) linkPersonalEntry(join(source, name), join(dest, name));
  const linked = new Set(personal);
  for (const name of readdirSync(dest)) {
    if (linked.has(name) || name === 'config.toml') continue;
    // Only a LINK is ours to drop: a real entry under a name the person has
    // not got is Codex's own (its sessions, on a box whose personal home had
    // none yet), and this agent's threads live in it.
    try { if (lstatSync(join(dest, name)).isSymbolicLink()) rmSync(join(dest, name), { force: true }); } catch { /* gone */ }
  }
  // Written beside and RENAMED over, so a config.toml that is somehow a link
  // is replaced as an entry and never written through: the personal
  // config.toml is the one file this home must never reach.
  const staged = join(dest, `.config.toml.${process.pid}.${Date.now()}`);
  try {
    writeFileSync(staged, config, { mode: 0o600, flag: 'wx' });
    renameSync(staged, join(dest, 'config.toml'));
  } finally {
    rmSync(staged, { force: true });
  }
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
 * configuration it otherwise could; `prepare(dir, snapshot, env, worktree,
 * kept)` returns the runner-specific part of prepareAgentTools' result — under
 * `dir`, which dies with the turn, except what `kept` names a lasting place for.
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
    // The agent's own lasting home when the caller has one (2026-09-29: its
    // threads are indexed under it — see isolatedCodexHome), else one that
    // dies with the turn, as every home did before.
    prepare: (dir, _snapshot, env, worktree, kept) => {
      const isolated = isolatedCodexHome(kept?.codexHome ?? join(dir, 'codex-home'), env, worktree);
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

/** The runner-specific files a turn needs, written under `dir` — or, for what
 *  `kept` names, where the caller keeps it between turns. */
export function prepareForRunner(runner, dir, snapshot, env, worktree, kept = {}) {
  return { pluginDir: null, codexHome: null, personalDeveloperInstructions: false, ...(rowFor(runner).prepare?.(dir, snapshot, env, worktree, kept) ?? {}) };
}
