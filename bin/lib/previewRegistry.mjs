/**
 * THE PREVIEW TUNNEL REGISTRY — which cloudflared groups this box started, so
 * a daemon that died ungracefully has its public tunnels reaped by the next.
 *
 * cloudflared is detached so we can kill its whole group — which also means it
 * SURVIVES an ungraceful daemon death (SIGKILL, crash, box sleep), leaving a
 * public hostname pointed at a worktree with nobody minding it. We record each
 * group's pid + a signature and reap ours at the next start.
 *
 * The registry is a read-modify-write over one file in a directory that TWO
 * daemons can legitimately share (the 0.51.2 instance lock is keyed on a
 * CREDENTIAL, so two daemons serving two different projects are fine and both
 * write here). It was unlocked, written back when previews were serial. A lost
 * entry is precisely the case reaping exists for.
 *
 * ── ONE REGISTRY IMPLEMENTATION, NOT TWO (SOLID audit 2026-09-26, F006) ──
 *
 * `procRegistry.mjs` was lifted out of `preview.mjs` for the dev-run system and
 * then the session process groups, and preview kept its ORIGINAL copy of the
 * lock, the atomic read/write and the process start-time reader — which had
 * drifted: no bound on the file at all, and a start time with no boot mark.
 * This file is preview's POLICY over procRegistry's PRIMITIVES:
 *
 *  - THE LOCK AND THE ATOMIC WRITE are procRegistry's, same paths and same
 *    stale-lock recovery as before.
 *  - THE PRUNE IS PREVIEW'S OWN and it NEVER DISCARDS AN UNREAPED TUNNEL.
 *    procRegistry's default prune caps the file at 32 rows and ages out dead
 *    ones after a week; a cap would drop a live public tunnel's only record
 *    the day a box had 33 of them. So a row survives exactly while its tunnel
 *    pid is alive (signal 0, EPERM counting as alive) — a dead tunnel has
 *    nothing left to reap, and the reap pass itself drops those anyway. The
 *    file is bounded by the tunnels that exist.
 *  - ONE PROCESS IDENTITY: procRegistry's `processStartTime`, which carries the
 *    boot mark, in a NEW field, `ownerMark`, which this code prefers.
 *
 * ── THE FILE IS SHARED ACROSS DAEMON VERSIONS, SO THE OLD FIELD KEEPS ITS
 *    OLD SPELLING ──
 *
 * The daemon is the one component a deploy cannot upgrade, and previews.json
 * is shared by every daemon on the box: two projects, the tray's bundled WSL
 * daemon beside a curl install, a self-update window. A published daemon
 * compares `ownerStart` EXACTLY against its own reading (`l:<ticks>` on Linux,
 * `d:<lstart>` on macOS) and SIGKILLs the tunnel when they differ. The first
 * cut of this move wrote the boot-marked reading INTO `ownerStart`, and an
 * older daemon starting beside a live new one read every new row as a dead
 * owner's and killed the peer's public tunnels (review 2026-09-26, reproduced
 * against 0.103.0's reap). So a row carries BOTH: `ownerStart` in the legacy
 * spelling, derived from the one reader, for published readers; `ownerMark`,
 * the boot-marked reading, for this one. A row with no `ownerMark` (written by
 * an older daemon) is judged on its legacy `ownerStart`, field for field, so a
 * peer that recorded its tunnels before this change is not reaped either.
 */

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';
import { mutateRegistry, processAlive, processStartTime, readRegistry } from './procRegistry.mjs';

const FLOWVIANT_DIR = join(homedir(), '.flowviant');
const PREVIEW_REGISTRY = join(FLOWVIANT_DIR, 'previews.json');
const REGISTRY_LOCK = join(FLOWVIANT_DIR, 'previews.lock');

/** A row lives while its tunnel does, uncapped — see the header. */
export const keepLiveTunnels = (list) => list.filter((e) => processAlive(e?.pid));

function mutatePreviews(fn) {
  mutateRegistry(FLOWVIANT_DIR, PREVIEW_REGISTRY, REGISTRY_LOCK, fn, { prune: keepLiveTunnels });
}

/**
 * The legacy spelling of a `processStartTime` reading, for `ownerStart` — the
 * field published daemons compare exactly (see the header). Linux readings are
 * `<boot mark>:<ticks>` and published readers wrote `l:<ticks>`; macOS readings
 * are the raw `lstart` and published readers wrote `d:<lstart>`. Null where a
 * published reader could not read a start time either.
 */
export function legacyOwnerStart(reading, os = platform()) {
  if (typeof reading !== 'string' || !reading) return null;
  if (os === 'linux') return `l:${reading.slice(reading.lastIndexOf(':') + 1)}`;
  if (os === 'darwin') return `d:${reading}`;
  return null;
}

/**
 * Does `recorded` (an entry's `ownerMark`, else its `ownerStart`) name the
 * process that holds `pid` NOW? `true`/`false`, or `null` when this box cannot
 * read a start time — the caller's "cannot tell", never a mismatch.
 *
 * `ownerMark` is procRegistry's reading verbatim. A legacy `ownerStart` (the
 * only mark on a row an older daemon wrote) is compared field for field:
 * `l:<ticks>` against the ticks after the boot mark, `d:<lstart>` against the
 * macOS reading, which never had a prefix in procRegistry.
 */
export function sameOwnerStart(recorded, pid) {
  const now = processStartTime(pid);
  if (now == null) return null;
  if (recorded.startsWith('l:')) return now.slice(now.lastIndexOf(':') + 1) === recorded.slice(2);
  if (recorded.startsWith('d:')) return now === recorded.slice(2);
  return now === recorded;
}

export function recordPreviewPid(pid, sig) {
  if (!pid) return;
  // `owner` is the DAEMON that spawned it. The registry is shared by design —
  // two daemons serving two projects both write here — so without an owner a
  // starting daemon reaped its PEER's live tunnels: killed them, wiped their
  // entries, and the peer kept heartbeating a URL that 530s (its probe watches
  // the origin port, which was still alive).
  //
  // `ownerStart` pins the owner to ONE process (audit 2026-09-24). A daemon that
  // is SIGKILLed with a share open leaves cloudflared up; if its pid is reused
  // by the next start — any process, another user's included, since EPERM
  // counts as alive — a pid-only check read the entry as a live peer's and
  // skipped it forever, leaving a public hostname aimed at a dead gate's
  // ephemeral port for anything that binds it next.
  //
  // `ownerMark` is that pin in the one identity reader's spelling; `ownerStart`
  // keeps the spelling published daemons compare — see the header.
  const ownerMark = processStartTime(process.pid);
  const ownerStart = legacyOwnerStart(ownerMark);
  mutatePreviews((list) => [
    ...list,
    { pid, sig, owner: process.pid, ...(ownerStart ? { ownerStart } : {}), ...(ownerMark ? { ownerMark } : {}) },
  ]);
}

export function forgetPreviewPid(pid) {
  if (!pid) return;
  mutatePreviews((list) => list.filter((e) => e.pid !== pid));
}

/**
 * Only kill a pid we can VERIFY is still one of ours — its command line must
 * still contain the signature we stored. A reused pid belonging to something
 * unrelated won't match, so we never kill a stranger.
 *
 * MACOS READS IT THROUGH `ps`, because "Linux-only, elsewhere just clear the
 * registry" was the worst of both. A macOS daemon killed ungracefully leaves
 * cloudflared running — it is spawned detached — so the public hostname keeps
 * resolving to this machine while the gate dies with the daemon. The reaper
 * then verified nothing, killed nothing, and DELETED the entry, so no later run
 * could ever find that process. The tunnel served 502 until anything else on
 * the box bound the gate's old port, which `startAuthProxy` obtained with
 * `listen(0)` and is therefore squarely inside the kernel's ephemeral reuse
 * pool — at which point a live public hostname forwarded straight to an
 * unrelated local service with no gate, no password and no grant check. Exactly
 * what this file's header says the reap exists to prevent.
 *
 * Three states, not two: `true` (ours), `false` (verified NOT ours, or gone),
 * and `null` (we could not look — the caller keeps the record rather than
 * dropping it).
 */
function stillOurs(pid, sig) {
  if (typeof sig !== 'string' || sig.length === 0) return false;
  if (platform() === 'linux') {
    try {
      const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
      return cmd.includes(sig);
    } catch {
      return false; // process gone / unreadable
    }
  }
  if (platform() === 'darwin') {
    try {
      const cmd = execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
        encoding: 'utf8',
        timeout: 5_000,
      });
      return cmd.includes(sig);
    } catch {
      // `ps` exits non-zero when the pid is gone — which is a real answer.
      return false;
    }
  }
  // Windows: no way to check from here. UNKNOWN, never "not ours" — see the
  // caller, which keeps the record so a later run on a platform that can look
  // is still able to.
  return null;
}

/** Reap tunnel process groups left behind by a previously-crashed daemon.
 *  Call once at daemon startup, before any work begins.
 *
 *  ORPHANS ONLY: an entry whose owning daemon is STILL ALIVE belongs to a
 *  peer serving another project (or to the process we are replacing, whose
 *  own teardown handles it) — killing those and wiping their entries was a
 *  peer daemon's startup silently breaking every live share on the box. Only
 *  the entries this pass handled are removed; a peer's records survive. */
/** Is the daemon that recorded an entry still the process at that pid? With
 *  a recorded start time, only when the pid's start time still matches (a
 *  recycled pid is an orphaned entry); where this box cannot report a start
 *  time now, or the entry predates the field, signal 0 is all there is. */
function ownerStillRunning(owner, ownerStart, ownerMark) {
  if (!processAlive(owner)) return false;
  const recorded = typeof ownerMark === 'string' ? ownerMark : ownerStart;
  if (typeof recorded !== 'string') return true;
  return sameOwnerStart(recorded, owner) !== false;
}

export function reapOrphanPreviews(log) {
  const list = readRegistry(PREVIEW_REGISTRY);
  if (list.length === 0) return;
  let killed = 0;
  const handled = new Set();
  for (const { pid, sig, owner, ownerStart, ownerMark } of list) {
    if (Number.isInteger(owner) && owner !== process.pid && ownerStillRunning(owner, ownerStart, ownerMark)) continue;
    const ours = stillOurs(pid, sig);
    /**
     * THE RECORD OUTLIVES A REAP THAT COULD NOT LOOK. `handled.add` ran BEFORE
     * this check, so an entry was dropped whether or not anything was killed —
     * and on any platform `stillOurs` could not read, that deleted the only
     * trace of a tunnel still serving the public internet. Kept on `null`
     * (unknown); removed on `true` (we killed it) and on `false` (the process
     * is gone, or the pid now belongs to somebody else and the entry is stale
     * either way).
     */
    if (ours === null) continue;
    handled.add(pid);
    if (!ours) continue;
    try {
      process.kill(-pid, 'SIGKILL'); // whole group
      killed++;
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
        killed++;
      } catch {
        /* already gone */
      }
    }
  }
  if (handled.size) mutatePreviews((cur) => cur.filter((e) => !handled.has(e.pid)));
  if (killed) log?.(`reaped ${killed} orphaned preview tunnel${killed === 1 ? '' : 's'} from a previous run.`);
}
