/**
 * THE UPLINK SCRUBBER — what every posted line is redacted against
 * (`uplinkScrub.mjs`).
 *
 * The scrubber split out of `env.mjs` (2026-09-26, the SOLID pass). The tests
 * that prove the CHECKOUT'S values reach it stay in `env.test.mjs`, driven
 * through the real scan, because that handoff is the integration that matters;
 * the tests here drive `learnSecrets` directly and pin the redaction policy
 * with no file on disk at all.
 *
 * Run: node --test bin/lib/uplinkScrub.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const env = await import('./uplinkScrub.mjs');

/**
 * EVERY FLOWVIANT CREDENTIAL IS REDACTED BY SHAPE. The machine credential sits
 * in `~/.flowviant/credentials.json` for every project on the box, readable by
 * any turn, and no value list held it — so a turn that read the store and
 * wrote it into an artifact, a trace or an answer shipped it verbatim.
 */
test('an fva_ token is redacted in text and found in bytes, with no list to feed it', () => {
  const token = 'fva_' + 'Ab3_-xYz9'.repeat(4) + 'Qq12'; // 40 chars, the nanoid alphabet
  const out = env.scrub(`{"projects":{"p":{"fleetToken":"${token}"}}}`);
  assert.ok(!out.includes(token));
  assert.match(out, /\[REDACTED:FLOWVIANT_TOKEN\]/);
  assert.equal(env.secretIn(Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(token), Buffer.from([255])])), 'FLOWVIANT_TOKEN');
  // The app's own identification prefix (`fva_` + 8) is not a credential.
  assert.equal(env.scrub('token fva_Ab3xYz9Q (revoked)'), 'token fva_Ab3xYz9Q (revoked)');
  assert.equal(env.secretIn(Buffer.from('plain bytes, nothing here')), null);
});

/**
 * THE POLICY, WITH NO SCAN IN THE WAY. `learnSecrets` is the scrubber's one
 * door: it takes the scan's UNFILTERED values, keeps only what `worthRedacting`
 * says is worth a split/join on the hot path, and merges the process
 * environment's deploy credentials in.
 */
test('learnSecrets arms the scrubber, filtered by shape', () => {
  env.learnSecrets([
    { name: 'API_KEY', value: 'sk-live_9f3aB2xQ7zR' },
    { name: 'NODE_ENV', value: 'development' },
    { name: 'TINY', value: 'ab' },
    { name: 'PORT', value: '3000' },
  ]);
  const out = env.scrub('dev on development, port 3000, flag ab, key sk-live_9f3aB2xQ7zR');
  assert.equal(out, 'dev on development, port 3000, flag ab, key [REDACTED:API_KEY]');
  assert.equal(env.secretIn(Buffer.from('xx sk-live_9f3aB2xQ7zR xx')), 'API_KEY');
  assert.equal(env.secretIn(Buffer.from('development')), null, 'a word is not a secret in bytes either');
});

/**
 * AN EMPTY READ DOES NOT DISARM, AND A NON-EMPTY ONE REPLACES. The file half is
 * only ever replaced by a read that found something; the process half is
 * re-read every time.
 */
test('learnSecrets: an empty read keeps the last list, a new read replaces it', () => {
  env.learnSecrets([{ name: 'OLD_TOKEN', value: 'old-secret-Value_11' }]);
  env.learnSecrets([]);
  assert.match(env.scrub('saw old-secret-Value_11'), /\[REDACTED:OLD_TOKEN\]/, 'an empty read keeps it');

  env.learnSecrets([{ name: 'NEW_TOKEN', value: 'new-secret-Value_22' }]);
  assert.match(env.scrub('saw new-secret-Value_22'), /\[REDACTED:NEW_TOKEN\]/, 'the new value is learnt');
  assert.equal(env.scrub('saw old-secret-Value_11'), 'saw old-secret-Value_11', 'and a real read replaces the old one');

  process.env.CLOUDFLARE_API_TOKEN = 'cf-Tok3n-learnt-4455';
  try {
    env.learnSecrets([]);
    assert.match(env.scrub('cf-Tok3n-learnt-4455'), /\[REDACTED:CLOUDFLARE_API_TOKEN\]/, 'the process half rides every learn');
    assert.match(env.scrub('saw new-secret-Value_22'), /\[REDACTED:NEW_TOKEN\]/, 'beside the file half it kept');
  } finally {
    delete process.env.CLOUDFLARE_API_TOKEN;
  }
});

/**
 * THE REDACTION RULE HAS ONE HOME. Every lane that posts text imports `scrub`
 * from here; a second `[REDACTED:` writer or a second `fva_` shape elsewhere is
 * a second policy that will drift from this one. Comments are stripped (the
 * shape is named in prose); each alternative has its own canary against the
 * home. The walk is the whole daemon (`bin/`, recursively: cli.mjs, lib/,
 * lib/hooks/).
 */
test('only uplinkScrub.mjs writes a redaction or knows the credential shape', () => {
  const root = join(process.cwd(), 'bin');
  const homePath = join(root, 'lib', 'uplinkScrub.mjs');
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const redactRe = /\[REDACTED:\$\{/;
  const shapeRe = /fva_\[/;
  const home = strip(readFileSync(homePath, 'utf8'));
  assert.ok(redactRe.test(home), 'canary: the home still writes the redaction');
  assert.ok(shapeRe.test(home), 'canary: the home still holds the fva_ shape');
  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? (e.name === 'node_modules' ? [] : walk(join(dir, e.name))) : [join(dir, e.name)],
    );
  const files = walk(root).filter((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs') && f !== homePath);
  assert.ok(files.some((f) => f.endsWith(join('bin', 'cli.mjs'))), 'canary: the walk reaches cli.mjs');
  assert.ok(files.some((f) => f.includes(join('lib', 'hooks'))), 'canary: the walk reaches lib/hooks');
  const copies = [];
  for (const f of files) {
    const src = strip(readFileSync(f, 'utf8'));
    if (redactRe.test(src) || shapeRe.test(src)) copies.push(f.slice(root.length + 1));
  }
  assert.deepEqual(copies, [], 'the uplink redaction must have exactly one home');
});
