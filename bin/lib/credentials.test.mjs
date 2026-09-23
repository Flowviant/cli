/**
 * `likelyChoiceIndex` — the picker's default row. It PRE-SELECTS and must never
 * be able to auto-serve, so the contract under test is exactly: a UNIQUE
 * name/slug match wins, anything ambiguous or absent returns -1 (start at the
 * top, ask the human).
 *
 * Run: node --test bin/lib/credentials.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { likelyChoiceIndex } from './credentials.mjs';

const P = (name) => ({ name, projectId: name ?? 'x' });

test('a unique match on the repo folder name wins', () => {
  const choices = [P('Calendar'), P('Skadooble'), P('Trader')];
  assert.equal(likelyChoiceIndex(choices, { repoBasename: 'skadooble' }), 1);
});

test('normalisation collapses spaces, case and punctuation', () => {
  const choices = [P('My Project'), P('other')];
  assert.equal(likelyChoiceIndex(choices, { repoBasename: 'my-project' }), 0);
  assert.equal(likelyChoiceIndex([P('pebble-paws')], { repoBasename: 'PebblePaws' }), 0);
});

test('the github repo-name is a second signal', () => {
  const choices = [P('Mainstreet'), P('Emailleable')];
  // Folder is a generic clone dir, but the origin slug names it.
  assert.equal(
    likelyChoiceIndex(choices, { repoBasename: 'work', repoSlugName: 'emailleable' }),
    1
  );
});

test('two projects with the same name are NOT a hint', () => {
  const choices = [P('api'), P('api')];
  assert.equal(likelyChoiceIndex(choices, { repoBasename: 'api' }), -1);
});

test('no match returns -1', () => {
  const choices = [P('one'), P('two')];
  assert.equal(likelyChoiceIndex(choices, { repoBasename: 'three' }), -1);
});

test('no signal at all returns -1', () => {
  assert.equal(likelyChoiceIndex([P('one')], {}), -1);
  assert.equal(likelyChoiceIndex([P('one')], { repoBasename: null, repoSlugName: null }), -1);
});

test('an unnamed project can never be the hint', () => {
  // name null must not match a null/empty want and pre-select a nameless row.
  assert.equal(likelyChoiceIndex([{ name: null, projectId: 'z' }], { repoBasename: '' }), -1);
});

// ── 0.95.0: two projects on one repo ────────────────────────────────────────

import { boundElsewhere, repoCollisions } from './credentials.mjs';

const E = (projectId, repoRoot, name = 'BRIF AI') => ({ projectId, repoRoot, name });

/**
 * THE DUPLICATE THE OWNER MET was two PROJECTS bound to ONE checkout, and the
 * store's answer is a fact about the repo: which entries name the same
 * directory. Compared by realpath like every path here; unbound entries
 * collide with nothing, because nothing has decided about them yet.
 */
test('repoCollisions groups entries bound to one directory and ignores the rest', () => {
  const a = E('fd716bf3', '/home/whuang/brif-ai');
  const b = E('fdcec6a0', '/home/whuang/brif-ai/');
  const other = E('f5f7db90', '/home/w/code/merriam-one', 'Merriam One');
  const unbound = E('deadbeef', null);
  const groups = repoCollisions([other, a, unbound, b]);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].entries.map((e) => e.projectId), ['fd716bf3', 'fdcec6a0']);
  assert.equal(groups[0].repoRoot, '/home/whuang/brif-ai');
  assert.deepEqual(repoCollisions([other, a, unbound]), []);
  assert.deepEqual(repoCollisions([]), []);
});

/**
 * WHAT LOGIN ASKS ABOUT: the projects ALREADY bound to the repo it is running
 * in, other than the one just approved. Re-logging into the same project is an
 * upsert and asks nothing; a login outside any repo has nothing to clash with.
 */
test('boundElsewhere names the other projects on this repo, never the one being logged into', () => {
  const a = E('fd716bf3', '/home/whuang/brif-ai');
  const b = E('fdcec6a0', '/home/whuang/brif-ai');
  const other = E('f5f7db90', '/home/w/code/merriam-one', 'Merriam One');
  assert.deepEqual(boundElsewhere([a, other], '/home/whuang/brif-ai', 'fdcec6a0').map((e) => e.projectId), ['fd716bf3']);
  assert.deepEqual(boundElsewhere([a, b, other], '/home/whuang/brif-ai', 'fd716bf3').map((e) => e.projectId), ['fdcec6a0']);
  assert.deepEqual(boundElsewhere([a, other], '/home/whuang/brif-ai', 'fd716bf3'), []);
  assert.deepEqual(boundElsewhere([a, other], null, 'zzz'), []);
  assert.deepEqual(boundElsewhere([a, other], '/somewhere/else', 'zzz'), []);
});
