/** Git worktree helpers (fleet & static-fleet modes). */

import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/**
 * THE SSH COMMAND A NETWORK GIT CALL RUNS UNDER when the operator has not named
 * one. `BatchMode` turns a passphrase or host-key prompt on /dev/tty into an
 * immediate failure; the keepalive pair ends a half-open connection (a laptop
 * that slept, a Wi-Fi change) in ~30s instead of when the kernel gives up hours
 * later. An agent key still works — BatchMode disables prompts, not keys.
 */
export const NET_SSH_COMMAND =
  'ssh -o BatchMode=yes -o ConnectTimeout=20 -o ServerAliveInterval=15 -o ServerAliveCountMax=2';

/** The default bound on one network git call. */
export const GIT_NET_TIMEOUT_MS = 60_000;

/**
 * The environment a NETWORK git call runs under — never interactive.
 *
 * `GIT_TERMINAL_PROMPT=0` makes git fail instead of opening /dev/tty for a
 * username (an HTTPS remote whose credential cache expired), and
 * `GCM_INTERACTIVE=never` says the same to Git Credential Manager. The SSH
 * command is set only when the operator has not chosen one — `GIT_SSH_COMMAND`,
 * `GIT_SSH` or `core.sshCommand` — because the env var OUTRANKS the config key,
 * and overriding somebody's `-i ~/.ssh/deploy_key` would break every fetch to
 * make it non-interactive. Their own command is still bounded by the timeout.
 */
export function gitNetEnv(cwd, env = process.env) {
  const out = { ...env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };
  if (env.GIT_SSH_COMMAND || env.GIT_SSH) return out;
  let configured = '';
  try {
    configured = execFileSync('git', ['config', '--get', 'core.sshCommand'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
    }).trim();
  } catch {
    /* unset (exit 1) or unreadable — ours, then */
  }
  if (!configured) out.GIT_SSH_COMMAND = NET_SSH_COMMAND;
  return out;
}

/**
 * A NETWORK git call (fetch, push), TIMED AND NON-INTERACTIVE.
 *
 * `git()` above is `execFileSync` with no timeout: right for a local
 * `rev-parse`, and a daemon-wide freeze for a `fetch` — the call blocks the
 * whole event loop, so a remote that prompts on /dev/tty or a connection that
 * went half-open stops every poll, settle, lease renewal and relay on the
 * machine until it returns. Every call that talks to a remote goes through
 * here. Returns the untrimmed stdout; throws like `git()` does (a timeout
 * throws with `code: 'ETIMEDOUT'`).
 */
export function gitNet(args, cwd, ms = GIT_NET_TIMEOUT_MS) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: ms,
    killSignal: 'SIGKILL',
    env: gitNetEnv(cwd),
  });
}

/**
 * The same call WITHOUT BLOCKING — for the unattended periodic fetch, where
 * even a bounded freeze every few minutes is a daemon that goes dark for a
 * remote's bad day. Spawned as its own process group so a timeout takes the
 * ssh or credential helper under git with it. Resolves stdout; rejects on a
 * non-zero exit, a spawn error or the timeout.
 */
export function gitNetAsync(args, cwd, ms = GIT_NET_TIMEOUT_MS) {
  return new Promise((resolvePromise, reject) => {
    let child;
    try {
      child = spawn('git', args, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: gitNetEnv(cwd),
        detached: true,
      });
    } catch (e) {
      reject(e);
      return;
    }
    let out = '';
    let err = '';
    let settled = false;
    const finish = (fn, v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(v);
    };
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }
      const e = new Error(`git ${args[0]} timed out after ${ms}ms`);
      e.code = 'ETIMEDOUT';
      finish(reject, e);
    }, ms);
    timer.unref?.();
    child.stdout.on('data', (d) => {
      out += d;
    });
    child.stderr.on('data', (d) => {
      err += d;
    });
    child.on('error', (e) => finish(reject, e));
    child.on('close', (code) => {
      if (code === 0) finish(resolvePromise, out);
      else {
        const e = new Error(`git ${args[0]} exited ${code}`);
        e.stderr = err;
        e.status = code;
        finish(reject, e);
      }
    });
  });
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
    console.error('error: the flowviant daemon must run inside a git repo.');
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
  /**
   * NO `origin/HEAD`. Prefer a CONVENTION over an accident.
   *
   * This used to fall straight through to `origin/<whatever is checked out
   * right now>` — which, since the result is computed once at daemon start and
   * held for the life of the process, meant starting the daemon while you
   * happened to be on `staging` silently made staging the merge target for
   * every ship until you restarted. Nothing said so.
   *
   * A remote branch actually called `main` or `master` is a far better guess
   * than the branch you were standing on, and unlike that one it does not
   * depend on when the process booted. The old behaviour survives as the last
   * resort, because a repo with neither is a repo where we genuinely have
   * nothing better.
   *
   * The real fix is that a human can now SET it (`projects.baseBranch`), which
   * overrides all of this. This just stops the unset case being arbitrary.
   */
  for (const conventional of ['origin/main', 'origin/master']) {
    try {
      git(['rev-parse', '--verify', '--quiet', `refs/remotes/${conventional}`], repoRoot);
      return conventional;
    } catch {
      /* not this one */
    }
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
    gitNet(['fetch', 'origin', '--quiet'], wt);
  } catch {
    /* offline / no remote / timed out — reset to whatever we have */
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
 * Add paths to the exclude file git ACTUALLY READS, for one worktree.
 *
 * MOVED HERE 2026-09-21, from env.mjs. It lived in the secrets vault because
 * the vault is what first needed it — materialized `.env` files had to be
 * untracked AND unstageable — but it is a plain `git info/exclude` helper with
 * no crypto, no bundle and no opinion about secrets, and the vault is deleted.
 * Its one surviving caller is `work.mjs`, which hides a tab's `.flowviant/`
 * upload directory with it.
 *
 * WHY IT IS NOT `.git/worktrees/<name>/info/exclude`: it used to resolve the
 * worktree's own gitdir and write there, on the belief that the file "applies
 * to that worktree only and never touches the user's repo". Git does not read
 * that file — it resolves `info/exclude` against $GIT_COMMON_DIR, the main
 * `.git` — so in every linked worktree the daemon creates, the exclusion did
 * nothing at all, and the paths it was meant to hide stayed visible to
 * `git add -A`.
 *
 * `--git-common-dir` is ASKED OF GIT rather than derived, because that is the
 * one answer that cannot drift from what git itself will consult. The file is
 * local to the clone and never committed. Idempotent: a path already listed is
 * not appended again, so calling this per fetch costs one read.
 *
 * Best-effort throughout. It is a CONVENIENCE and never a guarantee — nothing
 * downstream may treat "we called this" as proof git cannot see a path.
 */
export function excludeInWorktree(wt, relPaths) {
  try {
    let gitdir;
    try {
      gitdir = resolve(
        wt,
        execFileSync('git', ['rev-parse', '--git-common-dir'], {
          cwd: wt,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim()
      );
    } catch {
      return; // not a repo — there is no exclude file to write
    }
    const excludePath = join(gitdir, 'info', 'exclude');
    mkdirSync(dirname(excludePath), { recursive: true });
    let existing = '';
    try {
      existing = readFileSync(excludePath, 'utf8');
    } catch {
      /* fresh */
    }
    const missing = relPaths.filter((p) => !existing.split('\n').includes(`/${p}`));
    if (missing.length) {
      appendFileSync(
        excludePath,
        `${existing.endsWith('\n') || !existing ? '' : '\n'}${missing.map((p) => `/${p}`).join('\n')}\n`
      );
    }
  } catch {
    /* best-effort */
  }
}
