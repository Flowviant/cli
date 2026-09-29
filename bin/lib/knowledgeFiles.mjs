/**
 * THE KNOWLEDGE LIBRARY ON DISK (2026-09-26, split out of knowledge.mjs —
 * SOLID SRP, F049): making `<checkout>/.flowviant/knowledge/` match a manifest,
 * the rev marker beside it, and the two questions the driver asks the disk
 * before it skips a same-rev roster (`libraryMissing`, `libraryStale`). The
 * bytes arrive through an injected `fetchFile`, so nothing here knows the
 * transport; the names and paths are knowledgeLibrary.mjs's, and each file is
 * fetched-and-verified by knowledgeFileSync.mjs's one loop. Why a sync does
 * what it does — the three states of the key, the failed download that does
 * not advance the rev — is argued in knowledge.mjs's header.
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { isCurrent, localSha, syncVerifiedFile, writeAtomic } from './knowledgeFileSync.mjs';
import {
  INSTRUCTIONS_FILE,
  KNOWLEDGE_DIR,
  KNOWLEDGE_FILE_MAX_BYTES,
  LIBRARY_DIRS,
  LIBRARY_FILE,
  MAX_FILES,
  knowledgeMaxFor,
  libraryItemsOf,
  planKnowledgeNames,
  renderLibraryCatalog,
} from './knowledgeLibrary.mjs';

/** The rev last materialised — OUTSIDE the directory the prompt hands the CLI,
 *  so the agent listing its library sees only the library. */
const MARKER = '.flowviant/knowledge.rev';

/**
 * Is `<checkout>/.flowviant` a real directory, or absent? Anything else — a
 * symlink, a regular file — REFUSES the sync rather than being touched.
 *
 * `.flowviant/` is not only ours: a repo declares `.flowviant/check.json` and
 * `.flowviant/deploy.json` there, and an operator may have arranged it however
 * they like. Deleting a file or a link at that path to make room for a library
 * would be Flowviant destroying something it did not create; following a link
 * would land downloads, and the emptied library's `rm -r`, wherever it points.
 * So the parent is checked, never repaired.
 */
function flowviantDirOk(checkoutDir) {
  try {
    const st = lstatSync(join(checkoutDir, '.flowviant'));
    return st.isDirectory() && !st.isSymbolicLink();
  } catch {
    return true; // absent — ours to create
  }
}

/** The library directory, as a real directory. The PARENT is checked by the
 *  caller; the library path itself is OURS, so a symlink or a file planted
 *  there is removed (unlinked — the link, never its target) rather than
 *  followed. */
function ensureDir(checkoutDir) {
  const dir = join(checkoutDir, KNOWLEDGE_DIR);
  try {
    const st = lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) unlinkSync(dir);
  } catch {
    /* absent */
  }
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * THE MARKER SAYS WHICH REV WAS WRITTEN, AND WHETHER THE LIBRARY WAS PART OF
 * IT (2026-09-23): `<rev>` or `<rev>:lib`.
 *
 * The rev alone could not tell an upgrade from a sync. A 0.96.0 box wrote the
 * marker for rev N while ignoring the manifest's `library` key (it did not
 * know one); updated to 0.97.0 with `knowledge_rev` still N, it read "N",
 * matched the roster, and never synced the library — then the server handed
 * `task.references` naming `designs/x-v1.html` and the agent was told to read
 * a file that was not there. `:lib` records that THIS rev's sync carried a
 * library key, so the upgrade case is one string compare and re-syncs at
 * once. An older daemon reading `N:lib` sees NaN and re-syncs once, which is
 * the harmless direction.
 */
function parseMarker(checkoutDir) {
  try {
    const m = /^(\d+)(:lib)?$/.exec(readFileSync(join(checkoutDir, MARKER), 'utf8').trim());
    if (!m) return null;
    const n = Number(m[1]);
    return Number.isSafeInteger(n) ? { rev: n, lib: Boolean(m[2]) } : null;
  } catch {
    return null;
  }
}

export function readKnowledgeMarker(checkoutDir) {
  return parseMarker(checkoutDir)?.rev ?? null;
}

/** Did the sync that wrote the marker carry a `library` key? */
export function knowledgeMarkerHasLibrary(checkoutDir) {
  return parseMarker(checkoutDir)?.lib ?? false;
}

export function writeKnowledgeMarker(checkoutDir, rev, lib = false) {
  try {
    mkdirSync(join(checkoutDir, '.flowviant'), { recursive: true });
    writeAtomic(join(checkoutDir, MARKER), `${rev}${lib ? ':lib' : ''}\n`);
  } catch {
    /* a lost marker costs one re-sync after a restart — every file already on
       disk matches by sha and is not downloaded again */
  }
}

/** A library subdirectory as a real directory — ours, like the library's own
 *  path: a symlink or a file planted there is removed, never followed. */
function ensureSubdir(dir, name) {
  const path = join(dir, name);
  try {
    const st = lstatSync(path);
    if (st.isSymbolicLink() || !st.isDirectory()) unlinkSync(path);
  } catch {
    /* absent */
  }
  mkdirSync(path, { recursive: true });
  return path;
}

function ensureLibraryParents(dir, relativePath) {
  const parts = relativePath.split('/');
  let at = dir;
  for (const part of parts.slice(0, -1)) at = ensureSubdir(at, part);
}

function sweepLibraryTree(dir, sub, wanted, result) {
  const walk = (at, prefix = '') => {
    let entries;
    try { entries = readdirSync(at); } catch { return; }
    for (const name of entries) {
      const rel = prefix ? `${prefix}/${name}` : name;
      const path = join(at, name);
      let st;
      try { st = lstatSync(path); } catch { continue; }
      if (st.isDirectory() && !st.isSymbolicLink()) {
        walk(path, rel);
        try { if (readdirSync(path).length === 0) rmSync(path, { recursive: true, force: true }); } catch { /* next sync */ }
      } else if (!wanted.has(rel)) {
        try { rmSync(path, { recursive: true, force: true }); result.removed.push(`${sub}/${rel}`); } catch { /* next sync */ }
      }
    }
  };
  walk(join(dir, sub));
};

/**
 * Make `<checkoutDir>/.flowviant/knowledge/` match `manifest`.
 *
 * `fetchFile(id)` returns the file's bytes as a Buffer, or throws. Injected so
 * the sync is testable against a temp directory and a fake server; the daemon
 * hands the `/fleet/knowledge/:id` fetch.
 *
 * @returns {{ ok: boolean, wrote: string[], removed: string[], refused: string[], failed: string[] }}
 *   `ok` is false when any download FAILED (to be retried); a file REFUSED for
 *   size is permanent for this rev and does not clear `ok`.
 */
export async function syncKnowledge({ checkoutDir, manifest, fetchFile, maxBytes = KNOWLEDGE_FILE_MAX_BYTES }) {
  const result = { ok: true, wrote: [], removed: [], refused: [], failed: [] };
  const dirPath = join(checkoutDir, KNOWLEDGE_DIR);
  const files = (manifest.files ?? [])
    .filter((f) => f && typeof f.id === 'string' && /^[0-9a-f-]{8,64}$/i.test(f.id))
    .slice(0, MAX_FILES);
  const instructions =
    typeof manifest.instructions === 'string' && manifest.instructions.trim()
      ? manifest.instructions
      : null;
  // null = the key is ABSENT (leave the library's paths alone); [] = emptied.
  const library = libraryItemsOf(manifest);

  if (!flowviantDirOk(checkoutDir)) {
    // Not a failure to retry every poll — nothing changes until a person
    // changes it — but not a success either: the rev must not advance over a
    // library that was never written.
    result.ok = false;
    result.failed.push('.flowviant (not a directory — left untouched)');
    return result;
  }

  // EMPTIED: the directory goes, and the prompt paragraph with it — unless the
  // library key is ABSENT and a synced library is on disk, which an older
  // server's emptied shelf has no say over.
  const libraryOnDisk =
    library === null &&
    [LIBRARY_FILE, ...Object.values(LIBRARY_DIRS)].some((n) => existsSync(join(dirPath, n)));
  if (files.length === 0 && !instructions && (library === null ? !libraryOnDisk : library.length === 0)) {
    if (existsSync(dirPath)) {
      try {
        const st = lstatSync(dirPath);
        if (st.isSymbolicLink()) unlinkSync(dirPath);
        else rmSync(dirPath, { recursive: true, force: true });
        result.removed.push(KNOWLEDGE_DIR);
      } catch {
        result.ok = false;
      }
    }
    return result;
  }

  const dir = ensureDir(checkoutDir);
  const planned = planKnowledgeNames(files);
  const keep = new Set(planned.map((p) => p.local));
  if (instructions) keep.add(INSTRUCTIONS_FILE);
  // ABSENT library key: its paths are neither synced nor swept.
  if (library === null) {
    keep.add(LIBRARY_FILE);
    for (const d of Object.values(LIBRARY_DIRS)) keep.add(d);
  }

  for (const f of planned) {
    // One verified-file rule for every kind the sync fetches — see
    // knowledgeFileSync.mjs for the five states.
    const state = await syncVerifiedFile({
      path: join(dir, f.local),
      sha256: f.sha256,
      bytes: f.bytes,
      maxBytes: knowledgeMaxFor(f.name, maxBytes),
      fetch: () => fetchFile(f.id),
    });
    if (state === 'refused') {
      // Permanent for this rev, and NOT a reason to delete the rest. Any stale
      // local copy under this name goes, because it is not the file the
      // manifest now names.
      result.refused.push(f.local);
      keep.delete(f.local);
    } else if (state === 'wrote') {
      result.wrote.push(f.local);
    } else if (!isCurrent(state)) {
      // A stale file is better than a missing one until the retry lands.
      result.ok = false;
      result.failed.push(f.local);
    }
  }

  if (instructions) {
    const path = join(dir, INSTRUCTIONS_FILE);
    const body = instructions.endsWith('\n') ? instructions : `${instructions}\n`;
    let same = false;
    try {
      same = lstatSync(path).isFile() && readFileSync(path, 'utf8') === body;
    } catch {
      /* absent */
    }
    if (!same) {
      writeAtomic(path, body);
      result.wrote.push(INSTRUCTIONS_FILE);
    }
  }

  if (library !== null) {
    await syncLibrary({ dir, items: library, fetchFile, maxBytes, keep, result });
  }

  // Everything the manifest no longer names — files, stray temp names, and
  // anything that is not a regular file — leaves.
  let entries = [];
  try {
    entries = readdirSync(dir);
  } catch {
    entries = [];
  }
  for (const name of entries) {
    if (keep.has(name)) continue;
    try {
      rmSync(join(dir, name), { recursive: true, force: true });
      result.removed.push(name);
    } catch {
      /* best-effort; the next sync tries again */
    }
  }
  return result;
}

/**
 * THE KEPT LIBRARY'S HALF OF A SYNC: each item into its subdirectory (fetched
 * only when its sha differs, written atomically, the bytes checked against the
 * manifest), every other entry in the library subdirectories removed, and
 * `LIBRARY.md` regenerated from the items that are on disk AS THE MANIFEST
 * NAMES THEM — the entry and every bundle file current (`isCurrent`,
 * knowledgeFileSync.mjs). A download that fails keeps whatever copy was there
 * and clears `ok`, the file rule, but that stale copy is not catalogued; an
 * item over the cap is refused for this rev and left out of the catalog.
 */
async function syncLibrary({ dir, items, fetchFile, maxBytes, keep, result }) {
  // One set per library folder, from the one table — a fourth folder added
  // there is synced and swept here with no second list to miss.
  const wanted = Object.fromEntries(Object.values(LIBRARY_DIRS).map((d) => [d, new Set()]));
  const onDisk = [];
  for (const kind of Object.keys(LIBRARY_DIRS)) {
    if (items.some((it) => it.kind === kind)) {
      ensureSubdir(dir, LIBRARY_DIRS[kind]);
      keep.add(LIBRARY_DIRS[kind]);
    }
  }
  for (const it of items) {
    const [sub, ...tail] = it.path.split('/');
    const file = tail.join('/');
    const path = join(dir, ...it.path.split('/'));
    ensureLibraryParents(dir, it.path);
    const itemMax = knowledgeMaxFor(it.path, maxBytes);
    wanted[sub].add(file);
    if (it.previewPath) wanted[sub].add(it.previewPath.split('/').slice(1).join('/'));
    if (it.previewUnknown) {
      const oldPng = file.includes('/') ? `${file.slice(0, file.lastIndexOf('/'))}/preview.png` : file.replace(/\.html$/, '.png');
      if (localSha(join(dir, sub, ...oldPng.split('/'))) !== null) wanted[sub].add(oldPng);
    }
    // THE ENTRY. Catalogued only when it IS the manifest's file — a stale
    // copy kept through a failed fetch stays on disk, but is not listed as
    // current (the defect this split fixed: any file at the path was).
    const entryState = await syncVerifiedFile({
      path,
      sha256: it.sha256,
      bytes: it.bytes,
      maxBytes: itemMax,
      fetch: () => fetchFile(it.id, { library: true }),
      beforeWrite: () => ensureLibraryParents(dir, it.path),
    });
    if (entryState === 'refused') {
      result.refused.push(it.path);
      wanted[sub].delete(file);
      continue;
    }
    if (entryState === 'wrote') result.wrote.push(it.path);
    else if (!isCurrent(entryState)) {
      result.ok = false;
      result.failed.push(it.path);
    }
    let complete = isCurrent(entryState);
    // THE PREVIEW: measured by the server, ours to cap — an oversized one is
    // a failure to retry, never a refusal. Not required for the catalog: the
    // entry reads the same without its picture.
    if (it.previewPath && it.preview?.sha256) {
      ensureLibraryParents(dir, it.previewPath);
      const previewState = await syncVerifiedFile({
        path: join(dir, ...it.previewPath.split('/')),
        sha256: it.preview.sha256,
        maxBytes: 2 * 1024 * 1024,
        oversizeFails: true,
        fetch: () => fetchFile(it.id, { library: true, preview: true }),
        beforeWrite: () => ensureLibraryParents(dir, it.previewPath),
      });
      if (previewState === 'wrote') result.wrote.push(it.previewPath);
      else if (!isCurrent(previewState)) {
        result.ok = false;
        result.failed.push(it.previewPath);
      }
    }
    // THE BUNDLE'S SIDECARS are REQUIRED: a design whose model failed to land
    // is not a complete current design, so it is not catalogued as one. The hash
    // is always compared (`String(...)`), so a manifest file without one fails
    // verification, as it always did.
    for (const f of it.files ?? []) {
      ensureLibraryParents(dir, f.path);
      const rel = f.path.split('/').slice(1).join('/');
      wanted[sub].add(rel);
      const fileState = await syncVerifiedFile({
        path: join(dir, ...f.path.split('/')),
        sha256: String(f.sha256),
        bytes: f.bytes,
        maxBytes: knowledgeMaxFor(f.path, maxBytes),
        fetch: () => fetchFile(it.id, { library: true, fileIndex: f.index }),
        beforeWrite: () => ensureLibraryParents(dir, f.path),
      });
      if (fileState === 'refused') {
        result.refused.push(f.path);
        wanted[sub].delete(rel);
      } else if (fileState === 'wrote') result.wrote.push(f.path);
      else if (!isCurrent(fileState)) {
        result.ok = false;
        result.failed.push(f.path);
      }
      // A REFUSED sidecar is permanent for this rev and said in `refused`, the
      // way `libraryStale` already stops expecting it — blocking the catalog on
      // it would leave LIBRARY.md missing and re-sync the rev every poll.
      if (fileState === 'stale' || fileState === 'failed') complete = false;
    }
    if (complete) onDisk.push(it);
  }
  // Each subdirectory holds exactly what the manifest names.
  for (const sub of Object.values(LIBRARY_DIRS)) {
    const subPath = join(dir, sub);
    try { if (!lstatSync(subPath).isDirectory()) continue; } catch { continue; }
    sweepLibraryTree(dir, sub, wanted[sub], result);
    // An emptied subdirectory leaves with its last item.
    if (wanted[sub].size === 0) keep.delete(sub);
  }
  const catalog = renderLibraryCatalog(onDisk);
  if (catalog) {
    keep.add(LIBRARY_FILE);
    const path = join(dir, LIBRARY_FILE);
    let same = false;
    try {
      same = lstatSync(path).isFile() && readFileSync(path, 'utf8') === catalog;
    } catch {
      /* absent */
    }
    if (!same) {
      writeAtomic(path, catalog);
      result.wrote.push(LIBRARY_FILE);
    }
  }
}

/**
 * The absolute library path, or null when there is nothing there for a turn
 * to read. The prompt paragraph is rendered only when this is non-null, so a
 * project with no library costs the prompt nothing.
 */
export function knowledgeDirFor(checkoutDir) {
  if (!checkoutDir || !flowviantDirOk(checkoutDir)) return null;
  const dir = join(checkoutDir, KNOWLEDGE_DIR);
  try {
    if (!lstatSync(dir).isDirectory()) return null;
    return readdirSync(dir).length > 0 ? dir : null;
  } catch {
    return null;
  }
}

/** Does the manifest name something the disk no longer has a directory for?
 *  An EMPTIED manifest over no directory is the synced state, not a loss. */
export function libraryMissing(checkoutDir, manifest) {
  const named =
    (Array.isArray(manifest.files) && manifest.files.length > 0) ||
    (typeof manifest.instructions === 'string' && manifest.instructions.trim() !== '') ||
    (Array.isArray(manifest.library?.items) && manifest.library.items.length > 0);
  if (!named) return false;
  try {
    lstatSync(join(checkoutDir, KNOWLEDGE_DIR));
    return false;
  } catch {
    return true;
  }
}

/**
 * Does the manifest name LIBRARY items the disk no longer holds — or a library
 * this box never synced at all? The same-rev skip's second question, beside
 * `libraryMissing`'s "is the directory there".
 *
 * `synced` is the marker's `:lib` (or the driver's memory of it): false means
 * the rev on the marker was written by a sync that ignored the library, the
 * 0.96.0-to-0.97.0 upgrade. Otherwise every named item's path AND `LIBRARY.md`
 * must be regular files — a hand-deleted `designs/`, or one item removed, is a
 * re-sync, and the files still on disk match by hash and are not fetched
 * again. Items the manifest itself puts over the cap, and items this driver
 * already saw refused for this rev, are not expected: a refusal is permanent
 * for the rev, and expecting it would re-fetch ten megabytes every poll.
 * An ABSENT `library` key expects nothing (an older server has no say).
 */
export function libraryStale(checkoutDir, manifest, { synced, refused }) {
  const items = libraryItemsOf(manifest);
  if (items === null) return false;
  if (!synced) return true;
  const expected = items.filter((it) => !(Number(it.bytes) > knowledgeMaxFor(it.path, KNOWLEDGE_FILE_MAX_BYTES)) && !refused.has(it.path));
  if (expected.length === 0) return false;
  const dir = join(checkoutDir, KNOWLEDGE_DIR);
  const isFile = (p) => {
    try {
      let parent = dir;
      for (const part of p.slice(dir.length + 1).split('/').slice(0, -1)) {
        parent = join(parent, part);
        const st = lstatSync(parent);
        if (st.isSymbolicLink() || !st.isDirectory()) return false;
      }
      return lstatSync(p).isFile();
    } catch {
      return false;
    }
  };
  if (!isFile(join(dir, LIBRARY_FILE))) return true;
  return expected.some((it) => !isFile(join(dir, ...it.path.split('/'))) ||
    (it.previewPath && !refused.has(it.previewPath) && !isFile(join(dir, ...it.previewPath.split('/')))) ||
    (it.files ?? []).some((f) => !refused.has(f.path) && !isFile(join(dir, ...f.path.split('/')))));
}
