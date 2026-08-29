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
