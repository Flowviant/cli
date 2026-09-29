/**
 * A CARD HAS A TYPE (0.106.0) — a Bug fix, a Refactor, a Code review: a
 * flavour over the card's kind. The server sends the id; the daemon owns the
 * words and prints the type with its one contract sentence inside THE CARD,
 * right after the kind line, so the pre-review's stash reads it too. What is
 * pinned: the table (every type, on a kind this daemon runs, with its label
 * and one sentence); the reader (absent and unknown are no type, a type on
 * another kind is none); the spec, the kickoffs and the planner's listing;
 * and that every job without a type is byte-for-byte what 0.105.0 printed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as prompts from './prompts.mjs';
import { AGENT_TASK_KINDS } from './agentTaskKinds.mjs';
import { AGENT_TASK_TYPES, agentTaskTypeFor, agentTaskTypeOf } from './agentTaskTypes.mjs';

const ORDER = [
  'feature', 'fix', 'tests', 'refactor', 'infra', 'automation', 'review',
  'ui', 'prototype', 'slides', 'model3d', 'vector', 'image', 'research', 'writing',
];

test('the table: fifteen types in the app’s order, each on a kind this daemon runs, with a label and one sentence', () => {
  assert.deepEqual(Object.keys(AGENT_TASK_TYPES), ORDER);
  for (const [id, t] of Object.entries(AGENT_TASK_TYPES)) {
    assert.ok(Object.hasOwn(AGENT_TASK_KINDS, t.kind), `${id} runs as a known kind`);
    assert.ok(typeof t.label === 'string' && t.label.length > 0, `${id} has a label`);
    // ONE sentence: one line, one full stop at its end, nothing after it.
    assert.ok(!t.contract.includes('\n'), `${id}: one line`);
    assert.match(t.contract, /^[a-z][^]*\.$/, `${id}: a sentence that follows the dash`);
    assert.ok(!/\.\s+[A-Z]/.test(t.contract), `${id}: one sentence`);
    assert.ok(t.contract.length <= 200, `${id}: short`);
  }
  assert.ok(Object.isFrozen(AGENT_TASK_TYPES) && Object.isFrozen(AGENT_TASK_TYPES.fix));
});

test('each sentence says what its type adds, true to its kind’s posture', () => {
  const c = (id) => AGENT_TASK_TYPES[id].contract;
  assert.match(c('fix'), /^reproduce it first, with a failing test where the repository has tests, then make that test pass\.$/);
  assert.match(c('tests'), /change no production code; if a test exposes a bug, say so in your summary instead of fixing it/);
  assert.match(c('refactor'), /behaviour must not change; if an existing test would have to change, stop and ask/);
  assert.match(c('infra'), /never run a deploy or touch a live environment/);
  // Nothing dispatches itself: an automation card ADDS the job and never runs it.
  assert.match(c('automation'), /add the scheduled job to the repository[^]*do not run it\.$/);
  assert.match(c('review'), /by file and line, most serious first; change nothing\.$/);
  assert.match(c('vector'), /its own \.svg file directly in \.flowviant\/artifacts\//);
  assert.match(c('prototype'), /every control in the flow work, with realistic sample data, in the one page/);
  // THE IMAGE TYPE (0.114.0): a generated picture, handed back as files the
  // image kind's proof accepts — never a page or a drawing in code.
  assert.equal(
    c('image'),
    'generate the picture the card describes with your image tool, at the size and in the style it names, ' +
      'and hand back each image it asks for as its own PNG or WebP file.'
  );
  assert.equal(AGENT_TASK_TYPES.image.kind, 'image');
  assert.equal(AGENT_TASK_TYPES.image.label, 'Image');
  // A non-code type never asks for a commit or a test run, and a code type
  // never asks for an artifact: each stays inside its kind's posture.
  for (const [id, t] of Object.entries(AGENT_TASK_TYPES)) {
    if (t.kind === 'code') assert.ok(!t.contract.includes('.flowviant/artifacts'), id);
    else assert.ok(!/\bcommit|\btests?\b/.test(t.contract), id);
  }
});

test('the reader: absent and unknown are no type; a type on another kind is none', () => {
  for (const v of [undefined, null, '', 'Fix', 'video', 'audio', 'Image', 7, {}]) assert.equal(agentTaskTypeOf(v), null, String(v));
  for (const id of ORDER) assert.equal(agentTaskTypeOf(id), id);
  assert.equal(agentTaskTypeFor({ taskType: 'fix' }), 'fix');
  assert.equal(agentTaskTypeFor({ taskType: 'review', taskKind: 'research' }), 'review');
  // Absent kind IS code, so a write-up type with no kind is not printed.
  assert.equal(agentTaskTypeFor({ taskType: 'review' }), null);
  assert.equal(agentTaskTypeFor({ taskType: 'fix', taskKind: 'design' }), null);
  assert.equal(agentTaskTypeFor({ taskType: 'video' }), null);
  // The Image type is printed on its own kind only (0.114.0).
  assert.equal(agentTaskTypeFor({ taskType: 'image', taskKind: 'image' }), 'image');
  assert.equal(agentTaskTypeFor({ taskType: 'image' }), null, 'absent kind is code, not image');
  assert.equal(agentTaskTypeFor({ taskType: 'image', taskKind: 'design' }), null);
  assert.equal(agentTaskTypeFor(undefined), null);
});

const code = { id: 't1', title: 'Fix login', brief: 'b', criteria: ['c'] };
/** What 0.105.0 printed for this card — the byte-identity baseline. */
const BARE = 'id: t1\ntitle: Fix login\n\nbrief:\nb\n\ndone when:\n- c\n';

test('the spec prints the type and its sentence right after the kind line', () => {
  assert.equal(
    prompts.AGENT_TASK_SPEC({ ...code, taskType: 'fix' }),
    'id: t1\ntitle: Fix login\n' +
      'type: Bug fix — reproduce it first, with a failing test where the repository has tests, then make that test pass.\n' +
      '\nbrief:\nb\n\ndone when:\n- c\n'
  );
  assert.match(
    prompts.AGENT_TASK_SPEC({ ...code, taskKind: 'research', taskType: 'review' }),
    /^id: t1\ntitle: Fix login\nkind: research\ntype: Code review — read the code the card names/
  );
  for (const id of ORDER) {
    const t = AGENT_TASK_TYPES[id];
    const spec = prompts.AGENT_TASK_SPEC({ ...code, taskKind: t.kind, taskType: id });
    assert.ok(spec.includes(`\ntype: ${t.label} — ${t.contract}\n`), id);
  }
});

test('every spec without a type is byte-for-byte 0.105.0’s — absent, unknown, or on another kind', () => {
  assert.equal(prompts.AGENT_TASK_SPEC(code), BARE);
  for (const taskType of [undefined, null, 'video', 'Fix', 'review']) {
    assert.equal(prompts.AGENT_TASK_SPEC({ ...code, taskType }), BARE, String(taskType));
  }
  const design = { ...code, taskKind: 'design' };
  assert.equal(prompts.AGENT_TASK_SPEC({ ...design, taskType: 'fix' }), prompts.AGENT_TASK_SPEC(design));
});

test('the type rides inside THE CARD on a task turn, code and artifact alike, and on a human turn’s card', () => {
  const k = prompts.AGENT_TASK_KICKOFF({ agentName: 'a', task: { ...code, taskType: 'refactor' }, position: 1, total: 2 });
  const card = k.slice(k.indexOf('THE CARD'), k.indexOf('Flowviant-Task:'));
  assert.match(card, /\ntype: Refactor — behaviour must not change; if an existing test would have to change, stop and ask\.\n/);
  const d = prompts.AGENT_TASK_KICKOFF({
    agentName: 'a', task: { ...code, taskKind: 'design', taskType: 'prototype' }, position: 1, total: 1,
  });
  assert.match(d, /THE CARD[^]*\nkind: design\ntype: Prototype — make every control/);
  const h = prompts.AGENT_HUMAN_KICKOFF({
    agentName: 'a', message: 'keep going', task: { ...code, taskType: 'tests' }, position: 1, total: 1,
  });
  assert.match(h, /THE CARD YOU ARE ON[^]*\ntype: Tests — add tests for code that already exists/);
  // Canary: the same kickoff with no type carries no type line.
  assert.ok(!prompts.AGENT_TASK_KICKOFF({ agentName: 'a', task: code, position: 1, total: 2 }).includes('type:'));
});

test('the planner lists each typed card’s type by its label, under its kind, and nothing else changes', () => {
  const plan = {
    tasks: [
      { id: 'c1', title: 'Fix login', criteria: [] },
      { id: 'r1', title: 'Audit auth', taskKind: 'research', criteria: [] },
    ],
    liveAgents: [],
    agentCap: 2,
  };
  const typed = {
    ...plan,
    tasks: [{ ...plan.tasks[0], taskType: 'fix' }, { ...plan.tasks[1], taskType: 'review' }],
  };
  const k = prompts.AGENT_PLAN_KICKOFF(typed);
  assert.match(k, /id: c1\n  title: Fix login\n  kind: code\n  type: Bug fix\n/);
  assert.match(k, /id: r1\n  title: Audit auth\n  kind: research\n  type: Code review\n/);
  // The contract sentence is the worker's, not the planner's.
  assert.ok(!k.includes('reproduce it first'));
  // Byte-identical without a type — absent, unknown, or on another kind.
  const bare = prompts.AGENT_PLAN_KICKOFF(plan);
  for (const taskType of [undefined, 'video']) {
    assert.equal(prompts.AGENT_PLAN_KICKOFF({ ...plan, tasks: plan.tasks.map((t) => ({ ...t, taskType })) }), bare);
  }
  assert.equal(
    prompts.AGENT_PLAN_KICKOFF({ ...plan, tasks: [{ ...plan.tasks[0], taskType: 'slides' }, plan.tasks[1]] }),
    bare
  );
});
