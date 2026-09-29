/**
 * THE MACHINE'S LIVE CLI CHILDREN — the registry every lane adds its spawn
 * to, the teardown that SIGTERMs them, the count the concurrency ceiling is
 * on, and the admission built over that count.
 *
 * Split out of work.mjs (2026-09-26, SOLID F037). Six lanes write
 * `workChildren` (tab turns, agent turns, plans, the check, the pre-review)
 * and three things read it (teardown, `liveTurnCount`, the machine snapshot's
 * per-task RSS), so the map and everything that reads it as "what is running
 * on this box" belong together — and apart from any one lane.
 */
import { createAdmission } from './admission.mjs';

export function createWorkChildren({ extraLiveTurns }) {
  /**
   * Live session-turn CLI children. The daemon's teardown SIGTERMs them: an
   * orphaned CLI keeps editing the session worktree and burning quota after
   * the daemon is gone. Each child's pid-lock is deliberately LEFT IN PLACE —
   * a CLI can trap SIGTERM to finish an in-flight request and outlive this
   * loop by seconds, and removing the lock in the same tick handed the
   * restarted daemon a green light to spawn a second CLI into the same held
   * context. turnLockedByLivePid already covers both outcomes: it waits while
   * the pid lives and clears the lock once it is dead.
   *
   * THE VALUE IS THE ID THE CHILD SERVES, and it used to be the pid-lock path —
   * which nothing in this file has ever read. A write-only value is not free:
   * the machine snapshot's per-task RSS (`/fleet/machine`) is the one readout
   * that answers "which task is holding nine gigabytes", and it was being built
   * from the dispatch-era `workers` map, which nothing has `.set()` since that
   * lane was deleted — so the column its own server handler calls the
   * load-bearing half of the report had never been populated once. This map is
   * the only place that knows both the pid and whose work it is, so it carries
   * both. `null` where there is no id to name (a Deploy press is not a task).
   */
  const workChildren = new Map(); // child process -> sessionId | agentId | null
  /**
   * Children whose whole PROCESS GROUP must go, not just the child.
   *
   * The standing rule is the opposite — teardown SIGTERMs the CLI child and
   * never its group, precisely so an unattended auto-update does not kill the
   * driver's dev server, which a turn started INTO the CLI's group. That rule
   * is about the CLI's group and stays.
   *
   * A project CHECK is a different group entirely: the daemon spawns it itself,
   * `detached` with `shell: true`, so its group holds the check command and
   * nothing else — no dev server of anybody's. And `shell: true` is exactly
   * what makes signalling only the child useless: a compound command like
   * `npm run lint && npm test` leaves `/bin/sh` as the child, so SIGTERM killed
   * the shell and the test runner underneath it carried on holding the
   * worktree — and that place's WRITER lock — through every stop, takeover and
   * auto-update. The check's own ten-minute timer already kills `-child.pid`
   * for this reason; teardown simply did not.
   */
  const groupKillChildren = new Set();
  const shutdownWork = () => {
    for (const [ch] of workChildren) {
      try {
        if (groupKillChildren.has(ch) && ch.pid) process.kill(-ch.pid, 'SIGTERM');
        else ch.kill('SIGTERM');
      } catch {
        // A group that has already gone, or a pid that is no longer a leader.
        try {
          ch.kill('SIGTERM');
        } catch {
          /* best-effort */
        }
      }
    }
    workChildren.clear();
    groupKillChildren.clear();
  };

  /**
   * HOW MANY CLIs THIS MACHINE IS RUNNING RIGHT NOW — the number
   * `MAX_CONCURRENT` is a ceiling on, and the thing that had no counter.
   *
   * Every lane, because the bound is on the BOX and not on a lane: session
   * turns, an agent's turn, a Deploy press's planner, a project check — all of
   * them land in `workChildren` — plus whatever the caller reports on top of it
   * (the wiki cartographer, wikiRunner.mjs).
   *
   * THE PROJECT CHECK COUNTS, deliberately. It is not a model turn, but it is a
   * full test or build run in a worktree, which is exactly the kind of process
   * this ceiling exists to stop stacking. Nothing gates a check, so counting it
   * cannot deadlock: it only ever delays the NEXT spawn.
   */
  const liveTurnCount = () => {
    const extra = Number(extraLiveTurns() ?? 0);
    return workChildren.size + (Number.isFinite(extra) && extra > 0 ? extra : 0);
  };

  /** The live turn children with the id each one serves — what the machine
   *  snapshot charges its per-task RSS to. Children with no id (the planner)
   *  are still counted above; they just have nothing to be charged TO. */
  const liveTurns = () => {
    const out = [];
    for (const [ch, id] of workChildren) if (ch?.pid) out.push({ id: id ?? null, pid: ch.pid });
    return out;
  };

  /**
   * WHETHER TO START ONE MORE. See admission.mjs for the whole argument: a
   * runaway bound on a machine, read at the spawn, surfaced only as the
   * machine's own measured sentence at the thing that is waiting, and never a
   * reason to settle a job — a deferred job is re-offered next poll.
   */
  const admit = createAdmission({ liveTurnCount });

  return { workChildren, groupKillChildren, shutdownWork, liveTurnCount, liveTurns, admit };
}
