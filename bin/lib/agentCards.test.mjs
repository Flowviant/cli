/**
 * THE CARD-SPEC STASH — the material the AI pre-review reads.
 *
 * The property under test is the one whose failure is invisible: the stash
 * ACCUMULATES ACROSS TURNS. An agent is fed one card per prompt and the server
 * keeps no copy on this disk, so a stash that only ever held the latest card
 * would produce a pre-review that silently judged a four-card branch against
 * card four — with no error anywhere and a confident paragraph on the deck.
 *
 * Run: node --test bin/lib/agentCards.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_STASHED_CARDS, readStash, stashCard } from './agentCards.mjs';

function stashFile(t) {
  const dir = mkdtempSync(join(tmpdir(), 'fv-cards-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'flowviant-agent-cards-ag1');
}

test('it accumulates across turns, in the order the cards were worked', (t) => {
  const path = stashFile(t);
  assert.deepEqual(readStash(path), [], 'no file is "this agent has run no card here"');
  stashCard(path, 'c1', 'id: c1\ntitle: the migration');
  stashCard(path, 'c2', 'id: c2\ntitle: the endpoint');
  stashCard(path, 'c3', 'id: c3\ntitle: the UI');
  const out = readStash(path);
  assert.deepEqual(
    out.map((c) => c.taskId),
    ['c1', 'c2', 'c3'],
    'every card the agent was given, not just the last'
  );
  assert.match(out[0].prompt, /the migration/);
});

/**
 * A RE-DELIVERED CARD IS ONE CARD. The walk's "Needs work" re-queues a link, so
 * the same id is handed out again with whatever the spec says NOW — and the
 * newest spec is the one the agent actually worked from. Two rows for one card
 * would put the same card twice on the review deck.
 */
test('a card handed out twice keeps its newest spec, and its first position', (t) => {
  const path = stashFile(t);
  stashCard(path, 'c1', 'title: original');
  stashCard(path, 'c2', 'title: second card');
  stashCard(path, 'c1', 'title: reworded after a send-back');
  const out = readStash(path);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((c) => c.taskId), ['c1', 'c2']);
  assert.match(out[0].prompt, /reworded/);
});

/**
 * ONE TRUNCATED LINE MUST NOT COST THE OTHERS — the boundary rule this repo
 * keeps for every relayed list. A daemon killed mid-append is the ordinary way
 * to reach this, and losing the whole stash to it would silently degrade the
 * pre-review to "no specs on this box".
 */
test('a half-written line is dropped alone', (t) => {
  const path = stashFile(t);
  stashCard(path, 'c1', 'title: one');
  writeFileSync(path, readFileSync(path, 'utf8') + '{"taskId":"c2","prom\n');
  stashCard(path, 'c3', 'title: three');
  assert.deepEqual(readStash(path).map((c) => c.taskId), ['c1', 'c3']);
});

test('nothing without an id or a spec is written', (t) => {
  const path = stashFile(t);
  assert.equal(stashCard(path, '', 'title: x'), false);
  assert.equal(stashCard(path, 'c1', '   '), false);
  assert.equal(stashCard(null, 'c1', 'title: x'), false, 'no private git dir — swallowed');
  assert.deepEqual(readStash(path), []);
  assert.deepEqual(readStash(null), []);
});

/** A bound on a MACHINE, and the NEWEST survive it: a reviewer reading a grown
 *  agent's branch is reading the work at its end. */
test('it keeps the newest specs past the cap', (t) => {
  const path = stashFile(t);
  for (let i = 0; i < MAX_STASHED_CARDS + 5; i++) stashCard(path, `c${i}`, `title: card ${i}`);
  const out = readStash(path);
  assert.equal(out.length, MAX_STASHED_CARDS);
  assert.equal(out[out.length - 1].taskId, `c${MAX_STASHED_CARDS + 4}`);
});
