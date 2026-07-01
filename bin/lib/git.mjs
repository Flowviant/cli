/** Git worktree helpers (fleet & static-fleet modes). */

import { execFileSync } from 'node:child_process';

export function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function repoRootOrDie() {
  try {
    return git(['rev-parse', '--show-toplevel'], process.cwd());
  } catch {
    console.error('error: fleet mode must run inside a git repo.');
    process.exit(1);
  }
}

export function detectBaseRef(repoRoot) {
  try {
    return git(['rev-parse', '--abbrev-ref', 'origin/HEAD'], repoRoot); // e.g. origin/main
  } catch {
    /* origin/HEAD not set */
  }
  try {
    return `origin/${git(['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot)}`;
  } catch {
    return 'HEAD';
  }
}

export function resetWorktree(wt, baseRef) {
  try {
    git(['fetch', 'origin', '--quiet'], wt);
  } catch {
    /* offline / no remote — reset to whatever we have */
  }
  try {
    git(['checkout', '--detach', baseRef], wt);
    git(['reset', '--hard', baseRef], wt);
    git(['clean', '-fd'], wt);
  } catch (e) {
    console.error(`  (worktree reset to ${baseRef} failed: ${e.message})`);
  }
}
