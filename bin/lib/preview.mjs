/**
 * Live preview (live mode). When a task opens its PR and parks for review, the
 * daemon starts the branch's dev server IN THE AGENT'S WORKTREE and opens a
 * cloudflared quick tunnel to it, so the reviewer can drive the real running
 * change in Flowviant (broker-not-host: Flowviant only stores the tunnel URL;
 * the reviewer's browser talks to it directly).
 *
 * Zero-config where possible: the preview config is read from
 * `.flowviant/preview.json` if present, otherwise INFERRED from package.json
 * (framework → port). cloudflared is AUTO-FETCHED if it isn't installed. No
 * cloudflared / no inferable config → no live preview, and review falls back to
 * the captured evidence the agent attached (never a hard failure).
 *
 * Config shape:
 *   { "ui": { "cmd": "<start dev server>", "port": 5173 },
 *     "api": { "cmd": "<start api>",        "port": 8787 } }
 */

import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, platform, arch } from 'node:os';

// ── Config: explicit file, else infer from package.json ────────────────────

function readPreviewConfig(repoRoot) {
  const p = join(repoRoot, '.flowviant', 'preview.json');
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

// Framework → conventional dev-server port. If we can't identify one, we don't
// guess — an explicit .flowviant/preview.json is the escape hatch.
const FRAMEWORK_PORTS = [
  { re: /\bvite\b/, port: 5173 },
  { re: /\bnext\b/, port: 3000 },
  { re: /react-scripts/, port: 3000 },
  { re: /\bastro\b/, port: 4321 },
  { re: /\bnuxt\b/, port: 3000 },
  { re: /\bremix\b/, port: 3000 },
  { re: /\bsvelte/, port: 5173 },
  { re: /\bgatsby\b/, port: 8000 },
  { re: /\bexpo\b/, port: 8081 },
];

function pkgManager(repoRoot) {
  if (existsSync(join(repoRoot, 'bun.lock')) || existsSync(join(repoRoot, 'bun.lockb'))) return 'bun';
  if (existsSync(join(repoRoot, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(repoRoot, 'yarn.lock'))) return 'yarn';
  return 'npm';
}

function inferPreviewConfig(repoRoot) {
  const pkgPath = join(repoRoot, 'package.json');
  if (!existsSync(pkgPath)) return null;
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  } catch {
    return null;
  }
  const scripts = pkg.scripts || {};
  const script = scripts.dev ? 'dev' : scripts.start ? 'start' : null;
  if (!script) return null;
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const hay = `${scripts[script]} ${Object.keys(deps).join(' ')}`.toLowerCase();
  const fw = FRAMEWORK_PORTS.find((f) => f.re.test(hay));
  if (!fw) return null; // can't safely guess the port
  const pm = pkgManager(repoRoot);
  const install = pm === 'npm' ? 'npm install' : `${pm} install`;
  const run = pm === 'yarn' ? `yarn ${script}` : `${pm} run ${script}`;
  return { ui: { cmd: `${install} && ${run}`, port: fw.port } };
}

/** The preview config for a repo — explicit file wins, else inferred. */
export function loadPreviewConfig(repoRoot) {
  return readPreviewConfig(repoRoot) ?? inferPreviewConfig(repoRoot);
}

// ── cloudflared: use if installed, else auto-fetch ─────────────────────────

function onPath() {
  try {
    execFileSync('cloudflared', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Resolve a cloudflared binary: PATH → cached fetch → download. Returns the
 *  command/path to run, or null if unavailable (Windows/macOS auto-fetch is
 *  skipped — those install cleanly via brew/winget). */
async function ensureCloudflared(log) {
  if (onPath()) return 'cloudflared';
  const os = platform();
  const dir = join(homedir(), '.flowviant', 'bin');
  const bin = join(dir, os === 'win32' ? 'cloudflared.exe' : 'cloudflared');
  if (existsSync(bin)) return bin;
  // Raw single-file binaries exist for linux + windows; macOS ships a tarball,
  // so point mac users at brew instead of unpacking here.
  if (os === 'darwin') {
    log?.('cloudflared not found — install it (`brew install cloudflared`) to enable live previews.');
    return null;
  }
  const osName = os === 'win32' ? 'windows' : 'linux';
  const a = arch() === 'arm64' ? 'arm64' : 'amd64';
  const url = `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-${osName}-${a}${
    os === 'win32' ? '.exe' : ''
  }`;
  log?.(`fetching cloudflared (${osName}-${a}) to enable live previews…`);
  try {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`http ${res.status}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(bin, Buffer.from(await res.arrayBuffer()));
    if (os !== 'win32') chmodSync(bin, 0o755);
    return bin;
  } catch (e) {
    log?.(`could not fetch cloudflared (${e.message}) — install it manually to enable live previews.`);
    return null;
  }
}

const TUNNEL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

/**
 * Start the dev server + tunnel for one worktree. Resolves { url, kind, stop }
 * once the tunnel URL is captured, or null if it can't come up. stop() kills
 * both the server and the tunnel.
 */
export async function startPreview({ worktree, kind, cmd, port, log, timeoutMs = 90_000 }) {
  const cf = await ensureCloudflared(log);
  if (!cf) return null; // fall back to captured evidence
  return new Promise((resolve) => {
    // detached so each gets its own process group — `bun run dev` via a shell
    // spawns a grandchild dev server that would otherwise SURVIVE a kill of the
    // shell, keep port bound, and get silently re-fronted by the NEXT task's
    // tunnel (reviewer sees the wrong branch). We kill the whole group instead.
    const server = spawn(cmd, {
      cwd: worktree,
      shell: true,
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    const tunnel = spawn(cf, ['tunnel', '--url', `http://localhost:${port}`], {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let settled = false;
    const killGroup = (child) => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, 'SIGKILL'); // negative pid = the whole group
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {
          /* gone */
        }
      }
    };
    const stop = () => {
      killGroup(server);
      killGroup(tunnel);
    };
    const finish = (val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!val) stop();
      resolve(val);
    };
    const onData = (d) => {
      const m = TUNNEL_RE.exec(d.toString());
      if (m) finish({ url: m[0], kind, stop });
    };
    tunnel.stdout.on('data', onData);
    tunnel.stderr.on('data', onData);
    tunnel.on('error', () => finish(null));
    tunnel.on('close', () => finish(null));
    const timer = setTimeout(() => {
      log?.('preview tunnel did not come up in time — skipping (captured evidence still applies).');
      finish(null);
    }, timeoutMs);
  });
}
