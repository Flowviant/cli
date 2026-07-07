/**
 * Self-update — keep a long-running daemon current without babysitting it.
 *
 * A daemon runs for hours/days from one launch, so "latest at launch" (even with
 * `npx flowviant@latest`) doesn't help a process that's already up when a new
 * version ships. The server reports {latest, min} on every roster poll; the
 * daemon compares its own VERSION and, at a SAFE boundary (startup or idle —
 * never mid-task), self-updates + re-execs. Below `min` it updates regardless
 * (older protocol is known-broken); otherwise it honors AUTO_UPDATE. When it
 * can't install (npx cache, or auto off) it nags with the exact command.
 */

import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { VERSION } from './config.mjs';
import { note, ok, warn } from './ui.mjs';

/** Compare x.y.z version strings → -1 | 0 | 1 (missing parts read as 0). */
export function cmpVersion(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

/**
 * npx runs from a per-invocation cache dir. `npm i -g` would install to a
 * DIFFERENT location than the one executing, so re-execing our own path would
 * loop on the stale cached copy. Detect npx and skip the install (nag instead —
 * relaunching with `npx flowviant@latest` is the npx-native update).
 */
export function runningViaNpx() {
  const ua = process.env.npm_config_user_agent || '';
  const argv1 = process.argv[1] || '';
  let self = '';
  try {
    self = fileURLToPath(import.meta.url);
  } catch {
    /* non-file URL — ignore */
  }
  return /\bnpx\b/.test(ua) || /[\\/]_npx[\\/]/.test(argv1) || /[\\/]_npx[\\/]/.test(self);
}

/**
 * Replace this process with a fresh one running the just-installed version.
 * `npm i -g` overwrote the global package in place, so re-running argv[1] loads
 * the NEW code. We tear down first (idle-gated, so nothing's mid-task) and keep
 * this process alive only as a thin proxy waiting on the child, so the user's
 * shell stays attached to one foreground process.
 */
function reexec(teardown) {
  try {
    teardown?.();
  } catch {
    /* best-effort */
  }
  const child = spawn(process.execPath, process.argv.slice(1), {
    stdio: 'inherit',
    env: process.env,
  });
  child.on('exit', (code) => process.exit(code ?? 0));
}

/** Install @latest globally. Throws on failure (EACCES without sudo, offline…). */
function installLatest() {
  execFileSync('npm', ['install', '-g', 'flowviant@latest'], { stdio: 'inherit' });
}

/** `flowviant update` — explicit, manual update. Does not re-exec into a daemon
 *  (the user ran a one-shot command); it installs and tells them to relaunch. */
export function runUpdateCommand() {
  if (runningViaNpx()) {
    note('running via npx — just relaunch with `npx flowviant@latest` to get the newest.');
    return;
  }
  try {
    note(`updating flowviant (currently ${VERSION})…`);
    installLatest();
    ok('updated. Relaunch `flowviant` to run the new version.');
  } catch (e) {
    warn(`update failed (${e?.message ?? e}). Try: npm i -g flowviant@latest`);
  }
}

// Nag at most once per target version, so a poll every ~10s doesn't spam.
let naggedFor = null;

/**
 * React to the server's {latest, min} signal from a roster poll.
 * @returns true if it kicked off a self-update + re-exec (caller must stop).
 */
export function handleVersionSignal({ latest, min, autoUpdate, safeToUpdate, teardown }) {
  const cur = VERSION;
  const belowMin = min && cmpVersion(cur, min) < 0;
  const belowLatest = latest && cmpVersion(cur, latest) < 0;
  if (!belowMin && !belowLatest) return false; // current — nothing to do
  const target = latest || min;
  const npx = runningViaNpx();
  const wantInstall = belowMin || autoUpdate;

  if (wantInstall && !npx) {
    if (!safeToUpdate) {
      // Outdated but an agent is mid-task — wait for idle. Nag once meanwhile.
      if (naggedFor !== target) {
        naggedFor = target;
        note(`flowviant ${cur} → ${target} available — self-updating once agents go idle.`);
      }
      return false;
    }
    try {
      note(`flowviant ${cur} → ${target}: self-updating…`);
      installLatest();
      ok('updated — restarting into the new version.');
      reexec(teardown);
      return true;
    } catch (e) {
      warn(`self-update failed (${e?.message ?? e}) — update manually: npm i -g flowviant@latest`);
      naggedFor = target; // don't retry-spam a failing install every poll
      return false;
    }
  }

  // Can't or won't auto-install → nag once per target version.
  if (naggedFor !== target) {
    naggedFor = target;
    const how = npx ? 'relaunch with `npx flowviant@latest`' : 'run `npm i -g flowviant@latest`';
    if (belowMin) {
      warn(`flowviant ${cur} is below the minimum ${min} — live mode may not work. Update: ${how}.`);
    } else {
      note(`flowviant ${cur} → ${latest} available. Update: ${how}.`);
    }
  }
  return false;
}
