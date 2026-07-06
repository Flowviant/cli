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

// ── Server-value validation ────────────────────────────────────────────────
// prUrl / branch / agentId arrive from the fleet server. execFileSync blocks
// SHELL injection but NOT git/gh option injection (a leading '-' becomes a
// flag) or cross-repo/cross-path abuse. These guards make a malicious or buggy
// server unable to touch a repo/branch/path outside the expected scope.

/** The `owner/repo` the daemon is running inside, from origin's URL. Null if
 *  origin isn't a github remote. */
export function originSlug(repoRoot) {
  try {
    const url = git(['remote', 'get-url', 'origin'], repoRoot);
    const m = url.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/i);
    return m ? `${m[1]}/${m[2]}` : null;
  } catch {
    return null;
  }
}

/** A PR URL is accepted only if it's an https github.com PR in THIS repo. */
export function isValidPrUrl(prUrl, slug) {
  if (typeof prUrl !== 'string' || !slug) return false;
  const m = prUrl.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/\d+$/);
  return !!m && m[1].toLowerCase() === slug.toLowerCase();
}

/** A branch name is accepted only if git considers it a well-formed ref, it's
 *  not the base branch, and it doesn't start with '-' (option injection). */
export function isValidBranch(branch, repoRoot, baseRef) {
  if (typeof branch !== 'string' || !branch || branch.startsWith('-')) return false;
  if (baseRef && (branch === baseRef || `origin/${branch}` === baseRef)) return false;
  try {
    git(['check-ref-format', '--branch', branch], repoRoot);
    return true;
  } catch {
    return false;
  }
}

/** A roster agent id used as a filesystem path segment — strict allowlist so
 *  it can't traverse (`..`, `/`) out of the worktrees dir. */
export function isSafePathSegment(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id);
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
