import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createToolLog } from './workToolLog.mjs';

/**
 * The tab turn's tool log, driven directly (split out of work.mjs 2026-09-26,
 * SOLID F037). Every rule below is one the transcript's tool cards depend on
 * and none of them was reachable without a real CLI turn before the split.
 */

test('consecutive identical reads collapse into one row with a count', () => {
  const { toolLog, pushToolEvent } = createToolLog('/wt');
  pushToolEvent('Read', { file_path: '/wt/a.js' });
  pushToolEvent('Read', { file_path: '/wt/a.js' });
  pushToolEvent('Read', { file_path: '/wt/b.js' });
  assert.equal(toolLog.ev.length, 2);
  assert.equal(toolLog.ev[0].n, 2);
  assert.equal(toolLog.ev[1].n, undefined, 'a single call carries no count');
});

test('consecutive edits of one file merge, summing their counts and keeping the newest preview', () => {
  const { toolLog, pushToolEvent } = createToolLog('/wt');
  pushToolEvent('Edit', { file_path: '/wt/a.js', old_string: 'x', new_string: 'y\nz' });
  pushToolEvent('Edit', { file_path: '/wt/a.js', old_string: 'p\nq', new_string: 'r' });
  assert.equal(toolLog.ev.length, 1);
  const [row] = toolLog.ev;
  assert.equal(row.n, 2);
  assert.equal(row.a, 3);
  assert.equal(row.d, 3);
  assert.deepEqual(row.dl, ['- p', '- q', '+ r']);
});

test('the plan is one event, moved to where it last changed', () => {
  const { toolLog, pushToolEvent } = createToolLog('/wt');
  pushToolEvent('TodoWrite', { todos: [{ content: 'one', status: 'pending' }] });
  pushToolEvent('Bash', { command: 'ls' });
  pushToolEvent('TodoWrite', { todos: [{ content: 'one', status: 'completed' }] });
  assert.deepEqual(toolLog.ev.map((e) => e.t), ['bash', 'plan']);
  assert.equal(toolLog.ev[1].items[0].s, 'done');
});

test('the cap keeps the newest 60 non-plan rows, counts the shed call-for-call, and never sheds the plan', () => {
  const { toolLog, pushToolEvent } = createToolLog('/wt');
  pushToolEvent('TodoWrite', { todos: [{ content: 'keep me', status: 'in_progress' }] });
  pushToolEvent('Glob', { pattern: 'x' });
  pushToolEvent('Glob', { pattern: 'x' }); // one row, n = 2
  for (let i = 0; i < 60; i += 1) pushToolEvent('Bash', { command: `echo ${i}` });
  assert.equal(toolLog.ev.length, 60);
  assert.ok(toolLog.ev.some((e) => e.t === 'plan'), 'the plan is exempt from the cap');
  assert.ok(!toolLog.ev.some((e) => e.t === 'glob'), 'the oldest non-plan row went first');
  assert.equal(toolLog.dropped, 3, 'the collapsed glob counts both calls, plus one bash');
});

test('a tool the builder does not know renders as nothing', () => {
  const { toolLog, pushToolEvent } = createToolLog('/wt');
  pushToolEvent('SomethingNew', { a: 1 });
  assert.deepEqual(toolLog, { ev: [], dropped: 0 });
});
