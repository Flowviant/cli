/**
 * Patch placement — landing a small change in the OWNER's own checkout.
 *
 * The motivating case: a teammate wants the login button to read "Sign in"
 * while you are mid-work on auth. A clone → branch → push → PR → review → merge
 * → pull cycle for a nine-character diff is absurd, and it blocks THEM on YOU.
 *
 * The naive version of this — let their agent write into your working directory
 * — is the one thing we will not do. Two writers in one directory produce silent
 * lost edits: the agent reads a file, thinks for forty seconds, and writes it
 * back over the change you made in between. No conflict marker, nothing to
 * resolve, and you find out three tasks later.
 *
 * So the agent still works in its OWN worktree, branched off your current
 * branch, and the daemon carries the result across with a cherry-pick:
 *
 *   1. the agent commits in its worktree (no push, no PR)
 *   2. we check the files it touched against YOUR uncommitted edits
 *   3. only if they are disjoint do we cherry-pick into your checkout
 *
 * Step 2 is the whole safety argument. A collision is reported as a blocker for
 * a human to sort out — never resolved by guessing, and never applied anyway.
 *
 * One patch at a time per daemon: `withPatchLock` serialises every apply in this
 * process, so two agents can't race to write your tree. (Two daemons on one repo
 * would still race — nothing in the daemon guards that today.)
 */

import { git, gitRaw, splitNul, isValidSha } from './git.mjs';

/** Serialises applies within this process. */
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

/** The branch the human is actually on, or null in a detached head. */
export function ownerCurrentBranch(repoRoot) {
  try {
    const name = git(['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot);
    return name && name !== 'HEAD' ? name : null;
  } catch {
    return null;
  }
}

/**
 * Repo-relative paths with uncommitted changes in the owner's checkout.
 *
 * `-z` on purpose. The line-based form quotes any path that isn't plain ASCII
 * ("src/caf\303\251.ts") while `git diff --name-only` renders the same file
 * differently — so the collision check, which is the entire safety argument for
 * patch placement, quietly stopped matching for anyone with an accent in a
 * filename and let the cherry-pick land on top of their edits. NUL-separated
 * output is verbatim on both sides.
 */
export function dirtyPaths(repoRoot) {
  let out = '';
  try {
    out = gitRaw(['status', '--porcelain', '-z'], repoRoot);
  } catch {
    return [];
  }
  // Porcelain -z is "XY path\0", and a RENAME is "R  new\0old\0" — the extra
  // entry is the source, which we skip: the destination is what gets clobbered.
  const entries = splitNul(out);
  const paths = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    // "XY " — two status columns and a space — then the path, verbatim.
    if (entry.length < 4) continue;
    const code = entry.slice(0, 2);
    paths.push(entry.slice(3));
    if (code.includes('R') || code.includes('C')) i += 1; // consume the source
  }
  return paths;
}

/** Commits the agent made on top of `base`, oldest first. */
export function commitsSince(cwd, base) {
  try {
    const out = git(['rev-list', '--reverse', `${base}..HEAD`], cwd);
    return out.split('\n').map((l) => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/** Files those commits touch. `-z` to match dirtyPaths byte for byte. */
export function filesChanged(cwd, base) {
  try {
    return splitNul(gitRaw(['diff', '--name-only', '-z', `${base}..HEAD`], cwd));
  } catch {
    return [];
  }
}

// A patch never reaches GitHub, so the server has no provider to read a diff
// back from — these commits exist only here. Without carrying it across, the
// delivery card asks the human to Keep or Revert on the agent's word alone,
// which is the review we skipped the PR to avoid needing.
//
// Capped because it crosses the wire and lands in a row read on every card
// render: 40 files, 24KB of hunks each. Truncation is stated in the patch text
// rather than silently trimmed — "no diff shown" is honest, a diff that lies
// about its own extent is not.
const MAX_DIFF_FILES = 40;
const MAX_PATCH_BYTES = 24_000;

const DIFF_STATUS = { A: 'added', D: 'removed', M: 'modified' };

/**
 * The per-file unified diffs for the agent's commits, in the same shape the PR
 * path returns so the delivery card renders both through one component.
 *
 * Rename detection is deliberately OFF (no -M): with it on, `--numstat` writes
 * the path as `dir/{old => new}.ts`, which no longer matches anything you can
 * pass back to `git diff -- <path>`. A rename showing up as a delete plus an add
 * is a slightly longer diff and a correct one.
 */
export function fileDiffs(cwd, base, { range, maxFiles = MAX_DIFF_FILES } = {}) {
  // `range` lets the per-COMMIT walk reuse this (`sha^..sha`); without it the
  // original meaning holds — everything the agent did since `base`.
  const rev = range ?? `${base}..HEAD`;
  let numstat = '';
  let names = '';
  try {
    numstat = git(['diff', '--numstat', '--no-renames', rev], cwd);
    names = git(['diff', '--name-status', '--no-renames', rev], cwd);
  } catch {
    return [];
  }

  const statusOf = new Map();
  for (const line of names.split('\n')) {
    const [letter, path] = line.split('\t');
    if (!letter || !path) continue;
    statusOf.set(path.trim(), letter.trim().charAt(0));
  }

  const out = [];
  for (const line of numstat.split('\n')) {
    if (out.length >= maxFiles) break;
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line.replace(/\n$/, ''));
    if (!m) continue;
    const path = m[3].trim();
    // A "-" count means binary — git has no textual hunks to give us.
    const binary = m[1] === '-' || m[2] === '-';

    let patch = null;
    if (!binary) {
      try {
        const full = git(['diff', rev, '--', path], cwd);
        // Drop git's own "diff --git a/… b/…" preamble; the card shows the path.
        const at = full.indexOf('@@');
        const hunks = at === -1 ? full : full.slice(at);
        patch =
          hunks.length > MAX_PATCH_BYTES
            ? `${hunks.slice(0, MAX_PATCH_BYTES)}\n… diff truncated (${hunks.length} bytes)`
            : hunks;
      } catch {
        patch = null;
      }
    }

    out.push({
      path,
      status: DIFF_STATUS[statusOf.get(path)] ?? 'modified',
      additions: binary ? 0 : Number(m[1]),
      deletions: binary ? 0 : Number(m[2]),
      patch,
    });
  }
  return out;
}

/**
 * Carry the agent's commits into the owner's checkout.
 *
 * Returns one of:
 *   { ok: true, shas, files }                — applied
 *   { ok: false, reason: 'no_commits' }      — the agent committed nothing
 *   { ok: false, reason: 'branch_moved' }    — the owner switched branches mid-run
 *   { ok: false, reason: 'conflict', paths } — the owner is editing those files
 *   { ok: false, reason: 'apply_failed', error }
 *
 * Never leaves a half-applied state: a failed cherry-pick is aborted and the
 * already-applied commits are rolled back, so the owner's tree is either fully
 * patched or untouched.
 */
export function applyPatch({ repoRoot, cwd, basedOnBranch, commitsFrom }) {
  // NB: uses revertPatch (declared below — hoisted) for its rollback path.
  //
  // Two different refs, and conflating them lost work. `basedOnBranch` is the
  // owner's branch, used ONLY to check they haven't moved since we mirrored it;
  // it is null when we couldn't mirror it at all (detached HEAD, a failed
  // fetch). `commitsFrom` is where the agent's commits start, which in that case
  // is the base ref the worktree actually got reset to. Defaulting the diff to
  // 'HEAD' meant HEAD..HEAD — an empty range reported as "the agent committed
  // nothing", which is a lie about work that is sitting right there.
  const base = commitsFrom ?? basedOnBranch ?? 'HEAD';
  const shas = commitsSince(cwd, base);
  if (shas.length === 0) return { ok: false, reason: 'no_commits' };

  // The tree we branched from must still be the tree we're landing in.
  const current = ownerCurrentBranch(repoRoot);
  if (basedOnBranch && current !== basedOnBranch) {
    return { ok: false, reason: 'branch_moved', expected: basedOnBranch, actual: current };
  }

  const files = filesChanged(cwd, base);
  const dirty = new Set(dirtyPaths(repoRoot));
  const collisions = files.filter((f) => dirty.has(f));
  if (collisions.length > 0) {
    return { ok: false, reason: 'conflict', paths: collisions };
  }

  // Make the agent's commits reachable from the main checkout. Worktrees of the
  // same repo share an object store, so this needs no network and no remote.
  const applied = [];
  try {
    for (const sha of shas) {
      git(['cherry-pick', '--allow-empty', '-x', sha], repoRoot);
      applied.push(sha);
    }
  } catch (e) {
    try {
      git(['cherry-pick', '--abort'], repoRoot);
    } catch {
      /* nothing in progress */
    }
    let rolledBack = true;
    if (applied.length > 0) {
      // Roll back the ones that did land — by REVERTING them, never by
      // resetting. `git reset --hard HEAD~n` would restore every tracked file
      // in the repo, silently destroying the owner's uncommitted work in files
      // this patch never touched. The pre-flight guard above only clears the
      // patch's OWN file set, so a reset here is unbounded damage for a bounded
      // mistake. A revert touches only the files in those commits.
      const rev = revertPatch({ repoRoot, shas: applied });
      rolledBack = rev.ok;
    }
    return {
      ok: false,
      reason: 'apply_failed',
      error: e?.message ?? String(e),
      // The caller must NOT claim "your tree is untouched" when part of the
      // patch is still sitting in the owner's history.
      partiallyApplied: !rolledBack,
      appliedShas: rolledBack ? [] : applied,
    };
  }

  // The landed shas differ from the source shas (cherry-pick rewrites them);
  // report the ones now in the owner's history, since Revert acts on those.
  let landed = applied;
  try {
    const out = git(['rev-list', `-n${applied.length}`, 'HEAD'], repoRoot);
    landed = out.split('\n').map((l) => l.trim()).filter(Boolean).reverse();
  } catch {
    /* keep the source shas as a best-effort record */
  }
  return { ok: true, shas: landed, files };
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


// How many commits of a task's branch we carry across. The server used to read
// this from GitHub and capped at 50 for the same reason: each commit costs a
// diff, and a runaway branch must not fan out unbounded work or produce a row
// too big to read on every card render. Truncation keeps the MOST RECENT
// commits — the tail is what a reviewer is looking at.
const MAX_COMMITS = 50;

/**
 * A task branch's commits with their real per-file diffs, in the exact shape
 * the server's GitHub read used to return (`TaskCommit[]`).
 *
 * This is the function that let the GitHub App die. The server used to resolve
 * the project's linked repo, mint an installation token, fetch
 * `GET /pulls/{n}/commits` and then run an N+1 of `GET /commits/{sha}` for the
 * per-file patches — up to ~52 API calls to describe work THIS process had just
 * performed, in a checkout it is standing in. Now the daemon reports it through
 * `report_commits` and the server reads a row.
 *
 * Oldest → newest, because the thread appends chronologically.
 */
export function commitHistory(cwd, base) {
  let log = '';
  try {
    // %x1f/%x1e are unit/record separators: a commit subject can contain
    // anything, tabs and pipes included, so the delimiters have to be bytes a
    // human will never type.
    log = git(
      ['log', '--reverse', `--max-count=${MAX_COMMITS}`, '--format=%H%x1f%s%x1f%an%x1f%aI%x1e', `${base}..HEAD`],
      cwd,
    );
  } catch {
    return [];
  }

  const out = [];
  for (const record of log.split('\x1e')) {
    const line = record.trim();
    if (!line) continue;
    const [sha, message, authorName, committedAt] = line.split('\x1f');
    if (!sha) continue;
    // First-parent range for the commit itself. A root commit has no `^`, in
    // which case git's empty-tree hash gives us the whole thing as an add.
    let range = `${sha}^..${sha}`;
    try {
      git(['rev-parse', `${sha}^`], cwd);
    } catch {
      range = `4b825dc642cb6eb9a060e54bf8d69288fbee4904..${sha}`;
    }
    const files = fileDiffs(cwd, null, { range });
    out.push({
      sha,
      message: (message ?? '').slice(0, 500),
      authorName: (authorName ?? '').slice(0, 200),
      authorLogin: null,
      committedAt: committedAt ?? new Date().toISOString(),
      url: null,
      additions: files.reduce((n, f) => n + f.additions, 0),
      deletions: files.reduce((n, f) => n + f.deletions, 0),
      files,
    });
  }
  return out;
}
