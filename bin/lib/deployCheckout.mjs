/**
 * THE THROWAWAY CHECKOUT A DEPLOY RUNS IN — a detached worktree at the base
 * tip, the operator's untracked environment linked in, and all of it taken
 * out again without ever following a link into the operator's own tree.
 *
 * Split out of deploy.mjs (SOLID F060): this half changes with filesystem and
 * git rules (what a worktree carries, what is linked and what is copied, how a
 * crashed deploy's corpse is swept). The lease, the config and the commands
 * do not.
 */

import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import { git, gitNetAsync } from './git.mjs';

/**
 * A DEPLOY BUILDS THE BASE COMMIT, NEVER THE OPERATOR'S WORKING TREE
 * (audit 2026-09-24).
 *
 * `readDeployConfig` reads the TARGET off base so that authoring a command
 * requires landing it — and then every command ran with `cwd: repoRoot`, the
 * operator's own checkout, on whatever branch they left it with whatever they
 * had not committed. So `npm run build` and `wrangler deploy` read the
 * package.json scripts, wrangler.toml and source of that working tree:
 * deploy-on-merge (queued by a teammate's ship, a PR merge or an agent merge,
 * none of which moves the checkout) shipped code WITHOUT the merge that
 * triggered it, and a co-owner's "deploy it to prod" shipped the operator's
 * half-finished branch. Reproduced: a checkout on `feature` with an
 * uncommitted edit deployed the edit.
 *
 * So a deploy runs in a THROWAWAY DETACHED WORKTREE at the base tip — the
 * shipMerge shape — and the config is read from THAT SHA, so the command and
 * the code it builds are one commit. The directory dies in a `finally`.
 *
 * What a fresh worktree does not have is what git does not track: installed
 * dependencies and the operator's env files. Those are the checkout's
 * ENVIRONMENT, not its code, so for every directory base tracks (three levels
 * deep) a `node_modules` in the checkout is re-created as a directory of links
 * to its entries — a WORKSPACE package's link re-pointed at base's own copy of
 * that package, never the checkout's working tree — and a `.env` / `.env.*` /
 * `.dev.vars` the base commit does not carry is COPIED in. Stated residual:
 * installed third-party packages and those env files are still the checkout's,
 * so a dependency installed for a feature branch, or an untracked env file an
 * agent edited, reaches the build; so does a workspace package's untracked
 * build output (`dist/`), which is simply absent here and fails the build
 * loudly rather than shipping the checkout's. A `.bin` shim is linked whole, so
 * a workspace package's own CLI still runs from the checkout. Submodules are
 * not initialised. The code and the commands no longer come from the checkout.
 */
const ENV_FILE_RE = /^(?:\.env(?:\..+)?|\.dev\.vars)$/;
const lexists = (p) => {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

/** Bring the checkout's untracked environment into a deploy worktree. Returns
 *  every path it created, so the cleanup can unlink them BEFORE the worktree
 *  is removed (a recursive delete must never be handed a symlink into the
 *  operator's own node_modules). */
export function linkCheckoutEnvironment(repoRoot, dir) {
  const made = [];
  let realRoot = repoRoot;
  try {
    realRoot = realpathSync(repoRoot);
  } catch {
    /* compared as given */
  }
  /**
   * A node_modules is a REAL directory of per-entry links, not one link to the
   * checkout's (review, audit 2026-09-24). A workspace package — npm, yarn and
   * pnpm all install one as a link like `node_modules/@x/shared ->
   * ../../packages/shared` — resolves THROUGH the checkout's node_modules into
   * the checkout's WORKING TREE, so a whole-directory link had every bundler
   * import the operator's uncommitted `packages/shared/src` into a deploy of
   * base. An entry whose real path is inside the checkout but outside any
   * node_modules is re-pointed at the SAME path in this worktree (base's copy);
   * one base does not carry is left out, since base cannot import what it does
   * not have. Every other entry links to the checkout's own, as before.
   */
  const linkNodeModules = (src, dst, depth) => {
    let entries;
    try {
      entries = readdirSync(src, { withFileTypes: true });
      mkdirSync(dst);
      made.push(dst);
    } catch {
      return;
    }
    for (const e of entries) {
      const s = join(src, e.name);
      const d = join(dst, e.name);
      // A scope directory holds packages, not a package: one level down.
      if (depth === 0 && e.name.startsWith('@') && e.isDirectory()) {
        linkNodeModules(s, d, 1);
        continue;
      }
      let target = s;
      if (e.isSymbolicLink()) {
        let real;
        try {
          real = realpathSync(s);
        } catch {
          continue; // a dangling link — nothing to bring
        }
        const rel = relative(realRoot, real);
        const inCheckout = rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
        if (inCheckout && !rel.split(sep).includes('node_modules')) {
          if (!existsSync(join(dir, rel))) continue;
          target = join(dir, rel);
        }
      }
      try {
        symlinkSync(target, d);
        made.push(d);
      } catch {
        /* the build says so if it needed it */
      }
    }
  };
  const walk = (rel, depth) => {
    let entries;
    try {
      entries = readdirSync(join(repoRoot, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const src = join(repoRoot, rel, e.name);
      const dst = join(dir, rel, e.name);
      if (e.name === '.git') continue;
      if (e.name === 'node_modules') {
        if (e.isDirectory() && !lexists(dst)) linkNodeModules(src, dst, 0);
        continue;
      }
      if (e.isFile() && ENV_FILE_RE.test(e.name)) {
        if (!lexists(dst)) {
          try {
            copyFileSync(src, dst);
            made.push(dst);
          } catch {
            /* unreadable — the build says so if it needed it */
          }
        }
        continue;
      }
      // Recurse only into directories BASE tracks — an untracked `dist/` or a
      // cache is neither code nor environment, and walking it costs a scan.
      if (e.isDirectory() && depth < 3 && existsSync(dst) && !lexists(join(dst, '.git'))) {
        walk(join(rel, e.name), depth + 1);
      }
    }
  };
  walk('', 0);
  return made;
}

/**
 * Cut the deploy worktree at the base tip. Returns `{ dir, sha, cleanup }`, or
 * throws with a sentence when base does not resolve. `worktreeDir` defaults to
 * the daemon's own worktree home for this repo (fleetStartup.mjs keys it the same
 * way); the job id is hashed into the path, never joined raw — it is a
 * server-named string.
 */
export async function openDeployCheckout({ repoRoot, baseRef, jobId, worktreeDir }) {
  if (!baseRef) throw new Error('no base branch resolved, so there is nothing to deploy from');
  try {
    // A NETWORK call, so timed, non-interactive and off the event loop — a
    // bare `git fetch` here is `execFileSync` with no timeout, and a remote
    // that prompts or a half-open connection froze every poll and lease on
    // the machine until it returned.
    await gitNetAsync(['fetch', 'origin', '--quiet'], repoRoot);
  } catch {
    /* offline — deploy the base this box last saw, and say which */
  }
  let sha;
  try {
    sha = git(['rev-parse', '--verify', `${baseRef}^{commit}`], repoRoot);
  } catch {
    throw new Error(`the base branch ${baseRef} does not resolve on this machine`);
  }
  const home =
    worktreeDir ??
    join(
      homedir(),
      '.flowviant',
      'worktrees',
      `${basename(repoRoot)}-${createHash('sha256').update(repoRoot).digest('hex').slice(0, 8)}`
    );
  const dir = join(home, 'deploy', createHash('sha256').update(String(jobId)).digest('hex').slice(0, 16));
  mkdirSync(join(home, 'deploy'), { recursive: true });
  const drop = (made = [], target = dir) => {
    // Newest first, so a node_modules directory we made is empty of our links
    // by the time it is removed.
    for (const p of [...made].reverse()) {
      try {
        unlinkSync(p);
      } catch {
        try {
          rmdirSync(p);
        } catch {
          /* already gone */
        }
      }
    }
    try {
      git(['worktree', 'remove', '--force', target], repoRoot);
    } catch {
      /* not registered */
    }
    // Every symlink we made is already unlinked, and `rmSync` unlinks a
    // symlink rather than descending it, so this can only delete our own copy.
    try {
      rmSync(target, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
    try {
      git(['worktree', 'prune'], repoRoot);
    } catch {
      /* best-effort */
    }
  };
  drop(); // a corpse from a crashed deploy of the same job
  // …and any other job's corpse old enough that no deploy can still be running
  // in it (two commands at most, 30 minutes each), so a daemon killed
  // mid-deploy does not leave a checkout on disk for ever.
  try {
    const cutoff = Date.now() - 3 * 60 * 60 * 1000;
    for (const name of readdirSync(join(home, 'deploy'))) {
      const p = join(home, 'deploy', name);
      try {
        if (p !== dir && lstatSync(p).mtimeMs < cutoff) drop([], p);
      } catch {
        /* gone meanwhile */
      }
    }
  } catch {
    /* nothing to sweep */
  }
  git(['worktree', 'add', '--detach', dir, sha], repoRoot);
  let made = [];
  try {
    made = linkCheckoutEnvironment(repoRoot, dir);
  } catch {
    /* the build says so if it needed any of it */
  }
  return { dir, sha, cleanup: () => drop(made) };
}
