import { baseBranchName } from './git.mjs';

/**
 * CARRY A SHIPPED TIP OUT ONTO BASE AND PUSH IT.
 *
 * Through a THROWAWAY DETACHED WORKTREE, which is the whole shape of this: the
 * merge commit has to be made somewhere, and making it in anybody's checkout
 * moves a directory somebody is working in. A detached worktree at base is
 * nobody's, so the merge lands, the push goes, and the directory dies in the
 * `finally` — on success, on conflict, on throw. It must die, or the next ship
 * of this session trips over its corpse.
 *
 * `--no-ff`, NEVER squash: every delivered card carries commit shas as its
 * receipts, and squashing would point all of them at commits that no longer
 * exist on base.
 *
 * Two behaviours beyond that, and both arrived with per-person worktrees.
 */
export function mergeOutward({
  tip,
  count,
  branch,
  label,
  git,
  gitMerge,
  repoRoot,
  tmpDir,
  baseRef,
  workingTree,
  warn,
}) {
  const dropTmp = () => {
    try {
      git(['worktree', 'remove', '--force', tmpDir], repoRoot);
    } catch {
      /* not there — fine */
    }
  };
  const attempt = () => {
    dropTmp();
    git(['worktree', 'add', '--detach', tmpDir, baseRef()], repoRoot);
    gitMerge(
      ['merge', '--no-ff', tip, '-m', `ship(${label}): ${count} commit${count === 1 ? '' : 's'}`],
      tmpDir
    );
    git(['push', 'origin', `HEAD:${baseBranchName(baseRef())}`], tmpDir);
  };
  try {
    try {
      attempt();
    } catch (e) {
      /**
       * TWO PEOPLE SHIPPED AT ONCE — retry exactly once.
       *
       * Ship takes a write lock on a PLACE, and since every person works in a
       * directory of their own, two teammates shipping hold two DIFFERENT
       * locks and nothing serializes them. Both fetch, both merge onto the same
       * base in their own throwaway, and whoever pushes second is rejected
       * non-fast-forward. The window is fetch-to-push, and it did not exist
       * while everyone shared one directory — it arrived with the split.
       *
       * WITHOUT THIS the loser is told their ship FAILED, in raw git, over a
       * race that resolves itself by looking again. That breaks the promise
       * this path exists to keep: nobody may be left believing their work is
       * or is not on base when the opposite is true.
       *
       * ONCE, not a loop. A second rejection is no longer a race — it is a repo
       * something else is writing to continuously, and the honest answer there
       * is the error. The retry re-fetches and rebuilds the throwaway from the
       * NEW base, so it merges against what the winner just landed rather than
       * re-pushing a stale merge. The TIP is untouched, so the receipts still
       * name exactly the same commits.
       */
      if (!isRaceRejection(e)) throw e;
      warn?.('ship: base moved under us — refetching and merging again');
      try {
        git(['fetch', 'origin', '--quiet'], repoRoot);
      } catch {
        /* offline — the retry fails honestly on the same push */
      }
      attempt();
    }
    /**
     * AND BRING THE SHIP PLACE'S OWN BRANCH UP, when that branch IS base.
     *
     * Which is every tab belonging to the machine's OPERATOR: their place is
     * the project folder, and it sits on main. Without this, main is left one
     * commit behind `origin/main` the instant it ships, because the `--no-ff`
     * merge exists only on the remote — and `worktreeDiff` computes `behind` as
     * `HEAD..origin/main` without filtering merges, so the rail immediately
     * reported "1 new on main since you branched" and listed the operator's OWN
     * ship commit back to them. That inverts the entire point of that block,
     * which is to show the one thing a session cannot see from inside itself.
     *
     * Safe by construction and never a surprise: ship already required a clean
     * tree, the fold already moved this same directory under the same exclusive
     * lock, and `--ff-only` can neither conflict nor write a commit.
     *
     * NOBODY ELSE'S CHECKOUT MOVES. A teammate's branch is not base, so this
     * does nothing for them — and their branch being genuinely behind base is a
     * fact the rail should keep telling them.
     */
    if (workingTree && branch && branch === baseBranchName(baseRef())) {
      try {
        git(['fetch', 'origin', '--quiet'], repoRoot);
        git(['merge', '--ff-only', baseRef()], workingTree);
      } catch {
        /* a readout, not the ship — the merge already landed, and the next
           fold picks this up either way */
      }
    }
  } finally {
    try {
      dropTmp();
      git(['worktree', 'prune'], repoRoot);
    } catch {
      /* best effort */
    }
  }
}

/**
 * Is this push failure a LOST RACE rather than a broken repo?
 *
 * Matched on git's own words. Deliberately narrow: anything unrecognised is
 * rethrown, because retrying an unknown failure is how a real problem gets
 * reported twice and understood never.
 */
export function isRaceRejection(e) {
  const d = `${e?.stdout ?? ''}\n${e?.stderr ?? ''}\n${e?.message ?? ''}`;
  return /non-fast-forward|\[rejected\]|fetch first|stale info/i.test(d);
}
