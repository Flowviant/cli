/**
 * WHAT `/` CAN OFFER — the machine's skill report.
 *
 * This file exists because the feature it covers had NEVER WORKED. Checked
 * against production on 2026-08-25, `agent_tokens.skills` was NULL for every
 * machine credential that has ever existed: the report is learned from the init
 * event of a tab turn, and the only tab turns ever run predated the release that
 * reports one. Nothing failed, because nothing asserted anything — the app
 * correctly rendered no menu for a machine that had never looked, and "never
 * looked" was every machine, forever.
 *
 * Two things are pinned here. The THREE-STATE contract (null = nobody looked,
 * [] = looked and found none, names = looked and found these), because the whole
 * surface hangs off telling ignorance from fact. And the LINE SCAN, because the
 * first cut of the probe read line 1 and stopped — measured-correct with the
 * default model and silently wrong with `--model haiku`, which prints a
 * `system/status` line first and puts init on line 2. That failure is invisible:
 * it looks exactly like the bug the probe was written to fix.
 *
 * Run: node --test bin/lib/skills.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseInitLine, recordSkills, knownSkills } from './runtimes.mjs';

// ── the line scan ────────────────────────────────────────────────────────────

test('init is found when it is NOT the first line — the measured haiku case', () => {
  const stream = [
    JSON.stringify({ type: 'system', subtype: 'status', message: 'using haiku' }),
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 'abc-123', skills: ['caveman'] }),
  ];
  const found = stream.map(parseInitLine).filter(Boolean);
  assert.equal(found.length, 1);
  assert.deepEqual(found[0].skills, ['caveman']);
  assert.equal(found[0].sessionId, 'abc-123');
});

test('a non-JSON line is skipped, never fatal — a CLI warning is not a failure', () => {
  assert.equal(parseInitLine('⚠ some notice printed on stdout'), null);
  assert.equal(parseInitLine(''), null);
});

test('other event types are not init', () => {
  assert.equal(parseInitLine(JSON.stringify({ type: 'assistant' })), null);
  assert.equal(parseInitLine(JSON.stringify({ type: 'system', subtype: 'status' })), null);
});

// An init event carrying no `skills` key IS still the init event: the scan must
// stop there rather than read a whole turn's output hunting for a better one.
test('an init event without skills still ends the scan, and records nothing', () => {
  const got = parseInitLine(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's' }));
  assert.notEqual(got, null);
  assert.equal(got.skills, null);
  assert.equal(got.sessionId, 's');
});

// The session id is what lets the probe delete the transcript it caused. A
// missing one is not an error — it just means there is nothing to clean up by
// name, which is better than guessing at a filename.
test('a missing session id is null, not a guess', () => {
  assert.equal(parseInitLine(JSON.stringify({ type: 'system', subtype: 'init' })).sessionId, null);
});

// ── the three-state report ───────────────────────────────────────────────────

test('a machine that has never looked reports NULL, not an empty list', () => {
  // Fresh module state: nothing has taught it yet.
  assert.equal(knownSkills(), null);
});

test('a machine that looked and found none reports [] — and [] is a FACT', () => {
  recordSkills([]);
  assert.deepEqual(knownSkills(), []);
  // The distinction that matters downstream: the poll SENDS `?skills=` for this
  // and OMITS the param for null, and the app renders an honest empty menu vs
  // no menu at all. Collapsing them would make every unmeasured machine claim
  // it has no skills.
  assert.notEqual(knownSkills(), null);
});

test('names are deduped, sorted and filtered to what could follow a slash', () => {
  recordSkills(['  diagnose  ', 'caveman', 'diagnose', 'plugin:skill', 'not a name', '../etc/passwd']);
  assert.deepEqual(knownSkills(), ['caveman', 'diagnose', 'plugin:skill']);
});

// The order has to be stable or the server writes a "change" on every poll.
test('the same set in a different order produces the same report', () => {
  recordSkills(['b', 'a', 'c']);
  const first = knownSkills().join(',');
  recordSkills(['c', 'b', 'a']);
  assert.equal(knownSkills().join(','), first);
});

test('a non-array is ignored rather than clearing what we knew', () => {
  recordSkills(['caveman']);
  recordSkills(undefined);
  recordSkills('caveman');
  assert.deepEqual(knownSkills(), ['caveman']);
});
