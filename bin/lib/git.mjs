/** Git worktree helpers (fleet & static-fleet modes). */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

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

/**
 * Get a detached worktree at `wt`, creating it at `ref` if it isn't there.
 *
 * Returns `{ path, fresh }` — `fresh` is the whole point. A worktree that
 * ALREADY existed is one somebody was mid-way through, and the caller must not
 * reset it; a freshly created one is at base by construction and has nothing to
 * preserve. That single bit replaces the in-memory `resuming` flag and the
 * on-disk task marker for the common case, because once a worktree is named
 * after its task, "does this directory exist" IS "am I resuming".
 *
 * The prune-and-retry is not paranoia: `git worktree add` refuses a path that
 * is still REGISTERED even when the directory is gone (`flowviant clean` rm's
 * the dirs, `git worktree list` keeps the stale entries), and that failure is
 * permanent until pruned.
 */
export function ensureWorktree(repoRoot, wt, ref) {
  // Resolve first. `existsSync` answers relative to THIS process's cwd while
  // `git worktree add` answers relative to repoRoot, so a relative path makes
  // the two disagree: the check says "not there", the add says "already
  // exists", and the prune-and-retry can't fix a path that was never the one
  // we looked at. Callers pass absolute paths today; this makes that not matter.
  wt = resolve(wt);
  if (existsSync(wt)) return { path: wt, fresh: false };
  try {
    git(['worktree', 'add', '--detach', wt, ref], repoRoot);
  } catch {
    git(['worktree', 'prune'], repoRoot);
    git(['worktree', 'add', '--detach', wt, ref], repoRoot);
  }
  return { path: wt, fresh: true };
}

// ── WIP checkpoints: the sandbox's state, on the remote ────────────────────
//
// A task's uncommitted work used to exist in exactly one place — a directory on
// whichever machine claimed it. That made the checkout precious: losing the box
// lost the work, so a task was pinned to a host, the host had to be named in the
// UI, and a container could never be thrown away. Pushing the work somewhere
// durable inverts all of that. The sandbox becomes a cache.
//
// These snapshots go to `refs/flowviant-wip/<intentId>`, NOT to a branch: they
// are machine state, not history, and they must never appear in a PR, a branch
// listing, or anyone's `git log`. Force-pushed, because only the latest matters.

const wipRef = (intentId) => `refs/flowviant-wip/${intentId}`;

/** git, with extra environment — for GIT_INDEX_FILE and a committer identity we
 *  can't assume the machine has configured. */
function gitWithEnv(args, cwd, extraEnv) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...extraEnv },
  }).trim();
}

/**
 * Snapshot everything in the worktree — staged, unstaged and untracked — and
 * push it, WITHOUT touching the agent's HEAD, index or files.
 *
 * That constraint is why this doesn't just commit. The agent is a live process
 * with its own git intentions; committing under it would rewrite state it is
 * mid-way through reasoning about, and `git stash` would rip the files out from
 * under an editor. Building the tree in a throwaway index leaves the agent's
 * world untouched — it cannot tell this happened.
 *
 * Returns the commit sha, or null if there was nothing dirty / no remote.
 */
export function checkpointWip(wt, intentId, baseRef) {
  if (!isSafePathSegment(intentId)) return null;
  const idx = join(tmpdir(), `flowviant-idx-${intentId}-${process.pid}`);
  const env = {
    GIT_INDEX_FILE: idx,
    // A snapshot must never fail because the machine has no user.name — this is
    // ours, not the user's, and it never lands in history anyone reads.
    GIT_AUTHOR_NAME: 'Flowviant',
    GIT_AUTHOR_EMAIL: 'daemon@flowviant.com',
    GIT_COMMITTER_NAME: 'Flowviant',
    GIT_COMMITTER_EMAIL: 'daemon@flowviant.com',
  };
  try {
    const head = git(['rev-parse', 'HEAD'], wt);
    gitWithEnv(['read-tree', head], wt, env);
    gitWithEnv(['add', '-A'], wt, env);
    const tree = gitWithEnv(['write-tree'], wt, env);
    // Nothing changed since HEAD — no snapshot worth pushing.
    if (tree === git(['rev-parse', `${head}^{tree}`], wt)) return null;
    const commit = gitWithEnv(
      ['commit-tree', tree, '-p', head, '-m', `flowviant wip ${intentId}`],
      wt,
      env
    );
    git(['push', '--force', 'origin', `${commit}:${wipRef(intentId)}`], wt);
    return commit;
  } catch {
    // Offline, no push rights, a repo with no origin — a checkpoint is an
    // optimisation, never a reason to fail a task.
    return null;
  } finally {
    try {
      rmSync(idx, { force: true });
    } catch {
      /* best-effort */
    }
    void baseRef;
  }
}

/**
 * Rebuild a worktree from its last pushed checkpoint. Returns true if one was
 * found and applied.
 *
 * The reset is MIXED on purpose: it leaves the snapshot's content in the files
 * with HEAD back at the parent, which is what the agent had before — dirty
 * working tree, nothing staged it didn't stage itself. A soft reset would hand
 * it a fully-staged index it never created.
 */
export function restoreWip(wt, intentId) {
  if (!isSafePathSegment(intentId)) return false;
  const ref = wipRef(intentId);
  try {
    git(['fetch', 'origin', `+${ref}:${ref}`], wt);
    const commit = git(['rev-parse', ref], wt);
    const parent = git(['rev-parse', `${commit}^`], wt);
    git(['checkout', '--detach', commit], wt);
    git(['reset', parent], wt);
    return true;
  } catch {
    return false; // no checkpoint for this task, or it's unreachable
  }
}

/** Drop a task's checkpoint once its work has landed somewhere real. */
export function clearWip(wt, intentId) {
  if (!isSafePathSegment(intentId)) return;
  try {
    git(['push', 'origin', '--delete', wipRef(intentId)], wt);
  } catch {
    /* already gone, or no remote */
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

/**
 * What has changed in this worktree since `baseRef` — committed or not.
 *
 * The definition matters. `git diff --numstat <base>` (no `..HEAD`) compares the
 * base against the WORKING TREE, so it covers commits the agent has made, staged
 * work, and edits it has not committed yet. Anything narrower would go blank at
 * the exact moments you look: right after a commit, or before the first one.
 *
 * Untracked files are added separately — they are invisible to `git diff` and
 * are usually the most interesting thing an agent has done (a new module, a new
 * test). Their line counts are read here rather than inferred; a file too large
 * to be source is reported as a path with no counts instead of being read into
 * memory.
 *
 * PATHS AND COUNTS ONLY. Nothing in here returns file content.
 *
 * Both git calls are `-z`, for the reason gitRaw exists: git's line-based output
 * QUOTES any path that is not plain ASCII, so an accented filename arrives as
 * "n\303\251w.txt" — a string that is not the path, cannot be stat'd, and reads
 * as garbage in the tray. `-z` emits paths verbatim.
 */
export function worktreeDiffstat(cwd, baseRef, { maxFiles = 200 } = {}) {
  const files = [];
  let additions = 0;
  let deletions = 0;

  const add = (path, added, removed) => {
    additions += added;
    deletions += removed;
    files.push({ path, added, removed });
  };

  try {
    // `--numstat -z` frames a normal change as one field, "added\tdeleted\tpath",
    // but a RENAME as three: "added\tdeleted\t" (empty path), then the old path,
    // then the new one. An empty path is therefore the rename marker, and the
    // next two fields belong to it — read line-wise instead, a rename would
    // report a file literally named "old => new".
    const fields = splitNul(gitRaw(['diff', '--numstat', '-z', baseRef, '--'], cwd));
    for (let i = 0; i < fields.length; i++) {
      const [a, d, ...rest] = fields[i].split('\t');
      let path = rest.join('\t');
      if (!path) {
        path = fields[i + 2] ?? fields[i + 1]; // the post-rename name is what exists now
        i += 2;
        if (!path) continue;
      }
      // Binary files report '-' for both counts; they changed, but not by lines.
      add(path, a === '-' ? 0 : Number(a) || 0, d === '-' ? 0 : Number(d) || 0);
    }
  } catch {
    // No base ref yet, or not a repo — nothing to report rather than a crash.
    return null;
  }

  try {
    const untracked = splitNul(
      gitRaw(['ls-files', '--others', '--exclude-standard', '-z'], cwd)
    );
    for (const path of untracked) {
      let added = 0;
      // Past the cap this path will not be shown, so do not pay to read it.
      // This is the one place the totals can undercount, and reaching it takes
      // an untracked tree bigger than the list itself — a generated directory
      // .gitignore missed. Statting and reading all of it on a 20s interval
      // would block the roster poll and every other lane on this daemon.
      if (files.length < maxFiles) {
        try {
          const { size } = statSync(join(cwd, path));
          // 2 MB: past this it is a build artifact or a binary, and reading it to
          // count newlines would be the most expensive thing this daemon does.
          if (size <= 2_000_000) {
            const text = readFileSync(join(cwd, path), 'utf8');
            // Lines, not segments. A file ending in a newline — i.e. essentially
            // every source file an agent writes — splits into one more piece
            // than it has lines, and that +1 was landing in the totals shown
            // beside git's own counts.
            added = text ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0;
          }
        } catch {
          /* vanished between listing and reading — report the path, no counts */
        }
      }
      add(path, added, 0);
    }
  } catch {
    /* untracked listing failed — the tracked half still stands */
  }

  if (files.length === 0) return null;
  // Totals stay whole while the LIST is capped: a truncated list must never
  // quietly shrink the number printed beside it.
  const truncated = Math.max(0, files.length - maxFiles);
  return { files: files.slice(0, maxFiles), additions, deletions, truncated };
}
