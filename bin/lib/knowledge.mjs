/**
 * PROJECT KNOWLEDGE, daemon side (2026-09-22, 0.94.0) — the library a person
 * keeps for their own Claude, materialised where a CLI can read it.
 *
 * The owner asked whether the Workbench could be "a clone of claude projects":
 * files uploaded once and a standing Instructions text, read by every turn on
 * the project. The server holds the bytes; the roster carries a MANIFEST
 * (`knowledge: { rev, instructions, files: [{ id, name, bytes, sha256 }] }`);
 * this module makes `<checkout>/.flowviant/knowledge/` match it, and the turn
 * prompts name that directory. Nothing here reads a file's CONTENTS for any
 * purpose but writing it — the only brain is the CLI, reading off a disk.
 *
 * ── ONE COPY PER BOX, IN THE CHECKOUT ──
 *
 * Not per worktree. Every session, capture and agent turn on this box runs in
 * some directory under the same user, and every one of them can read an
 * ABSOLUTE path; a copy per worktree would be a copy per agent, fifty megabytes
 * times however many agents are open, and N copies that can each go stale on
 * their own. The prompt hands the absolute path.
 *
 * It is never committed: its paths (`FLOWVIANT_OWN_PATHS` — never the whole
 * `.flowviant/`, 2026-09-23) are written to the exclude file git actually
 * reads (`excludeInWorktree`, which resolves `--git-common-dir`, so one call
 * covers the checkout and every linked worktree alike). An untracked
 * `.flowviant/` in the checkout would make the operator's own `git status`
 * dirty and, for a tab standing in the checkout, show the library in the
 * rail's diffstat as session changes.
 *
 * ── THE THREE STATES OF THE ROSTER KEY ──
 *
 *   ABSENT — an older server, a project that never had knowledge, or a daemon
 *     below the floor (it never sees this code). LEAVE THE DIRECTORY ALONE. An
 *     absence is what an older server says on every poll; letting it mean
 *     "delete the library" would wipe it on a server rollback.
 *   `{ rev, files: [], instructions: null }` — the project HAD knowledge and
 *     the person emptied it. The server sends this for as long as the
 *     project's rev is above zero (forever after the first write), so emptying
 *     is SAID, never inferred. The directory is removed, and with it the
 *     prompt paragraph — which is rendered only while the directory exists.
 *   non-empty — sync to it.
 *
 * ── WHAT A SYNC DOES ──
 *
 * When `rev` differs from the last one materialised (held in memory AND in a
 * marker file beside the directory, so a restart does not re-sync a library
 * that is already on disk): download each file whose sha256 differs from the
 * local copy — a local copy somebody edited by hand is restored, because the
 * library is the server's and the directory is its mirror; delete every
 * regular file the manifest no longer names; write or remove INSTRUCTIONS.md.
 *
 * A FAILED DOWNLOAD DOES NOT ADVANCE THE REV. The next poll tries again — but
 * only the files that still differ, and on a widening backoff, so a server
 * that 500s one file cannot make this box re-download fifty megabytes every
 * ten seconds. A file refused on SIZE is not a failure to retry: it is
 * permanent for that rev, skipped with a warning, and the rest of the library
 * is written.
 *
 * ── THE KEPT LIBRARY (2026-09-23, 0.97.0) ──
 *
 * The manifest may carry `library: { items: [...] }` — the designs and
 * write-ups the project KEPT when a person accepted them — and each item lands
 * at its own relative path, `designs/<slug>-v<N>.html` or
 * `research/<slug>-v<N>.md`, with a generated `LIBRARY.md` at the root naming
 * every one (path, title, kind, the card that asked for it, the date, what it
 * supersedes). So "implement design A" is an agent opening LIBRARY.md, finding
 * design A, and reading the page.
 *
 * SUBDIRECTORIES, AND EXACTLY TWO. The safe-name rule for a knowledge file
 * forbids every separator; a library item is the one thing allowed ONE, and
 * only after one of the two literal prefixes, with a stem that is already
 * safe and the extension its kind hands back. `..`, a third segment, another
 * prefix, a leading dot — refused, never rewritten, because a rewritten path
 * could collide with another item's real one. The two directories are OURS the
 * way the library directory is: a symlink or a file planted there is removed
 * (the link, never its target) and a real directory made.
 *
 * ABSENT MEANS "LEAVE IT ALONE", the same rule the whole key keeps: a manifest
 * with no `library` key is an older server, and `designs/`, `research/` and
 * `LIBRARY.md` are neither synced nor swept. `library: { items: [] }` is the
 * emptied catalog, SAID — both directories and the catalog go.
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

/** Relative to the checkout, under `.flowviant/` beside the turn uploads and
 *  the artifacts — see `FLOWVIANT_OWN_PATHS` for why that is NOT one exclude
 *  line covering all three. */
export const KNOWLEDGE_DIR = '.flowviant/knowledge';

/**
 * THE PATHS UNDER `.flowviant/` THAT ARE OURS, and the exclude file names these
 * and nothing wider (2026-09-23).
 *
 * The first cut excluded `/.flowviant/` whole, from every place a turn spawns
 * in — the attachment fetch's line, which until this release was written only
 * in repos somebody had attached a file in. But `.flowviant/` is not only ours:
 * the repo DECLARES `.flowviant/check.json` and `.flowviant/deploy.json` there,
 * committed like any other file. An exclude line never hides a TRACKED file,
 * so an existing one was safe — and a NEW one was not: an agent asked to "add a
 * check command" writes `.flowviant/check.json`, its `git add -A` skips it as
 * ignored, the commit lands without it, and `git status` shows nothing to
 * explain why. Writing that line into every worktree on every turn would have
 * made the product's own configuration uncommittable by the product's own
 * agents. So the exclude names the four things this daemon writes there, and a
 * repo's own `.flowviant/*.json` stays ordinary, committable work.
 *
 * (A repo that already carries the old `/.flowviant/` line keeps it — it is in
 * the user's own exclude file, and removing a line we cannot prove we alone
 * wrote is not ours to do.)
 */
export const FLOWVIANT_OWN_PATHS = [
  '.flowviant/knowledge/',
  '.flowviant/knowledge.rev*',
  '.flowviant/artifacts/',
  '.flowviant/uploads/',
];
/** The generated catalog of the kept library, at the knowledge root. Reserved
 *  like INSTRUCTIONS.md: a person's file of that name is suffixed, because the
 *  prompt tells the CLI this one is the catalog. */
export const LIBRARY_FILE = 'LIBRARY.md';
/** The two subdirectories a kept item may live in, by kind. */
export const LIBRARY_DIRS = { design: 'designs', research: 'research' };
const LIBRARY_EXT = { design: '.html', research: '.md' };
/** The server caps a library at 200 items; a longer manifest is cut. */
const MAX_LIBRARY_ITEMS = 256;

/** The person's standing brief, written from the manifest's `instructions`.
 *  A RESERVED name: a library FILE called this gets a suffix, because the
 *  prompt tells the CLI to read this one first and a stranger's file must
 *  never be able to stand in for the person's own words. */
export const INSTRUCTIONS_FILE = 'INSTRUCTIONS.md';
/** The rev last materialised — OUTSIDE the directory the prompt hands the CLI,
 *  so the agent listing its library sees only the library. */
const MARKER = '.flowviant/knowledge.rev';
/** The server's per-file ceiling (`KNOWLEDGE_FILE_MAX_BYTES`), re-checked here:
 *  this is somebody's disk, and one place checking is one deploy away from
 *  zero places — the attachment fetch's own rule. */
export const KNOWLEDGE_FILE_MAX_BYTES = 10 * 1024 * 1024;
/** The manifest is capped at the server (25 files); a manifest longer than
 *  this is not one the product produced, and is cut rather than trusted. */
const MAX_FILES = 64;

/** FNV-1a, 32-bit, as 8 hex — deterministic, so the same long name always maps
 *  to the same stored name. Verbatim against the server's `fnv1a8`
 *  (apps/api/src/routes/sessionsAttachments.routes.ts). */
function fnv1a8(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
/** What counts as an extension worth keeping through a cut. */
const SAFE_EXT_RE = /^[A-Za-z0-9]{1,10}$/;
const SAFE_NAME_MAX = 80;

/**
 * `safeFileName`, verbatim (apps/api/src/routes/sessionsAttachments.routes.ts):
 * drops every path separator, never starts with a dot or a dash, and — since
 * 2026-09-24 — THE EXTENSION SURVIVES A CUT. A bare `slice(0, 80)` truncated
 * an over-long name mid-extension (an 84-character `….html` mockup stored as
 * `….` with an unrecognised type and its bytes discarded), so a long name's
 * stem is now cut and an 8-hex FNV-1a hash of the WHOLE sanitised name is
 * appended before the extension: stable across calls, at most 80 characters,
 * idempotent over its own output, and — the reason it is re-applied here
 * rather than trusted to the server's own pass — byte-identical to what
 * `safeFileName` computes there, so a knowledge file synced under this name
 * and one requested by name later never disagree over the cut.
 */
export function safeKnowledgeName(raw) {
  const clean = String(raw ?? '')
    .split(/[\\/]/)
    .pop()
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/^[.-]+/, '');
  if (!clean) return 'file';
  if (clean.length <= SAFE_NAME_MAX) return clean;
  const dot = clean.lastIndexOf('.');
  const ext = dot > 0 && SAFE_EXT_RE.test(clean.slice(dot + 1)) ? clean.slice(dot + 1) : '';
  const stem = ext ? clean.slice(0, dot) : clean;
  const tag = `-${fnv1a8(clean)}`;
  const room = SAFE_NAME_MAX - tag.length - (ext ? ext.length + 1 : 0);
  return `${stem.slice(0, room)}${tag}${ext ? `.${ext}` : ''}`;
}

/**
 * The LOCAL name each manifest entry is written under, in manifest order.
 * Collisions get a numeric suffix (`spec.md`, `spec-2.md`) — two files a
 * person uploaded with one name are two files, and silently writing one over
 * the other loses one. Deterministic in the manifest's order, so the same
 * manifest always yields the same names and a re-sync never renames a file.
 * `INSTRUCTIONS.md` is reserved (compared case-insensitively — macOS and
 * Windows disks are).
 */
export function planKnowledgeNames(files) {
  // The catalog's name and the two library directories are reserved beside
  // the brief (0.97.0): a person's `LIBRARY.md` or a file called `designs`
  // must never stand where the catalog or a directory has to.
  const taken = new Set([
    INSTRUCTIONS_FILE.toLowerCase(),
    LIBRARY_FILE.toLowerCase(),
    ...Object.values(LIBRARY_DIRS),
  ]);
  const out = [];
  for (const f of files) {
    const name = safeKnowledgeName(f.name);
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    let candidate = name;
    for (let n = 2; taken.has(candidate.toLowerCase()); n++) candidate = `${stem}-${n}${ext}`;
    taken.add(candidate.toLowerCase());
    out.push({ ...f, local: candidate });
  }
  return out;
}

const sha256Of = (buf) => createHash('sha256').update(buf).digest('hex');

/** A regular file's sha256, or null for anything else (missing, a directory, a
 *  symlink — a symlink is never followed, so it is never "the same file"). */
function localSha(path) {
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
function writeAtomic(path, data) {
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

function writeKnowledgeMarker(checkoutDir, rev, lib = false) {
  try {
    mkdirSync(join(checkoutDir, '.flowviant'), { recursive: true });
    writeAtomic(join(checkoutDir, MARKER), `${rev}${lib ? ':lib' : ''}\n`);
  } catch {
    /* a lost marker costs one re-sync after a restart — every file already on
       disk matches by sha and is not downloaded again */
  }
}

/**
 * A kept item's relative path, or null when it is not EXACTLY
 * `<designs|research>/<safe stem>.<its kind's extension>` — see the header.
 * Refused rather than rewritten: a rewritten path is one the server never
 * named, and it could land on another item's real one.
 */
export function safeLibraryPath(name, kind) {
  if (typeof name !== 'string' || !(kind in LIBRARY_DIRS)) return null;
  const parts = name.split('/');
  if (parts.length !== 2) return null;
  const [dir, file] = parts;
  if (dir !== LIBRARY_DIRS[kind]) return null;
  if (!file || file !== safeKnowledgeName(file)) return null;
  if (!file.toLowerCase().endsWith(LIBRARY_EXT[kind]) || file.length <= LIBRARY_EXT[kind].length) return null;
  return `${dir}/${file}`;
}

/** The manifest's library items that are safe to write, in manifest order, or
 *  null when the key is ABSENT (an older server — leave everything alone). */
function libraryItemsOf(manifest) {
  const lib = manifest?.library;
  if (lib === undefined || lib === null) return null;
  if (typeof lib !== 'object' || !Array.isArray(lib.items)) return null;
  const out = [];
  const seen = new Set();
  for (const it of lib.items.slice(0, MAX_LIBRARY_ITEMS)) {
    if (!it || typeof it.id !== 'string' || !/^[0-9a-f-]{8,64}$/i.test(it.id)) continue;
    const path = safeLibraryPath(it.name, it.kind);
    if (!path || seen.has(path.toLowerCase())) continue;
    seen.add(path.toLowerCase());
    out.push({ ...it, path });
  }
  return out;
}

/** One line of the catalog: server strings are made single-line and capped —
 *  they are a person's card title and an artifact's name, headed into a file
 *  an agent reads, so they may not carry a line break that forges a second
 *  entry. */
const catalogText = (v, max) =>
  String(v ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

/**
 * THE CATALOG, generated whole from the manifest on every sync:
 *
 *   - designs/landing-v2.html — Landing mockup (design, from card "Redesign
 *     landing page", 2026-09-23, supersedes designs/landing-v1.html)
 *
 * (one line per item, oldest first — the server's order — so a sync that adds
 * one item adds one line and moves nothing). Null when there are no items, in
 * which case the file is removed rather than written empty.
 */
export function renderLibraryCatalog(items) {
  if (!items || items.length === 0) return null;
  const lines = items.map((it) => {
    const facts = [it.kind === 'research' ? 'research' : 'design'];
    const card = catalogText(it.taskTitle, 200);
    if (card) facts.push(`from card "${card.replace(/"/g, "'")}"`);
    const day = typeof it.createdAt === 'string' ? it.createdAt.slice(0, 10) : '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(day)) facts.push(day);
    const sup = typeof it.supersedes === 'string' ? catalogText(it.supersedes, 200) : '';
    if (sup) facts.push(`supersedes ${sup}`);
    const title = catalogText(it.title, 200) || it.path;
    return `- ${it.path} — ${title} (${facts.join(', ')})`;
  });
  return (
    '# Library\n\n' +
    'The designs and research this project kept. Paths are relative to this directory;\n' +
    'a newer version supersedes an older one of the same name.\n\n' +
    `${lines.join('\n')}\n`
  );
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

/** Does this manifest look like one the server produced? Anything else is
 *  ignored whole rather than half-applied. */
export function isKnowledgeManifest(k) {
  return (
    !!k &&
    typeof k === 'object' &&
    Number.isInteger(k.rev) &&
    k.rev >= 0 &&
    (k.instructions === null || k.instructions === undefined || typeof k.instructions === 'string') &&
    Array.isArray(k.files)
  );
}

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
    const path = join(dir, f.local);
    if (Number(f.bytes) > maxBytes) {
      // Permanent for this rev, and NOT a reason to delete the rest. Any stale
      // local copy under this name goes, because it is not the file the
      // manifest now names.
      result.refused.push(f.local);
      keep.delete(f.local);
      continue;
    }
    if (typeof f.sha256 === 'string' && localSha(path) === f.sha256.toLowerCase()) continue;
    try {
      const buf = await fetchFile(f.id);
      if (!Buffer.isBuffer(buf) || buf.byteLength > maxBytes) {
        result.refused.push(f.local);
        keep.delete(f.local);
        continue;
      }
      // The bytes must BE the file the manifest names. A mismatch is a
      // failure to retry, never a file to trust.
      if (typeof f.sha256 === 'string' && sha256Of(buf) !== f.sha256.toLowerCase()) {
        throw new Error('sha256 mismatch');
      }
      writeAtomic(path, buf);
      result.wrote.push(f.local);
    } catch {
      result.ok = false;
      result.failed.push(f.local);
      // Keep whatever copy is there: a stale file is better than a missing one
      // until the retry lands.
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
 * manifest), every other entry in the two subdirectories removed, and
 * `LIBRARY.md` regenerated from the items that are on disk. A download that
 * fails keeps whatever copy was there and clears `ok`, the file rule; an item
 * over the cap is refused for this rev and left out of the catalog.
 */
async function syncLibrary({ dir, items, fetchFile, maxBytes, keep, result }) {
  const wanted = { designs: new Set(), research: new Set() };
  const onDisk = [];
  for (const kind of Object.keys(LIBRARY_DIRS)) {
    if (items.some((it) => it.kind === kind)) {
      ensureSubdir(dir, LIBRARY_DIRS[kind]);
      keep.add(LIBRARY_DIRS[kind]);
    }
  }
  for (const it of items) {
    const [sub, file] = it.path.split('/');
    const path = join(dir, sub, file);
    wanted[sub].add(file);
    if (Number(it.bytes) > maxBytes) {
      result.refused.push(it.path);
      wanted[sub].delete(file);
      continue;
    }
    if (typeof it.sha256 === 'string' && localSha(path) === it.sha256.toLowerCase()) {
      onDisk.push(it);
      continue;
    }
    try {
      const buf = await fetchFile(it.id, { library: true });
      if (!Buffer.isBuffer(buf) || buf.byteLength > maxBytes) {
        result.refused.push(it.path);
        wanted[sub].delete(file);
        continue;
      }
      if (typeof it.sha256 === 'string' && sha256Of(buf) !== it.sha256.toLowerCase()) {
        throw new Error('sha256 mismatch');
      }
      writeAtomic(path, buf);
      result.wrote.push(it.path);
      onDisk.push(it);
    } catch {
      result.ok = false;
      result.failed.push(it.path);
      // A stale copy is better than none until the retry lands — and it stays
      // in the catalog only if it is actually there.
      if (localSha(path) !== null) onDisk.push(it);
    }
  }
  // Each subdirectory holds exactly what the manifest names.
  for (const sub of Object.values(LIBRARY_DIRS)) {
    const subPath = join(dir, sub);
    let entries = [];
    try {
      if (!lstatSync(subPath).isDirectory()) continue;
      entries = readdirSync(subPath);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (wanted[sub].has(name)) continue;
      try {
        rmSync(join(subPath, name), { recursive: true, force: true });
        result.removed.push(`${sub}/${name}`);
      } catch {
        /* best-effort */
      }
    }
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
function libraryMissing(checkoutDir, manifest) {
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
function libraryStale(checkoutDir, manifest, { synced, refused }) {
  const items = libraryItemsOf(manifest);
  if (items === null) return false;
  if (!synced) return true;
  const expected = items.filter((it) => !(Number(it.bytes) > KNOWLEDGE_FILE_MAX_BYTES) && !refused.has(it.path));
  if (expected.length === 0) return false;
  const dir = join(checkoutDir, KNOWLEDGE_DIR);
  const isFile = (p) => {
    try {
      return lstatSync(p).isFile();
    } catch {
      return false;
    }
  };
  if (!isFile(join(dir, LIBRARY_FILE))) return true;
  return expected.some((it) => !isFile(join(dir, ...it.path.split('/'))));
}

/**
 * The per-process driver: called with every roster's `knowledge` key.
 *
 * Holds the last-materialised rev in memory (seeded from the marker, so a
 * restart does not re-sync), serialises syncs (a slow download must never be
 * overlapped by the next poll's), and backs off after a failure: 30s, 60s,
 * 120s … capped at ten minutes. Never throws into the poll loop.
 */
export function createKnowledgeSync({
  checkoutDir,
  fetchFile,
  onExclude = () => {},
  log = () => {},
  now = () => Date.now(),
}) {
  let rev = readKnowledgeMarker(checkoutDir);
  /** Whether the sync that wrote `rev` carried a library key — the marker's
   *  `:lib`, then this process's own memory. */
  let libSynced = knowledgeMarkerHasLibrary(checkoutDir);
  /** Library paths refused for size at `rev` — not expected on disk. */
  let libRefused = new Set();
  let busy = false;
  let failures = 0;
  let retryAt = 0;
  /** The rev the backoff belongs to. A NEW rev is a new library and is tried
   *  at once — waiting out a backoff earned by a file the person has since
   *  removed would hold their next upload hostage to the last one's failure. */
  let failedRev = null;

  return {
    /** The rev last fully materialised, or null. */
    get rev() {
      return rev;
    },
    /** @returns {Promise<null | ReturnType<typeof syncKnowledge>>} null when
     *  nothing ran (absent key, same rev, busy, or backing off). */
    async onRoster(knowledge) {
      if (knowledge === undefined || knowledge === null) return null; // ABSENT: leave it alone
      if (!isKnowledgeManifest(knowledge)) return null;
      /**
       * THE SAME REV IS NOT ALWAYS THE SAME DISK (2026-09-23). The marker says
       * which rev was written; it cannot say the directory is still there. An
       * `rm -r .flowviant/knowledge` — by hand, or by an agent tidying its
       * checkout — left the marker naming the current rev, so every poll after
       * it matched and returned, the prompt paragraph vanished with the
       * directory (`knowledgeDirFor` answers null), and every turn ran without
       * the library until somebody happened to edit it. A manifest that names
       * something over a directory that does not exist is re-synced; files
       * already on disk match by hash and are not fetched again.
       */
      //
      // …AND THE SAME REV IS NOT ALWAYS THE SAME LIBRARY: an upgrade from a
      // daemon that ignored the `library` key, or a hand-deleted `designs/`,
      // leaves the marker current over files a card's references name. See
      // `libraryStale`.
      if (
        knowledge.rev === rev &&
        !libraryMissing(checkoutDir, knowledge) &&
        !libraryStale(checkoutDir, knowledge, { synced: libSynced, refused: libRefused })
      )
        return null;
      if (busy) return null;
      if (knowledge.rev === failedRev && now() < retryAt) return null;
      busy = true;
      try {
        try {
          onExclude(checkoutDir);
        } catch {
          /* a convenience, never a gate */
        }
        const r = await syncKnowledge({ checkoutDir, manifest: knowledge, fetchFile });
        if (r.ok) {
          rev = knowledge.rev;
          libSynced = libraryItemsOf(knowledge) !== null;
          libRefused = new Set(r.refused);
          failures = 0;
          retryAt = 0;
          failedRev = null;
          writeKnowledgeMarker(checkoutDir, rev, libSynced);
          if (r.wrote.length || r.removed.length) {
            log(
              `knowledge · synced rev ${rev}` +
                (r.wrote.length ? ` · ${r.wrote.length} written` : '') +
                (r.removed.length ? ` · ${r.removed.length} removed` : '')
            );
          }
        } else {
          failures = knowledge.rev === failedRev ? failures + 1 : 1;
          failedRev = knowledge.rev;
          retryAt = now() + Math.min(600_000, 30_000 * 2 ** (failures - 1));
          log(`knowledge · ${r.failed.length} file(s) did not download — retrying`);
        }
        if (r.refused.length) {
          log(`knowledge · skipped over the size cap: ${r.refused.join(', ')}`);
        }
        return r;
      } catch (e) {
        failures = knowledge.rev === failedRev ? failures + 1 : 1;
        failedRev = knowledge.rev;
        retryAt = now() + Math.min(600_000, 30_000 * 2 ** (failures - 1));
        log(`knowledge · sync failed: ${e?.message ?? e}`);
        return null;
      } finally {
        busy = false;
      }
    },
  };
}

/**
 * The `/fleet/knowledge/:id` download, in the attachment fetch's own shape:
 * the machine credential as a bearer, a 60s ceiling, and the size checked on
 * the header AND on the bytes (a lying header must not decide the cap). The
 * URL is derived from the roster URL the way every `/fleet/*` path is, so a
 * self-hosted `FLOWVIANT_FLEET_URL` is honoured.
 */
export function knowledgeFetcher({ fleetUrl, token, userAgent, maxBytes = KNOWLEDGE_FILE_MAX_BYTES }) {
  const base = String(fleetUrl).replace(/\/agents\/?$/, '/knowledge');
  // A kept library item (0.97.0) is its sibling, `GET /fleet/library/:id` —
  // the same credential, the same shape, the same caps.
  const libraryBase = String(fleetUrl).replace(/\/agents\/?$/, '/library');
  return async (id, { library = false } = {}) => {
    const res = await fetch(`${library ? libraryBase : base}/${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${token}`, 'User-Agent': userAgent },
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (Number(res.headers.get('content-length') ?? '0') > maxBytes) {
      // Returned rather than thrown: over the cap is a REFUSAL, permanent for
      // this rev, not a failure the backoff should keep retrying.
      return Buffer.alloc(maxBytes + 1);
    }
    return Buffer.from(await res.arrayBuffer());
  };
}
