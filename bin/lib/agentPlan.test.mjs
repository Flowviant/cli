/**
 * READING A PLANNER'S ANSWER.
 *
 * The failure this guards against is not a crash — it is a proposal that parses
 * into something plausible and wrong, which somebody then accepts. So the tests
 * are mostly about what must be REFUSED.
 *
 * Run: node --test bin/lib/agentPlan.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseProposal } from './agentPlan.mjs';

const plan = { agents: [{ tempId: 'a1', name: 'auth', taskIds: ['t1', 't2'] }] };

test('reads a fenced object', () => {
  const out = parseProposal('```json\n' + JSON.stringify(plan) + '\n```');
  assert.equal(out.agents.length, 1);
  assert.deepEqual(out.agents[0].taskIds, ['t1', 't2']);
});

test('reads a bare object, and one with prose around it', () => {
  assert.ok(parseProposal(JSON.stringify(plan)));
  assert.ok(parseProposal(`Here you go:\n${JSON.stringify(plan)}\nHope that helps.`));
});

// A planner that wrote a sentence containing a brace must not truncate its own
// plan — the fallback spans the OUTERMOST braces on purpose.
test('survives a brace in the prose before the object', () => {
  const out = parseProposal(`I looked at {the auth module} first.\n${JSON.stringify(plan)}`);
  assert.equal(out.agents[0].name, 'auth');
});

test('refuses anything it cannot turn into agents', () => {
  assert.equal(parseProposal(''), null);
  assert.equal(parseProposal('I could not work out how to split this.'), null);
  assert.equal(parseProposal('```json\n{ not json }\n```'), null);
  assert.equal(parseProposal(JSON.stringify({ agents: 'auth' })), null);
  assert.equal(parseProposal(JSON.stringify({ note: 'hi' })), null);
});

// AN AGENT WITH NO CARDS IS NOT AN AGENT. Accepting one would cut a worktree
// and a branch for nothing, and leave it in Working forever with an empty
// queue.
test('drops an agent holding no cards, and refuses a plan of only those', () => {
  const mixed = parseProposal(
    JSON.stringify({ agents: [{ tempId: 'a1', taskIds: [] }, { tempId: 'a2', taskIds: ['t1'] }] })
  );
  assert.equal(mixed.agents.length, 1);
  assert.equal(mixed.agents[0].tempId, 'a2');
  assert.equal(parseProposal(JSON.stringify({ agents: [{ tempId: 'a1', taskIds: [] }] })), null);
});

test('keeps only string task ids', () => {
  const out = parseProposal(
    JSON.stringify({ agents: [{ tempId: 'a1', taskIds: ['t1', 42, null, '', 't2'] }] })
  );
  assert.deepEqual(out.agents[0].taskIds, ['t1', 't2']);
});

// A budget of zero is not a budget: zero is the absence of a size, and an agent
// budgeted at zero would stop before it started.
test('treats a zero or negative budget as absent', () => {
  const zero = parseProposal(
    JSON.stringify({ agents: [{ tempId: 'a1', taskIds: ['t1'], pointsBudget: 0 }] })
  );
  assert.equal('pointsBudget' in zero.agents[0], false);
  const neg = parseProposal(
    JSON.stringify({ agents: [{ tempId: 'a1', taskIds: ['t1'], pointsBudget: -5 }] })
  );
  assert.equal('pointsBudget' in neg.agents[0], false);
});

test('names an agent even when the planner did not', () => {
  const out = parseProposal(JSON.stringify({ agents: [{ taskIds: ['t1'] }] }));
  assert.equal(out.agents[0].tempId, 'a1');
  assert.equal(out.agents[0].name, '');
});

// This is model output about untrusted card content, and it becomes a row.
test('caps every string it carries', () => {
  const out = parseProposal(
    JSON.stringify({
      note: 'n'.repeat(5000),
      agents: [{ tempId: 'a1', name: 'x'.repeat(500), taskIds: ['t1'] }],
    })
  );
  assert.equal(out.agents[0].name.length, 80);
  assert.equal(out.note.length, 1000);
});
