/**
 * WATCHING AN AGENT WORK — the turn trace relay.
 *
 * The stream was always there: `runTurn` parses every thought, every line of
 * narration and every tool call, and the agent lane read ONE of them every two
 * seconds, overwrote the previous one and dropped the rest. What is pinned here
 * is the three properties that make the replacement trustworthy rather than
 * merely fuller:
 *
 *   · ORDER, because the server appends what arrives — two batches in flight at
 *     once would interleave a turn's steps into a sequence that never happened.
 *   · ABSOLUTE SEQ, because a retry must be idempotent (the server trims
 *     against its own high-water mark) and because a DROP must stay visible: a
 *     buffer that shed its oldest entries silently would render as a complete
 *     account of a turn with holes in it.
 *   · THE DEDUPE PAIRING, because a Claude tool call goes down two paths at
 *     once and the rule that drops one of them lives in a third file. All three
 *     are edited independently and the failure is invisible either way — a
 *     doubled read looks like a busy agent, a dropped one looks like a quiet
 *     turn.
 *
 * Run: node --test bin/lib/trace.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTraceRelay, TRACE_BATCH, TRACE_BUFFER, TRACE_PROSE_CAP } from './trace.mjs';
import {
  humanizeClaudeTool,
  toolEventOf,
  CLAUDE_TOOL_PROSE_KINDS,
} from './runtimes.mjs';

/** A post that records every batch and answers however the test says. */
const recorder = (answer = () => true) => {
  const sent = [];
  return {
    sent,
    post: async (body) => {
      sent.push(body);
      return answer(body, sent.length);
    },
  };
};

const relayOn = (rec, over = {}) =>
  makeTraceRelay({ agentId: 'a1', turnId: 't1', post: rec.post, ...over });

// ── the entries ──────────────────────────────────────────────────────────────

test('the three prose kinds, and everything else is a note', () => {
  const rec = recorder();
  const r = relayOn(rec);
  r.prose('think', 'thinking…');
  r.prose('say', 'I will start with the migration');
  r.prose('error', 'turn failed');
  r.prose('bash', '$ npm test');
  r.stop();
  return r.flush().then(() => {
    assert.deepEqual(rec.sent[0].entries, [
      { k: 'think', t: 'thinking…' },
      { k: 'say', t: 'I will start with the migration' },
      { k: 'note', t: 'turn failed' },
      { k: 'note', t: '$ npm test' },
    ]);
  });
});

test('prose is scrubbed, collapsed and clamped — it is the CLI\'s own stdout', async () => {
  const rec = recorder();
  const r = relayOn(rec, { scrub: (s) => s.split('hunter2').join('[REDACTED:PW]') });
  r.prose('say', '  export  PW=hunter2\n  and then\t nothing  ');
  r.prose('say', 'x'.repeat(900));
  r.stop();
  await r.flush();
  assert.equal(rec.sent[0].entries[0].t, 'export PW=[REDACTED:PW] and then nothing');
  assert.equal(rec.sent[0].entries[1].t.length, TRACE_PROSE_CAP);
});

test('an empty line is not an entry', async () => {
  const rec = recorder();
  const r = relayOn(rec);
  r.prose('say', '   ');
  r.prose('say', null);
  r.tool(null);
  r.tool(undefined);
  r.stop();
  await r.flush();
  assert.equal(rec.sent.length, 0, 'nothing to say means no POST at all');
  assert.equal(r.stats().emitted, 0);
});

test('a tool event rides through exactly as the builder made it', async () => {
  const rec = recorder();
  const r = relayOn(rec);
  r.tool(toolEventOf('Read', { file_path: '/wt/src/a.ts' }, '/wt'));
  r.stop();
  await r.flush();
  assert.deepEqual(rec.sent[0].entries, [{ k: 'tool', e: { t: 'read', p: 'src/a.ts' } }]);
});

// ── order and seq ────────────────────────────────────────────────────────────

test('seq is absolute, batches are capped, and order is the contract', async () => {
  const rec = recorder();
  const r = relayOn(rec);
  for (let i = 0; i < TRACE_BATCH + 5; i++) r.prose('say', `line ${i}`);
  r.stop();
  await r.flush();
  assert.equal(rec.sent.length, 2);
  assert.equal(rec.sent[0].seq, 0);
  assert.equal(rec.sent[0].entries.length, TRACE_BATCH);
  assert.equal(rec.sent[1].seq, TRACE_BATCH);
  assert.equal(rec.sent[1].entries.length, 5);
  // Reassembled in arrival order, the stream is the stream.
  const all = rec.sent.flatMap((b) => b.entries.map((e) => e.t));
  assert.deepEqual(
    all,
    Array.from({ length: TRACE_BATCH + 5 }, (_, i) => `line ${i}`)
  );
});

test('two flushes at once do not interleave — one chain, in order', async () => {
  const rec = recorder();
  const r = relayOn(rec);
  for (let i = 0; i < TRACE_BATCH * 2; i++) r.prose('say', `line ${i}`);
  r.stop();
  await Promise.all([r.flush(), r.flush()]);
  assert.deepEqual(
    rec.sent.map((b) => b.seq),
    [0, TRACE_BATCH]
  );
});

test('every batch names the turn it belongs to', async () => {
  const rec = recorder();
  const r = relayOn(rec);
  r.prose('say', 'hello');
  r.stop();
  await r.flush();
  assert.equal(rec.sent[0].agentId, 'a1');
  assert.equal(rec.sent[0].turnId, 't1');
});

/**
 * …AND WHICH ATTEMPT AT IT IS SPEAKING.
 *
 * `seq` is absolute within a RUN, and this relay is built fresh inside
 * `runAgentTurn` — so its counter restarts at zero on every attempt, while the
 * server's high-water mark lives on the turn row and does not. A daemon restart
 * mid-turn, a takeover, or a throw after the CLI ran put the identical turn back
 * on the next poll; without a run name, attempt two posted `seq: 0` against a
 * mark of three hundred and every batch it sent was trimmed to nothing.
 */
test('every batch names its RUN, and two relays on one turn never share one', async () => {
  const rec = recorder();
  const a = relayOn(rec);
  a.prose('say', 'attempt one');
  a.stop();
  await a.flush();
  const b = relayOn(rec);
  b.prose('say', 'attempt two');
  b.stop();
  await b.flush();
  assert.ok(rec.sent[0].run, 'a batch with no run is read as the single pre-0.83.0 stream');
  assert.notEqual(rec.sent[0].run, rec.sent[1].run);
  // Both restart their own counter — which is exactly why the server rebases.
  assert.equal(rec.sent[0].seq, 0);
  assert.equal(rec.sent[1].seq, 0);
});

test('one relay keeps ONE run across every batch it ever sends', async () => {
  const rec = recorder();
  const r = relayOn(rec);
  for (let i = 0; i < TRACE_BATCH + 5; i += 1) r.prose('say', `line ${i}`);
  r.stop();
  await r.flush();
  assert.ok(rec.sent.length > 1);
  assert.equal(new Set(rec.sent.map((b) => b.run)).size, 1);
  assert.equal(r.stats().run, rec.sent[0].run);
});

// ── retry ────────────────────────────────────────────────────────────────────

test('a failed POST holds its entries AT THE SAME SEQ', async () => {
  let fail = true;
  const rec = recorder(() => !fail);
  const r = relayOn(rec);
  r.prose('say', 'one');
  r.prose('say', 'two');
  r.stop();
  await r.flush();
  assert.equal(rec.sent.length, 1);
  assert.equal(r.stats().queued, 2, 'a refused batch is not forgotten');
  fail = false;
  await r.flush();
  assert.equal(rec.sent.length, 2);
  // The SAME seq, deliberately: the server trims the overlap against its own
  // high-water mark, so a re-POST of a batch it already has is idempotent
  // rather than a duplicated stretch of the turn.
  assert.equal(rec.sent[1].seq, 0);
  assert.deepEqual(rec.sent[0].entries, rec.sent[1].entries);
  assert.equal(r.stats().queued, 0);
});

test('a failure stops the drain — later entries do not overtake the stuck batch', async () => {
  const rec = recorder((_, n) => n !== 1);
  const r = relayOn(rec);
  for (let i = 0; i < TRACE_BATCH * 2; i++) r.prose('say', `line ${i}`);
  r.stop();
  await r.flush();
  assert.equal(rec.sent.length, 1, 'the second batch must not go out ahead of the first');
  await r.flush();
  assert.deepEqual(
    rec.sent.map((b) => b.seq),
    [0, 0, TRACE_BATCH]
  );
});

test('a POST that throws is a held batch, not a lost one', async () => {
  let boom = true;
  const r = relayOn({
    post: async () => {
      if (boom) throw new Error('socket');
      return true;
    },
  });
  r.prose('say', 'one');
  r.stop();
  await r.flush();
  assert.equal(r.stats().queued, 1);
  boom = false;
  await r.flush();
  assert.equal(r.stats().queued, 0);
});

test('a permanent refusal is forgotten rather than retried forever', async () => {
  // `postAgentTrace` resolves TRUE for a 4xx — an older server with no such
  // route 404s every batch, and holding them would fill the buffer, shed the
  // turn's real steps and re-POST a rejected body for the life of the turn.
  const rec = recorder(() => true);
  const r = relayOn(rec);
  r.prose('say', 'one');
  r.stop();
  await r.flush();
  assert.equal(r.stats().queued, 0);
});

// ── overflow ─────────────────────────────────────────────────────────────────

test('an overflowing buffer sheds the OLDEST and the gap shows in the seq', async () => {
  const rec = recorder();
  const r = relayOn(rec);
  const n = TRACE_BUFFER + 30;
  for (let i = 0; i < n; i++) r.prose('say', `line ${i}`);
  r.stop();
  // Nothing has been sent yet, so the shed 30 were never on the wire — the
  // first batch must therefore START at 30, or the server would renumber the
  // survivors and report a complete account of a turn with holes in it.
  assert.equal(r.stats().seq, 30);
  assert.equal(r.stats().emitted, n, 'a shed entry still counted');
  await r.flush();
  assert.equal(rec.sent[0].seq, 30);
  assert.equal(rec.sent[0].entries[0].t, 'line 30');
  const all = rec.sent.flatMap((b) => b.entries.map((e) => e.t));
  assert.equal(all.length, TRACE_BUFFER);
  assert.equal(all[all.length - 1], `line ${n - 1}`, 'the NEWEST steps are the ones kept');
});

test('the buffer only overflows while the uplink is down', async () => {
  const rec = recorder();
  const r = relayOn(rec);
  for (let i = 0; i < TRACE_BUFFER; i++) r.prose('say', `a${i}`);
  await r.flush();
  for (let i = 0; i < TRACE_BUFFER; i++) r.prose('say', `b${i}`);
  r.stop();
  await r.flush();
  const all = rec.sent.flatMap((b) => b.entries.map((e) => e.t));
  assert.equal(all.length, TRACE_BUFFER * 2, 'nothing was dropped');
  assert.equal(r.stats().emitted, TRACE_BUFFER * 2);
});

test('stop() ends the stream but never the delivery of what is already held', async () => {
  const rec = recorder();
  const r = relayOn(rec);
  r.prose('say', 'before');
  r.stop();
  r.prose('say', 'after');
  r.tool({ t: 'read', p: 'x' });
  await r.flush();
  assert.deepEqual(rec.sent[0].entries, [{ k: 'say', t: 'before' }]);
});

// ── the dedupe pairing ───────────────────────────────────────────────────────

test('CLAUDE_TOOL_PROSE_KINDS is exactly the kinds that ARRIVE TWICE', () => {
  // One `tool_use` reaches the agent lane down two paths: a humanized line
  // through onActivity and a structured event through onToolEvent. The trace
  // takes both, so the prose half of a doubled call is dropped — and only that
  // half. `LS` is the case that makes this a real rule rather than a list of
  // tool kinds: it produces a `list` activity and NO tool event, so dropping
  // `list` would delete it from the trace entirely.
  const cases = [
    ['Read', { file_path: '/wt/a.ts' }],
    ['Write', { file_path: '/wt/a.ts', content: 'x' }],
    ['Edit', { file_path: '/wt/a.ts', old_string: 'a', new_string: 'b' }],
    ['Grep', { pattern: 'x' }],
    ['Glob', { pattern: '*.ts' }],
    ['LS', { path: '/wt' }],
    ['Bash', { command: 'npm test' }],
    ['TodoWrite', { todos: [{ content: 'a', status: 'pending' }] }],
    ['Task', { description: 'find the callers' }],
    ['WebFetch', { url: 'https://x' }],
  ];
  const doubled = new Set();
  for (const [name, input] of cases) {
    const prose = humanizeClaudeTool(name, input, '/wt');
    const event = toolEventOf(name, input, '/wt');
    if (prose && event) doubled.add(prose.kind);
    else if (prose)
      assert.ok(
        !CLAUDE_TOOL_PROSE_KINDS.has(prose.kind),
        `${name} has no structured twin — dropping '${prose.kind}' would silence it`
      );
  }
  assert.deepEqual([...doubled].sort(), [...CLAUDE_TOOL_PROSE_KINDS].sort());
});

// ── the wiring, pinned as source ─────────────────────────────────────────────

const here = dirname(fileURLToPath(import.meta.url));
const workSrc = readFileSync(join(here, 'work.mjs'), 'utf8');

const between = (src, from, to, what) => {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a + 1);
  assert.ok(a >= 0, `${what}: anchor not found — ${from}`);
  assert.ok(b > a, `${what}: closing anchor not found after it — ${to}`);
  return src.slice(a, b);
};

test('the agent turn feeds BOTH channels, and the pulse stays a drop-sampler', () => {
  const region = between(
    workSrc,
    'const trace = makeTraceRelay({',
    'onSpawn: (ch) => {',
    'the agent turn stream wiring'
  );
  assert.ok(region.includes('trace.prose(a.kind, line)'));
  assert.ok(region.includes('trace.tool(toolEventOf('));
  // The one-line beat is what carries STALENESS — "the machine last spoke 40
  // seconds ago" — which an append-only list of steps cannot say, because a
  // list that stopped growing looks exactly like a finished one.
  assert.ok(region.includes('postAgentActivity(agentId'));
  // Only the runtime whose stream reaches onToolEvent may drop tool prose:
  // codex and agy never call it and would go silent.
  assert.ok(region.includes('doubledKinds'));
  assert.ok(region.includes('RUNTIMES[rt]?.parse'));
});

test('the tail is flushed BEFORE the settle', () => {
  const lane = between(
    workSrc,
    'const runAgentTurn = async (job, releaseSlot',
    'const lastAgentBeat = new Map()',
    'runAgentTurn'
  );
  const flushAt = lane.indexOf('await trace.flush(');
  const settleAt = lane.indexOf('const commits = commitsBetween(');
  assert.ok(flushAt >= 0, 'the final flush is missing');
  assert.ok(settleAt >= 0, 'the settle anchor moved');
  assert.ok(flushAt < settleAt, 'the last thing the agent did must be on the record first');
  // Bounded: the settle is the turn's contract and this is a readout.
  assert.ok(lane.includes('TRACE_FINAL_FLUSH_MS'));
});
