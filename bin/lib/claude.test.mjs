/**
 * sawSentinel / blockedId — line-anchored sentinel matching, linear (audit
 * 2026-09-24). Both used to be a `^\s*NAME\s*$`-shaped regex over the whole
 * CLI stdout blob; a long run of whitespace on one line made that quadratic
 * (measured ~0.5s at 40KB there). They are a length-capped line split now,
 * the same shape `taskIdsFromMessage` (worktreeDiff.mjs) already uses.
 *
 * Run: node --test bin/lib/claude.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sawSentinel, blockedId } from './claude.mjs';

test('sawSentinel matches the sentinel only on its OWN line', () => {
  assert.equal(sawSentinel('WIKI_DONE', 'WIKI_DONE'), true);
  assert.equal(sawSentinel('some prose\nWIKI_DONE\nmore prose', 'WIKI_DONE'), true);
  assert.equal(sawSentinel('  WIKI_DONE  ', 'WIKI_DONE'), true, 'surrounding whitespace on the line is fine');
  assert.equal(sawSentinel('', 'WIKI_DONE'), false);
});

test('sawSentinel refuses a mere MENTION of the word in prose', () => {
  // The whole reason this is line-anchored rather than substring matching —
  // an agent explaining what it will NOT do must not trip the sentinel.
  assert.equal(sawSentinel("I won't print WIKI_DONE until it's actually done", 'WIKI_DONE'), false);
  assert.equal(sawSentinel('WIKI_DONE and more on the same line', 'WIKI_DONE'), false);
});

test('sawSentinel ignores an absurdly long line rather than scanning it whole', () => {
  const line = `${'x'.repeat(5000)}WIKI_DONE`;
  assert.equal(sawSentinel(line, 'WIKI_DONE'), false, 'a 5000-char line is over the cap');
  // A short line elsewhere in the same blob still matches.
  assert.equal(sawSentinel(`${line}\nWIKI_DONE`, 'WIKI_DONE'), true);
});

test('sawSentinel does not blow up on a huge trailing run of whitespace', () => {
  // The exact shape the quadratic regex choked on: `Flowviant-Task: id` plus
  // hundreds of thousands of trailing spaces before end-of-line. A 40KB
  // whitespace tail must resolve in milliseconds, not the better part of a
  // second.
  const hostile = `WIKI_DON${' '.repeat(40_000)}E`;
  const t0 = Date.now();
  assert.equal(sawSentinel(hostile, 'WIKI_DONE'), false);
  assert.ok(Date.now() - t0 < 200, 'must resolve in milliseconds, not stall the event loop');
});

test('blockedId reads the id off its own BLOCKED: line', () => {
  assert.equal(blockedId('BLOCKED:card-123'), 'card-123');
  assert.equal(blockedId('some prose\nBLOCKED:card-abc\nmore'), 'card-abc');
  assert.equal(blockedId('  BLOCKED:card-1  '), 'card-1');
});

test('blockedId refuses a BLOCKED: mentioned mid-sentence or with no id', () => {
  assert.equal(blockedId("I won't fabricate a BLOCKED:<id> line"), null);
  assert.equal(blockedId('no sentinel here'), null);
  assert.equal(blockedId('BLOCKED: card-1'), null, 'a space after the colon is not the sentinel shape');
  assert.equal(blockedId(''), null);
});

test('blockedId skips an over-length line rather than scanning it whole', () => {
  const line = `BLOCKED:${'x'.repeat(3000)}`;
  assert.equal(blockedId(line), null);
  assert.equal(blockedId(`${line}\nBLOCKED:card-9`), 'card-9', 'a later short line still matches');
});
