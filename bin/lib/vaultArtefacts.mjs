/**
 * WHAT THE DELETED SECRETS VAULT LEFT ON THIS DISK — swept once, on start
 * (2026-09-21).
 *
 * The vault went whole on the owner's ruling — *"no i dont want it. unless its
 * needed where i want to show the env of each of the machines (for
 * comparison)"* — and deleting the CODE that writes a file does not delete the
 * file. Two artefacts survive an upgrade on every box that ever ran a daemon
 * before this release, and both are plaintext-adjacent:
 *
 *  1. `~/.flowviant/env-cache/<projectId>.json` — the bundle at rest, sealed
 *     under a key derived from this box's own private half. Nothing can read it
 *     any more (`loadCachedEnv`, `readCache` and `cacheKey` are all deleted), so
 *     it is an encrypted blob whose only remaining property is that it is a
 *     copy of the project's secrets sitting in the operator's home directory
 *     for ever. There is no version of keeping it that is useful.
 *  2. MATERIALIZED `.env` FILES in worktrees — `materializeInto` wrote the
 *     decrypted dev secrets into every session and task worktree it cut. Those
 *     are PLAINTEXT, they are not maintained by anything any more, and the
 *     worktrees themselves outlive daemon restarts and reboots by design.
 *
 * ── THE MARKER IS WHAT MAKES DELETING A FILE ALLOWED ──
 *
 * `renderEnvFile` opened every file it wrote with a fixed first line —
 * `# Materialized by flowviant env sync — DO NOT COMMIT.` — and the vault's own
 * `removeStaleEnvFile` already gated its deletions on exactly that prefix, for
 * exactly this reason. So this sweep inherits a reliable marker rather than
 * guessing, and the rule is absolute: NO MARKER, NO DELETE. An operator's own
 * `.env` is often the only copy of something they pasted in from a provider
 * months ago, and deleting it is unrecoverable from here. A file we did not
 * write is never touched on a guess, a heuristic, or a name match.
 *
 * ── THE WALK IS BOUNDED, AND THE BOUND IS STATED ──
 *
 * The vault's `targetFile` was any relative path, so in principle a marked file
 * could be at `apps/api/.dev.vars`. A full tree walk of every worktree on a
 * daemon's boot path is how a sweep ends up reading somebody's `node_modules`,
 * so this goes three directories deep, skips `node_modules`, `.git` and every
 * dot-directory, visits at most `MAX_DIRS` directories in total, and only opens
 * files whose NAME could plausibly be a target (`.env*`, `*.vars`). A marked
 * file deeper or more exotically named than that is LEFT, and it is left
 * wearing a header that says whose it is — which is a strictly better outcome
 * than an unbounded walk, and is why the bound is acceptable rather than
 * merely convenient.
 *
 * ── IT NEVER THROWS, AND IT IS QUIET WHEN IT DID NOTHING ──
 *
 * It runs on the boot path, before anything is serving, so an EACCES or a
 * vanished directory must cost nothing. And it prints ONLY if it actually
 * removed something: a line saying "cleaned up nothing" on every start, for
 * ever, on every box that never ran the vault, is the standing-readout noise
 * this daemon deletes everywhere else. Once per process, because it is a
 * migration and not a sweep — there is nothing that can put these files back.
 */

import { lstatSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** The exact first line `renderEnvFile` wrote. Compared as a PREFIX, because
 *  the full line carried a trailing " — DO NOT COMMIT." that is not worth
 *  depending on byte-for-byte across the releases that wrote it. */
const MATERIALIZE_HEADER = '# Materialized by flowviant env sync';

const MAX_DEPTH = 3;
const MAX_DIRS = 400;
/** Only these are ever opened. A target could in principle be named anything;
 *  see the walk bound above for why the answer to that is a stated limit
 *  rather than reading every file in the tree. */
const couldBeTarget = (name) => name.startsWith('.env') || name.endsWith('.vars');
const SKIP_DIRS = new Set(['node_modules', '.git']);

/** Is this file one we wrote? Read bounded — the header is the first line, so
 *  a file that is huge, binary or unreadable answers "not ours" without being
 *  slurped. */
function isMaterialized(abs) {
  try {
    const st = lstatSync(abs);
    // A SYMLINK IS NOT A FILE HERE EITHER. `readFileSync` follows one and
    // `rmSync` would then remove the link while the marker it matched belongs
    // to whatever it points at — a delete primitive must validate its own
    // input, which is the lesson `removeStaleEnvFile` recorded in its own
    // comment.
    if (!st.isFile() || st.size > 1024 * 1024) return false;
    return readFileSync(abs, 'utf8').startsWith(MATERIALIZE_HEADER);
  } catch {
    return false;
  }
}

/**
 * Do the work. Returns `{ cacheRemoved, filesRemoved }` — the file list is
 * absolute paths, for the caller's one line and for the test.
 *
 * `roots` are directories to walk: the checkout, and the worktree home under
 * `~/.flowviant/worktrees/<repo>-<hash>`. Separated from the once-guard below
 * so the behaviour can be driven repeatedly against temp directories; a
 * migration whose only proof is that it ran once is not proof.
 */
export function removeVaultArtefacts({ home = homedir(), roots = [] } = {}) {
  const out = { cacheRemoved: false, filesRemoved: [] };
  try {
    const cache = join(home, '.flowviant', 'env-cache');
    if (lstatSync(cache).isDirectory()) {
      rmSync(cache, { recursive: true, force: true });
      out.cacheRemoved = true;
    }
  } catch {
    /* no cache on this box, or we cannot read it — either way, nothing to do */
  }

  let dirsVisited = 0;
  const walk = (dir, depth) => {
    if (depth > MAX_DEPTH || dirsVisited >= MAX_DIRS) return;
    dirsVisited += 1;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
        walk(abs, depth + 1);
        continue;
      }
      if (!e.isFile() || !couldBeTarget(e.name)) continue;
      if (!isMaterialized(abs)) continue; // NO MARKER, NO DELETE
      try {
        rmSync(abs, { force: true });
        out.filesRemoved.push(abs);
      } catch {
        /* best-effort: a file we cannot remove is one we leave, marked */
      }
    }
  };
  for (const root of roots) {
    if (typeof root === 'string' && root) walk(root, 0);
  }
  return out;
}

let swept = false;

/**
 * The boot-path entry point: at most once per process, never throwing, and
 * silent unless something was actually removed. Returns the same shape, or
 * `null` if it has already run — which is what makes "at most once" provable
 * rather than asserted.
 */
export function sweepVaultArtefactsOnce({ home, roots, log } = {}) {
  if (swept) return null;
  swept = true;
  let res;
  try {
    res = removeVaultArtefacts({ home, roots });
  } catch {
    return null; // a cleanup that breaks the boot path is worse than the files
  }
  const n = res.filesRemoved.length;
  if (typeof log === 'function' && (res.cacheRemoved || n > 0)) {
    const parts = [];
    if (res.cacheRemoved) parts.push('the encrypted env cache');
    if (n > 0) parts.push(`${n} materialized .env file${n === 1 ? '' : 's'}`);
    log(`removed ${parts.join(' and ')} left by the deleted secrets vault.`);
  }
  return res;
}
