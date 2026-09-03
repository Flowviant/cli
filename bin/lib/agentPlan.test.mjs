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

// ── An agent's answer at the end of a turn ──────────────────────────────────

test('reads a delivery, with and without raised cards', async () => {
  const { parseTurnResult } = await import('./agentPlan.mjs');
  const plain = parseTurnResult('```json\n{"status":"delivered","summary":"did it"}\n```');
  assert.equal(plain.outcome, 'delivered');
  assert.equal(plain.answer, 'did it');
  assert.deepEqual(plain.raised, []);

  const withRaised = parseTurnResult(
    JSON.stringify({
      status: 'delivered',
      summary: 's',
      raised: [{ title: 'flaky test', brief: 'it was already failing' }],
    })
  );
  assert.equal(withRaised.raised.length, 1);
  assert.equal(withRaised.raised[0].title, 'flaky test');
});

test('reads a block as a question', async () => {
  const { parseTurnResult } = await import('./agentPlan.mjs');
  const out = parseTurnResult(JSON.stringify({ status: 'blocked', question: 'which auth?' }));
  assert.equal(out.outcome, 'question');
  assert.equal(out.answer, 'which auth?');
});

// A "blocked" with no question parks an agent with nothing to reply to. Falling
// through to null says truthfully that the machine went quiet instead.
test('refuses a block that asks nothing', async () => {
  const { parseTurnResult } = await import('./agentPlan.mjs');
  assert.equal(parseTurnResult(JSON.stringify({ status: 'blocked' })), null);
  assert.equal(parseTurnResult(JSON.stringify({ status: 'blocked', question: '   ' })), null);
});

// NULL IS THE MOST IMPORTANT ANSWER. Anything ambiguous must end up here rather
// than being read as success — optimistic status from a machine that quit is
// the one lie this board cannot afford.
test('returns null for anything that did not declare an outcome', async () => {
  const { parseTurnResult } = await import('./agentPlan.mjs');
  assert.equal(parseTurnResult(''), null);
  assert.equal(parseTurnResult('I got about halfway and then ran out of context.'), null);
  assert.equal(parseTurnResult(JSON.stringify({ status: 'done' })), null);
  assert.equal(parseTurnResult(JSON.stringify({ summary: 'did it' })), null);
});

// A delivery buried after prose still counts — the turn ran and was paid for.
test('finds the object after prose, and ignores a decoy brace', async () => {
  const { parseTurnResult } = await import('./agentPlan.mjs');
  const out = parseTurnResult(
    'I touched {config} and then finished.\n```json\n{"status":"delivered","summary":"ok"}\n```'
  );
  assert.equal(out.outcome, 'delivered');
});
