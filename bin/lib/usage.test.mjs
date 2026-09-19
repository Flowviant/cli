/**
 * WHAT A TURN SPENT — the harvest, and the two things it must never become.
 *
 * `usageFromResult` reads the four token counts off the CLI's own `result`
 * event and nothing else. The cases here pin the whole contract, because every
 * one of them is a way a spend readout goes wrong quietly:
 *
 *  · NO USAGE OBJECT IS NULL, never four zeros. A turn that reported nothing
 *    charges nothing, and that is a different sentence from a turn that
 *    reported zeros — the three-state rule every readout in this daemon keeps.
 *  · A FAILED RESULT STILL COUNTS. A turn that hit a limit or aborted sent the
 *    requests it sent, and skipping those would under-report exactly the runs
 *    somebody opens the number to understand.
 *  · DOLLARS ARE NOT RELAYED. `total_cost_usd` rides the same event and is a
 *    notional list price a subscription operator did not pay; carrying it would
 *    be the product asserting a figure nobody was charged.
 *
 * Run: node --test bin/lib/usage.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { handleStreamLine, usageFromResult } from './claude.mjs';

test('the four counts are read off the result event, as the CLI reported them', () => {
  assert.deepEqual(
    usageFromResult({
      type: 'result',
      usage: {
        input_tokens: 12,
        output_tokens: 3_400,
        cache_creation_input_tokens: 89_000,
        cache_read_input_tokens: 1_360_000,
      },
      total_cost_usd: 1.42,
    }),
    { input: 12, output: 3_400, cacheCreate: 89_000, cacheRead: 1_360_000 }
  );
});

test('an event with no usage object reports NOTHING, which is not zero', () => {
  assert.equal(usageFromResult({ type: 'result', result: 'done' }), null);
  assert.equal(usageFromResult({ type: 'result', usage: null }), null);
  assert.equal(usageFromResult({}), null);
  assert.equal(usageFromResult(undefined), null);
});

test('a failed result still reports what it spent', () => {
  assert.deepEqual(
    usageFromResult({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      usage: { input_tokens: 5, output_tokens: 0 },
    }),
    { input: 5, output: 0, cacheCreate: 0, cacheRead: 0 }
  );
});

/**
 * ONE BAD FIELD MUST NOT POISON THE OTHER THREE. These are summed into a
 * counter that only ever goes up, so a NaN, an Infinity or a negative has to
 * land as 0 rather than as itself — a single Infinity in a D1 integer column is
 * a row nobody can ever correct.
 */
test('a value that is not a real count reads as zero, alone', () => {
  assert.deepEqual(
    usageFromResult({
      usage: {
        input_tokens: 'many',
        output_tokens: Infinity,
        cache_creation_input_tokens: -50,
        cache_read_input_tokens: 12.7,
      },
    }),
    { input: 0, output: 0, cacheCreate: 0, cacheRead: 12 }
  );
});

test('the dollar figure beside it is never carried', () => {
  const src = readFileSync(new URL('./claude.mjs', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .join('\n');
  assert.ok(!src.includes('total_cost_usd'), 'tokens only — no dollars leave this machine');
});

/**
 * …AND THE WIRING IS REACHED, WHICH IT WAS NOT (2026-09-19, found in review).
 *
 * `usageFromResult` was fully tested above while the four edits that carry its
 * answer out of the process — the destructure, the call in the result branch,
 * `runTurn`'s option, and `onLine`'s pass-through — were pinned by nothing at
 * all. Delete any one and both suites stay green; the only symptom in
 * production is a container reporting no spend, which this feature's own
 * three-state rule makes indistinguishable from an older daemon. A callback
 * whose failure mode is SILENCE cannot be left to a source read alone.
 *
 * So `handleStreamLine` is called for real here (it is exported for this), and
 * the two sites a direct call cannot reach — the plumbing between `runTurn` and
 * it — are pinned in the source with BOTH anchors asserted, never a bare
 * `indexOf` that answers -1 and slices the wrong region.
 */

/** The context `handleStreamLine` is handed, with every sink recorded. */
const streamCtx = (over = {}) => {
  const seen = { usage: [], text: '', activity: [] };
  return [
    seen,
    {
      cwd: '/tmp/x',
      emit: (a) => seen.activity.push(a),
      onActivity: (a) => seen.activity.push(a),
      appendText: (t) => {
        seen.text += t;
      },
      onUsage: (u) => seen.usage.push(u),
      ...over,
    },
  ];
};

test('a result line carries its usage out through onUsage, coerced', () => {
  const [seen, ctx] = streamCtx();
  handleStreamLine(
    JSON.stringify({
      type: 'result',
      result: 'done',
      usage: {
        input_tokens: 12,
        output_tokens: '3400',
        cache_creation_input_tokens: -5,
        cache_read_input_tokens: 1_360_000,
      },
      total_cost_usd: 1.42,
    }),
    ctx
  );
  assert.deepEqual(seen.usage, [
    { input: 12, output: 3_400, cacheCreate: 0, cacheRead: 1_360_000 },
  ]);
  // The rest of the branch is untouched by the harvest that now precedes it.
  assert.equal(seen.text, 'done\n');
});

test('a failed result line still carries its spend out', () => {
  const [seen, ctx] = streamCtx();
  handleStreamLine(
    JSON.stringify({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      usage: { input_tokens: 5, output_tokens: 7 },
    }),
    ctx
  );
  assert.deepEqual(seen.usage, [{ input: 5, output: 7, cacheCreate: 0, cacheRead: 0 }]);
});

test('a result with no usage, and a line that is not one, fire nothing', () => {
  const [seen, ctx] = streamCtx();
  handleStreamLine(JSON.stringify({ type: 'result', result: 'done' }), ctx);
  handleStreamLine(JSON.stringify({ type: 'assistant', message: { content: [] } }), ctx);
  handleStreamLine('not json at all', ctx);
  assert.deepEqual(seen.usage, []);
});

/** A caller that wants no spend passes no `onUsage`, and the optional call must
 *  not throw on a stream that happens to report one. */
test('a caller that asked for no usage is unaffected', () => {
  const [, ctx] = streamCtx({ onUsage: undefined });
  handleStreamLine(JSON.stringify({ type: 'result', result: 'done', usage: { input_tokens: 1 } }), ctx);
});

test('runTurn threads onUsage down to the line reader', () => {
  const src = readFileSync(new URL('./claude.mjs', import.meta.url), 'utf8');
  /** BOTH ANCHORS, or the region is not the region. */
  const between = (from, to) => {
    const a = src.indexOf(from);
    assert.ok(a > -1, `anchor not found: ${from}`);
    const b = src.indexOf(to, a + 1);
    assert.ok(b > a, `closing anchor not found after it: ${to}`);
    return src.slice(a, b);
  };
  // The option is declared on runTurn's parameter object…
  const params = between('export function runTurn({', '}) {');
  assert.ok(params.includes('onUsage'), 'runTurn no longer takes onUsage');
  // …and handed to handleStreamLine by the line reader, which is the hop a
  // direct call to handleStreamLine can never exercise.
  const onLine = between('const onLine = (line) => {', 'const ev = rt.parse(line, cwd)');
  assert.ok(onLine.includes('onUsage'), 'onLine no longer passes onUsage through');
});
