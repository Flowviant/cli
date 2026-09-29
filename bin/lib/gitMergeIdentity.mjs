/**
 * THE IDENTITY A DAEMON MERGE COMMIT IS WRITTEN UNDER (2026-09-26, SOLID F165).
 *
 * A merge COMMIT needs a git identity and the machine may have none. Prefer the
 * operator's own config; fall back to the daemon's, so a bare machine does not
 * fail the fold with "Please tell me who you are".
 *
 * Split out because the session ship lane (workShip.mjs) and the agent merge
 * lane (workAgentMerges.mjs) each carried a copy of the probe and the four
 * fallback variables — an identity-policy change needed two edits. Both lanes
 * now take their `gitMerge` from `gitMergeIn(repoRoot)`; their merge decisions
 * are their own.
 */

import { execFileSync } from 'node:child_process';
import { git } from './git.mjs';

export const DAEMON_GIT_IDENTITY = Object.freeze({
  GIT_AUTHOR_NAME: 'Flowviant',
  GIT_AUTHOR_EMAIL: 'daemon@flowviant.com',
  GIT_COMMITTER_NAME: 'Flowviant',
  GIT_COMMITTER_EMAIL: 'daemon@flowviant.com',
});

/** The env a merge in `repoRoot` needs: null when the operator's config names a
 *  user.email (git uses theirs), the daemon's identity when it names none. */
export function mergeIdentityEnv(repoRoot) {
  try {
    git(['config', 'user.email'], repoRoot);
    return null;
  } catch {
    return DAEMON_GIT_IDENTITY;
  }
}

/**
 * A `gitMerge(args, cwd)` for a checkout rooted at `repoRoot`: runs `git args`
 * in `cwd` (a throwaway worktree, usually) under the identity the probe finds.
 * The probe runs per call, so an identity configured mid-job is heard.
 */
export function gitMergeIn(repoRoot) {
  return (args, cwd) => {
    const idEnv = mergeIdentityEnv(repoRoot);
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(idEnv ? { env: { ...process.env, ...idEnv } } : {}),
    });
  };
}
