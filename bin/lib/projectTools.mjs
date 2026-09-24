/** Repo-owned tool configuration, read from the base ref for every agent turn. */
import { execFileSync } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';

const MAX_TOOLS = 40;
const MAX_REPORT_TOOLS = 80; // 40 MCP servers plus 40 instruction directories
const MAX_INSTRUCTION_FILES = 80;
const MAX_INSTRUCTION_BYTES = 512 * 1024;
const nameOk = (name) => /^[A-Za-z0-9_-]{1,80}$/.test(name) && name !== 'flowviant';
const toml = (value) => JSON.stringify(String(value));
const show = (root, ref, path) => {
  try {
    return execFileSync('git', ['show', `${ref}:${path}`], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1024 * 1024,
    });
  } catch { return null; }
};
const showBytes = (root, ref, path) => {
  try {
    return execFileSync('git', ['show', `${ref}:${path}`], {
      cwd: root, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1024 * 1024,
    });
  } catch { return null; }
};

function onPath(command, env) {
  if (isAbsolute(command)) {
    try { accessSync(command, constants.X_OK); return true; } catch { return false; }
  }
  if (command.includes('/') || command.includes('\\')) return false;
  return (env.PATH ?? '').split(delimiter).some((dir) => {
    try { accessSync(join(dir, command), constants.X_OK); return true; } catch { return false; }
  });
}

function referenced(value) {
  return [...String(value).matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((m) => m[1]);
}

/** Pure mapping used before a future tool-attach gesture is offered. */
export function runnerToolCapabilities(runner) {
  return ({ claude: { mcp: true, skills: true }, codex: { mcp: true, skills: true }, antigravity: { mcp: false, skills: false } })[runner]
    ?? { mcp: false, skills: false };
}

export function readBaseTools(root, ref, env = process.env) {
  // Resolve once: a base branch may advance while the turn is being prepared.
  const commit = execFileSync('git', ['rev-parse', '--verify', ref], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  const raw = show(root, commit, '.mcp.json');
  let servers = {};
  if (raw != null) {
    try { servers = JSON.parse(raw).mcpServers ?? {}; } catch { servers = {}; }
  }
  const entries = Object.entries(servers).filter(([name, value]) => nameOk(name) && value && typeof value === 'object').slice(0, MAX_TOOLS);
  const skills = [];
  const skillFiles = [];
  try {
    const paths = execFileSync('git', ['ls-tree', '-r', '--name-only', commit, '--', '.claude/skills'], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1024 * 1024,
    }).split('\n');
    let bytes = 0;
    for (const path of paths) {
      if (!/^\.claude\/skills\/[A-Za-z0-9_-]+\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/.test(path)) continue;
      if (skillFiles.length >= 200 || bytes >= 4 * 1024 * 1024) break;
      const body = showBytes(root, commit, path);
      if (body == null) continue;
      bytes += body.length;
      if (bytes > 4 * 1024 * 1024) break;
      skillFiles.push({ path, body });
      if (path.endsWith('/SKILL.md') && path.split('/').length === 4 && skills.length < MAX_TOOLS) skills.push({ path, body: body.toString('utf8') });
    }
  } catch { /* no skills at this ref */ }
  const tools = entries.map(([name, config]) => {
    const vars = new Set();
    for (const value of [config.command, config.url, ...(Array.isArray(config.args) ? config.args : []), ...Object.values(config.env ?? {}), ...Object.values(config.headers ?? {})]) {
      for (const key of referenced(value)) vars.add(key);
    }
    const missing = [...vars].filter((key) => !env[key]).sort();
    const commandMissing = typeof config.command === 'string' && !onPath(expand(config.command, env), env);
    const unsupported = typeof config.command !== 'string' && typeof config.url !== 'string';
    const reason = missing.length ? `env ${missing.join(', ')} unset` : commandMissing ? `command ${config.command} not on PATH` : unsupported ? 'MCP configuration unsupported' : null;
    return { name, config, state: reason ? 'missing' : 'ready', reason };
  });
  // Nested instructions are normally discovered when a CLI enters that path.
  // Their worktree copies must not regain authority through that discovery.
  const instructions = [];
  const paths = execFileSync('git', ['ls-tree', '-r', '--name-only', commit], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1024 * 1024,
  }).split('\n').filter((path) => /(^|\/)(CLAUDE|AGENTS)\.md$/.test(path));
  if (paths.length > MAX_INSTRUCTION_FILES) throw new Error('Base branch has too many agent instruction files');
  let instructionBytes = 0;
  for (const path of paths) {
    const body = show(root, commit, path);
    if (body == null) throw new Error(`Cannot read base instruction ${path}`);
    instructionBytes += Buffer.byteLength(body);
    if (instructionBytes > MAX_INSTRUCTION_BYTES) throw new Error('Base branch agent instructions exceed the turn limit');
    instructions.push({ path, body });
  }
  return { tools, skills, skillFiles, instructions };
}

const expand = (value, env) => String(value).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, key) => env[key] ?? '');

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

/** Temporary per-turn files are removed after the last retry. No personal CLI config is written. */
export function prepareAgentTools(snapshot, runner, env = process.env, worktree = null) {
  const dir = mkdtempSync(join(tmpdir(), 'flowviant-agent-tools-'));
  const caps = runnerToolCapabilities(runner);
  const usable = snapshot.tools.filter((t) => t.state === 'ready' && caps.mcp && !(runner === 'codex' && t.config.type === 'sse'));
  const mcpServers = {};
  const codexArgs = [];
  for (const { name, config } of usable) {
    if (typeof config.command === 'string') {
      const command = expand(config.command, env);
      const args = Array.isArray(config.args) ? config.args.map((v) => expand(v, env)) : [];
      const vars = Object.fromEntries(Object.entries(config.env ?? {}).map(([k, v]) => [k, expand(v, env)]));
      mcpServers[name] = { command, args, env: vars };
      codexArgs.push('-c', `mcp_servers.${name}.command=${toml(command)}`);
      codexArgs.push('-c', `mcp_servers.${name}.args=${JSON.stringify(args)}`);
      for (const [key, value] of Object.entries(vars)) {
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) codexArgs.push('-c', `mcp_servers.${name}.env.${key}=${toml(value)}`);
      }
    } else if (typeof config.url === 'string') {
      const url = expand(config.url, env);
      const headers = Object.fromEntries(Object.entries(config.headers ?? {}).map(([k, v]) => [k, expand(v, env)]));
      mcpServers[name] = { type: config.type ?? 'http', url, ...(Object.keys(headers).length ? { headers } : {}) };
      codexArgs.push('-c', `mcp_servers.${name}.url=${toml(url)}`);
      if (Object.keys(headers).length) {
        const inline = Object.entries(headers).map(([key, value]) => `${toml(key)}=${toml(value)}`).join(',');
        codexArgs.push('-c', `mcp_servers.${name}.http_headers={${inline}}`);
      }
    }
  }
  const mcpPath = join(dir, 'mcp.json');
  writeFileSync(mcpPath, JSON.stringify({ mcpServers }), { mode: 0o600 });
  const pointers = [];
  for (const { path, body } of [...snapshot.instructions, ...(caps.skills ? snapshot.skillFiles : [])]) {
    const dest = join(dir, path);
    mkdirSync(join(dest, '..'), { recursive: true });
    writeFileSync(dest, body, { mode: 0o600 });
    if (!path.startsWith('.claude/skills/') || path.endsWith('/SKILL.md')) pointers.push(`${path}: ${dest}`);
  }
  const baseInstructions = snapshot.instructions.map(({ path, body }) => `Base ${path}:\n${body}`).join('\n\n');
  const instructions = [baseInstructions,
    pointers.length ? `Base-branch instruction and skill copies (read the relevant nested files and skill files before acting):\n${pointers.join('\n')}` : '',
  ].filter(Boolean).join('\n\n');
  const pluginDir = runner === 'claude' && snapshot.skillFiles.length ? join(dir, 'reviewed-plugin') : null;
  if (pluginDir) {
    mkdirSync(join(pluginDir, '.claude-plugin'), { recursive: true });
    writeFileSync(join(pluginDir, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'flowviant-reviewed', version: '1.0.0', description: 'Base-branch agent skills' }), { mode: 0o600 });
    for (const { path, body } of snapshot.skillFiles) {
      const dest = join(pluginDir, path.replace(/^\.claude\//, ''));
      mkdirSync(join(dest, '..'), { recursive: true });
      writeFileSync(dest, body, { mode: 0o600 });
    }
  }
  let codexHome = null;
  let personalDeveloperInstructions = false;
  try {
    if (runner === 'codex') {
      const isolated = isolatedCodexHome(dir, env, worktree);
      codexHome = isolated.path;
      personalDeveloperInstructions = isolated.personalDeveloperInstructions;
    }
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  return {
    mcpPath,
    codexArgs,
    instructions,
    pluginDir,
    codexHome,
    personalDeveloperInstructions,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export function toolReadout(snapshot, runner) {
  const caps = runnerToolCapabilities(runner);
  const short = (reason) => reason == null ? null : String(reason).slice(0, 200);
  const mcp = snapshot.tools.map(({ name, config, state, reason }) => {
    const unsupported = runner === 'codex' && config.type === 'sse';
    return {
      name, kind: 'mcp',
      state: caps.mcp && !unsupported ? state : 'missing',
      reason: short(!caps.mcp ? runner === 'none' ? 'no installed CLI can take MCP' : `${runner} cannot take MCP`
        : unsupported ? 'Codex cannot take SSE MCP' : reason),
    };
  });
  const instructions = snapshot.skills.map(({ path }) => ({
    name: path.split('/')[2], kind: 'instruction', state: caps.skills ? 'ready' : 'missing',
    reason: short(caps.skills ? null : runner === 'none' ? 'no installed CLI can take instructions' : `${runner} cannot take instructions`),
  }));
  return [...mcp, ...instructions].slice(0, MAX_REPORT_TOOLS);
}
