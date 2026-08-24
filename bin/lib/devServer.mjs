/**
 * RUNNING THE PROJECT'S DEV COMMAND IN A TAB'S WORKTREE.
 *
 * THIS FILE MUST NEVER READ A REPO FILE TO DECIDE WHAT TO EXECUTE. That is the
 * one rule, and it is the whole difference between this and the live-preview
 * target deleted in 2026-08-21, whose obituary is in `preview.mjs`: that one
 * read a command out of `.flowviant/preview.json` — a file the BRANCH controls
 * — or inferred one from package.json, then `spawn(cmd, {shell: true})` with
 * `{...process.env}`, running `npm install` and its lifecycle scripts and
 * handing the resulting internet-exposed process the daemon's own credential.
 * One click behind a button and a hostile branch owned the machine.
 *
 * Here the argv arrives ON THE JOB, already parsed from a string a human
 * approved once for this project and stored server-side. The branch cannot
 * change it. This file re-validates the SHAPE at its own boundary — one place
 * doing a check is one deploy away from being zero places — and spawns with
 * `shell: false`.
 *
 * THE HONEST LIMIT, stated here rather than implied: pinning the command does
 * not pin what the command does. `npm run dev` dereferences to `scripts.dev`,
 * which the branch writes. What this buys is that a human chose the ENTRYPOINT
 * in the open, plus a child environment that is a strict subset of what the
 * agent's own `npm run dev` gets today. The child runs as the SAME UID as this
 * daemon and `~/.flowviant/credentials.json` is 0600 and readable by it. The
 * env allowlist is a control against ACCIDENT AND INHERITANCE — a crash
 * reporter, an error page that dumps `process.env`, a build log — and it is NOT
 * confinement. Nothing in the UI may say "sandboxed" or "isolated".
 *
 * NO PORT IS EVER SCRAPED. The deleted feature learned its port from the
 * child's stdout and tunnelled a guess when it found none. A scraped port has
 * no attribution behind it, and "this port was measured, by cwd, inside THIS
 * worktree" is the only real security control this feature family has. The port
 * here comes from `listenersIn` or it does not come at all — and a running
 * server with no measured port is a REAL state that gets a sentence.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { childEnv } from './childEnv.mjs';
import { mutateRegistry, processAlive, readRegistry } from './procRegistry.mjs';
import { listenersIn } from './listeners.mjs';
import { scrub } from './env.mjs';

const FLOWVIANT_DIR = join(homedir(), '.flowviant');
const REGISTRY = join(FLOWVIANT_DIR, 'devruns.json');
const REGISTRY_LOCK = join(FLOWVIANT_DIR, 'devruns.lock');

/** Output we keep. Only the tail is ever uplinked, and it is scrubbed on the
 *  way out: a dev server routinely prints connection strings. */
const RING_BYTES = 512 * 1024;
const TAIL_BYTES = 4096;
/** How long we wait for the command to bind something inside the worktree
 *  before reporting it as running-but-unmeasured. */
const BIND_WATCH_MS = 45_000;
/** At most this many restarts inside the window, and only for a run that bound
 *  at least once — a server that never bound is a broken command, not a crash,
 *  and restarting it burns the box. */
const MAX_RESTARTS = 3;
const RESTART_WINDOW_MS = 10 * 60_000;
const BACKOFF_MS = [2_000, 8_000, 30_000];
const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);

const remember = (entry) =>
  mutateRegistry(FLOWVIANT_DIR, REGISTRY, REGISTRY_LOCK, (list) => [
    ...list.filter((e) => e.pid !== entry.pid),
    entry,
  ]);
const forget = (pid) =>
  mutateRegistry(FLOWVIANT_DIR, REGISTRY, REGISTRY_LOCK, (list) =>
    list.filter((e) => e.pid !== pid)
  );

/** SIGTERM the GROUP, wait, then SIGKILL it. `npm run dev` spawns grandchildren
 *  that outlive a kill of the parent, which is what `detached: true` and the
 *  negative pid are for. */
function killGroup(pid, graceMs = 8_000) {
  const signal = (sig) => {
    try {
      process.kill(-pid, sig);
    } catch {
      try {
        process.kill(pid, sig);
      } catch {
        /* already gone */
      }
    }
  };
  signal('SIGTERM');
  setTimeout(() => {
    if (processAlive(pid)) signal('SIGKILL');
  }, graceMs).unref?.();
}

/**
 * THE FRESH-WORKTREE ANSWER, measured rather than discovered as a bug.
 *
 * `ensureWorktree` is a bare `git worktree add`, so a new tab has source and no
 * `node_modules`, and the first run there would fail with something unhelpful.
 * This is a measurement, and it routes dependency installation to the one place
 * that should own it: a turn in the tab, with a human asking and an audit row
 * for it. The button is never silently broken and the remedy is one sentence.
 */
export function missingDeps(worktree, argv) {
  if (!PACKAGE_MANAGERS.has(argv[0])) return false;
  return !existsSync(join(worktree, 'node_modules'));
}

/**
 * Start the command and supervise it.
 *
 * `onState` is called with `{started, port, pid, error, endedReason, logTail,
 * restarts}` at each transition; the caller reports it upward. Resolves once
 * the first outcome is known — bound, or running-unmeasured, or failed — and
 * keeps supervising after that.
 */
export function startDevServer({ sessionId, worktree, argv, log, onState, onExit }) {
  if (missingDeps(worktree, argv)) {
    return Promise.resolve({
      ok: false,
      endedReason: 'no_deps',
      error:
        "No dependencies are installed in this tab's worktree. Ask your Claude to install them, then run dev again.",
    });
  }

  let ring = '';
  let child = null;
  let stopped = false;
  let everBound = false;
  let restarts = 0;
  const restartTimes = [];

  const append = (buf) => {
    ring = (ring + buf.toString('utf8')).slice(-RING_BYTES);
  };
  const tail = () => scrub(ring.slice(-TAIL_BYTES));

  const spawnOnce = () => {
    child = spawn(argv[0], argv.slice(1), {
      cwd: worktree,
      env: childEnv({ cwd: worktree }),
      // Its own process group, so the whole tree can be reaped. Load-bearing:
      // a package manager is a wrapper and the server is its grandchild.
      detached: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // PERMANENT DRAIN LISTENERS, and this is not optional. A detached
    // long-lived child on piped stdio with no reader BLOCKS ON WRITE once the
    // pipe buffer fills, so a dev server would hang after a few minutes of HMR
    // logs — the least diagnosable failure this feature could have.
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    return child;
  };

  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };

    const attachExit = () => {
      child.once('error', (e) => {
        forget(child?.pid);
        finish({ ok: false, endedReason: 'spawn_failed', error: String(e?.message || e) });
      });
      child.once('exit', (code, signal) => {
        const pid = child?.pid;
        forget(pid);
        if (stopped) return;
        // A command that NEVER bound is a broken command, not a crash. Restarting
        // it would spin the box on somebody's typo.
        const now = Date.now();
        while (restartTimes.length && now - restartTimes[0] > RESTART_WINDOW_MS) restartTimes.shift();
        if (everBound && restartTimes.length < MAX_RESTARTS) {
          const delay = BACKOFF_MS[Math.min(restartTimes.length, BACKOFF_MS.length - 1)];
          restartTimes.push(now);
          restarts += 1;
          log?.(`dev server exited (${signal || code}); restarting in ${delay / 1000}s`);
          setTimeout(() => {
            if (stopped) return;
            spawnOnce();
            attachExit();
            remember(entryFor());
            onState?.({ started: true, port: null, pid: child.pid, restarts, logTail: tail() });
          }, delay).unref?.();
          return;
        }
        onExit?.({
          exitCode: typeof code === 'number' ? code : null,
          signal: signal || null,
          logTail: tail(),
          endedReason: everBound ? 'crashed' : 'spawn_failed',
          error: everBound
            ? `the dev server exited (${signal || `code ${code}`})`
            : `the command exited immediately (${signal || `code ${code}`}) without listening`,
        });
        finish({ ok: false, endedReason: everBound ? 'crashed' : 'spawn_failed' });
      });
    };

    const entryFor = () => ({
      sessionId,
      pid: child.pid,
      cwd: worktree,
      startedAt: Date.now(),
      owner: process.pid,
    });

    try {
      spawnOnce();
    } catch (e) {
      finish({ ok: false, endedReason: 'spawn_failed', error: String(e?.message || e) });
      return;
    }
    attachExit();
    remember(entryFor());

    // WATCH FOR THE BIND through `listenersIn` and nowhere else.
    const deadline = Date.now() + BIND_WATCH_MS;
    const poll = setInterval(() => {
      if (stopped || !child || child.exitCode !== null) {
        clearInterval(poll);
        return;
      }
      const found = listenersIn(worktree)[0];
      if (found) {
        clearInterval(poll);
        everBound = true;
        onState?.({ started: true, port: found.port, pid: child.pid, restarts, logTail: tail() });
        finish({ ok: true, port: found.port, pid: child.pid, stop, restarts });
        return;
      }
      if (Date.now() > deadline) {
        clearInterval(poll);
        // RUNNING, NOTHING MEASURED. A real state and not a spinner: a
        // `docker compose up` binds from inside a container whose cwd is not
        // this worktree and will never be attributed.
        onState?.({ started: true, port: null, pid: child.pid, restarts, logTail: tail() });
        finish({ ok: true, port: null, pid: child.pid, stop, restarts });
      }
    }, 1000);
    poll.unref?.();

    function stop() {
      stopped = true;
      clearInterval(poll);
      const pid = child?.pid;
      if (pid) {
        killGroup(pid);
        forget(pid);
      }
    }
  });
}

/**
 * What survived a daemon restart.
 *
 * IDENTITY IS NOT THE COMMAND STRING. `stillOurs` in `preview.mjs` matches a
 * substring of `/proc/<pid>/cmdline`, which cannot work here: `npm run dev` is
 * a human-authored string identical across two tabs, two worktrees, and the
 * driver's own hand-started server. Identity is the CWD — the same readlink
 * `listeners.mjs` already does — plus the pid still being alive. Both must
 * hold, and a could-not-measure is NOT a match and kills nothing.
 */
export function adoptableDevRuns() {
  const out = [];
  for (const e of readRegistry(REGISTRY)) {
    if (!e || typeof e.sessionId !== 'string' || !Number.isInteger(e.pid)) continue;
    // Another LIVE daemon owns it — leave it alone entirely.
    if (e.owner && e.owner !== process.pid && processAlive(e.owner)) continue;
    if (!processAlive(e.pid)) continue;
    out.push(e);
  }
  return out;
}

/** Kill a registry entry's process group and drop the row. Used when the
 *  session it belonged to is gone. */
export function killDevRunEntry(entry) {
  if (!entry || !Number.isInteger(entry.pid)) return;
  killGroup(entry.pid);
  forget(entry.pid);
}

/** Adopt or reap what the previous process left behind. `activeIds` is the set
 *  of sessions still live on the server; a run whose session is gone is killed,
 *  and one whose session survives is handed back to the caller to re-supervise. */
export function reapOrphanDevRuns(activeIds, log) {
  const adopt = [];
  for (const e of adoptableDevRuns()) {
    if (Array.isArray(activeIds) && !activeIds.includes(e.sessionId)) {
      log?.(`dev server for a closed tab (pid ${e.pid}) — stopping it`);
      killDevRunEntry(e);
      continue;
    }
    adopt.push(e);
  }
  return adopt;
}
