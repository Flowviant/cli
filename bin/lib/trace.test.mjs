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
  THINK_MARKER,
  RUNTIMES,
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

test('prose is scrubbed and clamped — it is the CLI\'s own stdout', async () => {
  const rec = recorder();
  const r = relayOn(rec, { scrub: (s) => s.split('hunter2').join('[REDACTED:PW]') });
  r.prose('say', '  export  PW=hunter2  and then\t nothing  ');
  r.prose('say', 'x'.repeat(9000));
  r.stop();
  await r.flush();
  assert.equal(rec.sent[0].entries[0].t, 'export PW=[REDACTED:PW] and then nothing');
  assert.equal(rec.sent[0].entries[1].t.length, TRACE_PROSE_CAP);
});

/**
 * THE CAP IS THE SERVER'S CAP. `agentTrace.ts` clamps to the same number, and a
 * daemon capping HIGHER would mean the server silently does the cutting and
 * this file's bounds stop describing what ships. It is 4000 rather than the
 * original 300 because an entry stopped being a one-line label the day the
 * relay started carrying whole sentences — at 300 a paragraph of narration was
 * cut mid-sentence, which is the clip this release exists to end.
 */
test('the prose cap mirrors the server, and it is the whole-sentence one', () => {
  assert.equal(TRACE_PROSE_CAP, 4_000);
});

/**
 * …AND THE SCRUB SEES THE WHOLE STRING, not the first 300 characters of it.
 *
 * The order is the load-bearing half: scrub, THEN cap. A secret sitting past
 * where the old cap used to fall must not reach the wire simply because the
 * entries grew — a thought is now thirteen times longer than a label was, and
 * this lane carries the CLI's own stdout.
 */
test('the scrub runs over the full text, not just the head of it', async () => {
  const rec = recorder();
  const r = relayOn(rec, { scrub: (s) => s.split('hunter2').join('[REDACTED:PW]') });
  r.prose('say', `${'padding '.repeat(200)}and the key is hunter2`);
  r.stop();
  await r.flush();
  const t = rec.sent[0].entries[0].t;
  assert.ok(t.length > 1_000, 'the entry really is past the old 300 cap');
  assert.ok(!t.includes('hunter2'));
  assert.ok(t.includes('[REDACTED:PW]'));
});

/**
 * …AND THE ORDER IS PINNED WHERE IT CAN ACTUALLY FAIL: ON A SECRET THAT
 * STRADDLES THE CAP.
 *
 * The test above proves the scrub reaches past 300; it cannot prove scrub
 * BEFORE cap, because every character of its fixture sits inside 4000, so
 * cutting first would have redacted the same string. This one puts the value
 * ACROSS the boundary, which is the only arrangement the two orders disagree
 * about — and they disagree catastrophically, because `env.mjs.scrub` replaces
 * EXACT FULL VALUES: cap first and the surviving head is a half-token the
 * scrub can no longer recognise, so it rides the wire raw. The window that
 * failure needs grew with the entries — at 300 a straddle could only expose a
 * fragment of a short label; at 4000 it is a hundred characters of key.
 *
 * Mutation this must catch: `slice(0, TRACE_PROSE_CAP)` moved inside the
 * `scrub(...)` call — the natural "tidy" the day somebody does not want to
 * scrub 100KB of stdout.
 */
test('a secret straddling the cap is redacted whole, not cut in half first', async () => {
  const SECRET = `sk-live-${'A'.repeat(300)}`;
  const rec = recorder();
  const r = relayOn(rec, { scrub: (s) => s.split(SECRET).join('[REDACTED:KEY]') });
  // The value starts 100 characters short of the cap and runs 208 past it.
  r.prose('say', `${'x'.repeat(TRACE_PROSE_CAP - 100)}${SECRET} trailing`);
  r.stop();
  await r.flush();
  const t = rec.sent[0].entries[0].t;
  assert.ok(!t.includes('sk-live-'), 'no fragment of the value rides the cap boundary');
  assert.ok(t.includes('[REDACTED:KEY]'), 'the whole value was matched and replaced');
  // And redacting SHORTENS it, so the tail after the secret survives the cap —
  // proof the assertion above is not passing because the entry was truncated.
  assert.ok(t.endsWith('trailing'));
});

/**
 * THE MODEL WRITES IN PARAGRAPHS AND THEY ARRIVE AS PARAGRAPHS.
 *
 * `\s+ → ' '` was right while an entry was a one-line console label and wrong
 * the moment the caller started handing over the whole of what the CLI said:
 * flattening a list into one run-on line is the relay deciding how the agent's
 * own words should be shaped, which is a summary with extra steps. Only
 * HORIZONTAL runs collapse.
 */
test('prose keeps its newlines and collapses only horizontal whitespace', async () => {
  const rec = recorder();
  const r = relayOn(rec);
  r.prose('say', '  First,   the migration.\nThen:\n  -  one\n  -\ttwo  ');
  r.stop();
  await r.flush();
  assert.equal(rec.sent[0].entries[0].t, 'First, the migration.\nThen:\n - one\n - two');
});

/** A wall of blank lines is padding, and padding eats the cap the real
 *  sentences need. One blank line survives; the wall does not. */
test('a run of blank lines collapses to one', async () => {
  const rec = recorder();
  const r = relayOn(rec);
  r.prose('say', 'a\n\n\n\n\nb\n\nc');
  r.stop();
  await r.flush();
  assert.equal(rec.sent[0].entries[0].t, 'a\n\nb\n\nc');
});

// ── the bare thinking marker ─────────────────────────────────────────────────

/**
 * A RUN OF EMPTY THINKING BLOCKS IS ONE STEP.
 *
 * The CLI emits the FACT that it reasoned and (measured 2026-09-16: 93 blocks
 * across three real transcripts, all empty) not a word of the reasoning, so the
 * trace filled with the identical marker repeated — noise standing exactly
 * where the thought would have been. The wiki feed collapses the same run for
 * the same reason (fleet.mjs).
 */
test('a run of bare thinking markers becomes one entry', async () => {
  const rec = recorder();
  const r = relayOn(rec);
  r.prose('think', 'thinking…');
  r.prose('think', 'thinking…');
  r.prose('think', 'thinking…');
  r.stop();
  await r.flush();
  assert.deepEqual(rec.sent[0].entries, [{ k: 'think', t: 'thinking…' }]);
  // A collapse is not a DROP: it never became an entry, so it never took a seq
  // and the server's "N earlier steps are not shown" stays a count of steps
  // that existed.
  assert.equal(r.stats().emitted, 1);
});

test('a marker after something else is a new step, not a duplicate', async () => {
  const rec = recorder();
  const r = relayOn(rec);
  r.prose('think', 'thinking…');
  r.prose('say', 'I will start with the migration');
  r.prose('think', 'thinking…');
  r.stop();
  await r.flush();
  assert.deepEqual(rec.sent[0].entries, [
    { k: 'think', t: 'thinking…' },
    { k: 'say', t: 'I will start with the migration' },
    { k: 'think', t: 'thinking…' },
  ]);
});

/** THE ONE THING THE COLLAPSE MAY NEVER EAT. A think WITH text is never equal
 *  to the bare marker, so the day a CLI starts emitting thinking text every
 *  block lands whole — including two identical thoughts in a row, which are two
 *  things the model thought. */
test('a think WITH text is never collapsed, even against itself', async () => {
  const rec = recorder();
  const r = relayOn(rec);
  r.prose('think', 'thinking: where is the cookie read');
  r.prose('think', 'thinking: where is the cookie read');
  r.stop();
  await r.flush();
  assert.equal(rec.sent[0].entries.length, 2);
});

/** A batch boundary is not a change in the stream, so the collapse survives a
 *  flush — `queue[queue.length - 1]` would not, because a flush empties it. */
test('the collapse holds across a flush', async () => {
  const rec = recorder();
  const r = relayOn(rec);
  r.prose('think', 'thinking…');
  await r.flush();
  r.prose('think', 'thinking…');
  r.stop();
  await r.flush();
  const all = rec.sent.flatMap((b) => b.entries);
  assert.deepEqual(all, [{ k: 'think', t: 'thinking…' }]);
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

// ── the parsers put the WHOLE text on the activity ───────────────────────────

/**
 * `label` IS THE READOUT; `full` IS THE RELAY.
 *
 * A prose activity feeds three consumers with two different needs: a terminal
 * console and a one-line pulse, which can only show a line, and the TRACE,
 * which is scrollback and for which a 140-char clamp is the product summarizing
 * its own agent. So the parsers carry both, and `label` is asserted UNCHANGED
 * here — the console and the pulse must be byte-identical across this release.
 *
 * Codex is the runtime that actually sends reasoning text today (Claude's
 * thinking blocks are measured empty), so it is where a real thought reaching
 * the trace whole can be pinned behaviourally at all.
 */
test('a codex message and a codex thought carry their full text beside the label', () => {
  const long = `First line of the plan.\n\n${'w'.repeat(400)}`;
  const say = RUNTIMES.codex.parse(
    JSON.stringify({ type: 'item.completed', item: { item_type: 'agent_message', text: long } }),
    '/wt'
  );
  assert.equal(say.activity.full, long, 'the trace gets what the CLI said');
  assert.equal(say.activity.label.length, 140, 'the console line is unchanged');
  assert.ok(!say.activity.label.includes('\n'));

  const think = RUNTIMES.codex.parse(
    JSON.stringify({ type: 'item.completed', item: { item_type: 'reasoning', text: long } }),
    '/wt'
  );
  assert.equal(think.activity.kind, 'think');
  assert.equal(think.activity.full, long);
});

/** An error is prose too, and its message is exactly the kind of sentence a
 *  140-char clamp cuts the cause out of. */
test('a codex error carries its full message', () => {
  const msg = `401 Unauthorized: ${'detail '.repeat(40)}`;
  const ev = RUNTIMES.codex.parse(JSON.stringify({ type: 'error', message: msg }), '/wt');
  assert.equal(ev.activity.full, msg);
  assert.equal(ev.activity.label.length, 140);
});

/**
 * …AND ADDING `full` DID NOT WIDEN THE LABEL BESIDE IT.
 *
 * An EXPLICITLY EMPTY error message is the one input where `oneLine(msg ?? …)`
 * and `oneLine(msg || …)` disagree: the first yields an empty label, which the
 * console and the pulse both swallow (`if (!line) return`), and the second
 * prints "turn failed" and fires a beat. This release's claim is that `label`
 * is byte-identical and only the trace gained a field, so the empty stays
 * empty — and `full` is absent, because there is no fuller text than nothing.
 */
test('an empty error message labels nothing, exactly as before full existed', () => {
  const failed = RUNTIMES.codex.parse(
    JSON.stringify({ type: 'turn.failed', error: { message: '' } }),
    '/wt'
  );
  assert.equal(failed.activity.label, '');
  assert.equal(failed.activity.full, undefined);
  const bare = RUNTIMES.codex.parse(JSON.stringify({ type: 'error', message: '' }), '/wt');
  assert.equal(bare.activity.label, '');
  assert.equal(bare.activity.full, undefined);
  // The fallback still fires where it always did — a MISSING message, not an
  // empty one, is what "turn failed" was written for.
  const missing = RUNTIMES.codex.parse(JSON.stringify({ type: 'turn.failed' }), '/wt');
  assert.equal(missing.activity.label, 'turn failed');
  assert.equal(missing.activity.full, undefined);
});

/** No text, no `full` — absence means "the label IS the whole of it", which is
 *  also what every pre-0.87.0 daemon reports for everything, and is why the
 *  reader falls back rather than blanking. */
test('an empty thought carries the marker and no full text', () => {
  const ev = RUNTIMES.codex.parse(
    JSON.stringify({ type: 'item.completed', item: { item_type: 'reasoning', text: '' } }),
    '/wt'
  );
  assert.equal(ev.activity.label, THINK_MARKER);
  assert.equal(ev.activity.full, undefined);
});

// ── the wiring, pinned as source ─────────────────────────────────────────────

const here = dirname(fileURLToPath(import.meta.url));
const workSrc = readFileSync(join(here, 'work.mjs'), 'utf8');
const claudeSrc = readFileSync(join(here, 'claude.mjs'), 'utf8');

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
  // THE TRACE TAKES THE WHOLE LINE and the pulse takes the label. Feeding
  // `line` here is the bug this release fixed and is invisible at a glance —
  // the trace would still be full, complete-looking, and clipped at 160 chars
  // per entry with no mark saying so.
  assert.ok(region.includes('trace.prose(a.kind, a.full ?? line)'));
  assert.ok(
    !/trace\.prose\(a\.kind,\s*line\)/.test(region),
    'the label-only feed is what the full-text relay replaced'
  );
  assert.ok(region.includes('trace.tool(toolEventOf('));
  // The one-line beat is what carries STALENESS — "the machine last spoke 40
  // seconds ago" — which an append-only list of steps cannot say, because a
  // list that stopped growing looks exactly like a finished one.
  //
  // ITS ARGUMENT IS PINNED TOO, both halves, because this release's whole claim
  // about the pulse is that it did NOT move: `full` exists now, and "why does
  // the pulse still clip?" is the most inviting follow-up edit in the diff.
  // Feeding it the paragraph would put up to 400 characters of multi-line prose
  // — newlines and all, since `prose()` stopped flattening — into the one
  // overwritten line the board renders under a running agent.
  assert.ok(region.includes('postAgentActivity(agentId, envScrub(String(line))'));
  assert.ok(
    !/postAgentActivity\([^)]*a\.full/.test(region),
    'the pulse is one line, never the paragraph'
  );
  // Only the runtime whose stream reaches onToolEvent may drop tool prose:
  // codex and agy never call it and would go silent.
  assert.ok(region.includes('doubledKinds'));
  assert.ok(region.includes('RUNTIMES[rt]?.parse'));
});

/**
 * CLAUDE'S OWN STREAM PARSER, pinned as source because it is a closure inside
 * `runTurn` and reaching it behaviourally means spawning a CLI.
 *
 * Two arms, and the second is the one that does nothing today: a thinking block
 * with text has never been observed (93 empty blocks across three transcripts,
 * measured 2026-09-16), and the branch is kept precisely so that the day a
 * release starts emitting one, the thought rides `full` with no daemon change
 * and no version floor. Deleting it as dead code is the regression this pins.
 */
test('the claude parser puts the untruncated text on say and on a real thought', () => {
  const region = between(
    claudeSrc,
    "if (b.type === 'thinking' || b.type === 'redacted_thinking') {",
    "} else if (b.type === 'tool_use') {",
    'the claude prose arms'
  );
  assert.ok(region.includes('full: b.text'), 'a say must relay what was said');
  assert.ok(region.includes('full: b.thinking'), 'a thought with text must relay whole');
  // The console line is unchanged on both arms — same collapse, same 160.
  assert.ok(region.includes('label: oneLine(b.text)'));
  assert.ok(region.includes('label: `thinking: ${oneLine(b.thinking)}`'));
  // And the empty block still takes the shared marker the collapse keys on.
  assert.ok(region.includes('label: THINK_MARKER'));
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
