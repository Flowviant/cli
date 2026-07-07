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
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync, readdirSync, rmSync } from 'node:fs';
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
  { re: /@angular\/|\bng serve\b/, port: 4200 },
  { re: /vue-cli-service/, port: 8080 },
];

// A repo whose ROOT is a library/monorepo often keeps its web app in a subdir,
// so the root package.json has no dev server at all. Search these (plus every
// child of apps/ and packages/) so a nested frontend previews with ZERO config.
const SUBDIR_CANDIDATES = [
  'web', 'webapp', 'frontend', 'client', 'ui', 'site', 'www', 'app', 'dashboard',
];
const SUBDIR_PARENTS = ['apps', 'packages'];

function pkgManager(dir) {
  if (existsSync(join(dir, 'bun.lock')) || existsSync(join(dir, 'bun.lockb'))) return 'bun';
  if (existsSync(join(dir, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(dir, 'yarn.lock'))) return 'yarn';
  return 'npm';
}

// An explicit port baked into the dev script (PORT=3005 …, -p 3005, --port 3005,
// --port=3005) overrides the framework default — otherwise the tunnel would
// target the wrong port and never connect.
function portFromScript(s) {
  const m = String(s).match(/(?:PORT=|(?:^|\s)-p[=\s]+|--port[=\s]+)(\d{2,5})\b/);
  return m ? Number(m[1]) : null;
}

// Infer {script, port} from one directory's package.json, or null if it has no
// dev/start script or no framework we can map to a port.
function inferFromDir(absDir) {
  const pkgPath = join(absDir, 'package.json');
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
  return { script, port: portFromScript(scripts[script]) ?? fw.port };
}

// The ordered dirs to probe: root, then the common frontend names, then every
// child of apps/ and packages/. Relative to repoRoot ('' = root).
function candidateDirs(repoRoot) {
  const dirs = ['', ...SUBDIR_CANDIDATES];
  for (const parent of SUBDIR_PARENTS) {
    const p = join(repoRoot, parent);
    try {
      for (const e of readdirSync(p, { withFileTypes: true })) {
        if (e.isDirectory()) dirs.push(`${parent}/${e.name}`);
      }
    } catch {
      /* no such parent dir */
    }
  }
  return dirs;
}

function buildConfig(repoRoot, rel, hit) {
  // Prefer the app dir's own package manager if it has a lockfile, else the repo
  // root's (monorepos install from the root).
  const abs = rel ? join(repoRoot, rel) : repoRoot;
  const hasOwnLock = ['bun.lock', 'bun.lockb', 'pnpm-lock.yaml', 'yarn.lock', 'package-lock.json'].some(
    (f) => existsSync(join(abs, f)),
  );
  const pm = pkgManager(hasOwnLock ? abs : repoRoot);
  const install = pm === 'npm' ? 'npm install' : `${pm} install`;
  const run = pm === 'yarn' ? `yarn ${hit.script}` : `${pm} run ${hit.script}`;
  const inner = `${install} && ${run}`;
  // Subdir apps run from their own folder (shell:true honors the cd prefix).
  const cmd = rel ? `cd ${rel} && ${inner}` : inner;
  return { ui: { cmd, port: hit.port }, dir: rel || '.' };
}

// Infer a preview config by probing the root and likely frontend subdirs.
function inferPreviewConfig(repoRoot) {
  for (const rel of candidateDirs(repoRoot)) {
    const hit = inferFromDir(rel ? join(repoRoot, rel) : repoRoot);
    if (hit) return buildConfig(repoRoot, rel, hit);
  }
  return null;
}

/** The preview config for a repo — explicit file wins, else inferred from the
 *  root or a nested frontend. Carries `dir` (relative) so callers can say where
 *  it found the app. */
export function loadPreviewConfig(repoRoot) {
  const explicit = readPreviewConfig(repoRoot);
  if (explicit) return explicit;
  return inferPreviewConfig(repoRoot);
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
  const a = arch() === 'arm64' ? 'arm64' : 'amd64';
  try {
    mkdirSync(dir, { recursive: true });
    if (os === 'darwin') {
      // macOS ships a .tgz (not a raw binary) — download it and extract the
      // single `cloudflared` executable with the system tar (always on macOS).
      const url = `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-${a}.tgz`;
      log?.(`fetching cloudflared (darwin-${a}) to enable live previews…`);
      const res = await fetch(url, { redirect: 'follow' });
      if (!res.ok) throw new Error(`http ${res.status}`);
      const tgz = join(dir, 'cloudflared.tgz');
      writeFileSync(tgz, Buffer.from(await res.arrayBuffer()));
      execFileSync('tar', ['-xzf', tgz, '-C', dir], { stdio: 'ignore' });
      rmSync(tgz, { force: true });
      if (!existsSync(bin)) throw new Error('archive did not contain cloudflared');
      chmodSync(bin, 0o755);
      return bin;
    }
    // linux + windows ship a raw single-file binary.
    const osName = os === 'win32' ? 'windows' : 'linux';
    const url = `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-${osName}-${a}${
      os === 'win32' ? '.exe' : ''
    }`;
    log?.(`fetching cloudflared (${osName}-${a}) to enable live previews…`);
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`http ${res.status}`);
    writeFileSync(bin, Buffer.from(await res.arrayBuffer()));
    if (os !== 'win32') chmodSync(bin, 0o755);
    return bin;
  } catch (e) {
    const hint = os === 'darwin' ? ' (or `brew install cloudflared`)' : '';
    log?.(`could not fetch cloudflared (${e.message}) — install it manually${hint} to enable live previews.`);
    return null;
  }
}

const TUNNEL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
// Where a dev server announces it bound — "Local: http://localhost:3001/".
const BIND_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d+)/i;

/**
 * Start the dev server + tunnel for one worktree. Resolves { url, kind, stop }
 * once the tunnel URL is captured, or null if it can't come up. stop() kills
 * both the server and the tunnel.
 *
 * The tunnel target is the port the server ACTUALLY bound (read from its
 * output), not the guessed one — vite/vinext/next hop to the next free port when
 * theirs is taken, and tunneling to the guess then 502s. We fall back to the
 * configured port only if the server never announces one.
 */
export async function startPreview({ worktree, kind, cmd, port, log, timeoutMs = 180_000 }) {
  const cf = await ensureCloudflared(log);
  if (!cf) return null; // fall back to captured evidence
  return new Promise((resolve) => {
    // We SIGKILL the dev server's whole group on teardown, which skips a tool's
    // graceful cleanup — some dev servers (e.g. vinext) leave a singleton
    // dev-lock behind and then REFUSE to start next time. Disable known locks so
    // a reused/uncleaned worktree still previews. Harmless to tools that ignore
    // these vars; BROWSER=none stops any auto-open.
    const env = { ...process.env, VINEXT_NO_DEV_LOCK: '1', BROWSER: 'none' };
    // detached so each gets its own process group — `bun run dev` via a shell
    // spawns a grandchild dev server that would otherwise SURVIVE a kill of the
    // shell. We kill the whole group instead. stdout/stderr piped so we can read
    // the bound port and surface failures.
    const server = spawn(cmd, {
      cwd: worktree,
      shell: true,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });

    let settled = false;
    let tunnel = null;
    let tunnelStarted = false;
    let out = '';
    const tail = () => out.trim().split('\n').slice(-15).join('\n');
    const killGroup = (child) => {
      if (!child?.pid) return;
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
    let bindTimer;
    let timer;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(bindTimer);
      if (!val) stop();
      resolve(val);
    };

    // Open the tunnel once we know the real port (detected or fallback).
    const openTunnel = (p) => {
      if (tunnelStarted || settled) return;
      tunnelStarted = true;
      clearTimeout(bindTimer);
      log?.(`preview: dev server on :${p} — opening the tunnel…`);
      // --http-host-header localhost: send the origin the Host it expects. Vite
      // (5+) rejects any Host it doesn't recognize (server.allowedHosts), and the
      // tunnel's public hostname isn't in that list → "Blocked request". Rewriting
      // the Host to localhost — what a local browser sends anyway — passes the
      // check with zero repo config, and is harmless to servers that don't check.
      tunnel = spawn(
        cf,
        ['tunnel', '--url', `http://localhost:${p}`, '--http-host-header', 'localhost'],
        { detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      const onTunnel = (d) => {
        const m = TUNNEL_RE.exec(d.toString());
        if (m) finish({ url: m[0], kind, stop });
      };
      tunnel.stdout.on('data', onTunnel);
      tunnel.stderr.on('data', onTunnel);
      tunnel.on('error', () => finish(null));
      tunnel.on('close', () => finish(null));
    };

    const onServer = (d) => {
      const s = d.toString();
      out = (out + s).slice(-4000);
      if (!tunnelStarted) {
        const m = BIND_RE.exec(s);
        if (m) openTunnel(Number(m[1]));
      }
    };
    server.stdout.on('data', onServer);
    server.stderr.on('data', onServer);
    // A dev server that exits before it's reachable (crash on boot, a singleton
    // lock refusing to start) is the loud failure mode — surface its output.
    server.on('exit', (code) => {
      if (settled) return;
      log?.(
        `preview dev server exited (code ${code}) before it was reachable — no preview.${
          tail() ? `\n  dev server said:\n${tail()}` : ''
        }`,
      );
      finish(null);
    });

    // If the server never prints a URL we recognize (quiet server), tunnel to the
    // configured port as a last resort.
    bindTimer = setTimeout(() => openTunnel(port), 30_000);
    timer = setTimeout(() => {
      log?.(
        `preview tunnel did not come up in ${Math.round(timeoutMs / 1000)}s — skipping.${
          tail() ? `\n  last dev-server output:\n${tail()}` : ''
        }`,
      );
      finish(null);
    }, timeoutMs);
  });
}
