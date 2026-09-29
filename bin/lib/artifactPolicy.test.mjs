/**
 * THE GENERATED ARTIFACT POLICY (2026-09-26, SOLID F044).
 *
 * `artifactPolicy.mjs` is rendered from the server's shared schema by the app
 * repo (`bun scripts/write-daemon-artifact-policy.ts`) and is the daemon's one
 * copy of the allowlist and the caps. The app's own parity test compares this
 * file byte for byte with a fresh render; here the daemon pins that the file
 * is the generated one, well-formed, and the only copy — and, when the app repo
 * is checked out beside this one, that every entry matches its source.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
import * as policy from './artifactPolicy.mjs';
import { artifactMaxBytesFor, artifactTypeFor, ARTIFACT_MAX_FILES } from './artifacts.mjs';

test('the snapshot is the generated file, not a hand copy', () => {
  const src = readFileSync(new URL('./artifactPolicy.mjs', import.meta.url), 'utf8');
  assert.match(src, /GENERATED, DO NOT EDIT BY HAND/);
  assert.equal(policy.ARTIFACT_POLICY_SOURCE, 'packages/shared/src/schemas/artifact.schema.ts');
});

test('every entry is a mime and a text flag; the model extensions are allowlisted types', () => {
  const entries = Object.entries(policy.ARTIFACT_TYPES);
  assert.ok(entries.length >= 20, 'canary: the whole list, not a stub');
  for (const [ext, t] of entries) {
    assert.match(ext, /^[a-z0-9]+$/);
    assert.equal(typeof t.mime, 'string');
    assert.equal(typeof t.text, 'boolean');
  }
  for (const ext of policy.ARTIFACT_BINARY_MODEL_EXTS) assert.ok(policy.ARTIFACT_TYPES[ext], ext);
  assert.ok(policy.ARTIFACT_BINARY_MODEL_MAX_BYTES > policy.ARTIFACT_MAX_BYTES);
});

test('artifacts.mjs reads the snapshot: types, caps and the per-scan bound', () => {
  assert.equal(artifactTypeFor('deck.PPTX'), policy.ARTIFACT_TYPES.pptx);
  assert.equal(artifactTypeFor('x.exe'), null);
  assert.equal(artifactMaxBytesFor('mesh.glb'), policy.ARTIFACT_BINARY_MODEL_MAX_BYTES);
  assert.equal(artifactMaxBytesFor('mesh.gltf'), policy.ARTIFACT_MAX_BYTES);
  assert.equal(ARTIFACT_MAX_FILES, policy.ARTIFACT_MAX_PER_OWNER);
});

/**
 * AN OBJ'S MATERIALS TRAVEL WITH IT (2026-09-27, 0.105.0). A 3D-model bundle
 * written as OBJ names its `.mtl` beside it; before the app's schema listed
 * `mtl` the chair's material file was reported by name and never uploaded, so
 * the viewer loaded a grey mesh. It is a text model file at the ordinary cap —
 * only `.glb`/`.bin` take the binary model cap.
 */
test('.mtl is an uploadable text model file at the ordinary cap', () => {
  assert.deepEqual(policy.ARTIFACT_TYPES.mtl, { mime: 'model/mtl', text: true });
  assert.equal(artifactTypeFor('chair/chair.MTL'), policy.ARTIFACT_TYPES.mtl);
  assert.equal(artifactMaxBytesFor('chair.mtl'), policy.ARTIFACT_MAX_BYTES);
  assert.ok(!policy.ARTIFACT_BINARY_MODEL_EXTS.includes('mtl'), 'mtl is text, not a binary buffer');
});

test('one daemon copy: no other module spells the allowlist', () => {
  const dir = new URL('./', import.meta.url);
  const hits = readdirSync(dir)
    .filter((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs'))
    .filter((f) => /officedocument\.presentationml|model\/gltf-binary/.test(readFileSync(new URL(f, dir), 'utf8')));
  assert.deepEqual(hits, ['artifactPolicy.mjs']);
});

/**
 * THE SOURCE, when it is here. The app repo sits beside this one on a release
 * box (`../flowviant`, or FLOWVIANT_APP_DIR). Node strips the schema's types
 * on import (22.6+ behind a flag, default from 23.6); where it cannot, or the
 * app is absent, the app repo's own parity test is the check that runs.
 */
const appDir = process.env.FLOWVIANT_APP_DIR ?? resolve(new URL('../../..', import.meta.url).pathname, 'flowviant');
const schemaPath = join(appDir, 'packages/shared/src/schemas/artifact.schema.ts');
test('matches the shared schema entry by entry, when the app repo is beside this one', { skip: !existsSync(schemaPath) && 'no app checkout beside this one' }, async (t) => {
  let shared;
  try {
    shared = await import(pathToFileURL(schemaPath).href);
  } catch (e) {
    t.skip(`this node cannot load TypeScript (${e.code ?? e.message})`);
    return;
  }
  assert.deepEqual(policy.ARTIFACT_TYPES, shared.ARTIFACT_TYPES);
  assert.equal(policy.ARTIFACT_MAX_BYTES, shared.ARTIFACT_MAX_BYTES);
  assert.equal(policy.ARTIFACT_BINARY_MODEL_MAX_BYTES, shared.ARTIFACT_BINARY_MODEL_MAX_BYTES);
  assert.deepEqual(policy.ARTIFACT_BINARY_MODEL_EXTS, [...shared.ARTIFACT_BINARY_MODEL_EXTS]);
  assert.equal(policy.ARTIFACT_MAX_PER_OWNER, shared.ARTIFACT_MAX_PER_OWNER);
});
