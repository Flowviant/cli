/**
 * A DISK REGISTRY OF DETACHED PROCESSES — one implementation, two users.
 *
 * The daemon spawns things that outlive it: cloudflared tunnels, and now dev
 * servers. If the daemon dies without tearing them down, the successor has to
 * find them — a public tunnel nobody is minding, or a dev server holding a port
 * in a worktree about to be `git worktree remove`d, are both worse than the
 * crash that caused them.
 *
 * Lifted verbatim out of `preview.mjs`, which grew all of this for the tunnel
 * and now shares it rather than being copied. Two things were ADDED on the way
 * out, because a dev server lives for hours where a tunnel lived for minutes
 * and long-lived rows make both matter:
 *
 *  - an entry CAP, so a registry cannot grow without bound;
 *  - a TTL sweep for entries whose pid is long dead, so a file nobody prunes
 *    does not become a file nobody can read.
 */

import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';

const LOCK_STALE_MS = 15_000;
const MAX_ENTRIES = 32;
const ENTRY_TTL_MS = 7 * 24 * 60 * 60_000;

/**
 * Best-effort exclusive lock. Returns a release function; on failure returns
 * null and the caller proceeds UNLOCKED — losing an entry is bad, refusing to
 * record one at all is worse.
 */
export function acquireLock(dir, lockPath) {
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    return null;
  }
  for (let i = 0; i < 30; i++) {
    try {
      const fd = openSync(lockPath, 'wx');
      closeSync(fd);
      return () => {
        try {
          unlinkSync(lockPath);
        } catch {
          /* already released */
        }
      };
    } catch {
      // Held — unless it was left behind by something that died holding it.
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
          unlinkSync(lockPath);
          continue;
        }
      } catch {
        continue;
      }
      const until = Date.now() + 20;
      while (Date.now() < until) {
        /* busy-wait: 20ms, 30 times, then give up entirely */
      }
    }
  }
  return null;
}

export function readRegistry(path) {
  try {
    const v = JSON.parse(readFileSync(path, 'utf8'));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** Atomic: write a sibling temp file and rename over the target, so a reader
 *  never sees a half-written array. */
export function writeRegistry(dir, path, list) {
  try {
    mkdirSync(dir, { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(list));
    renameSync(tmp, path);
  } catch {
    /* best-effort */
  }
}

/** Signal-0 liveness. EPERM means alive and not ours, which is still alive. */
export function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/**
 * Read-modify-write under the lock, then prune.
 *
 * The prune is here rather than at the call sites so it cannot be forgotten by
 * one of them: an entry whose pid has been dead for a week is not a process
 * anybody is going to reap, and keeping it only makes the next reader slower
 * and the next pid collision more likely.
 */
export function mutateRegistry(dir, path, lockPath, fn) {
  const release = acquireLock(dir, lockPath);
  try {
    const next = fn(readRegistry(path));
    const now = Date.now();
    const pruned = next
      .filter((e) => {
        if (processAlive(e?.pid)) return true;
        const started = Number(e?.startedAt ?? 0);
        return started > 0 && now - started < ENTRY_TTL_MS;
      })
      .slice(-MAX_ENTRIES);
    writeRegistry(dir, path, pruned);
    return pruned;
  } finally {
    release?.();
  }
}
