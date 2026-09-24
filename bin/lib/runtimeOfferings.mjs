/** Local, bounded Codex readouts. No agent turn is started for these reports. */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readBaseTools } from './projectTools.mjs';

const TTL = 5 * 60_000;
let cachedAt = 0;
let cached = null;
let repoCached = null;
const home = (env) => env.CODEX_HOME || join(homedir(), '.codex');
const nameOk = (name) => typeof name === 'string' && /^[A-Za-z0-9_.:-]{1,80}$/.test(name) && name !== 'flowviant';
const run = (args, env) => execFileSync('codex', args, {
  encoding: 'utf8', timeout: 5000, maxBuffer: 128 * 1024,
  stdio: ['ignore', 'pipe', 'ignore'], env,
});

export function localCodexOfferings({ env = process.env, runCodex = run, read = readFileSync, list = readdirSync } = {}) {
  const result = {};
  try {
    const cachePath = join(home(env), 'models_cache.json');
    if (read === readFileSync && statSync(cachePath).size > 2 * 1024 * 1024) throw Error('model cache too large');
    const data = JSON.parse(read(cachePath, 'utf8'));
    if (Array.isArray(data.models)) result.models = data.models
      .filter((m) => m?.visibility === 'list' && nameOk(m.slug))
      .slice(0, 60)
      .map((m) => ({ slug: m.slug, displayName: String(m.display_name || m.slug).slice(0, 100),
        efforts: Array.isArray(m.supported_reasoning_levels) ? m.supported_reasoning_levels
          .map((e) => e?.effort).filter((e) => typeof e === 'string' && /^[a-z]{1,20}$/.test(e)).slice(0, 8) : [] }));
  } catch { /* absent or unreadable is unknown */ }
  try {
    const lines = runCodex(['features', 'list'], env).split('\n');
    result.capabilities = lines.some((line) => /^image_generation\s+\S+\s+true\s*$/.test(line)) ? ['image'] : [];
  } catch { /* a failed local probe is unknown */ }
  try {
    result.skills = list(join(home(env), 'skills'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && nameOk(entry.name))
      .map((entry) => entry.name).slice(0, 80);
  } catch (error) { if (error?.code === 'ENOENT') result.skills = []; }
  try {
    const servers = JSON.parse(runCodex(['mcp', 'list', '--json'], env));
    if (Array.isArray(servers)) result.mcp = servers
      // Unknown/unsupported auth is not proof of disconnection. Keep their
      // names local, just as connected servers stay local.
      .filter((s) => nameOk(s?.name) && ['needs_auth', 'failed'].includes(s.auth_status))
      .slice(0, 80)
      .map((s) => ({ n: s.name, s: s.auth_status === 'needs_auth' ? 'needs-auth' : 'failed' }));
  } catch { /* no read is unknown */ }
  return result;
}

export function runtimeOfferings(repoRoot, baseRef, { refresh = false } = {}) {
  if (!cached || refresh || Date.now() - cachedAt >= TTL) {
    cached = localCodexOfferings();
    cachedAt = Date.now();
  }
  const out = { rtm: {}, rtc: {}, rts: {}, rtp: {} };
  if (cached.models) out.rtm.codex = cached.models;
  if (cached.capabilities) out.rtc.codex = cached.capabilities;
  if (cached.skills) out.rts.codex = cached.skills;
  if (cached.mcp) out.rtp.codex = cached.mcp;
  // Repo skills and MCP are read from the base commit, like the turn itself.
  try {
    if (!repoCached || repoCached.root !== repoRoot || repoCached.ref !== baseRef || refresh || Date.now() - repoCached.at >= TTL) {
      repoCached = { root: repoRoot, ref: baseRef, at: Date.now(), snapshot: readBaseTools(repoRoot, baseRef) };
    }
    const snapshot = repoCached.snapshot;
    if (out.rts.codex) out.rts.codex = [...new Set([...out.rts.codex, ...snapshot.skills.map((s) => s.path.split('/')[2])])].slice(0, 80);
    if (out.rtp.codex) out.rtp.codex = [...new Map([...out.rtp.codex, ...snapshot.tools
      .filter((t) => t.state !== 'ready' || t.config.type === 'sse')
      .map((t) => ({ n: t.name, s: 'failed' }))].map((server) => [server.n, server])).values()].slice(0, 80);
  } catch { /* keep local measurements */ }
  return out;
}
