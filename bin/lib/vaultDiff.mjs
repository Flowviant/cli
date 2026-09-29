/**
 * WHAT A VAULT SYNC SENDS — the pure planner behind syncVault (2026-09-26,
 * SOLID F063).
 *
 * Split out of vault.mjs, where the deletion and carry-forward policy sat
 * inside the walk, the POSTs and the state write, so its central rule could
 * only be driven by building files and intercepting the network. This module
 * decides; vault.mjs walks the directory, reads the prior state, POSTs the
 * planned requests in order, and advances the state only after every one
 * lands.
 *
 * HARD RULE — deletion is opt-in, never inferred: a page we can't read, can't
 * upload (oversized / invalid path), or truncated past the cap is CARRIED
 * FORWARD at its last-synced state, not turned into a deletion. Only a page
 * that verifiably vanished from a readable vault becomes a delete. Otherwise
 * an append-only log.md crossing the size cap would silently erase itself
 * server-side.
 */

import { createHash } from 'node:crypto';

// Mirror the server contract (shared schema) — a page that violates it is
// skipped with a warning (and carried forward if previously synced), never
// allowed to 400 the whole request and wedge the sync.
export const MAX_FILE_BYTES = 262_144;
const MAX_PATH_CHARS = 300;
export const MAX_FILES = 400;
export const CHUNK_FILES = 30;
export const CHUNK_BYTES = 700_000;
export const MAX_DELETIONS_PER_REQ = 200;

/** Daemon-side mirror of the server's isSafeVaultPath. */
export const isSafePath = (p) =>
  p.length > 0 &&
  p.length <= MAX_PATH_CHARS &&
  p.endsWith('.md') &&
  !p.includes('\\') &&
  !p.includes('\0') &&
  !p.startsWith('/') &&
  p.split('/').every((seg) => seg.length > 0 && seg !== '.' && seg !== '..' && !seg.startsWith('.'));

const SKIPPED = Object.freeze({ pages: 0, uploaded: 0, deleted: 0, skipped: true });

/**
 * Plan one sync.
 *
 *  found        vault-relative .md paths the walk discovered, sorted
 *  walkErrors   how many directories the walk could not read
 *  prev         path -> sha256 of the last successful sync ({} on the first)
 *  read(p)      the page's markdown, or null when it cannot be read
 *  scrub        uplink redaction, applied before hashing
 *  finalize, groundedAtSha, repoFullName   ride the LAST request only
 *
 * Returns `{ warnings, result }` when nothing is sent (result is syncVault's
 * return), else `{ warnings, requests, state, finalized, pages, uploaded,
 * deleted }` — `requests` are the POST bodies in order, `state` the hashes to
 * write once every one has landed.
 */
export function planVaultSync({ found, walkErrors = 0, prev = {}, read, scrub = (t) => t, finalize = false, groundedAtSha, repoFullName, dir = 'the vault' }) {
  const warnings = [];
  if (walkErrors > 0 && found.length === 0) {
    // Vault root (or everything under it) unreadable — nothing to diff against.
    warnings.push(`vault at ${dir} is unreadable — skipping sync; check the vault dir`);
    return { warnings, result: { ...SKIPPED } };
  }

  // Partition into uploadable pages and carried-forward ones. Carried = we
  // know the page exists (or existed) but can't ship this state — keep the
  // server's last-good copy: tracked in `current` (prev hash) + manifest,
  // never a deletion.
  const current = {}; // path -> sha256 tracked as the post-sync state
  const contents = {}; // path -> markdown to upload (subset of current)
  const carry = (p, why) => {
    if (prev[p]) {
      current[p] = prev[p];
      warnings.push(`vault page ${p}: ${why} — keeping the last synced copy`);
    } else {
      warnings.push(`vault page ${p}: ${why} — not synced`);
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
    let text = read(p);
    if (text == null) {
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
  if (walkErrors > 0) {
    warnings.push(
      `vault walk hit ${walkErrors} unreadable director${walkErrors === 1 ? 'y' : 'ies'} — carrying missing pages forward, no deletions this pass`
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
    warnings.push(`vault at ${dir} presents 0 pages but ${prevCount} were synced — refusing to delete; check the vault dir`);
    return { warnings, result: { ...SKIPPED } };
  }

  const changed = Object.keys(current).filter((p) => p in contents && prev[p] !== current[p]);
  const deletions = Object.keys(prev).filter((p) => !(p in current));
  const pages = Object.keys(current).length;
  if (changed.length === 0 && deletions.length === 0 && !finalize) {
    return { warnings, result: { pages, uploaded: 0, deleted: 0, skipped: true } };
  }

  // Finalize manifests are schema-capped server-side at MAX_FILES; carried
  // pages can push the tracked set past it. Downgrade to a plain merge (no
  // prune) rather than wedge the whole sync on a 400 — nothing is lost, the
  // regen request stays pending, and the warning names the cause.
  let doFinalize = !!finalize;
  if (doFinalize && pages > MAX_FILES) {
    warnings.push(`vault tracks ${pages} pages (> ${MAX_FILES}) — skipping the finalize prune this pass`);
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

  const last = requests.length - 1;
  requests[last] = {
    ...requests[last],
    ...(doFinalize ? { finalize: { manifest: Object.keys(current) } } : {}),
    ...(groundedAtSha ? { groundedAtSha } : {}),
    ...(repoFullName ? { repoFullName } : {}),
  };

  return { warnings, requests, state: current, finalized: doFinalize, pages, uploaded: changed.length, deleted: deletions.length };
}
