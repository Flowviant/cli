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

import { execFileSync } from 'node:child_process';
import { platform, uptime } from 'node:os';
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

/**
 * WHICH BOOT THIS IS — so a pid or process-group id read back off disk is only
 * ever believed in the boot that wrote it.
 *
 * A registry outlives a reboot and pids do not: after one, the number a file
 * remembers belongs to whatever the kernel handed it to next — another user's
 * service, the operator's shell — and signal-0 says "alive" about a stranger.
 * Linux names the boot outright (`boot_id`); elsewhere the boot INSTANT stands
 * in, derived from the uptime and compared with slack, because two reads a
 * second apart disagree by the rounding.
 */
const BOOT_SLACK_S = 120;
export function bootMark() {
  try {
    const id = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    if (id) return id;
  } catch {
    /* not Linux, or /proc is not mounted */
  }
  return `bt:${Math.round(Date.now() / 1000 - uptime())}`;
}
/** Was `mark` written during this boot? An absent mark is NOT this boot —
 *  an entry that cannot say when it was written cannot be trusted across one. */
export function sameBoot(mark, now = bootMark()) {
  if (typeof mark !== 'string' || !mark) return false;
  if (mark.startsWith('bt:') && now.startsWith('bt:'))
    return Math.abs(Number(mark.slice(3)) - Number(now.slice(3))) <= BOOT_SLACK_S;
  return mark === now;
}

/**
 * WHEN A PROCESS STARTED, as an opaque token — so a lock that remembers a pid
 * can tell the process it meant from one that inherited the number.
 *
 * Linux: field 22 of `/proc/<pid>/stat` (start time in clock ticks since boot),
 * read after the LAST `)` because the comm field may itself contain one.
 * macOS: `ps -o lstart=`. Null when it cannot be read, which callers treat as
 * "cannot tell" — never as a mismatch.
 */
export function processStartTime(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    // `rest[0]` is field 3 (state), so field 22 is rest[19].
    const st = rest[19];
    return st && /^\d+$/.test(st) ? `${bootMark()}:${st}` : null;
  } catch {
    /* not Linux, or the pid is gone */
  }
  if (platform() !== 'darwin') return null;
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
    }).trim();
    return out || null;
  } catch {
    return null;
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
