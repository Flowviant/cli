/**
 * ONE TURN'S TOKENS, SUMMED ACROSS ITS SPAWNS (2026-09-28) — `addUsage`, the
 * one adder the Terminal tab, the capture chat, the planner and the wiki use
 * before their one report carries the turn's spend.
 *
 * Run: node --test bin/lib/turnUsage.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addUsage } from './turnUsage.mjs';

test('the four counters add, and the CLI that counted them is kept', () => {
  assert.deepEqual(
    addUsage(
      { input: 10, output: 2, cacheCreate: 300, cacheRead: 4000, runtime: 'claude' },
      { input: 1, output: 20, cacheCreate: 0, cacheRead: 5, runtime: 'claude' }
    ),
    { input: 11, output: 22, cacheCreate: 300, cacheRead: 4005, runtime: 'claude' }
  );
});

test('nothing reported on either side is null, never four zeros', () => {
  assert.equal(addUsage(null, null), null);
  assert.equal(addUsage(undefined, undefined), null);
});

test('one side missing is the other side, normalized', () => {
  const u = { input: 3, output: 4, cacheCreate: 5, cacheRead: 6, runtime: 'codex' };
  assert.deepEqual(addUsage(null, u), u);
  assert.deepEqual(addUsage(u, null), u);
  assert.notEqual(addUsage(null, u), u, 'a copy, never the caller’s object');
});

test('garbage counters add nothing and poison nothing', () => {
  assert.deepEqual(addUsage({ input: 'x', output: -4, cacheCreate: NaN, cacheRead: Infinity }, { input: 2.9, output: '7' }), {
    input: 2,
    output: 7,
    cacheCreate: 0,
    cacheRead: 0,
  });
});
