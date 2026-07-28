/** Git worktree helpers (fleet & static-fleet modes). */

import { execFileSync } from 'node:child_process';

export function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/**
 * Same call, UNTRIMMED — for `-z` (NUL-separated) output, where trimming would
 * eat the final separator and the leading space of a status code.
 *
 * Anything that COMPARES two path lists has to use this. Git's default
 * line-based output quotes and escapes any path that isn't plain ASCII, and it
 * does so inconsistently between commands — so a comparison of `git status`
 * paths against `git diff` paths silently stops matching the moment a filename
 * has an accent in it. For the patch collision check, "silently stops matching"
 * means "overwrites the edits it exists to protect".
 */
export function gitRaw(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Split NUL-separated git output into entries. */
export function splitNul(out) {
  return String(out).split('\0').filter(Boolean);
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

/** A commit sha from the server, before it reaches `git revert` argv. Server
 *  values reaching git are validated here by convention (see isValidBranch,
 *  isValidPrUrl) — a revision RANGE ("HEAD~10..HEAD") or a leading-dash option
 *  must never pass, whatever the roster says. */
export function isValidSha(sha) {
  return typeof sha === 'string' && /^[0-9a-f]{7,40}$/.test(sha);
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

/**
 * The BRANCH NAME behind a base ref.
 *
 * `detectBaseRef` returns a remote-tracking ref (`origin/main`) because that is
 * what you check out and reset against. GitHub's API has never heard of it: a PR
 * base must be a branch that exists in the repo, so `gh pr edit --base
 * origin/main` 422s every time. Anything that talks to the provider needs this
 * form, not the ref.
 */
export function baseBranchName(baseRef) {
  return String(baseRef || '').replace(/^origin\//, '') || 'main';
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
