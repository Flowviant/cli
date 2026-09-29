/**
 * WHICH PROCESS GROUPS EACH TAB HAS STARTED — kept, persisted per repo and
 * boot, and pruned against the kernel on every read.
 *
 * Split out of work.mjs (2026-09-26, SOLID F037). It changes for one reason —
 * how a watcher that outlives its turn stays attributed to its tab — and has
 * three writers (the session lane and the agent lane note a group at spawn,
 * the sweep prunes closed ids) and two readers (the worktree report's
 * `processes`, and the kill lane's check in workProcesses.mjs, which is handed
 * `sessionGroups` itself). groupRegistry.test.mjs drives it through the
 * manager against a real registry file.
 */
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { measureProcesses, liveGroups, processesSupported } from './processes.mjs';
import { bootMark, mutateRegistry, readRegistry, sameBoot } from './procRegistry.mjs';
import { scrub as envScrub } from './uplinkScrub.mjs';

export function createWorkSessionGroups({ repoRoot }) {
  /**
   * WHICH PROCESS GROUPS EACH TAB HAS STARTED.
   *
   * A turn's CLI is spawned `detached`, so its pid is a process-group id and
   * everything the agent starts inherits it — through `nohup` and `setsid`,
   * which is precisely where attribution by ppid falls apart. Kept per SESSION
   * and not per turn: the point of the feature is the watcher that outlives the
   * turn that started it.
   *
   * PRUNED ON EVERY READ against the kernel, which is not housekeeping. A pgid
   * is a pid and pids are recycled, so an un-pruned set would eventually
   * attribute a stranger's process to a tab that has been closed for a week.
   */
  const sessionGroups = new Map(); // sessionId -> Set<pgid>

  /**
   * …AND IT SURVIVES A RESTART, which it did not until 2026-08-27.
   *
   * This map used to live only in this closure. The processes it tracks
   * OUTLIVE the daemon on purpose — `shutdownWork` SIGTERMs the CLI child and
   * never the group, precisely so an unattended auto-update does not kill the
   * driver's dev server — so every daemon restart left a live watcher running
   * with nothing left that knew whose it was. The tab reported `[]`, the web
   * read that as "looked, found none", and the Running section went dark until
   * some later turn happened to open a new group.
   *
   * That is not a small bug: AUTO_UPDATE is on by default, so it fired on every
   * release, on every machine. And it broke the three-state rule this file
   * states in its own header — the honest answer after a restart was "we have
   * forgotten", and `[]` is not that. Persisting is what makes `[]` true again,
   * which is why the fix is a disk write and not a fourth state.
   *
   * `procRegistry` is the right home and was sitting unused: it was built for
   * exactly this ("the daemon spawns things that outlive it… the successor has
   * to find them"), was orphaned when the dev-run system was deleted, and
   * already does the atomic write, the stale-lock recovery, the entry cap and
   * the dead-pid TTL. Its prune is deliberately LOOSE here — it keeps an entry
   * whose leader is gone, because the leader is the CLI and it exits at the end
   * of every turn while the watcher it started keeps running. `liveGroups` is
   * the real prune, on every read, against the kernel.
   */
  /*
   * THREE RULES THE FIRST CUT BROKE (2026-09-24), each a way the file named a
   * group that was not this tab's, or forgot one that was:
   *
   *  - ONE FILE PER REPO, not per OS user. Each daemon rewrote the shared file
   *    with only its own groups, so two daemons on one box (project A in one
   *    checkout, B in another) erased each other's entries and A's watcher
   *    was forgotten at A's next restart. The instance lock already makes a
   *    repo one daemon, so the repo is the right owner. The pre-2026-09-24
   *    shared file is not read: its entries carry no boot, so no rule below
   *    could believe them anyway.
   *  - AN ENTRY IS BELIEVED ONLY IN THE BOOT THAT WROTE IT. After a reboot the
   *    remembered pgid belongs to whatever the kernel handed it to next — the
   *    operator's shell, another project's children — and the Running list
   *    relayed that group's command lines as this tab's and `killTargetOk`
   *    accepted a Stop on them.
   *  - ONLY LIVE GROUPS ARE WRITTEN, each with the time it was FIRST seen.
   *    Every persist used to restamp every entry with `Date.now()`, so the
   *    registry's 7-day TTL never applied to anything, and dead entries (one per
   *    agent turn, recorded under a key nothing read) filled the 32-entry cap
   *    and pushed a tab's live watcher off the end.
   */
  const GROUPS_DIR = join(homedir(), '.flowviant');
  const GROUPS_KEY = createHash('sha256').update(String(repoRoot)).digest('hex').slice(0, 16);
  const GROUPS_FILE = join(GROUPS_DIR, `session-groups-${GROUPS_KEY}.json`);
  const GROUPS_LOCK = join(GROUPS_DIR, `session-groups-${GROUPS_KEY}.lock`);
  const groupFirstSeen = new Map(); // pgid -> ms first recorded
  const BOOT = bootMark();

  const persistGroups = () => {
    const flat = [];
    for (const [sid, set] of sessionGroups) {
      for (const pgid of liveGroups(set)) {
        if (!groupFirstSeen.has(pgid)) groupFirstSeen.set(pgid, Date.now());
        flat.push({ sessionId: sid, pid: pgid, startedAt: groupFirstSeen.get(pgid), boot: BOOT });
      }
    }
    const kept = new Set(flat.map((e) => e.pid));
    for (const g of groupFirstSeen.keys()) if (!kept.has(g)) groupFirstSeen.delete(g);
    try {
      mutateRegistry(GROUPS_DIR, GROUPS_FILE, GROUPS_LOCK, () => flat);
    } catch {
      /* best-effort: losing the file costs a restart's visibility, never a turn */
    }
  };

  try {
    for (const e of readRegistry(GROUPS_FILE)) {
      if (!e?.sessionId || !Number.isInteger(e?.pid)) continue;
      if (!sameBoot(e.boot, BOOT)) continue; // another boot's pgid names a stranger now
      const set = sessionGroups.get(e.sessionId) ?? new Set();
      set.add(e.pid);
      sessionGroups.set(e.sessionId, set);
      if (Number(e.startedAt) > 0) groupFirstSeen.set(e.pid, Number(e.startedAt));
    }
  } catch {
    /* no registry yet — the ordinary first run */
  }

  /** Forget the groups of every id the roster no longer names — a closed tab,
   *  a finished agent. Nothing reports or stops a group for an id that is not
   *  live, so holding it only grows the map for the life of the process. */
  const pruneSessionGroups = (activeIds) => {
    const live = new Set(activeIds);
    let changed = false;
    for (const id of [...sessionGroups.keys()]) {
      if (live.has(id)) continue;
      sessionGroups.delete(id);
      changed = true;
    }
    if (changed) persistGroups();
  };

  const noteSessionGroup = (sessionId, pgid) => {
    if (!sessionId || !pgid) return;
    const set = sessionGroups.get(sessionId) ?? new Set();
    if (set.has(pgid)) return;
    set.add(pgid);
    sessionGroups.set(sessionId, set);
    persistGroups();
  };

  /** This tab's live processes, or null where the machine cannot look. */
  const sessionProcesses = (sessionId) => {
    if (!processesSupported()) return null;
    const known = sessionGroups.get(sessionId);
    // The SHAPE `measureProcesses` returns — a bare `[]` here has no `.rows`,
    // so the report's `processes` key came out undefined and was dropped from
    // the JSON: "looked and found none" arrived as "never looked".
    if (!known || known.size === 0) return { rows: [], total: 0 };
    const alive = liveGroups(known);
    // Only touch the disk when the set actually MOVED. This runs on every
    // sweep, for every live tab, forever; an unconditional write would be a
    // file rewrite a minute for the life of the daemon to restate what is
    // already there — the same reasoning the auto-name relay uses for its
    // unchanged-title check.
    const changed = alive.size !== known.size;
    if (alive.size === 0) sessionGroups.delete(sessionId);
    else sessionGroups.set(sessionId, alive);
    if (changed) persistGroups();
    return measureProcesses(alive, { scrub: envScrub });
  };

  return { sessionGroups, noteSessionGroup, pruneSessionGroups, sessionProcesses };
}
