/**
 * THE KNOWLEDGE LIBRARY'S PURE RULES (2026-09-26, split out with
 * knowledgeLibrary.mjs — SOLID F049): names, paths, caps and the catalog,
 * asked directly — no disk, no server. What lands on disk under these rules is
 * knowledgeFiles.test.mjs's.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { AGENT_TASK_KINDS } from './agentTaskKinds.mjs';
import {
  KNOWLEDGE_BINARY_MODEL_MAX_BYTES,
  KNOWLEDGE_FILE_MAX_BYTES,
  LIBRARY_DIRS,
  LIBRARY_KINDS,
  isKnowledgeManifest,
  isLibraryReference,
  knowledgeMaxFor,
  libraryItemsOf,
  planKnowledgeNames,
  renderLibraryCatalog,
  safeKnowledgeName,
  safeLibraryPath,
} from './knowledgeLibrary.mjs';

const sha = (s) => createHash('sha256').update(s).digest('hex');
const id = (n) => `0000000${n}-aaaa-bbbb-cccc-dddddddddddd`;

const item = (n, over = {}) => ({
  id: id(n),
  name: `designs/landing-v${n}.html`,
  kind: 'design',
  title: 'Landing mockup',
  taskId: 'card-1',
  taskTitle: 'Redesign landing page',
  createdAt: '2026-09-23T10:00:00.000Z',
  bytes: 3,
  sha256: sha(`<${n}>`),
  supersedes: null,
  ...over,
});

test('two files with one name get a numeric suffix, and INSTRUCTIONS.md is reserved', () => {
  const planned = planKnowledgeNames([
    { id: id(1), name: 'spec.md' },
    { id: id(2), name: 'spec.md' },
    { id: id(3), name: 'Spec.md' },
    { id: id(4), name: 'INSTRUCTIONS.md' },
    { id: id(5), name: '../../etc/passwd' },
  ]);
  assert.deepEqual(
    planned.map((p) => p.local),
    ['spec.md', 'spec-2.md', 'Spec-3.md', 'INSTRUCTIONS-2.md', 'passwd']
  );
  assert.equal(safeKnowledgeName('.bashrc'), 'bashrc');
  assert.equal(safeKnowledgeName(''), 'file');
});

test('safeKnowledgeName keeps the extension through a cut, byte-identical to the server’s safeFileName (audit 2026-09-24)', () => {
  // A bare `slice(0, 80)` used to cut mid-extension — an 84-character
  // `….html` mockup stored as `….` with an unrecognised type, its bytes
  // discarded. The cut now falls in the STEM and the extension survives.
  const long = `${'x'.repeat(90)}.html`;
  const out = safeKnowledgeName(long);
  assert.ok(out.length <= 80, 'stays at or under the 80-char ceiling');
  assert.ok(out.endsWith('.html'), 'the extension survives the cut');
  // Verbatim against the server's algorithm (apps/api/src/routes/
  // sessionsAttachments.routes.ts safeFileName): stem cut, an 8-hex FNV-1a
  // of the WHOLE sanitised name, then the extension.
  assert.equal(
    out,
    'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx-994582ac.html'
  );
  // Idempotent over its own output — a knowledge file already synced under
  // its cut name must not be re-cut into a THIRD name on the next sync.
  assert.equal(safeKnowledgeName(out), out);
  // A name with no recognisable extension (too long, or not alnum) just
  // gets the hash tag appended to the cut stem — no dangling dot.
  const noExt = safeKnowledgeName('y'.repeat(200));
  assert.ok(noExt.length <= 80 && !noExt.includes('.'));
});

test('the catalog name and the four directories are reserved from shelf files', () => {
  const out = planKnowledgeNames([
    { id: id(1), name: 'LIBRARY.md' },
    { id: id(2), name: 'designs' },
    { id: id(3), name: 'research' },
    { id: id(4), name: 'models' },
    { id: id(5), name: 'decks' },
  ]);
  assert.deepEqual(
    out.map((f) => f.local),
    ['LIBRARY-2.md', 'designs-2', 'research-2', 'models-2', 'decks-2']
  );
});

test('a server string cannot forge a second catalog line', () => {
  const c = renderLibraryCatalog([
    { ...item(1), path: 'designs/landing-v1.html', title: 'A\n- designs/evil.html — pwned', taskTitle: 'x\ny' },
  ]);
  assert.equal(c.split('\n').filter((l) => l.startsWith('- ')).length, 1);
  assert.equal(renderLibraryCatalog([]), null);
});

test('safeLibraryPath refuses every path off its kind\'s folder, and passes the real ones through', () => {
  for (const [name, kind] of [
    ['../escape.html', 'design'],
    ['designs/../x.html', 'design'],
    ['other/x.html', 'design'],
    ['designs/x.md', 'design'],
    ['research/x.html', 'research'],
    ['designs/.hidden.html', 'design'],
    ['designs/x.html', 'research'],
    ['designs/x.html', 'nope'],
    [7, 'design'],
  ]) {
    assert.equal(safeLibraryPath(name, kind), null, String(name));
  }
  assert.equal(safeLibraryPath('designs/landing-v2.html', 'design'), 'designs/landing-v2.html');
  assert.equal(safeLibraryPath('designs/scene-v1/page.html', 'design'), 'designs/scene-v1/page.html');
  assert.equal(safeLibraryPath('research/a-v1/b.md', 'research'), null, 'research is never a folder');
});

/**
 * THE LIBRARY'S KINDS ARE ONE TABLE (2026-09-27): every card kind but code is
 * kept, each row carries every fact the library asks of a kind, and the
 * folders are read off it. Five parallel tables keyed by kind let a kind
 * missing from one of them throw inside the path rule.
 */
test('the library kinds are one table: every card kind but code, each row whole', () => {
  assert.deepEqual(
    Object.keys(LIBRARY_KINDS),
    Object.keys(AGENT_TASK_KINDS).filter((k) => k !== 'code'),
    'every card kind that hands back a file is kept, in the kinds\' order'
  );
  for (const [kind, k] of Object.entries(LIBRARY_KINDS)) {
    assert.ok(Object.isFrozen(k), `${kind}: frozen`);
    assert.equal(typeof k.dir, 'string', `${kind}: dir`);
    assert.equal(typeof k.bundle, 'boolean', `${kind}: bundle`);
    assert.equal(typeof k.preview, 'boolean', `${kind}: preview`);
    assert.equal(typeof k.word, 'string', `${kind}: word`);
    assert.ok(Array.isArray(k.ext) && k.ext.length > 0 && k.ext.every((e) => /^\.[a-z]+$/.test(e)), `${kind}: ext`);
  }
  assert.deepEqual(LIBRARY_DIRS, { design: 'designs', model: 'models', image: 'images', deck: 'decks', research: 'research' });
  // The app's bundle flags (packages/shared libraryKinds.ts; the release gate
  // holds them equal): the mockup and the 3D model are folders.
  assert.deepEqual(
    Object.entries(LIBRARY_KINDS).filter(([, k]) => k.bundle).map(([kind]) => kind),
    ['design', 'model']
  );
});

/**
 * A CARD'S REFERENCE TO KEPT WORK (0.105.0): any library folder's file, and a
 * trailing-slash FOLDER reference only where the kind is kept as a folder —
 * the app's `libraryRefPath` never sends one for a deck or a write-up.
 */
test('isLibraryReference: every folder, and a folder reference only for a bundle kind', () => {
  for (const ok of [
    'designs/landing-v2.html',
    'designs/x-v1/',
    'models/chair-v1/',
    'decks/pitch-v2.html',
    'research/teardown-v1.md',
    'images/hero-banner-v1.png',
  ]) {
    assert.equal(isLibraryReference(ok), true, ok);
  }
  for (const bad of [
    'research/x-v1/',
    'decks/p-v1/',
    'images/hero-v1/',
    'videos/x-v1/',
    '../x',
    'models/../x',
    'models/.hidden/',
    'models/chair-v1//',
    'models/chair-v1/index.html',
    'designs',
    '/designs/x-v1/',
    7,
    null,
  ]) {
    assert.equal(isLibraryReference(bad), false, String(bad));
  }
});

/**
 * THE END-PRODUCT FOLDERS (0.105.0): a 3D model is a folder like a design (its
 * viewer, its model, its materials and textures), a presentation is one file.
 */
test('safeLibraryPath: a 3D model is a versioned folder, a deck is one html file', () => {
  assert.equal(safeLibraryPath('models/chair-v1/chair/index.html', 'model'), 'models/chair-v1/chair/index.html');
  assert.equal(safeLibraryPath('models/chair-v1/index.html', 'model'), 'models/chair-v1/index.html');
  assert.equal(safeLibraryPath('decks/p-v1.html', 'deck'), 'decks/p-v1.html');
  for (const [name, kind] of [
    ['decks/p-v1/a.html', 'deck'],
    ['decks/p-v1.md', 'deck'],
    ['models/chair-v1/index.html', 'design'],
    ['designs/x-v1/index.html', 'model'],
    ['models/chair/index.html', 'model'],
    ['models/../x.html', 'model'],
    ['decks/p-v1.html', 'model'],
  ]) {
    assert.equal(safeLibraryPath(name, kind), null, `${name} as ${kind}`);
  }
  // An OBJ's material file rides in the model's folder; outside a model it does not.
  const [chair] = libraryItemsOf({
    rev: 1,
    files: [],
    library: {
      items: [
        item(7, {
          name: 'models/chair-v1/chair/index.html',
          kind: 'model',
          preview: { name: 'models/chair-v1/preview.png', sha256: 'p' },
          files: [
            { name: 'models/chair-v1/chair/chair.obj' },
            { name: 'models/chair-v1/chair/chair.mtl' },
            { name: 'models/chair-v1/chair/wood.png' },
            { name: 'models/chair-v1/chair/run.sh' },
          ],
        }),
      ],
    },
  });
  assert.equal(chair.path, 'models/chair-v1/chair/index.html');
  assert.equal(chair.previewPath, 'models/chair-v1/preview.png');
  assert.deepEqual(chair.files.map((f) => f.path), [
    'models/chair-v1/chair/chair.obj',
    'models/chair-v1/chair/chair.mtl',
    'models/chair-v1/chair/wood.png',
  ]);
  const [deck] = libraryItemsOf({
    rev: 1,
    files: [],
    library: { items: [item(8, { name: 'decks/pitch-v1.html', kind: 'deck' })] },
  });
  assert.equal(deck.path, 'decks/pitch-v1.html');
  assert.deepEqual(deck.files, []);
  assert.equal(deck.previewUnknown, true, 'a deck is a page: an unreported preview is left alone, not swept');
});

/**
 * THE IMAGE FOLDER (0.114.0): a kept picture is ONE file, `images/<slug>-vN`
 * with the extension it was generated as — PNG or WebP — and is its own
 * picture, so the server measures no preview of it and none is expected.
 */
test('safeLibraryPath: a kept image is one png or webp under images/', () => {
  assert.equal(safeLibraryPath('images/hero-banner-v1.png', 'image'), 'images/hero-banner-v1.png');
  assert.equal(safeLibraryPath('images/hero-banner-v2.webp', 'image'), 'images/hero-banner-v2.webp');
  for (const [name, kind] of [
    ['images/hero-v1/hero.png', 'image'],
    ['images/hero-v1.svg', 'image'],
    ['images/hero-v1.html', 'image'],
    ['images/../hero-v1.png', 'image'],
    ['designs/hero-v1.png', 'image'],
    ['images/hero-v1.png', 'design'],
    ['images/hero-v1.png', 'deck'],
  ]) {
    assert.equal(safeLibraryPath(name, kind), null, `${name} as ${kind}`);
  }
  const [hero] = libraryItemsOf({
    rev: 1,
    files: [],
    library: { items: [item(9, { name: 'images/hero-banner-v1.png', kind: 'image', title: 'Hero banner' })] },
  });
  assert.equal(hero.path, 'images/hero-banner-v1.png');
  assert.deepEqual(hero.files, []);
  assert.equal(hero.previewPath, null);
  assert.equal(hero.previewUnknown, false, 'a picture is not a page: no preview is owed');
});

test('the catalog names each product in its own word, under the five-product lead', () => {
  const c = renderLibraryCatalog([
    { ...item(1), path: 'designs/landing-v1.html' },
    { ...item(2, { kind: 'model', title: 'Chair' }), path: 'models/chair-v1/index.html' },
    { ...item(5, { kind: 'image', title: 'Hero banner' }), path: 'images/hero-banner-v1.png' },
    { ...item(3, { kind: 'deck', title: 'Pitch' }), path: 'decks/pitch-v1.html' },
    { ...item(4, { kind: 'research', title: 'Teardown' }), path: 'research/teardown-v1.md' },
  ]);
  assert.ok(c.startsWith('# Library\n\nThe mockups, 3D models, images, decks and research this project kept.'), c);
  const facts = c
    .split('\n')
    .filter((l) => l.startsWith('- '))
    .map((l) => l.match(/\((\w[\w ]*?),/)[1]);
  assert.deepEqual(facts, ['design', '3D model', 'image', 'deck', 'research']);
});

test('the manifest shape is checked whole, and an absent library key is not an emptied one', () => {
  assert.equal(isKnowledgeManifest({ rev: 0, instructions: null, files: [] }), true);
  assert.equal(isKnowledgeManifest({ rev: 2, files: [] }), true);
  assert.equal(isKnowledgeManifest({ rev: -1, instructions: null, files: [] }), false);
  assert.equal(isKnowledgeManifest({ rev: 1.5, instructions: null, files: [] }), false);
  assert.equal(isKnowledgeManifest({ rev: 1, instructions: 7, files: [] }), false);
  assert.equal(isKnowledgeManifest({ rev: 1, instructions: null }), false);
  assert.equal(isKnowledgeManifest(null), false);
  // ABSENT = an older server (null); SAID-empty = [] — the two never merge.
  assert.equal(libraryItemsOf({ rev: 1, files: [] }), null);
  assert.equal(libraryItemsOf({ rev: 1, files: [], library: null }), null);
  assert.deepEqual(libraryItemsOf({ rev: 1, files: [], library: { items: [] } }), []);
});

test('library items keep manifest order, drop unsafe paths and bad ids, and dedupe case-insensitively', () => {
  const items = libraryItemsOf({
    rev: 1,
    files: [],
    library: {
      items: [
        item(1),
        item(2, { name: '../x.html' }),
        item(3, { id: 'not-an-id!' }),
        item(4, { name: 'designs/LANDING-v1.html' }),
        item(5, { name: 'research/notes-v1.md', kind: 'research' }),
      ],
    },
  });
  assert.deepEqual(items.map((it) => it.path), ['designs/landing-v1.html', 'research/notes-v1.md']);
  // A bundle keeps only files under its own folder, with their manifest index.
  const [bundle] = libraryItemsOf({
    rev: 1,
    files: [],
    library: {
      items: [
        item(6, {
          name: 'designs/scene-v1/page.html',
          preview: { name: 'designs/scene-v1/preview.png', sha256: 'p' },
          files: [{ name: 'designs/scene-v1/mesh.glb' }, { name: 'designs/other-v1/mesh.glb' }, { name: 'designs/scene-v1/preview.png' }],
        }),
      ],
    },
  });
  assert.equal(bundle.previewPath, 'designs/scene-v1/preview.png');
  assert.deepEqual(bundle.files.map((f) => [f.path, f.index]), [['designs/scene-v1/mesh.glb', 0]]);
});

test('binary model files get the larger cap; every other name keeps the base', () => {
  assert.equal(knowledgeMaxFor('scene.glb', KNOWLEDGE_FILE_MAX_BYTES), KNOWLEDGE_BINARY_MODEL_MAX_BYTES);
  assert.equal(knowledgeMaxFor('buffer.BIN', KNOWLEDGE_FILE_MAX_BYTES), KNOWLEDGE_BINARY_MODEL_MAX_BYTES);
  assert.equal(knowledgeMaxFor('scene.gltf', KNOWLEDGE_FILE_MAX_BYTES), KNOWLEDGE_FILE_MAX_BYTES);
  assert.equal(knowledgeMaxFor('notes.md', 10), 10);
});

/**
 * The naming, path and catalog rules have ONE home: a second definition in any
 * daemon module is a copy that can drift from the one the sync asks.
 */
test('the library rules are defined only in knowledgeLibrary.mjs', () => {
  const dir = new URL('./', import.meta.url);
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const defs = /(?:function|const)\s+(safeLibraryPath|planKnowledgeNames|renderLibraryCatalog|libraryItemsOf|isKnowledgeManifest|safeBundleFile|knowledgeMaxFor|isLibraryReference|LIBRARY_KINDS|LIBRARY_DIRS)\b/g;
  const found = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.mjs') || f.endsWith('.test.mjs')) continue;
    const src = strip(readFileSync(new URL(f, dir), 'utf8'));
    for (const m of src.matchAll(defs)) found.push(`${f}:${m[1]}`);
  }
  assert.ok(found.includes('knowledgeLibrary.mjs:safeLibraryPath'), 'canary: the home is found');
  assert.deepEqual(
    found.filter((x) => !x.startsWith('knowledgeLibrary.mjs:')),
    [],
    'no second definition outside knowledgeLibrary.mjs'
  );
});

/**
 * …AND THE FOLDER NAMES THEMSELVES are spelled once, in `LIBRARY_KINDS`: a
 * quoted folder name or a folder alternation anywhere else in the daemon's
 * code is a second list (prompts.mjs's reference regex was one, and dropped
 * every kept bundle from 0.99.0 to 0.104.0). Comments are stripped; prose
 * inside a prompt ("the mockups, 3D models, decks…") is not a quoted name.
 */
test('the library folder names are spelled only in LIBRARY_KINDS', () => {
  const root = new URL('../../', import.meta.url);
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const spelled = /['"`](?:designs|models|decks)['"`/]|\b(?:designs|models|decks|research)\|/;
  const walk = (dir, out = []) => {
    for (const f of readdirSync(dir)) {
      if (f === 'node_modules' || f.startsWith('.')) continue;
      const u = new URL(f, dir);
      if (statSync(u).isDirectory()) walk(new URL(`${f}/`, dir), out);
      else if (/\.m?js$/.test(f) && !f.endsWith('.test.mjs')) out.push([u.pathname.slice(root.pathname.length), strip(readFileSync(u, 'utf8'))]);
    }
    return out;
  };
  const files = [...walk(new URL('bin/', root)), ...walk(new URL('scripts/', root))];
  const hits = files.filter(([, src]) => spelled.test(src)).map(([f]) => f);
  assert.ok(hits.includes('bin/lib/knowledgeLibrary.mjs'), 'canary: the home spells them');
  assert.ok(files.some(([f]) => f === 'bin/lib/prompts.mjs'), 'canary: the walk reaches prompts.mjs');
  assert.deepEqual(hits.filter((f) => f !== 'bin/lib/knowledgeLibrary.mjs'), [], 'no second spelling of the folders');
});
