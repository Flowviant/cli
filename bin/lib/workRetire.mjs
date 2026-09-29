/**
 * THE MANAGER'S DISK HYGIENE — which session directories this daemon holds,
 * retiring the worktrees of closed tabs (and stopping a stopped agent's CLI
 * there), and fast-forwarding each person's clean manual place.
 *
 * Split out of work.mjs (2026-09-26, SOLID F037). All three read the
 * `sessions/` directory the poll hands back and act only on what the roster
 * says is no longer live or is safely behind; none of them runs a turn or
 * reports a measurement.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { git, isSafePathSegment } from './git.mjs';

export function createWorkRetire({
  repoRoot,
  baseDir,
  baseRef,
  placeOf,
  placeLocks,
  shipping,
  workTokens,
  agentChildren,
  sweepMergedSessionBranch,
}) {
  /**
   * Retire the worktrees of sessions the server says are CLOSED.
   *
   * `activeWorkSessions` on the roster is the list of this fleet's LIVE
   * sessions; a directory whose id is absent belongs to a tab its owner
   * closed, and the directory — never the branch: committed work survives on
   * `session/<id>`, and ship re-attaches to it — is returned to disk. NEVER
   * by count: the old cap-12 retirement destroyed live sessions on shared
   * machines. When the roster omits the field entirely (older server),
   * absence of signal is not a close — retire nothing.
   */
  /** Every session this daemon currently has a worktree for — what renews our
   *  lease on the poll. Read off the directory rather than a map, so it is the
   *  same fact retirement acts on. */
  const heldSessionIds = () => {
    const dir = join(baseDir, 'sessions');
    try {
      return readdirSync(dir).filter(isSafePathSegment).slice(0, 50);
    } catch {
      return [];
    }
  };

  const retireWorkSessions = (activeIds, heldElsewhere) => {
    if (!Array.isArray(activeIds)) return;
    // Sessions ANOTHER daemon on this credential is serving. They are absent
    // from activeWorkSessions for us and present for them, and removing their
    // worktree would pull the directory out from under a running turn. Absence
    // means "the tab closed"; this is the one other thing it can mean.
    const peers = new Set(Array.isArray(heldElsewhere) ? heldElsewhere : []);
    // A peer-held session's CACHED work token is a claim-bypass: the mint is
    // the one place the session lease 409s a non-holder, and a token younger
    // than ~23h skips the mint entirely — so a daemon that lost a lease would
    // run the next turn anyway, editing the worktree while every MCP call
    // 401s (the peer's mint rotated the secret). Dropping the cache forces
    // the next turn through the mint, where the 409 stands it down.
    for (const id of peers) workTokens.delete(id);
    const dir = join(baseDir, 'sessions');
    if (!existsSync(dir)) return;
    let ids;
    try {
      ids = readdirSync(dir);
    } catch {
      return;
    }
    const live = new Set(activeIds);
    let removed = 0;
    for (const id of ids) {
      if (live.has(id)) continue;
      if (peers.has(id)) continue; // another daemon's tab — not ours to retire
      /**
       * A HARD STOP REACHES THE CLI HERE, and this is the whole of it.
       *
       * `stopAgent` marked the agent abandoned in D1 and nothing on the wire
       * told the machine, so the CLI went on working, editing the worktree and
       * spending the operator's quota — while the confirm dialog said the agent
       * was stopped. It also never got cleaned up, because the check below
       * skips any place whose lock is held and a running turn holds it: a
       * stopped agent mid-turn kept its directory forever.
       *
       * No new wire field and no version floor: an abandoned agent simply drops
       * out of `activeWorkSessions` (that list is built from LIVE statuses), so
       * the server ALREADY says everything needed. Absence means "nothing here
       * is live any more", and the honest response to that is to stop what we
       * are running in it and then take the directory.
       *
       * SIGTERM the CHILD, never its group — the rule teardown keeps, so an
       * unattended sweep cannot take the driver's dev server with it. The lock
       * is released when the child exits, so the removal happens on the next
       * pass rather than this one.
       */
      const running = agentChildren.get(id);
      if (running) {
        try {
          running.kill('SIGTERM');
        } catch {
          /* already gone */
        }
        agentChildren.delete(id);
      }
      // Asked of the PLACE, not the session: the lock is keyed by directory,
      // and a session sharing one with a busy peer is not ours to retire
      // either — its worktree is the peer's working directory.
      if (placeLocks.has(placeOf(id)) || shipping.has(id)) continue; // still draining here
      const wt = join(dir, id);
      try {
        // Uncommitted work is the human's — a resource sweep does not outrank
        // it, closed tab or not. (The non-force remove would refuse anyway;
        // the explicit check keeps the intent legible.)
        if (git(['status', '--porcelain'], wt) !== '') continue;
        git(['worktree', 'remove', wt], repoRoot); // non-force
        workTokens.delete(id);
        removed++;
        // NOW the branch can be judged. While this worktree existed the branch
        // was checked out in it, so `git branch -d` refused on every earlier
        // attempt — a tab that shipped and then closed would otherwise leave
        // its merged branch behind forever, which is the common case.
        // Unshipped work still refuses here: `-d` is what decides.
        sweepMergedSessionBranch(id);
      } catch {
        /* not cleanly removable — leave it */
      }
    }
    if (removed) {
      try {
        git(['worktree', 'prune'], repoRoot);
      } catch {
        /* best effort */
      }
    }
  };

  /**
   * KEEP EACH PERSON'S MANUAL WORKTREE FRESH.
   *
   * Every teammate's Workbench tabs share one directory of their own on a
   * branch of their own — which is not a preference, it is what git allows:
   * two worktrees cannot have the same branch checked out, so "everyone works
   * on main" is only true for the machine's OPERATOR, whose place is the
   * checkout itself. Everyone else needs a branch, and a branch left alone
   * drifts behind main until the first thing they do in a new tab is a merge
   * they did not ask for.
   *
   * FAST-FORWARD ONLY, and that is the whole safety argument. If their branch
   * has no commits of its own it simply catches up, which is the ordinary case
   * and the one worth automating. The moment it HAS diverged, this stops and
   * leaves it exactly as it is: their commits are theirs, a rebase would
   * rewrite them under somebody who is not looking, and a merge would put a
   * commit in their history that they did not make. Their own Claude can fold
   * base in whenever they ask it to.
   *
   * Guarded three ways: a DIRTY tree is left alone (uncommitted work outranks
   * freshness), a place with a live lock is skipped (a turn is standing in it),
   * and the whole thing is silent — nothing here reports, warns or blocks.
   */
  const freshenManualPlaces = () => {
    let dir;
    try {
      dir = readdirSync(join(baseDir, 'sessions'));
    } catch {
      return; // no worktrees yet
    }
    for (const place of dir) {
      // Only a PERSON's manual place. An agent's own worktree (`a-<id>`) is
      // deliberately not touched: its branch is the reviewable unit, and
      // moving it under a review would change what somebody is deciding about.
      if (!place.startsWith('u-') || !isSafePathSegment(place)) continue;
      if (placeLocks.has(place)) continue;
      const wt = join(baseDir, 'sessions', place);
      try {
        if (git(['status', '--porcelain'], wt).trim() !== '') continue;
        git(['merge', '--ff-only', baseRef()], wt);
      } catch {
        /* diverged, or something else is going on in there. Leave it. */
      }
    }
  };

  return { heldSessionIds, retireWorkSessions, freshenManualPlaces };
}
