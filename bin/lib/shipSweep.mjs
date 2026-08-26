import { baseBranchName } from './git.mjs';

/**
 * RETIRE A BRANCH FLOWVIANT MADE AND FLOWVIANT MERGED.
 *
 * NOT PRUNING SOMEBODY'S REPO — removing our own bookkeeping. `session/<id>`
 * is an artifact this daemon created, named and merged; the driver's work is
 * the commits, and after a `--no-ff` ship those are on base. The standing law
 * that the Repository block reports and never prunes is untouched: it was
 * written for refs of UNKNOWN provenance — a branch the agent cut mid-turn, a
 * worktree a crash left behind — and this is the one category that is
 * provably ours.
 *
 * WHY IT MATTERS MORE THAN TIDINESS: a reporting surface only works if what
 * it reports is rare. Every merged session branch used to accumulate forever,
 * so "is claude polluting the branches" could not be answered from a list
 * dominated by our own litter. Stop littering and what remains is worth
 * reading.
 *
 * `git branch -d` IS THE GUARD, deliberately, rather than a stack of checks
 * of our own. It refuses an UNMERGED branch and it refuses one CHECKED OUT in
 * any worktree — which are two of the three conditions, enforced by the tool
 * that owns the truth instead of by our reading of it. Never `-D`: if git
 * objects, git is right and we stop. The third condition is ours and is the
 * name: only `session/<id>` exactly, so a branch the agent cut is never in
 * scope no matter what it was merged into.
 *
 * ORDERING IS LOAD-BEARING. This must not run while a ship report is still
 * undelivered. Ship's idempotency path recovers from a lost report by asking
 * `branchExists && ancestorOfBase(branch)`; with the branch gone a re-offered
 * job answers "nothing to ship — this session has no branch on this machine"
 * for work that shipped, and the server's reconciliation backstop silently
 * never books the commits no card claimed.
 *
 * Local only. Ship pushes base and has never pushed `session/*`, so there is
 * nothing to clean on a remote.
 */
export function sweepMergedBranch(sessionId, { git, repoRoot, baseRef, note, isReportPending }) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(String(sessionId ?? ''))) return false;
  // The report has not landed. See ORDERING above.
  if (isReportPending?.(sessionId)) return false;
  const name = `session/${sessionId}`;
  try {
    git(['rev-parse', '--verify', '--quiet', `refs/heads/${name}`], repoRoot);
  } catch {
    return false; // already gone, or never existed
  }
  try {
    git(['branch', '-d', name], repoRoot);
  } catch {
    // Unmerged, or checked out somewhere. Both are correct reasons to keep it,
    // and both are git's answer rather than ours.
    return false;
  }
  // NARRATED, like every other sweep: a deletion with no trace in the log
  // cannot be diagnosed from either end.
  note?.(`retired ${name} — already merged into ${baseBranchName(baseRef)}`);
  return true;
}
