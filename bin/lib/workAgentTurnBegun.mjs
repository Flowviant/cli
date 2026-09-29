/**
 * THE BEGUN-GUARD: may this box run a turn the server says has BEGUN?
 *
 * Split out of workAgentTurns.mjs (SOLID F036, 2026-09-26). It is one rule
 * with its own measurements — the agent's directory, its branch ref read in
 * three states, and the published branch fetched as the fallback — and none of
 * it is about running a CLI or reporting one. It answers before a worktree can
 * be cut, which is the whole point of it (`placeWtFor` would otherwise cut a
 * rival branch of the same name), so the caller gates on `job.begun` and asks
 * here before `placeWtFor`.
 *
 * It RETURNS the sentence and does not post it: the settle is the caller's,
 * through the one turn-done wire (workAgentTurnReports.mjs). Null means go on.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { git } from './git.mjs';

/**
 * WORK THAT HAS BEGUN LIVES ON EXACTLY ONE BOX, AND THIS MAY NOT BE IT.
 *
 * A project has ONE machine credential and every device is handed the same
 * raw token, so two boxes can both be polling for the same agents. Nothing
 * pushes an agent's branch before approve, so a turn that has already run
 * somewhere has its worktree, its branch and its CONVERSATION on that box's
 * disk and nowhere else. `placeWtFor` cannot tell the difference: it finds
 * no directory, cuts a fresh `session/a-<id>` off base, and the CLI starts
 * with no memory of the card — a confident, context-free redo of work
 * somebody is in the middle of, on the operator's shared account, landing
 * on a rival branch of the same name.
 *
 * So: if the server says this agent has BEGUN and this box holds neither
 * its directory nor its branch, refuse before anything is cut. `nothing` is
 * the honest outcome — this machine did not run the turn — and the sentence
 * says what was measured (two absences here, and the box name only when the
 * server recorded one; inferring where the work is would be invention).
 *
 * THE BRANCH ALONE IS ENOUGH TO CONTINUE. `placeWtFor`'s attach fallback
 * re-attaches a worktree to a surviving branch, so a directory somebody
 * cleaned up on THIS box is same-box recovery of real committed work and
 * behaves exactly as it did before this guard existed.
 *
 * The remedy is the stop path and nothing else. "Reconnect the other
 * machine" is not reachable from here once holdership has moved, and a
 * remedy somebody cannot carry out is worse than none.
 */
export function begunTurnRefusal(job, place, { baseDir, repoRoot, fetchPublishedBranch }) {
  const wtDir = join(baseDir, 'sessions', place);
  let hasBranch = false;
  /**
   * THREE STATES, AND THE MIDDLE ONE IS WHY THIS IS NOT A BARE CATCH.
   *
   * `rev-parse --verify --quiet` exits 1 and prints nothing for a ref that
   * is not there — that exit code IS the measurement, and it is the one
   * this guard acts on. Any OTHER failure (128 for "not a repository",
   * ENOENT for no git at all, a momentary index lock) measured nothing;
   * collapsing it onto "the branch is absent" would make the daemon assert
   * "this machine does not hold this agent's branch" off a repo it could
   * not read — the guard inventing the very fact it exists to relay.
   *
   * So an unmeasured branch stands the guard DOWN. That re-enters the path
   * this guard is a belt for, which is the fail-open direction it wants;
   * `placeWtFor` is about to fail on the same unreadable repo and say so
   * in its own words, which is the honest sentence.
   */
  let branchMeasured = true;
  try {
    hasBranch = Boolean(
      git(['rev-parse', '--verify', '--quiet', `refs/heads/session/${place}`], repoRoot)
    );
  } catch (e) {
    if (e?.status === 1) hasBranch = false;
    else branchMeasured = false;
  }
  if (branchMeasured && !existsSync(wtDir) && !hasBranch) {
    /**
     * …UNLESS THE WORK IS ON THE REMOTE (0.86.0).
     *
     * The guard's premise was "nothing pushes an agent's branch before
     * approve", and a project that publishes has changed exactly that
     * third of it: the COMMITS are on `origin` under `flowviant/`, so a
     * box that holds neither the directory nor the branch can fetch them
     * and continue the work instead of redoing it. The other two thirds
     * are untouched — the conversation still does not move, which is why
     * the kickoff re-prompts from the card either way.
     *
     * The refusal below is still the fallback, and it is the fallback for
     * BOTH shapes of failure: a project that does not publish (no ref,
     * sentence unchanged) and a fetch that could not land (sentence
     * extended with git's own reason, because "this machine does not hold
     * it" alone would hide that we tried and how it went).
     */
    const fetched = fetchPublishedBranch(place, job.publishedRef);
    if (!fetched?.ok) {
      const on = typeof job.begunOn === 'string' && job.begunOn.trim()
        ? job.begunOn.trim().slice(0, 64)
        : null;
      return (
        `This machine does not hold this agent's worktree or branch${on ? ` — its work is on ${on}` : ''}. ` +
        'Stop the agent to re-plan it here.' +
        (fetched ? ` Its published branch could not be fetched (${fetched.why}).` : '')
      );
    }
    // The branch is here and measured. `placeWtFor`'s attach fallback
    // opens a worktree on it below — the same path a directory somebody
    // cleaned up already takes, on commits this box now genuinely holds.
  }
  return null;
}
