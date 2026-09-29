/**
 * Knowledge-vault plumbing: the local Obsidian-style wiki directory Claude
 * writes (plain markdown + [[wikilinks]]) and the hash-diff sync that ships it
 * to Flowviant. The vault lives OUTSIDE the repo and its worktrees
 * (~/.flowviant/vaults/<projectId>) so it persists across sweeps, and gets a
 * private `git init` so every pass is versioned locally for free — the user's
 * repository is never touched.
 *
 * Sync protocol (POST /api/fleet/wiki-vault, fleet-token auth): only files
 * whose sha256 changed since the last successful sync are uploaded, chunked;
 * the LAST request carries the finalize.manifest of a completed full sweep so
 * the server prunes pages the sweep no longer has. The last-synced hashes live
 * in `.flowviant-sync.json` inside the vault (dotfile — never walked, never
 * uploaded).
 *
 * HARD RULE — deletion is opt-in, never inferred. That rule, the carry-forward
 * policy and the request plan live in vaultDiff.mjs (planVaultSync); this
 * module is the adapter: walk, read, POST in order, advance the state.
 */

import {
  readdirSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, relative, sep } from 'node:path';
import { planVaultSync } from './vaultDiff.mjs';

const SYNC_STATE = '.flowviant-sync.json';

/** Create the vault dir + its private git history (best-effort). */
export function ensureVault(dir) {
  mkdirSync(dir, { recursive: true });
  if (!existsSync(join(dir, '.git'))) {
    try {
      execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
    } catch {
      /* git unavailable — the vault still works, just unversioned */
    }
  }
}

/** All vault-relative .md paths (forward slashes), dotfiles/dirs skipped.
 *  Splits on the PLATFORM separator only — a literal backslash in a Linux
 *  filename must not be mangled into a bogus subpath. A failed directory read
 *  bumps `errors.count` — the caller MUST treat the walk as partial then
 *  (pages under an unreadable subtree are absent, not deleted). */
function walkMd(dir, base = dir, out = [], errors = { count: 0 }) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    errors.count++;
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walkMd(p, base, out, errors);
    else if (e.isFile() && e.name.endsWith('.md'))
      out.push(relative(base, p).split(sep).join('/'));
  }
  return out;
}

/** Best-effort local history commit — identity pinned so it works on machines
 *  with no global git config, and never touches the user's identity. */
function commitVault(dir, message) {
  try {
    execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'ignore' });
    execFileSync(
      'git',
      ['-c', 'user.name=flowviant', '-c', 'user.email=wiki@flowviant.local', 'commit', '-q', '-m', message],
      { cwd: dir, stdio: 'ignore' }
    );
  } catch {
    /* nothing to commit / git unavailable — fine */
  }
}

/**
 * Hash-diff sync the vault to the server. Returns counts; throws on a failed
 * upload (the sync state is only advanced after EVERY request lands, so a
 * partial failure re-uploads next time — server upserts are idempotent).
 */
export async function syncVault({ dir, url, token, userAgent, finalize, groundedAtSha, repoFullName, warn = () => {}, scrub = (t) => t }) {
  const walkErrors = { count: 0 };
  const found = walkMd(dir, dir, [], walkErrors).sort();
  let prev = {};
  if (!(walkErrors.count > 0 && found.length === 0)) {
    try {
      prev = JSON.parse(readFileSync(join(dir, SYNC_STATE), 'utf8'));
    } catch {
      /* first sync */
    }
  }
  const read = (p) => {
    try {
      return readFileSync(join(dir, p), 'utf8');
    } catch {
      return null;
    }
  };
  // What to send is vaultDiff.mjs's decision; this adapter only moves bytes.
  const plan = planVaultSync({ found, walkErrors: walkErrors.count, prev, read, scrub, finalize, groundedAtSha, repoFullName, dir });
  for (const w of plan.warnings) warn(w);
  if (plan.result) return plan.result;

  for (const body of plan.requests) {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'User-Agent': userAgent,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(60_000),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`wiki-vault sync failed (${res.status})`);
  }

  writeFileSync(join(dir, SYNC_STATE), JSON.stringify(plan.state));
  commitVault(dir, plan.finalized ? `sweep${groundedAtSha ? ` @ ${groundedAtSha.slice(0, 7)}` : ''}` : `update${groundedAtSha ? ` @ ${groundedAtSha.slice(0, 7)}` : ''}`);
  return { pages: plan.pages, uploaded: plan.uploaded, deleted: plan.deleted };
}
