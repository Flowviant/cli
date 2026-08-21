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
 * IT FAILS OPEN. A home directory we cannot write to is not a reason to refuse
 * to start; it is a reason to say so and carry on unguarded.
 */

import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

/** Deliberately a HASH: a credential must never become a filename. */
export function instanceLockPath(fleetToken) {
  const key = createHash('sha256').update(String(fleetToken || 'anon')).digest('hex').slice(0, 12);
  return join(homedir(), '.flowviant', `daemon-${key}.lock`);
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
  JSON.stringify({ pid: process.pid, repoRoot, startedAt: new Date().toISOString() });

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
export function acquireInstanceLock(fleetToken, repoRoot) {
  if (process.env.FLOWVIANT_ALLOW_MULTI === '1') return { ok: true, release: () => {} };
  const path = instanceLockPath(fleetToken);
  try {
    mkdirSync(join(homedir(), '.flowviant'), { recursive: true });
  } catch {
    return { ok: true, release: () => {}, unguarded: true };
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
      return { ok: false, holder };
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
