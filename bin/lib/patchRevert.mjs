/**
 * TAKING A LANDED PATCH BACK — the one live half of what used to be
 * `patch.mjs`.
 *
 * `patch.mjs` held two lifecycles: patch PLACEMENT (cherry-picking a
 * teammate's agent commit into the owner's checkout after a dirty-path
 * collision check, plus a commit-history reader for the retired
 * `report_commits` path) and patch REVERT. Nothing in the daemon has called
 * placement or the history reader since the dispatch lane was deleted — the
 * roster still carries `patchRevertJobs` for a patch that landed before then,
 * and fleetJobs.mjs is the only caller of what is left. So the revert moved here
 * under its own name and the uncalled half was deleted rather than kept as a
 * second, stale commit-record parser nobody tests (SOLID audit 2026-09-26,
 * F167). Git history has the placement code if a new argument ever wants it.
 *
 * One revert at a time per daemon: `withPatchLock` serialises every write this
 * lane makes to the owner's tree, so two jobs cannot race in one checkout.
 */

import { git, isValidSha } from './git.mjs';

/** Serialises reverts within this process. */
let patchChain = Promise.resolve();

export function withPatchLock(fn) {
  const run = patchChain.then(fn, fn);
  // Keep the chain alive regardless of outcome, but don't swallow the result.
  patchChain = run.then(
    () => {},
    () => {}
  );
  return run;
}

/**
 * Undo a landed patch. `git revert` rather than `reset` on purpose: the owner
 * has almost certainly committed or edited on top by now, and rewriting their
 * history to take something back would be far worse than the patch was.
 */
export function revertPatch({ repoRoot, shas }) {
  // These arrive over the roster and go straight into git argv. Anything that
  // isn't a bare object id — a revision range, a leading-dash option — is
  // refused here rather than trusted because the server said so.
  const clean = (shas ?? []).filter(isValidSha);
  if (clean.length === 0 || clean.length !== (shas ?? []).length) {
    return { ok: false, error: 'refused: patch revert carried a non-sha value' };
  }
  const ordered = [...clean].reverse(); // newest first
  try {
    for (const sha of ordered) git(['revert', '--no-edit', sha], repoRoot);
    return { ok: true };
  } catch (e) {
    try {
      git(['revert', '--abort'], repoRoot);
    } catch {
      /* nothing in progress */
    }
    return { ok: false, error: e?.message ?? String(e) };
  }
}
