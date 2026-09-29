/** Repo-owned tool configuration, read from the base ref for every agent turn. */
import { execFileSync } from 'node:child_process';
import { accessSync, constants, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';
import { mcpRefusal, prepareForRunner, skillsRefusal, toml } from './projectToolRuntimes.mjs';

const MAX_TOOLS = 40;
const MAX_REPORT_TOOLS = 80; // 40 MCP servers plus 40 instruction directories
const MAX_INSTRUCTION_FILES = 80;
const MAX_INSTRUCTION_BYTES = 512 * 1024;
const nameOk = (name) => /^[A-Za-z0-9_-]{1,80}$/.test(name) && name !== 'flowviant';
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

/**
 * Temporary per-turn files are removed after the last retry. No personal CLI config is written.
 *
 * `codexHome` is the AGENT'S OWN CODEX_HOME, kept between its turns
 * (2026-09-29): a place the caller owns, refreshed here each turn and never
 * removed by `cleanup`, because Codex indexes a thread under the home it ran
 * in and the next card resumes that thread. Absent, a Codex turn gets a home
 * that dies with it.
 */
export function prepareAgentTools(snapshot, runner, env = process.env, worktree = null, { codexHome: keptCodexHome = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'flowviant-agent-tools-'));
  const usable = snapshot.tools.filter((t) => t.state === 'ready' && mcpRefusal(runner, t.config) == null);
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
  for (const { path, body } of [...snapshot.instructions, ...(skillsRefusal(runner) == null ? snapshot.skillFiles : [])]) {
    const dest = join(dir, path);
    mkdirSync(join(dest, '..'), { recursive: true });
    writeFileSync(dest, body, { mode: 0o600 });
    if (!path.startsWith('.claude/skills/') || path.endsWith('/SKILL.md')) pointers.push(`${path}: ${dest}`);
  }
  const baseInstructions = snapshot.instructions.map(({ path, body }) => `Base ${path}:\n${body}`).join('\n\n');
  const instructions = [baseInstructions,
    pointers.length ? `Base-branch instruction and skill copies (read the relevant nested files and skill files before acting):\n${pointers.join('\n')}` : '',
  ].filter(Boolean).join('\n\n');
  let prepared;
  try {
    prepared = prepareForRunner(runner, dir, snapshot, env, worktree, { codexHome: keptCodexHome });
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  const { pluginDir, codexHome, personalDeveloperInstructions } = prepared;
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
  const short = (reason) => reason == null ? null : String(reason).slice(0, 200);
  const mcp = snapshot.tools.map(({ name, config, state, reason }) => {
    const refused = mcpRefusal(runner, config);
    return { name, kind: 'mcp', state: refused ? 'missing' : state, reason: short(refused ?? reason) };
  });
  const skillsRefused = skillsRefusal(runner);
  const instructions = snapshot.skills.map(({ path }) => ({
    name: path.split('/')[2], kind: 'instruction', state: skillsRefused ? 'missing' : 'ready', reason: short(skillsRefused),
  }));
  return [...mcp, ...instructions].slice(0, MAX_REPORT_TOOLS);
}
