/**
 * `flowviant shot <url>` — capture a headless-browser screenshot of a running
 * page, so a build agent can attach REAL visual evidence to its delivery card
 * (not just the ephemeral live preview). This is the primitive the daemon agent
 * shells out to; it wraps the two fiddly parts — finding a browser across the
 * user's environment, and driving Chrome's headless `--screenshot` — so the
 * agent doesn't have to guess.
 *
 * Design mirrors the preview/cloudflared path: zero-config where possible, and
 * NEVER a hard failure. No browser found / render crashes → a clear one-line
 * hint on stderr + a non-zero exit, and the agent falls back to text evidence
 * (test output, request/response, sample). It must never block a delivery.
 *
 * Environment coverage (the "what about WSL / a Linux VM?" cases):
 *   - Linux: PATH + conventional install paths for chrome/chromium/edge/brave.
 *   - macOS / Windows: the standard app locations.
 *   - WSL with no Linux browser: falls back to Windows Chrome/Edge via /mnt/c
 *     interop, translating paths with `wslpath` (WSL2 forwards localhost, so a
 *     Windows browser can still reach the dev server running in WSL).
 *   - A bare VM with no browser AND no system libs: probing/render fails →
 *     graceful text-evidence fallback with an `apt install chromium` hint.
 *   - FLOWVIANT_CHROME / CHROME_PATH override wins over all discovery.
 */

import { spawn, execFileSync } from 'node:child_process';
import { existsSync, statSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, platform } from 'node:os';

// ── Browser discovery ───────────────────────────────────────────────────────

const LINUX_BINS = [
  'google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser',
  'chrome', 'brave-browser', 'microsoft-edge', 'microsoft-edge-stable',
];
const LINUX_PATHS = [
  '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome', '/usr/bin/chromium',
  '/usr/bin/chromium-browser', '/snap/bin/chromium', '/usr/bin/brave-browser',
  '/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable',
];
const MAC_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
];
const WIN_PATHS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];
// WSL interop: the same Windows installs, seen through the /mnt/c mount.
const WSL_WIN_PATHS = WIN_PATHS.map((p) => `/mnt/c/${p.slice(3)}`);

function which(name) {
  try {
    const p = execFileSync('which', [name], { encoding: 'utf8' }).trim();
    return p || null;
  } catch {
    return null;
  }
}

function isWSL() {
  if (process.env.WSL_DISTRO_NAME) return true;
  try {
    return /microsoft|wsl/i.test(readFileSync('/proc/version', 'utf8'));
  } catch {
    return false;
  }
}

/** Locate a usable browser, or null. `viaWindows` means a Windows .exe reached
 *  through WSL interop — its file-path args must be translated with wslpath. */
export function resolveBrowser() {
  const override = process.env.FLOWVIANT_CHROME || process.env.CHROME_PATH;
  if (override && existsSync(override)) return { bin: override, viaWindows: false };

  const os = platform();
  if (os === 'darwin') {
    for (const p of MAC_PATHS) if (existsSync(p)) return { bin: p, viaWindows: false };
    return null;
  }
  if (os === 'win32') {
    for (const p of WIN_PATHS) if (existsSync(p)) return { bin: p, viaWindows: false };
    return null;
  }
  // linux
  for (const name of LINUX_BINS) {
    const p = which(name);
    if (p) return { bin: p, viaWindows: false };
  }
  for (const p of LINUX_PATHS) if (existsSync(p)) return { bin: p, viaWindows: false };
  // WSL with no Linux browser — reach the Windows one.
  if (isWSL()) {
    for (const p of WSL_WIN_PATHS) if (existsSync(p)) return { bin: p, viaWindows: true };
  }
  return null;
}

// ── Capture ─────────────────────────────────────────────────────────────────

function toWinPath(p) {
  return execFileSync('wslpath', ['-w', p], { encoding: 'utf8' }).trim();
}

function runChrome(browser, { url, out, width, height, headlessFlag, timeoutMs }) {
  return new Promise((resolve) => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'flowviant-shot-'));
    const cleanup = () => { try { rmSync(userDataDir, { recursive: true, force: true }); } catch { /* best effort */ } };

    // A Windows .exe can't read a WSL path — translate the file args it touches.
    let outArg = out;
    let udArg = userDataDir;
    if (browser.viaWindows) {
      try {
        outArg = toWinPath(out);
        udArg = toWinPath(userDataDir);
      } catch {
        cleanup();
        return resolve({ ok: false, reason: 'wslpath', message: 'wslpath unavailable — cannot use Windows Chrome from WSL.' });
      }
    }

    const args = [
      headlessFlag,
      '--disable-gpu',
      '--no-sandbox',            // required as root / in many VMs + containers
      '--disable-dev-shm-usage', // small /dev/shm in containers/VMs crashes Chrome otherwise
      '--hide-scrollbars',
      '--force-color-profile=srgb',
      `--user-data-dir=${udArg}`,
      `--window-size=${width},${height}`,
      '--virtual-time-budget=5000', // let fonts/JS settle before capture (SPAs)
      `--screenshot=${outArg}`,
      url,
    ];

    let err = '';
    let child;
    try {
      child = spawn(browser.bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (e) {
      cleanup();
      return resolve({ ok: false, reason: 'spawn', message: e.message });
    }
    child.stderr?.on('data', (d) => { err += d.toString(); });
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      cleanup();
      resolve({ ok: false, reason: 'spawn', message: e.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      cleanup();
      if (existsSync(out) && statSync(out).size > 0) return resolve({ ok: true, path: out });
      const tail = err.trim().split('\n').slice(-2).join(' ');
      resolve({ ok: false, reason: 'render', message: `Chrome exited (code ${code}) without an image.${tail ? ' ' + tail : ''}` });
    });
  });
}

/** Capture `url` to a PNG at `out`. Tries new headless, then classic headless
 *  (older Chromium). Resolves { ok, path } or { ok:false, reason, message }. */
export async function captureScreenshot({ url, out, width = 1440, height = 900, timeoutMs = 60_000 }) {
  const browser = resolveBrowser();
  if (!browser) {
    return {
      ok: false,
      reason: 'no-browser',
      message: 'No Chrome/Chromium/Edge found. Install one (Linux: `sudo apt install chromium`) to capture screenshot evidence.',
    };
  }
  let r = await runChrome(browser, { url, out, width, height, headlessFlag: '--headless=new', timeoutMs });
  if (!r.ok && r.reason === 'render') {
    // Older Chromium rejects `--headless=new` — retry with classic headless.
    r = await runChrome(browser, { url, out, width, height, headlessFlag: '--headless', timeoutMs });
  }
  return r;
}

// ── CLI ───────────────────────────────────────────────────────────────────

function getOpt(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** `flowviant shot <url> [--out file.png] [--width N] [--height N] [--base64]`
 *  On success prints the PNG path (or its base64 with --base64) to stdout and
 *  exits 0. On any failure: a hint on stderr, exit 1 (graceful — the agent then
 *  attaches text evidence instead). Usage error exits 2. */
export async function runShot(argv) {
  const url = argv.find((a) => !a.startsWith('--') && /^(https?|file|data):/i.test(a));
  if (!url) {
    console.error('usage: flowviant shot <url> [--out file.png] [--width 1440] [--height 900] [--base64]');
    console.error('  url: a running page (http://localhost:5173/…), a built file (file://…), or a data: URL');
    process.exit(2);
  }
  const out = getOpt(argv, '--out') || join(process.cwd(), `flowviant-shot-${Date.now()}.png`);
  const width = Number(getOpt(argv, '--width')) || 1440;
  const height = Number(getOpt(argv, '--height')) || 900;
  const wantBase64 = argv.includes('--base64');

  const r = await captureScreenshot({ url, out, width, height });
  if (!r.ok) {
    console.error(`flowviant shot: ${r.message}`);
    process.exit(1);
  }
  if (wantBase64) {
    process.stdout.write(readFileSync(out).toString('base64'));
  } else {
    console.log(r.path);
  }
  process.exit(0);
}
