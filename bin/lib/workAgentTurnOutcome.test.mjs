import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentTurnSettlement, failedTurnSettlement } from './workAgentTurnOutcome.mjs';
import { AGENT_TASK_KINDS } from './agentTaskKinds.mjs';
import { snapshotArtifacts } from './artifacts.mjs';

/**
 * WHAT A RAN TURN REPORTS, as a round trip (SOLID F036).
 *
 * These rules were source pins while they sat behind a CLI this suite never
 * spawns (work.test.mjs says why). The split made the decision a function of
 * what was measured, so each claim is now exercised on real inputs: a real
 * `parseTurnResult`, a real artifact scan over a real directory, the real
 * scrub. The pins in work.test.mjs stay as the wiring half.
 */
const code = AGENT_TASK_KINDS.code;
const design = AGENT_TASK_KINDS.design;
const TOKEN = `fva_${'A'.repeat(40)}`; // scrubbed by shape, no env needed

const place = (t) => {
  const d = mkdtempSync(join(tmpdir(), 'fv-outcome-'));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  return d;
};
const draw = (wt, name, body = '<html></html>') => {
  mkdirSync(join(wt, '.flowviant', 'artifacts'), { recursive: true });
  writeFileSync(join(wt, '.flowviant', 'artifacts', name), body);
};
const base = (wt, extra = {}) => ({
  turnId: 't1',
  job: { kind: 'task' },
  kind: code,
  out: '',
  lastAnswer: null,
  usage: null,
  commits: [],
  artifactsBefore: new Map(),
  branch: 'session/a-1',
  wt,
  ...extra,
});
const said = (o) => JSON.stringify(o);

test('a parsed result is the one final settle, and it carries every measured key', (t) => {
  const wt = place(t);
  const usage = { input: 3, output: 4, runtime: 'claude' };
  const s = agentTurnSettlement(
    base(wt, {
      out: said({ status: 'delivered', summary: 'did it', progress: 'Built the thing.' }),
      usage,
      commits: ['abc'],
    })
  );
  assert.equal(s.final, true);
  assert.equal(s.limit, null);
  assert.ok(s.res, 'the parsed result is handed back — the caller clears the limit off it');
  assert.deepEqual(s.body, {
    turnId: 't1',
    outcome: 'delivered',
    answer: 'did it',
    commits: ['abc'],
    usage,
    progress: 'Built the thing.',
    branch: 'session/a-1',
    worktree: wt,
  });
});

test("the agent's last message outranks everything else the CLI printed", (t) => {
  const wt = place(t);
  const s = agentTurnSettlement(
    base(wt, {
      out: `the format is ${said({ status: 'delivered', summary: 'quoted example' })}`,
      lastAnswer: said({ status: 'blocked', question: 'Which table?' }),
    })
  );
  assert.equal(s.body.outcome, 'question');
  assert.equal(s.body.answer, 'Which table?');
});

test('the account is omitted when absent, never sent empty, and scrubbed before it is cut', (t) => {
  const wt = place(t);
  const none = agentTurnSettlement(base(wt, { out: said({ status: 'delivered', summary: 's' }) }));
  assert.equal('progress' in none.body, false, 'absent is the server\'s signal to keep the last account');
  // A credential straddling the 1000-char cut: cut first, its prefix would ship.
  const long = `${'x'.repeat(990)}${TOKEN}`;
  const s = agentTurnSettlement(base(wt, { out: said({ status: 'delivered', summary: 's', progress: long }) }));
  assert.ok(s.body.progress.length <= 1000);
  assert.ok(!s.body.progress.includes('fva_'), 'no half-credential survives the cut');
});

test('raised cards ride scrubbed, never verbatim', (t) => {
  const wt = place(t);
  const s = agentTurnSettlement(
    base(wt, {
      out: said({ status: 'delivered', summary: 's', raised: [{ title: `leak ${TOKEN}`, brief: `see ${TOKEN}` }] }),
    })
  );
  assert.equal(s.body.raised.length, 1);
  assert.ok(!said(s.body.raised).includes(TOKEN));
});

test('a limit is a limit only when the turn declared nothing', (t) => {
  const wt = place(t);
  const usage = { input: 1, runtime: 'codex' };
  // A delivered turn ABOUT rate limiting parks nothing.
  const talk = agentTurnSettlement(
    base(wt, { out: `rate limit handling added\n${said({ status: 'delivered', summary: 'rate limit fixed' })}` })
  );
  assert.equal(talk.limit, null);
  assert.equal(talk.body.outcome, 'delivered');
  // The same phrase with no outcome is the CLI failing with it.
  const hit = agentTurnSettlement(base(wt, { out: 'Error: usage limit reached for today', usage, commits: ['c1'] }));
  assert.equal(hit.res, null);
  assert.equal(hit.limit, 'Error: usage limit reached for today');
  assert.equal(hit.final, false, 'a limit settle never opens the review-entry beat');
  assert.deepEqual(hit.body, {
    turnId: 't1',
    outcome: 'nothing',
    answer: 'Error: usage limit reached for today',
    usage,
    branch: 'session/a-1',
    worktree: wt,
  });
});

test('no declared outcome settles nothing with the CLI\'s own words, scrubbed', (t) => {
  const wt = place(t);
  const s = agentTurnSettlement(base(wt, { out: `crashed while reading ${TOKEN}`, commits: ['c1'] }));
  assert.equal(s.body.outcome, 'nothing');
  assert.match(s.body.answer, /^crashed while reading \[REDACTED:FLOWVIANT_TOKEN\]$/);
  assert.deepEqual(s.body.commits, ['c1'], 'a report never lies by omission about the branch');
  assert.equal('progress' in s.body, false);
  assert.equal(s.final, false);
  const silent = agentTurnSettlement(base(wt, { out: '   ' }));
  assert.equal(silent.body.answer, 'the turn produced no output on the machine — its CLI may be signed out');
  assert.equal('commits' in silent.body, false);
  assert.equal('usage' in silent.body, false, 'no spend measured, no spend claimed');
});

test('a design card is not delivered until its mockup is measured on disk', (t) => {
  const wt = place(t);
  const delivered = said({ status: 'delivered', summary: 'drew it' });
  const missing = agentTurnSettlement(base(wt, { kind: design, out: delivered }));
  assert.equal(missing.body.outcome, 'nothing');
  assert.equal(missing.body.answer, design.artifact.missing);
  assert.equal(missing.final, false);
  // Written this turn: counts.
  draw(wt, 'hero.html');
  const wrote = agentTurnSettlement(base(wt, { kind: design, out: delivered }));
  assert.equal(wrote.body.outcome, 'delivered');
  assert.equal(wrote.final, true);
  // Standing from before this TASK turn: the first card's page cannot pass the second.
  const before = snapshotArtifacts(wt);
  const stale = agentTurnSettlement(base(wt, { kind: design, out: delivered, artifactsBefore: before }));
  assert.equal(stale.body.outcome, 'nothing');
  // …but a HUMAN turn, or a redo, may deliver on the page already standing.
  const human = agentTurnSettlement(base(wt, { kind: design, out: delivered, artifactsBefore: before, job: { kind: 'human' } }));
  assert.equal(human.body.outcome, 'delivered');
  const redo = agentTurnSettlement(
    base(wt, { kind: design, out: delivered, artifactsBefore: before, job: { kind: 'task', redo: true } })
  );
  assert.equal(redo.body.outcome, 'delivered');
});

/**
 * THE 3D-MODEL KIND (0.107.0) is proven by its page: the model is built in it.
 * The page must be NEW OR CHANGED on a task turn, like a mockup, so a second
 * model card cannot pass on the first card's page; a human turn delivers on
 * the page already standing.
 */
test('a 3D-model card is delivered when its page stands, and a task turn must write it', (t) => {
  const model = AGENT_TASK_KINDS.model;
  const wt = place(t);
  const delivered = said({ status: 'delivered', summary: 'modelled it' });
  const drawIn = (dir, name, body = '<html></html>') => {
    mkdirSync(join(wt, '.flowviant', 'artifacts', dir), { recursive: true });
    writeFileSync(join(wt, '.flowviant', 'artifacts', dir, name), body);
  };
  // Nothing written: nothing, in the measured sentence.
  const none = agentTurnSettlement(base(wt, { kind: model, out: delivered }));
  assert.equal(none.body.outcome, 'nothing');
  assert.equal(none.body.answer, 'the turn ended without writing a 3D model page under .flowviant/artifacts/');
  assert.equal(none.body.answer, model.artifact.missing);
  // The page, written this turn: delivered.
  drawIn('chair', 'index.html');
  assert.equal(agentTurnSettlement(base(wt, { kind: model, out: delivered })).body.outcome, 'delivered');
  // Standing from before a TASK turn: the first card's page cannot pass the second…
  const before = snapshotArtifacts(wt);
  const stale = agentTurnSettlement(base(wt, { kind: model, out: delivered, artifactsBefore: before }));
  assert.equal(stale.body.outcome, 'nothing');
  // …a HUMAN turn delivers on the page already standing…
  const human = agentTurnSettlement(base(wt, { kind: model, out: delivered, artifactsBefore: before, job: { kind: 'human' } }));
  assert.equal(human.body.outcome, 'delivered');
  // …and a second card's own page delivers it.
  drawIn('table', 'index.html');
  assert.equal(agentTurnSettlement(base(wt, { kind: model, out: delivered, artifactsBefore: before })).body.outcome, 'delivered');
});

test('a model file alone is not a 3D-model delivery, and a deck is proven by its page', (t) => {
  const wt = place(t);
  const delivered = said({ status: 'delivered', summary: 'x' });
  draw(wt, 'chair.obj', 'v 0 0 0');
  const meshOnly = agentTurnSettlement(base(wt, { kind: AGENT_TASK_KINDS.model, out: delivered }));
  assert.equal(meshOnly.body.outcome, 'nothing');
  const deck = AGENT_TASK_KINDS.deck;
  const noDeck = agentTurnSettlement(base(wt, { kind: deck, out: delivered, artifactsBefore: snapshotArtifacts(wt) }));
  assert.equal(noDeck.body.outcome, 'nothing');
  assert.equal(noDeck.body.answer, 'the turn ended without writing a deck under .flowviant/artifacts/');
  draw(wt, 'pitch.html');
  assert.equal(agentTurnSettlement(base(wt, { kind: deck, out: delivered })).body.outcome, 'delivered');
});

test('a run that threw settles nothing once, with the error\'s own words and what was measured', () => {
  const body = failedTurnSettlement({
    turnId: 't9',
    error: new Error(`hook failed near ${TOKEN}`),
    commits: ['c1', 'c2'],
    usage: { input: 5, runtime: 'claude' },
    branch: 'session/a-9',
    wt: '/wt/a-9',
  });
  assert.deepEqual(body, {
    turnId: 't9',
    outcome: 'nothing',
    answer: 'This machine could not finish the turn: hook failed near [REDACTED:FLOWVIANT_TOKEN]',
    commits: ['c1', 'c2'],
    usage: { input: 5, runtime: 'claude' },
    branch: 'session/a-9',
    worktree: '/wt/a-9',
  });
  // Nothing measured, nothing claimed: no worktree means no branch keys, no
  // CLI means no spend, and a message-less throw still says what happened.
  assert.deepEqual(failedTurnSettlement({ turnId: 't8', error: {} }), {
    turnId: 't8',
    outcome: 'nothing',
    answer: 'This machine could not finish the turn.',
  });
  // Scrubbed BEFORE it is cut: a credential at the cap cannot leave a prefix.
  const long = failedTurnSettlement({ turnId: 't7', error: new Error(`${'y'.repeat(1470)}${TOKEN}`) });
  assert.ok(long.answer.length <= 1500);
  assert.ok(!long.answer.includes('fva_'));
});

test('the model the CLI named rides every settle, and none is claimed when it named none', (t) => {
  const wt = place(t);
  const model = 'claude-opus-5-5';
  const delivered = agentTurnSettlement(base(wt, { out: said({ status: 'delivered', summary: 'did it' }), model }));
  assert.equal(delivered.body.model, model, 'the parsed result');
  assert.equal(agentTurnSettlement(base(wt, { out: 'Error: usage limit reached', model })).body.model, model, 'a limit');
  assert.equal(agentTurnSettlement(base(wt, { out: 'it crashed', model })).body.model, model, 'no declared outcome');
  const missing = agentTurnSettlement(base(wt, { kind: design, out: said({ status: 'delivered', summary: 'drew it' }), model }));
  assert.equal(missing.body.outcome, 'nothing', 'canary: the artifact rule settled it');
  assert.equal(missing.body.model, model, 'a missing artifact');
  assert.equal(failedTurnSettlement({ turnId: 't2', error: new Error('x'), model }).model, model, 'a run that threw');
  // Unmeasured is absent — never an empty string, never a guess.
  assert.equal('model' in agentTurnSettlement(base(wt, { out: said({ status: 'delivered', summary: 'did it' }) })).body, false);
  assert.equal('model' in failedTurnSettlement({ turnId: 't3', error: new Error('x') }), false);
});

/**
 * ONE HOME. The settlement decision is this module's; the run posts what it
 * returns. A second `parseTurnResult` reader or limit match in the lane's files
 * is the copy this exists to catch — comments stripped, both ways.
 */
test('the settlement decision has one home', () => {
  const code = (file) =>
    readFileSync(new URL(`./${file}`, import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*)/.test(l))
      .join('\n');
  const home = code('workAgentTurnOutcome.mjs');
  assert.ok(home.includes('parseTurnResult(lastAnswer)'), 'canary: the decision reads the last message');
  assert.ok(home.includes('limitLine(out)'));
  const lane = readdirSync(new URL('.', import.meta.url)).filter(
    (f) => /^workAgentTurn\w*\.mjs$/.test(f) && f !== 'workAgentTurnOutcome.mjs'
  );
  assert.ok(lane.includes('workAgentTurnExecution.mjs') && lane.includes('workAgentTurns.mjs'), 'canary: the walk sees the lane');
  for (const file of lane) {
    const src = code(file);
    assert.ok(!/parseTurnResult\(/.test(src), `${file} parses a turn result of its own`);
    assert.ok(!/limitLine\(/.test(src), `${file} matches limits of its own`);
    assert.ok(!/kind\.artifact\.match/.test(src), `${file} checks the artifact contract of its own`);
  }
});
