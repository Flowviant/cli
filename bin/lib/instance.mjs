/**
 * ONE DAEMON PER CREDENTIAL, refused at startup.
 *
 * WHY THIS EXISTS. Nothing stopped two daemons before, and the server hands
 * work out by READING, never claiming: `listWorkTurnJobs` selects every pending
 * turn for the fleet token, `listShipJobs` reads a flag. So two daemons on one
 * credential are offered the SAME turn — and the ProjectRoom nudges every
 * connected daemon socket at once, so they do not even drift out of phase.
 *
 * The per-worktree `flowviant-turn.lock` cannot save it. That lock is written
 * AFTER the work token is minted and the attachments are fetched — a window
 * containing a network round trip — so both daemons clear the check and both
 * spawn a CLI into one held conversation. It was built for a RESTARTED daemon
 * (its own comment says so, work.mjs), where the holder is already live when
 * the successor looks; it was never a concurrency primitive.
 *
 * What the duplicate run costs, all of it invisible in the tab: two Claudes
 * editing one worktree, two cards from one `file_card` (no idempotency key),
 * the session write budget spent twice, quota spent twice — and then exactly
 * ONE answer survives, because `settleWorkTurn` is atomic. The side effects
 * land twice and the transcript shows one turn.
 *
 * KEYED ON THE CREDENTIAL, NOT THE REPO. The credential is stored once, at
 * ~/.flowviant/credentials.json, so `flowviant` in two DIFFERENT checkouts is
 * still one project served twice — and that case is strictly worse, because the
 * two daemons have different worktree roots and the turn lock cannot even see
 * across them. Keying on the token catches both, and still lets a second
 * credential run a second project on the same machine.
 *
 * ...AND ONE DAEMON PER REPO, which is NOT the same statement. The lock above
 * is keyed on the credential, and the two coincide only while one credential
 * serves one project — which is the product's law but not a thing this file can
 * assume. Two DIFFERENT credentials pointing at one checkout both acquired
 * happily (measured), giving two daemons in one working tree: two `git fetch`,
 * two worktree sweeps, `retireWorkSessions` in one removing directories the
 * other is serving, and a ship in one racing a rebase in the other. No server
 * lease can arbitrate any of that, because the server never sees a directory.
 * So the repo is checked too, across every credential's lock.
 *
 * WHAT A SECOND RUN DOES, and this is the whole rule:
 *
 *   SAME REPO      -> the new run WINS. The holder is asked to stand down and
 *                     this daemon takes its place. Re-running `flowviant` in a
 *                     directory you are working in means "serve this repo", and
 *                     the process already serving it is by definition the one
 *                     you are replacing. That is a restart, and a restart
 *                     should not require you to go and find a pid.
 *
 *   DIFFERENT REPO -> REFUSED, and nothing is signalled. That daemon is serving
 *                     other work; killing it because you happened to run this
 *                     command elsewhere is not a restart, it is collateral.
 *                     `--takeover` overrides, deliberately explicitly.
 *
 * One rule, and it is the invariant stated as behaviour: one daemon per repo.
 * `--no-takeover` (or FLOWVIANT_NO_TAKEOVER=1) makes even the same-repo case
 * refuse, for anyone who wants the old ceremony.
 *
 * IT FAILS OPEN. A home directory we cannot write to is not a reason to refuse
 * to start; it is a reason to say so and carry on unguarded.
 */

import { execFileSync } from 'node:child_process';
import {
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { VERSION } from './config.mjs';

/** Deliberately a HASH: a credential must never become a filename. */
export function instanceLockPath(fleetToken) {
  const key = createHash('sha256').update(String(fleetToken || 'anon')).digest('hex').slice(0, 12);
  return join(homedir(), '.flowviant', `daemon-${key}.lock`);
}

/** Numeric dotted compare, -1/0/1. Unparsable compares EQUAL, so a version we
 *  cannot read never silently authorises a downgrade. */
function cmpVersion(a, b) {
  const x = String(a).split('.').map((n) => Number.parseInt(n, 10));
  const y = String(b).split('.').map((n) => Number.parseInt(n, 10));
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const p = x[i] ?? 0;
    const q = y[i] ?? 0;
    if (Number.isNaN(p) || Number.isNaN(q)) return 0;
    if (p !== q) return p > q ? 1 : -1;
  }
  return 0;
}

/** Signal 0 — a liveness probe, not a kill. EPERM means alive and not ours. */
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

function readHolder(path) {
  try {
    const v = JSON.parse(readFileSync(path, 'utf8'));
    return v && Number.isInteger(v.pid) && v.pid > 0 ? v : null;
  } catch {
    return null; // absent, truncated, or half-written — treat as no holder
  }
}

const record = (repoRoot) =>
  JSON.stringify({
    pid: process.pid,
    repoRoot,
    startedAt: new Date().toISOString(),
    // The script we were started from, and what we are. A takeover matches the
    // live command line against `entry` before signalling anything — a lock
    // records a PID, and a crashed daemon's PID can be reused by anything.
    entry: process.argv[1] || '',
    version: VERSION,
  });

/** Same directory, whatever it is spelled as — symlinks and trailing slashes
 *  included. A repo compared by string would let `/repo` and `/repo/` past. */
function samePath(a, b) {
  if (!a || !b) return false;
  const norm = (v) => {
    try {
      return realpathSync(v);
    } catch {
      return String(v).replace(/\/+$/, '');
    }
  };
  return norm(a) === norm(b);
}

/**
 * A LIVE daemon in this same checkout, under a DIFFERENT credential.
 *
 * The lock above cannot see one: it is keyed on the credential, so a second
 * token in the same directory opens its own file and takes it. Every other
 * lock file on this machine is ours to read, so read them.
 *
 * Returns the holder, or null. A stale file never blocks — it is cleared by
 * whichever acquire owns it, and blocking on a corpse would be worse than the
 * thing this prevents.
 */
/** Which lock file a neighbour holder was read from — takeOverFrom waits on it. */
const NEIGHBOUR_PATHS = new WeakMap();
function neighbourLockPath(holder, fallback) {
  return NEIGHBOUR_PATHS.get(holder) ?? fallback;
}

export function daemonInSameRepo(repoRoot, ownPath) {
  const dir = join(homedir(), '.flowviant');
  let files;
  try {
    files = readdirSync(dir).filter((f) => /^daemon-[0-9a-f]{12}\.lock$/.test(f));
  } catch {
    return null;
  }
  for (const f of files) {
    const path = join(dir, f);
    if (path === ownPath) continue; // our own credential — the lock above owns that question
    const holder = readHolder(path);
    if (!holder || !alive(holder.pid)) continue;
    if (holder.pid === process.ppid) continue; // ourselves mid self-update re-exec
    if (samePath(holder.repoRoot, repoRoot)) {
      NEIGHBOUR_PATHS.set(holder, path);
      return holder;
    }
  }
  return null;
}

/**
 * IS THIS PID STILL THE DAEMON THAT TOOK THE LOCK?
 *
 * `process.kill(pid, 0)` says "a process exists", which is not the same claim,
 * and the difference matters the moment we are about to signal it. Matched on
 * the holder's own recorded ENTRYPOINT, never on the word "flowviant": a
 * command line merely CONTAINING it matches a shell, an editor, or a test
 * runner living under a `…-flowviant/` directory. That last one is not
 * hypothetical — a looser version of this check SIGTERMed one.
 *
 * A lock with no `entry` predates this and is never signalled.
 */
function stillTheHolder(holder) {
  const want = typeof holder?.entry === 'string' ? holder.entry : null;
  if (!want) return false;
  try {
    if (platform() === 'linux') {
      return readFileSync(`/proc/${holder.pid}/cmdline`, 'utf8').replace(/\0/g, ' ').includes(want);
    }
    return execFileSync('ps', ['-o', 'command=', '-p', String(holder.pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
    }).includes(want);
  } catch {
    return false; // gone, or unreadable — not something we signal
  }
}

/** Blocking, because this runs before there is an event loop worth yielding to
 *  and the caller cannot proceed until it knows whether the holder is gone. */
const sleep = (ms) => {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    /* no SharedArrayBuffer — check again immediately */
  }
};

/** How long the outgoing daemon gets to stand down cleanly. Its SIGTERM handler
 *  kills the CLI children it spawned and stops its preview tunnels; both are
 *  why we ask before we insist. */
const TAKEOVER_GRACE_MS = 20_000;

/**
 * Ask the holder to stand down, then take its place.
 *
 * SIGTERM FIRST, and not out of politeness: the daemon's handler runs its
 * teardown — it kills the CLI children it spawned and stops its preview
 * tunnels, which are DETACHED and would otherwise keep a public hostname
 * serving a worktree until the box reboots.
 *
 * WAIT ON THE LOCK FILE, not the pid. A departing daemon's release() removes it
 * on exit, so the file changing IS the handover. `kill(pid, 0)` cannot see it:
 * a process that exited but has not been reaped is a ZOMBIE and answers signal
 * 0 exactly like a living one — measured, a peer that exited cleanly still read
 * as alive for the full grace window.
 *
 * And "gone" is NOT "the file stopped naming our pid". It can stop naming it
 * because the holder SELF-UPDATED: update.mjs re-execs and the successor adopts
 * this same lock through the ppid branch. Treating that as free steals a live
 * daemon's lock and leaves it running unguarded — measured doing exactly that.
 */
function takeOverFrom(holder, path, log, { allowDowngrade = false } = {}) {
  if (!holder?.pid || !alive(holder.pid)) return null; // already gone
  if (!stillTheHolder(holder)) {
    return { failed: `pid ${holder.pid} is no longer the daemon that took this lock — refusing to signal it` };
  }
  if (!allowDowngrade && holder.version && cmpVersion(VERSION, holder.version) < 0) {
    return {
      failed: `the running daemon is ${holder.version} and this one is ${VERSION} — refusing to replace a newer daemon with an older one (--takeover-downgrade if you mean it)`,
    };
  }

  log?.(`asking daemon pid ${holder.pid} to stand down…`);
  try {
    process.kill(holder.pid, 'SIGTERM');
  } catch {
    return { failed: `could not signal pid ${holder.pid}` };
  }

  const standing = () => {
    const now = readHolder(path);
    if (!now || !alive(now.pid)) return null;
    return now;
  };
  const deadline = Date.now() + TAKEOVER_GRACE_MS;
  for (;;) {
    const now = standing();
    if (!now) break;
    if (now.pid !== holder.pid) {
      return {
        failed: `the daemon handed over to pid ${now.pid}${now.version ? ` (${now.version})` : ''} while we waited — it is mid-update, so try again in a moment`,
      };
    }
    if (Date.now() >= deadline) {
      log?.(`pid ${holder.pid} did not stand down within ${TAKEOVER_GRACE_MS / 1000}s — forcing it.`);
      try {
        process.kill(holder.pid, 'SIGKILL');
      } catch {
        /* exited in the gap */
      }
      sleep(600);
      const after = standing();
      if (after && after.pid !== holder.pid) {
        return { failed: `the daemon handed over to pid ${after.pid} — try again in a moment` };
      }
      if (after) return { failed: `pid ${holder.pid} would not stop` };
      break;
    }
    sleep(400);
  }

  // A SIGKILLed daemon never ran its release(), so clear what it left.
  try {
    rmSync(path, { force: true });
  } catch {
    return { failed: 'could not clear the lock file' };
  }
  log?.(`daemon pid ${holder.pid} stopped — taking over.`);
  return null;
}

/**
 * Take the lock, or report who holds it.
 *
 * Returns `{ ok: true, release }` — call `release()` to drop it, and it is
 * already wired to process exit — or `{ ok: false, holder }` with the other
 * daemon's pid and repo so the caller can say something useful.
 *
 * `wx` is the whole guarantee: create-exclusive is one atomic syscall, which is
 * the property the turn lock's check-then-write does not have.
 */
export function acquireInstanceLock(fleetToken, repoRoot, opts = {}) {
  const { takeover: force = false, noTakeover = false, allowDowngrade = false, log } = opts;
  if (process.env.FLOWVIANT_ALLOW_MULTI === '1') return { ok: true, release: () => {} };
  const path = instanceLockPath(fleetToken);
  try {
    mkdirSync(join(homedir(), '.flowviant'), { recursive: true });
  } catch {
    return { ok: true, release: () => {}, unguarded: true };
  }

  // ONE DAEMON PER REPO, checked across every credential — see the header. This
  // runs BEFORE we take our own lock, so a refusal leaves nothing behind.
  const neighbour = daemonInSameRepo(repoRoot, path);
  if (neighbour) {
    // Same working tree, another credential. Under "one daemon per repo" the
    // new run wins here too — but it is signalling a process that belongs to a
    // DIFFERENT project, so it is worth saying out loud rather than doing
    // quietly.
    if (noTakeover) return { ok: false, holder: neighbour, sameRepo: true };
    log?.(`another project's daemon is serving this repo (pid ${neighbour.pid}).`);
    const bad = takeOverFrom(neighbour, neighbourLockPath(neighbour, path), log);
    if (bad) return { ok: false, holder: neighbour, sameRepo: true, takeoverFailed: bad.failed };
  }

  // Two passes at most: one to clear a stale holder, one to take the lock. A
  // loop here would spin against a peer that keeps re-taking it.
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd;
    try {
      fd = openSync(path, 'wx');
    } catch (e) {
      if (e.code !== 'EEXIST') return { ok: true, release: () => {}, unguarded: true };
      const holder = readHolder(path);
      if (!holder || !alive(holder.pid)) {
        // A crashed daemon's leftover. Clear it and take it on the next pass.
        try {
          rmSync(path, { force: true });
        } catch {
          return { ok: true, release: () => {}, unguarded: true };
        }
        continue;
      }
      // OUR OWN PARENT, which is not a second daemon — it is this one, mid
      // re-exec. The SELF-UPDATE is the case: a live daemon holding this lock
      // installs a new version, spawns it, and stays alive as a proxy awaiting
      // it (update.mjs), so the successor's ppid IS the holder. Refusing there
      // would brick every auto-update. Adopt instead; the parent's release is
      // ownership-checked, so it will not delete the lock it handed over.
      // (`flowviant login` also proxies a child, but that parent never reached
      // the daemon and holds nothing — the child simply acquires.)
      if (holder.pid === process.ppid) {
        try {
          writeFileSync(path, record(repoRoot));
        } catch {
          return { ok: true, release: () => {}, unguarded: true };
        }
        return { ok: true, release: makeRelease(path) };
      }
      // THE RULE. Same repo -> this run replaces it; different repo -> refuse
      // and signal nothing, unless --takeover says otherwise. See the header.
      const here = samePath(holder.repoRoot, repoRoot);
      const wanted = force || (here && !noTakeover);
      if (wanted) {
        const bad = takeOverFrom(holder, path, log, { allowDowngrade });
        if (bad) return { ok: false, holder, takeoverFailed: bad.failed, sameRepo: here };
        continue; // the file is gone — the next pass takes it
      }
      return { ok: false, holder, sameRepo: here };
    }
    try {
      writeSync(fd, record(repoRoot));
    } finally {
      closeSync(fd);
    }
    return { ok: true, release: makeRelease(path) };
  }
  // Both passes lost to something re-creating the file — assume a peer.
  return { ok: false, holder: readHolder(path) };
}

/** Release ONLY what we still own: a successor that adopted the lock (see the
 *  ppid branch) must not have it deleted out from under it when we exit. */
function makeRelease(path) {
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    const holder = readHolder(path);
    if (holder && holder.pid !== process.pid) return; // handed over — leave it
    try {
      rmSync(path, { force: true });
    } catch {
      /* best-effort; a stale file is cleared by the next acquire */
    }
  };
  // 'exit' covers the SIGINT/SIGTERM handlers too — both call process.exit().
  process.on('exit', release);
  return release;
}
