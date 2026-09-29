/**
 * ONE VERIFIED FILE, FETCHED ONLY WHEN IT DIFFERS (2026-09-26, split out of
 * knowledge.mjs — SOLID F003).
 *
 * The knowledge sync downloads four kinds of file — shelf entries, kept
 * library entries, their previews and a design bundle's sidecar files — and it
 * had four hand-written download-and-verify loops that disagreed about the one
 * question the catalog asks: IS THIS FILE THE ONE THE MANIFEST NAMES? The kept
 * entry's loop, on a failed download, catalogued any file that happened to be
 * at the path (`localSha(path) !== null`) without matching it to the manifest
 * hash — so `LIBRARY.md` could advertise a stale entry, or a design whose
 * bundle files never landed, as current.
 *
 * `syncVerifiedFile` is the one loop, and its answer is a STATE rather than a
 * boolean, so the caller cannot collapse the difference:
 *
 *   current  — the file on disk already matches the manifest hash; not fetched
 *   wrote    — fetched, verified against the hash, written atomically
 *   refused  — over its cap (declared or delivered): permanent for this rev
 *   stale    — the fetch failed and an OLDER copy stays on disk (a stale file
 *              is better than a missing one until the retry lands — but it is
 *              not the manifest's file, and is never catalogued as one)
 *   failed   — the fetch failed and nothing is on disk
 *
 * The retry semantics are the callers' as before: `stale`/`failed` clear the
 * sync's `ok` and the driver backs off and tries again. A missing manifest
 * hash cannot be `current` (nothing to match), so such a file is always
 * fetched, exactly as the shelf always did.
 */

import { lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

export const sha256Of = (buf) => createHash('sha256').update(buf).digest('hex');

/** A regular file's sha256, or null for anything else (missing, a directory, a
 *  symlink — a symlink is never followed, so it is never "the same file"). */
export function localSha(path) {
  try {
    const st = lstatSync(path);
    if (!st.isFile()) return null;
    return sha256Of(readFileSync(path));
  } catch {
    return null;
  }
}

/** Write through a temp name and rename, so a CLI reading the library mid-sync
 *  sees the old file or the new one, never half of one. Anything already at
 *  the path that is NOT a regular file (a symlink planted there) is removed
 *  first — `writeFileSync` would otherwise follow it and write wherever it
 *  pointed. */
export function writeAtomic(path, data) {
  try {
    const st = lstatSync(path);
    if (!st.isFile()) rmSync(path, { recursive: true, force: true });
  } catch {
    /* absent — the ordinary case */
  }
  const tmp = `${path}.fvtmp`;
  // THE TEMP NAME IS CHECKED TOO (2026-09-23). The first cut guarded the
  // destination and then wrote straight through `<name>.fvtmp` — a link planted
  // THERE would have been followed, the library's bytes written wherever it
  // pointed, and the link renamed into place. Unlinked first, then created
  // EXCLUSIVELY (`wx`): if anything reappears at the name between the two, the
  // write throws into the caller's catch rather than following it.
  rmSync(tmp, { recursive: true, force: true });
  writeFileSync(tmp, data, { flag: 'wx' });
  renameSync(tmp, path);
}

/** A state the manifest's file is on disk in — the only states a catalog may
 *  list. */
export const isCurrent = (state) => state === 'current' || state === 'wrote';

/**
 * Make `path` hold the manifest's file.
 *
 * @param {object} o
 * @param {string} o.path          where it lives
 * @param {string|undefined} o.sha256  the manifest hash; absent = always fetch
 * @param {number|undefined} o.bytes   the manifest's declared size; over `maxBytes` refuses unfetched
 * @param {number} o.maxBytes      the ceiling for this file
 * @param {() => Promise<Buffer>} o.fetch  the bytes, or a throw
 * @param {boolean} [o.oversizeFails]  an over-cap DELIVERY is a failure to retry
 *   rather than a refusal (a preview: its cap is ours, not the manifest's)
 * @param {() => void} [o.beforeWrite] makes the parent directories real, right before the write
 * @returns {Promise<'current'|'wrote'|'refused'|'stale'|'failed'>}
 */
export async function syncVerifiedFile({ path, sha256, bytes, maxBytes, fetch, oversizeFails = false, beforeWrite = () => {} }) {
  if (Number(bytes) > maxBytes) return 'refused';
  const want = typeof sha256 === 'string' ? sha256.toLowerCase() : null;
  if (want !== null && localSha(path) === want) return 'current';
  try {
    const buf = await fetch();
    if (!Buffer.isBuffer(buf) || buf.byteLength > maxBytes) {
      if (oversizeFails) throw new Error('over the cap');
      return 'refused';
    }
    // The bytes must BE the file the manifest names. A mismatch is a failure
    // to retry, never a file to trust. Keyed on the TYPE, not truthiness: an
    // empty-string hash is a hash no bytes match, so it fails as every copy
    // this replaced did — only an ABSENT hash skips the check.
    if (want !== null && sha256Of(buf) !== want) throw new Error('sha256 mismatch');
    beforeWrite();
    writeAtomic(path, buf);
    return 'wrote';
  } catch {
    // Keep whatever copy is there — but say it is not the manifest's.
    return localSha(path) !== null ? 'stale' : 'failed';
  }
}
