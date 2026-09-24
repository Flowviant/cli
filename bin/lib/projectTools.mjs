/** Repo-owned tool configuration, read from the base ref for every agent turn. */
import { execFileSync } from 'node:child_process';
import { accessSync, constants, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';

const MAX_TOOLS = 40;
const MAX_REPORT_TOOLS = 80; // 40 MCP servers plus 40 instruction directories
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
  return { tools, skills, skillFiles, instructions: ['CLAUDE.md', 'AGENTS.md'].map((path) => ({ path, body: show(root, commit, path) })).filter((v) => v.body != null) };
}

const expand = (value, env) => String(value).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, key) => env[key] ?? '');

/** Temporary per-turn files are removed after the last retry. No personal CLI config is written. */
export function prepareAgentTools(snapshot, runner, env = process.env) {
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
  return {
    mcpPath,
    codexArgs,
    instructions: pointers.length ? `Repo instructions and skills from the base branch for this turn:\n${pointers.join('\n')}\nRead the relevant files at these paths before acting.` : '',
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
