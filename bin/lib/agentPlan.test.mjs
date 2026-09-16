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
import { SYSTEM_PLAN } from './prompts.mjs';

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

// ── The split is for PARALLELISM, so there is no way to say "wait" ──────────

/**
 * A STRAY `waitsOn` IS DROPPED, AND THE PROPOSAL AROUND IT STANDS.
 *
 * The planner's schema used to carry it; the owner deleted the idea — "whats
 * the point of dividing up the agents if one of the agents rely on waiting for
 * one to finish? if thats the case have it be in the same agent" — and
 * SYSTEM_PLAN no longer mentions the key. A model emitting one anyway is
 * answering a schema it was not given (an older prompt cached in a resumed
 * conversation, or invention), and reading it would create a silently-waiting
 * agent through the exact door the prompt closed.
 *
 * DROPPED rather than REFUSED, on this file's own law: lenient packaging,
 * strict shape. A stray key is packaging, and refusing the whole plan over one
 * would throw away a turn the operator already paid for.
 */
test('drops a waitsOn the model was never asked for, and keeps the rest', () => {
  const out = parseProposal(
    JSON.stringify({
      note: 'split by surface',
      agents: [
        { tempId: 'a1', name: 'auth', taskIds: ['t1'] },
        { tempId: 'a2', name: 'billing', taskIds: ['t2'], waitsOn: ['a1'], pointsBudget: 8 },
      ],
    })
  );
  assert.equal(out.agents.length, 2);
  assert.equal(out.note, 'split by surface');
  for (const a of out.agents) assert.equal('waitsOn' in a, false);
  // Everything beside it on the same agent survives — the key is dropped, the
  // agent is not.
  assert.equal(out.agents[1].name, 'billing');
  assert.equal(out.agents[1].taskIds[0], 't2');
  assert.equal(out.agents[1].pointsBudget, 8);
});

/**
 * THE PROMPT DOES NOT OFFER THE WORD — an ABSENCE, with a positive anchor.
 *
 * A rule the model can still express a violation of is one it will sometimes
 * express a violation of, so the vocabulary is gone rather than discouraged.
 * The anchors are asserted FIRST and deliberately: an absence pin over a string
 * that has moved, been renamed or gone empty passes forever while proving
 * nothing, which is a failure this repo has shipped more than once.
 *
 * Scoped to SYSTEM_PLAN and nothing wider, because `waitsOn` is ALIVE
 * elsewhere: SYSTEM_AGENT's `update_cards` uses it for card-level ordering, and
 * the server still reads it off stored proposals from 0.86.0 daemons.
 */
test('SYSTEM_PLAN still states the answer schema, and never the word waitsOn', () => {
  assert.ok(SYSTEM_PLAN.includes('```json'), 'the schema block is still fenced');
  assert.ok(SYSTEM_PLAN.includes('"taskIds"'));
  assert.ok(SYSTEM_PLAN.includes('"pointsBudget"'));
  assert.ok(SYSTEM_PLAN.includes('"intoAgentId"'));
  assert.ok(
    SYSTEM_PLAN.includes('SEQUENTIAL WORK BELONGS IN ONE AGENT'),
    'rule 1 is where the reasoning lives'
  );
  assert.ok(!SYSTEM_PLAN.includes('waitsOn'), 'a wait is a split done wrong');
});

/** `intoAgentId` sits directly beside it in the source and is a DIFFERENT
 *  thing: adding cards to an agent that already exists, which the prompt still
 *  asks for. Deleting the wrong arm is the plausible slip. */
test('intoAgentId survives the removal of waitsOn', () => {
  const out = parseProposal(
    JSON.stringify({
      agents: [{ tempId: 'a1', taskIds: ['t1'], waitsOn: ['a0'], intoAgentId: 'agent-9' }],
    })
  );
  assert.equal(out.agents[0].intoAgentId, 'agent-9');
  assert.equal('waitsOn' in out.agents[0], false);
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
