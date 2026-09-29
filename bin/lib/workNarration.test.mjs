import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorkNarration } from './workNarration.mjs';

/** The tab's live line, driven directly (split out of work.mjs 2026-09-26,
 *  SOLID F037) against a recording fetch. */
function recordFetch(t) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), body: JSON.parse(opts.body) });
    return { ok: true, status: 200 };
  };
  t.after(() => {
    globalThis.fetch = real;
  });
  return calls;
}
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

test('a deferral is said once per session per window, and speaks again once a turn has started', async (t) => {
  const calls = recordFetch(t);
  const { sayTurnDeferred, lastDeferSaid } = createWorkNarration();
  sayTurnDeferred('s1', 't1', 'the machine is at its ceiling');
  sayTurnDeferred('s1', 't1', 'the machine is at its ceiling');
  await tick(5);
  assert.equal(calls.length, 1, 'a re-offer every poll is not a POST every poll');
  assert.ok(calls[0].url.endsWith('/session-activity'));
  assert.deepEqual(calls[0].body, {
    sessionId: 's1',
    turnId: 't1',
    lines: ['Deferred — the machine is at its ceiling. The machine retries on its next poll.'],
  });
  sayTurnDeferred('s2', 't2', 'memory is low');
  lastDeferSaid.delete('s1'); // what the session lane does when a turn starts
  sayTurnDeferred('s1', 't3', 'memory is low');
  await tick(5);
  assert.equal(calls.length, 3);
});

test('the narrator relays a scrubbed, one-line, capped tail on a throttle, with the tool log beside it', async (t) => {
  const calls = recordFetch(t);
  const { makeNarrator } = createWorkNarration();
  const tools = { ev: [{ t: 'read', p: 'a.js' }], dropped: 0 };
  const n = makeNarrator('s1', 't1', () => tools);
  n.line('  reading\n\n a.js  ');
  n.line('x'.repeat(500));
  n.line('');
  await tick(20);
  assert.equal(calls.length, 1, 'one POST per window');
  // Both lines landed before the beat fired; the second is cut to 200.
  assert.deepEqual(calls[0].body.lines, ['reading a.js', 'x'.repeat(200)]);
  assert.deepEqual(calls[0].body.tools, tools);
  assert.equal(calls[0].body.turnId, 't1', 'narration is scoped to the turn that produced it');
  n.line('queued behind the throttle');
  n.stop();
  await tick(1_700);
  assert.equal(calls.length, 1, 'a stopped narrator sends nothing more, even what was pending');
});
