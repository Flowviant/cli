/**
 * THE CROSS-PROCESS TURN LOCK — the one reading of "is a CLI of ours already
 * working in this directory".
 *
 * Split out of work.mjs (2026-09-26, SOLID F037). It is read by the session
 * lane before a spawn and by the ship executor before a merge, and it is pure
 * over the disk and the kernel: no manager state, so it needs no factory and
 * is tested directly (turnLock.test.mjs). The lock FILE's path is the
 * caller's (`sessionMetaPath(wt, 'flowviant-turn.lock')`); what a pid in it
 * means is this module's.
 */
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { processStartTime } from './procRegistry.mjs';

/**
 * The spawn lock: the pid of the CLI currently live in this worktree. A
 * restarted daemon must not put a second Claude into a directory the orphan
 * of its previous life is still editing — two CLIs appending to one held
 * conversation is exactly the incoherence workChains prevents in-process,
 * and the lock extends that guarantee across a restart. A dead pid is a
 * stale lock (removed here); a live one means "come back next poll".
 *
 * …AND A PID IS ONLY THE HOLDER WHILE IT IS STILL THE SAME PROCESS.
 *
 * The lock outlives a reboot or a daemon killed mid-turn, and pids are
 * recycled. Two readings treated a stranger as the holder and wedged every
 * turn and ship in the place until somebody deleted the file by hand: EPERM
 * was read as "alive, just not ours" — but the lock only ever holds a CLI this
 * daemon spawned under its own uid, so a pid we may not signal is by
 * definition not ours, i.e. stale — and a recycled pid of our OWN uid
 * answered signal 0 like the CLI it replaced. The lock now records the
 * process's start time beside the pid (`pid:start`); a live pid whose start
 * time differs is a different process. A lock with no start time (written by
 * an older daemon) keeps the old signal-0 reading, minus EPERM.
 */
export const turnLockedByLivePid = (lockPath) => {
  if (!lockPath || !existsSync(lockPath)) return false;
  let pid = 0;
  let start = null;
  try {
    const raw = readFileSync(lockPath, 'utf8').trim();
    const cut = raw.indexOf(':');
    pid = Number(cut < 0 ? raw : raw.slice(0, cut));
    start = cut < 0 ? null : raw.slice(cut + 1) || null;
  } catch {
    /* unreadable — treat as stale */
  }
  if (Number.isInteger(pid) && pid > 0) {
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = true; // signal 0 delivered — a process of OUR uid holds the pid
    } catch {
      /* ESRCH: gone. EPERM: another uid's process — never our CLI. Stale. */
    }
    if (alive) {
      const now = start ? processStartTime(pid) : null;
      // Unmeasurable start time is "cannot tell", which keeps the lock.
      if (!start || !now || now === start) return true;
    }
  }
  try {
    rmSync(lockPath, { force: true }); // dead holder — clear the stale lock
  } catch {
    /* best-effort */
  }
  return false;
};
