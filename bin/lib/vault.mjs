/**
 * Knowledge-vault plumbing: the local Obsidian-style wiki directory Claude
 * writes (plain markdown + [[wikilinks]]) and the hash-diff sync that ships it
 * to Flowviant. The vault lives OUTSIDE the repo and its worktrees
 * (~/.flowviant/vaults/<projectId>) so it persists across sweeps, and gets a
 * private `git init` so every pass is versioned locally for free — the user's
 * repository is never touched.
 *
 * Sync protocol (POST /api/v2/fleet/wiki-vault, fleet-token auth): only files
 * whose sha256 changed since the last successful sync are uploaded, chunked;
 * the LAST request carries the finalize.manifest of a completed full sweep so
 * the server prunes pages the sweep no longer has. The last-synced hashes live
 * in `.flowviant-sync.json` inside the vault (dotfile — never walked, never
 * uploaded).
 *
 * HARD RULE — deletion is opt-in, never inferred: a page we can't read, can't
 * upload (oversized / invalid path), or truncated past the cap is CARRIED
 * FORWARD at its last-synced state, not turned into a deletion. Only a page
 * that verifiably vanished from a readable vault becomes a delete. Otherwise
 * an append-only log.md crossing the size cap would silently erase itself
 * server-side.
 */

import {
  readdirSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join, relative, sep } from 'node:path';

const SYNC_STATE = '.flowviant-sync.json';
// Mirror the server contract (shared schema) — a page that violates it is
// skipped with a warning (and carried forward if previously synced), never
// allowed to 400 the whole request and wedge the sync.
const MAX_FILE_BYTES = 262_144;
const MAX_PATH_CHARS = 300;
const MAX_FILES = 400;
const CHUNK_FILES = 30;
const CHUNK_BYTES = 700_000;
const MAX_DELETIONS_PER_REQ = 200;

/** Daemon-side mirror of the server's isSafeVaultPath. */
const isSafePath = (p) =>
  p.length > 0 &&
  p.length <= MAX_PATH_CHARS &&
  p.endsWith('.md') &&
  !p.includes('\\') &&
  !p.includes('\0') &&
  !p.startsWith('/') &&
  p.split('/').every((seg) => seg.length > 0 && seg !== '.' && seg !== '..' && !seg.startsWith('.'));

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
  if (walkErrors.count > 0 && found.length === 0) {
    // Vault root (or everything under it) unreadable — nothing to diff against.
    warn(`vault at ${dir} is unreadable — skipping sync; check the vault dir`);
    return { pages: 0, uploaded: 0, deleted: 0, skipped: true };
  }

  // Partition into uploadable pages and carried-forward ones. Carried = we
  // know the page exists (or existed) but can't ship this state — keep the
  // server's last-good copy: tracked in `current` (prev hash) + manifest,
  // never a deletion.
  const current = {}; // path -> sha256 tracked as the post-sync state
  const contents = {}; // path -> markdown to upload (subset of current)
  let prev = {};
  try {
    prev = JSON.parse(readFileSync(join(dir, SYNC_STATE), 'utf8'));
  } catch {
    /* first sync */
  }
  const carry = (p, why) => {
    if (prev[p]) {
      current[p] = prev[p];
      warn(`vault page ${p}: ${why} — keeping the last synced copy`);
    } else {
      warn(`vault page ${p}: ${why} — not synced`);
    }
  };

  let kept = 0;
  for (const p of found) {
    if (!isSafePath(p)) {
      carry(p, 'name violates the sync contract (length/characters)');
      continue;
    }
    if (kept >= MAX_FILES) {
      carry(p, `vault exceeds ${MAX_FILES} pages`);
      continue;
    }
    let text;
    try {
      text = readFileSync(join(dir, p), 'utf8');
    } catch {
      carry(p, 'unreadable');
      continue;
    }
    // Uplink scrub: the cartographer quotes real repo files, and a repo file
    // can contain a synced secret — redact known values before upload. The
    // hash is computed on the SCRUBBED text so the diff state stays coherent.
    text = scrub(text);
    if (Buffer.byteLength(text) > MAX_FILE_BYTES) {
      carry(p, 'exceeds 256KB');
      continue;
    }
    kept++;
    contents[p] = text;
    current[p] = createHash('sha256').update(text).digest('hex');
  }

  // Partial walk (an unreadable SUBdirectory): every previously-synced page the
  // walk failed to reach must be carried forward, not inferred deleted — a
  // transient EMFILE/EACCES on e.g. docs/ must never erase those pages
  // server-side. The hard rule: deletion is opt-in, never inferred.
  if (walkErrors.count > 0) {
    warn(
      `vault walk hit ${walkErrors.count} unreadable director${walkErrors.count === 1 ? 'y' : 'ies'} — carrying missing pages forward, no deletions this pass`
    );
    for (const p of Object.keys(prev)) {
      if (!(p in current)) current[p] = prev[p];
    }
  }

  // A readable vault that suddenly presents ZERO pages while the server holds
  // many is almost always a broken/moved dir, not an intentional wipe — refuse
  // to mass-delete. (An intentional reset is a fresh Regenerate: the sweep
  // rewrites pages, then finalize prunes precisely.)
  const prevCount = Object.keys(prev).length;
  if (Object.keys(current).length === 0 && prevCount > 0) {
    warn(`vault at ${dir} presents 0 pages but ${prevCount} were synced — refusing to delete; check the vault dir`);
    return { pages: 0, uploaded: 0, deleted: 0, skipped: true };
  }

  const changed = Object.keys(current).filter((p) => p in contents && prev[p] !== current[p]);
  const deletions = Object.keys(prev).filter((p) => !(p in current));
  const pages = Object.keys(current).length;
  if (changed.length === 0 && deletions.length === 0 && !finalize) {
    return { pages, uploaded: 0, deleted: 0, skipped: true };
  }

  // Finalize manifests are schema-capped server-side at MAX_FILES; carried
  // pages can push the tracked set past it. Downgrade to a plain merge (no
  // prune) rather than wedge the whole sync on a 400 — nothing is lost, the
  // regen request stays pending, and the warning names the cause.
  let doFinalize = !!finalize;
  if (doFinalize && pages > MAX_FILES) {
    warn(`vault tracks ${pages} pages (> ${MAX_FILES}) — skipping the finalize prune this pass`);
    doFinalize = false;
  }

  // Build the request series: file chunks (count+byte capped), then however
  // many deletion batches the 200-cap needs. finalize/sha ride the LAST
  // request only, so the server prunes exactly once, after every upsert landed.
  const fileChunks = [];
  let cur = [];
  let bytes = 0;
  for (const p of changed) {
    const size = Buffer.byteLength(contents[p]);
    if (cur.length && (cur.length >= CHUNK_FILES || bytes + size > CHUNK_BYTES)) {
      fileChunks.push(cur);
      cur = [];
      bytes = 0;
    }
    cur.push(p);
    bytes += size;
  }
  if (cur.length) fileChunks.push(cur);

  const requests = fileChunks.map((paths) => ({ files: paths.map((p) => ({ path: p, content: contents[p] })), deletions: [] }));
  for (let i = 0; i < deletions.length; i += MAX_DELETIONS_PER_REQ) {
    requests.push({ files: [], deletions: deletions.slice(i, i + MAX_DELETIONS_PER_REQ) });
  }
  if (requests.length === 0) requests.push({ files: [], deletions: [] }); // finalize-only

  for (let i = 0; i < requests.length; i++) {
    const last = i === requests.length - 1;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'User-Agent': userAgent,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(60_000),
      body: JSON.stringify({
        ...requests[i],
        ...(last && doFinalize ? { finalize: { manifest: Object.keys(current) } } : {}),
        ...(last && groundedAtSha ? { groundedAtSha } : {}),
        ...(last && repoFullName ? { repoFullName } : {}),
      }),
    });
    if (!res.ok) throw new Error(`wiki-vault sync failed (${res.status})`);
  }

  writeFileSync(join(dir, SYNC_STATE), JSON.stringify(current));
  commitVault(dir, doFinalize ? `sweep${groundedAtSha ? ` @ ${groundedAtSha.slice(0, 7)}` : ''}` : `update${groundedAtSha ? ` @ ${groundedAtSha.slice(0, 7)}` : ''}`);
  return { pages, uploaded: changed.length, deleted: deletions.length };
}
