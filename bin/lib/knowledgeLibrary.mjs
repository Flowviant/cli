/**
 * THE KNOWLEDGE LIBRARY'S RULES, pure (2026-09-26, split out of knowledge.mjs —
 * SOLID SRP, F049): where every manifest entry may land, under what name, at
 * what cap, and what the generated catalog says. No disk, no network — the
 * materialisation (knowledgeFiles.mjs), the download (knowledgeFetch.mjs) and
 * the roster driver (knowledge.mjs) all ask these, so a change to the bundle
 * format or the naming rule is a change here and nowhere else.
 *
 * ── THE KEPT LIBRARY (2026-09-23, 0.97.0) ──
 *
 * The manifest may carry `library: { items: [...] }` — the designs and
 * write-ups the project KEPT when a person accepted them — and each item lands
 * at its own relative path, `designs/<slug>-v<N>.html` or
 * `research/<slug>-v<N>.md`, with a generated `LIBRARY.md` at the root naming
 * every one (path, title, kind, the card that asked for it, the date, what it
 * supersedes). So "implement design A" is an agent opening LIBRARY.md, finding
 * design A, and reading the page. At 0.99.0 a kept design is one folder,
 * including its original relative sidecar paths and measured preview. At
 * 0.105.0 the end-product kinds add `models/<slug>-v<N>/` (a 3D model, a
 * folder like a design: its viewer, its model files, its textures) and
 * `decks/<slug>-v<N>.html` (a presentation, one file). At 0.114.0 the image
 * kind adds `images/<slug>-v<N>.png` or `.webp` — one BINARY file per kept
 * picture, fetched and written as bytes like every entry.
 *
 * SUBDIRECTORIES, AND EXACTLY FIVE. The safe-name rule for a knowledge file
 * forbids every separator; a library item is the one thing allowed ONE (or,
 * for a bundle kind, a versioned folder), and only after one of the five
 * literal prefixes, with a stem that is already safe and the extension its
 * kind hands back. `..`, another prefix, a leading dot, a folder for a
 * single-file kind — refused, never rewritten, because a rewritten path could
 * collide with another item's real one. The five directories are OURS the way
 * the library directory is: a symlink or a file planted there is removed (the
 * link, never its target) and a real directory made.
 *
 * ABSENT MEANS "LEAVE IT ALONE", the same rule the whole key keeps: a manifest
 * with no `library` key is an older server, and `designs/`, `models/`,
 * `images/`, `decks/`, `research/` and `LIBRARY.md` are neither synced nor
 * swept.
 * `library: { items: [] }` is the emptied catalog, SAID — every directory and
 * the catalog go.
 */

import { safeFileName } from './safeFileName.mjs';

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
const DESIGN_EXT = Object.freeze(['.html', '.htm', '.gltf', '.obj', '.glb', '.bin']);
/**
 * THE KEPT LIBRARY'S KINDS — the daemon's ONE table of them (2026-09-27,
 * SOLID fix-up of the end-product kinds). Per kind:
 *  - `dir`: the folder under the knowledge directory it lands in;
 *  - `bundle`: kept as a FOLDER (`<dir>/<slug>-vN/…`) rather than one file;
 *  - `ext`: the extensions its entry (or, for a bundle, its files) may carry;
 *  - `preview`: its kept entry is a page the server may measure a PNG of;
 *  - `word`: what it is called in the catalog.
 * `dir` and `bundle` are copies of the app's `LIBRARY_KINDS` rows
 * (packages/shared/src/schemas/libraryKinds.ts), and the release gate
 * (scripts/check-app-parity.mjs) holds both equal to the app's; the keys are
 * every card kind but code (`knowledgeLibrary.test.mjs`). Every other library
 * fact below — `LIBRARY_DIRS`, the path rule, the reference rule, the
 * previews, the catalog — reads this, so a kind is one row here. It was five
 * parallel tables keyed by kind, and a kind missed in one of them threw.
 * `model` is the 3D-model kind, `deck` the presentation kind, `image` the
 * picture kind (0.114.0: one PNG or WebP, which is its own preview — no page
 * for the server to measure).
 */
export const LIBRARY_KINDS = Object.freeze({
  design: Object.freeze({ dir: 'designs', bundle: true, ext: DESIGN_EXT, preview: true, word: 'design' }),
  model: Object.freeze({ dir: 'models', bundle: true, ext: Object.freeze([...DESIGN_EXT, '.mtl']), preview: true, word: '3D model' }),
  image: Object.freeze({ dir: 'images', bundle: false, ext: Object.freeze(['.png', '.webp']), preview: false, word: 'image' }),
  deck: Object.freeze({ dir: 'decks', bundle: false, ext: Object.freeze(['.html', '.htm']), preview: true, word: 'deck' }),
  research: Object.freeze({ dir: 'research', bundle: false, ext: Object.freeze(['.md']), preview: false, word: 'research' }),
});
/** The five subdirectories a kept item may live in, by kind — read off
 *  `LIBRARY_KINDS`. */
export const LIBRARY_DIRS = Object.freeze(
  Object.fromEntries(Object.entries(LIBRARY_KINDS).map(([kind, k]) => [kind, k.dir]))
);
const libraryKind = (kind) => (typeof kind === 'string' && Object.hasOwn(LIBRARY_KINDS, kind) ? LIBRARY_KINDS[kind] : null);

/**
 * IS THIS A PATH A CARD MAY NAME AS A REFERENCE (0.105.0)? `<dir>/<name>` for
 * any library folder, and `<dir>/<name>/` — a kept bundle referenced as its
 * FOLDER, the shape the app's `libraryRefPath` sends — only for a `bundle`
 * kind. The name's first character is never a dot, so `..` and a hidden
 * segment cannot pass. Built from `LIBRARY_KINDS`, never a re-spelled folder
 * list: a copy of the list here dropped every kept design bundle from 0.99.0
 * to 0.104.0.
 */
export function isLibraryReference(name) {
  if (typeof name !== 'string') return false;
  const m = /^([^/]+)\/[A-Za-z0-9_][A-Za-z0-9._-]*(\/?)$/.exec(name);
  return !!m && Object.values(LIBRARY_KINDS).some((k) => k.dir === m[1] && (m[2] === '' || k.bundle));
}
/** The server caps a library at 200 items; a longer manifest is cut. */
const MAX_LIBRARY_ITEMS = 256;

/** The person's standing brief, written from the manifest's `instructions`.
 *  A RESERVED name: a library FILE called this gets a suffix, because the
 *  prompt tells the CLI to read this one first and a stranger's file must
 *  never be able to stand in for the person's own words. */
export const INSTRUCTIONS_FILE = 'INSTRUCTIONS.md';
/** The server's per-file ceiling (`KNOWLEDGE_FILE_MAX_BYTES`), re-checked here:
 *  this is somebody's disk, and one place checking is one deploy away from
 *  zero places — the attachment fetch's own rule. */
export const KNOWLEDGE_FILE_MAX_BYTES = 10 * 1024 * 1024;
export const KNOWLEDGE_BINARY_MODEL_MAX_BYTES = 20 * 1024 * 1024;
export const knowledgeMaxFor = (name, base) => /\.(glb|bin)$/i.test(name)
  ? Math.max(base, KNOWLEDGE_BINARY_MODEL_MAX_BYTES) : base;
/** The manifest is capped at the server (25 files); a manifest longer than
 *  this is not one the product produced, and is cut rather than trusted. */
export const MAX_FILES = 64;

/**
 * `safeFileName` (bin/lib/safeFileName.mjs — the server's rule, one daemon
 * home): drops every path separator, never starts with a dot or a dash, and
 * THE EXTENSION SURVIVES A CUT — byte-identical to what the server computes,
 * so a knowledge file synced under this name and one requested by name later
 * never disagree over the cut. An empty name is `file`.
 */
export const safeKnowledgeName = (raw) => safeFileName(raw, 'file');

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
  // The catalog's name and the library directories (two at 0.97.0, four at
  // 0.105.0) are reserved beside the brief: a person's `LIBRARY.md` or a file
  // called `designs` must never stand where the catalog or a directory has to.
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

/**
 * A kept item's relative path, or null when it is not EXACTLY
 * `<its kind's dir>/<safe stem>.<its kind's extension>` (or, for a bundle
 * kind, a file inside `<dir>/<slug>-vN/`) — see the header. Refused rather
 * than rewritten: a rewritten path is one the server never named, and it
 * could land on another item's real one.
 */
export function safeLibraryPath(name, kind) {
  const k = libraryKind(kind);
  if (typeof name !== 'string' || !k) return null;
  const parts = name.split('/');
  if (parts.length !== 2 && !(k.bundle && parts.length >= 3 && parts.length <= 7)) return null;
  const [dir, ...rest] = parts;
  const file = rest.at(-1);
  if (dir !== k.dir) return null;
  if (rest.length >= 2 && !/^[a-z0-9-]+-v[1-9][0-9]*$/.test(rest[0])) return null;
  if (rest.slice(1, -1).some((p) => !safeBundleSegment(p))) return null;
  if (!file || (rest.length === 1 ? file !== safeKnowledgeName(file) : !safeBundleSegment(file))) return null;
  if (!k.ext.some((ext) => file.toLowerCase().endsWith(ext) && file.length > ext.length)) return null;
  return name;
}

function safeBundleSegment(part) {
  return typeof part === 'string' && part.length > 0 && part.length <= 80 &&
    /^[A-Za-z0-9][A-Za-z0-9._ -]*$/.test(part) && !part.endsWith('.');
}

function safeBundleFile(path, rootDir) {
  if (typeof path !== 'string' || !path.startsWith(`${rootDir}/`)) return null;
  const relative = path.slice(rootDir.length + 1);
  if (relative === 'preview.png') return null;
  const parts = relative.split('/');
  if (!parts.length || parts.some((p) => !safeBundleSegment(p))) return null;
  if (!/\.(gltf|obj|mtl|glb|bin|png|jpg|jpeg|gif|webp|svg|json)$/i.test(relative)) return null;
  return path;
}

/** The manifest's library items that are safe to write, in manifest order, or
 *  null when the key is ABSENT (an older server — leave everything alone). */
export function libraryItemsOf(manifest) {
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
    const bundleDir = path.split('/').length >= 3 ? path.split('/').slice(0, 2).join('/') : null;
    const expectedPreview = bundleDir ? `${bundleDir}/preview.png` : it.name.replace(/\.html$/, '.png');
    const preview = libraryKind(it.kind).preview;
    const previewPath = preview && it.preview && it.preview.name === expectedPreview ? expectedPreview : null;
    const files = bundleDir && Array.isArray(it.files) ? it.files.map((f, index) => ({ ...f,
      index, path: safeBundleFile(f.name, bundleDir),
    })).filter((f) => f.path && !seen.has(f.path.toLowerCase())) : [];
    for (const f of files) seen.add(f.path.toLowerCase());
    out.push({ ...it, path, files, previewPath, previewUnknown: preview && path.endsWith('.html') && it.preview === undefined });
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
    const facts = [libraryKind(it.kind)?.word];
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
    'The mockups, 3D models, images, decks and research this project kept. Paths are relative to this directory;\n' +
    'a newer version supersedes an older one of the same name.\n\n' +
    `${lines.join('\n')}\n`
  );
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
