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

/**
 * THE AGENT'S RUNNING ACCOUNT OF THE BRANCH (2026-09-22, 0.93.0) — the key that
 * must be OMITTED rather than emptied.
 *
 * The owner: "we should add a brief summary of what the agent has done overall
 * at the top that updates." `progress` rides the settle body straight into a
 * stored column, and the whole contract between the two halves is that an
 * ABSENT key means "keep the last account that was true" — so a turn that did
 * not write one must produce no key at all. An empty string would be
 * indistinguishable, at the server, from an agent saying this branch now
 * amounts to nothing, and it would blank the top of somebody's run because a
 * model dropped a field.
 *
 * ON BOTH SHAPES, because a turn that stopped to ask has still done work.
 */
test('carries the running account, on a delivery and on a question alike', async () => {
  const { parseTurnResult } = await import('./agentPlan.mjs');
  const delivered = parseTurnResult(
    JSON.stringify({
      status: 'delivered',
      summary: 'wired the route',
      progress: '  Added the column and the route. Wired the head to read it.  ',
    })
  );
  assert.equal(delivered.outcome, 'delivered');
  // TRIMMED, so leading whitespace cannot survive into a paragraph rendered at
  // the top of a page.
  assert.equal(delivered.progress, 'Added the column and the route. Wired the head to read it.');
  // …and the per-card summary is untouched beside it. They answer different
  // questions — this card, versus the branch — and a reader of either must
  // never be handed the other.
  assert.equal(delivered.answer, 'wired the route');

  const blocked = parseTurnResult(
    JSON.stringify({
      status: 'blocked',
      question: 'which auth?',
      progress: 'Read the two auth paths and changed nothing yet.',
    })
  );
  assert.equal(blocked.outcome, 'question');
  assert.equal(blocked.progress, 'Read the two auth paths and changed nothing yet.');
});

test('omits the key entirely when the turn wrote no account', async () => {
  const { parseTurnResult } = await import('./agentPlan.mjs');
  // AN OLDER PROMPT, a resumed conversation that never saw the key, or a model
  // that simply dropped it. Each must leave the stored account standing.
  const absent = parseTurnResult(JSON.stringify({ status: 'delivered', summary: 's' }));
  assert.equal('progress' in absent, false);
  // WHITESPACE IS NOT AN ACCOUNT, and neither is a non-string. `in` rather than
  // a truthiness check, because `{ progress: '' }` would spread onto the settle
  // body and reach the column.
  for (const bad of ['', '   ', 42, null, { text: 'x' }, ['x']]) {
    const out = parseTurnResult(JSON.stringify({ status: 'delivered', summary: 's', progress: bad }));
    assert.equal('progress' in out, false, `progress must not survive ${JSON.stringify(bad)}`);
  }
  const q = parseTurnResult(JSON.stringify({ status: 'blocked', question: 'which?' }));
  assert.equal('progress' in q, false);
});

/**
 * THE PROMPT HAS TO ASK FOR IT ON BOTH SHAPES, or the parser above reads a key
 * nothing was ever told to write.
 *
 * This is the half that is invisible when it breaks: drop `progress` out of the
 * blocked example and every delivered turn still carries an account, so the
 * feature looks like it works — and the one run where somebody most wants to
 * know what has been done, the stalled one waiting on an answer, is the one
 * that silently has nothing at the top of it.
 */
test('the work contract asks for the account on the delivered AND the blocked shape', async () => {
  const { SYSTEM_AGENT } = await import('./prompts.mjs');
  const shapes = SYSTEM_AGENT.split('```json')
    .slice(1)
    .map((b) => b.slice(0, b.indexOf('```')))
    // The prose above the examples says "in a ```json fence:", which splits
    // like an opener and holds no object. The shapes are the ones that do.
    .filter((b) => b.trimStart().startsWith('{'));
  assert.equal(shapes.length, 2, 'the contract draws exactly two shapes');
  for (const shape of shapes) {
    assert.ok(shape.includes('"progress"'), `every shape must ask for it: ${shape}`);
  }
  // Positive anchor on the pair, so a rename of one status cannot leave this
  // asserting twice over the survivor.
  assert.ok(shapes.some((b) => b.includes('"delivered"')));
  assert.ok(shapes.some((b) => b.includes('"blocked"')));
  // …and it must say what the account IS, or a model writes the card summary
  // twice. The two things it has to state: it is cumulative across the branch,
  // and it REPLACES rather than appends.
  assert.match(SYSTEM_AGENT, /REPLACES the previous one whole/);
  assert.match(SYSTEM_AGENT, /SO FAR/);
});

/**
 * BOUNDED HERE, BUT ABOVE THE WIRE'S CUT — and the gap is the whole point
 * (corrected 2026-09-22, in review).
 *
 * This parser used to slice to the wire's own 1000, which INVERTED the order
 * `work.mjs` states it keeps: `envScrub` replaces EXACT values, so a paragraph
 * cut at 1000 before the scrub ever sees it hands the scrub a credential cut in
 * half — it matches nothing and the surviving prefix ships. The cap a reader
 * SEES belongs after the scrub; what belongs here is the absurdity bound
 * `summary` beside it already takes, so a model that answered with its whole
 * transcript still cannot reach the caller unbounded.
 *
 * Both numbers are asserted, because a bound equal to the wire's cut is exactly
 * the bug this replaced and reads identically on the happy path.
 */
test('bounds the account for absurdity, and leaves the display cap to the scrub', async () => {
  const { parseTurnResult } = await import('./agentPlan.mjs');
  const out = parseTurnResult(
    JSON.stringify({ status: 'delivered', summary: 's', progress: 'x'.repeat(40_000) })
  );
  assert.equal(out.progress.length, 8000);
  // A paragraph a person might actually get is untouched here — the cut that
  // shortens it happens on the far side of `envScrub`, in `work.mjs`.
  const long = parseTurnResult(
    JSON.stringify({ status: 'delivered', summary: 's', progress: 'y'.repeat(4000) })
  );
  assert.equal(long.progress.length, 4000);
});

// A delivery buried after prose still counts — the turn ran and was paid for.
test('finds the object after prose, and ignores a decoy brace', async () => {
  const { parseTurnResult } = await import('./agentPlan.mjs');
  const out = parseTurnResult(
    'I touched {config} and then finished.\n```json\n{"status":"delivered","summary":"ok"}\n```'
  );
  assert.equal(out.outcome, 'delivered');
});

// ── THE AI PRE-REVIEW's ANSWER ────────────────────────────────────────────────
//
// The strict half bites harder here than anywhere else in this file: this text
// is rendered on the surface where somebody decides whether a branch reaches
// main, and a precheck that posts NOTHING costs a label nobody was promised.

test('reads a triage, fence and all', async () => {
  const { parsePrecheck } = await import('./agentPlan.mjs');
  const out = parsePrecheck(
    'Here you go:\n```json\n' +
      JSON.stringify({
        cards: [
          { taskId: 'c1', verdict: 'ok', note: '' },
          { taskId: 'c2', verdict: 'concerns', note: 'the migration drops a column nothing re-adds' },
        ],
        overall: 'read c2 first',
      }) +
      '\n```'
  );
  assert.equal(out.cards.length, 2);
  assert.equal(out.cards[0].verdict, 'ok');
  assert.equal(out.cards[0].note, undefined, 'an empty note is absent, never an empty string');
  assert.match(out.cards[1].note, /drops a column/);
  assert.equal(out.overall, 'read c2 first');
});

/**
 * A MALFORMED ANSWER POSTS NOTHING. Every shape here is one a model reaches:
 * the right punctuation with no content, a verdict word nobody listed, a card
 * with no id. None of them may become a paragraph on the review deck.
 */
test('returns null for anything that is not a readable triage', async () => {
  const { parsePrecheck } = await import('./agentPlan.mjs');
  assert.equal(parsePrecheck(''), null);
  assert.equal(parsePrecheck('The branch looks fine to me.'), null);
  assert.equal(parsePrecheck('{"cards":'), null, 'truncated JSON is not a triage');
  assert.equal(parsePrecheck(JSON.stringify({ overall: '' })), null, 'no cards key at all');
  assert.equal(
    parsePrecheck(JSON.stringify({ cards: [], overall: '   ' })),
    null,
    'right punctuation, no content'
  );
  assert.equal(
    parsePrecheck(JSON.stringify({ cards: [{ taskId: 'c1', verdict: 'looks-good' }] })),
    null,
    'an unlisted verdict is DROPPED, never coerced to ok'
  );
  assert.equal(
    parsePrecheck(JSON.stringify({ cards: [{ verdict: 'ok', note: 'x' }] })),
    null,
    'a note nobody can attach to a card is not a triage'
  );
});

/**
 * SCRUBBED BEFORE IT IS CUT, and this test is the behavioural half of the
 * source pin in `work.test.mjs` (review, 2026-09-17).
 *
 * The lane shipped `envScrub(note).slice(0, 400)` over a note this parser had
 * ALREADY cut to 400 — and `scrub` is an EXACT FULL-VALUE replace, so a secret
 * straddling the cap arrived pre-severed, matched nothing, and its prefix was
 * stored and rendered to every member of the project. The reviewer reads a
 * worktree holding the project's materialized dev secrets, so a note quoting a
 * `.env` line is the ordinary way to reach this. Both fields straddle their own
 * cap here on purpose.
 */
test('a secret straddling the cap is redacted, not severed', async () => {
  const { parsePrecheck } = await import('./agentPlan.mjs');
  const SECRET = `sk-live-${'z'.repeat(40)}`;
  const scrub = (s) => s.split(SECRET).join('[REDACTED:API_KEY]');
  const out = parsePrecheck(
    JSON.stringify({
      // The secret starts 20 chars before the 400-cap and 20 before the 1200.
      cards: [{ taskId: 'c1', verdict: 'concerns', note: `${'a'.repeat(380)}${SECRET} tail` }],
      overall: `${'b'.repeat(1180)}${SECRET} tail`,
    }),
    scrub
  );
  for (const field of [out.cards[0].note, out.overall]) {
    assert.ok(!field.includes('sk-live-'), 'not even the prefix survives');
    assert.ok(field.includes('[REDACTED:API_KEY]'), 'the whole value matched and was replaced');
  }
  // …and the caps still hold: redacting first must not grow the row past what
  // the server and the deck will take.
  assert.ok(out.cards[0].note.length <= 400);
  assert.ok(out.overall.length <= 1200);
  // An un-scrubbed call is still a legal call — the default is identity, so a
  // caller that forgets loses redaction rather than the whole reading.
  assert.ok(parsePrecheck(JSON.stringify({ cards: [], overall: 'plain' })).overall === 'plain');
});

// An `overall` on its own IS an answer — the reviewer gets the paragraph even
// when the model forgot to judge the cards one by one.
test('keeps an overall with no readable cards', async () => {
  const { parsePrecheck } = await import('./agentPlan.mjs');
  const out = parsePrecheck(JSON.stringify({ cards: [{ verdict: 'nonsense' }], overall: 'careful' }));
  assert.deepEqual(out, { cards: [], overall: 'careful' });
});

// ONE ENTRY PER CARD, first wins: a model that judged a card twice contradicted
// itself, and two notes on one card face asks the reviewer to arbitrate.
test('keeps the first verdict per card and caps what it keeps', async () => {
  const { parsePrecheck } = await import('./agentPlan.mjs');
  const out = parsePrecheck(
    JSON.stringify({
      cards: [
        { taskId: 'c1', verdict: 'concerns', note: 'first' },
        { taskId: 'c1', verdict: 'ok', note: 'second' },
      ],
      overall: 'x'.repeat(5000),
    })
  );
  assert.equal(out.cards.length, 1);
  assert.equal(out.cards[0].note, 'first');
  assert.equal(out.overall.length, 1200);
});

test('caps a note at the length the prompt asked for', async () => {
  const { parsePrecheck } = await import('./agentPlan.mjs');
  const out = parsePrecheck(
    JSON.stringify({ cards: [{ taskId: 'c1', verdict: 'concerns', note: 'y'.repeat(2000) }] })
  );
  assert.equal(out.cards[0].note.length, 400);
});
