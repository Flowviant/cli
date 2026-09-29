import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAgentTurnReports } from './workAgentTurnReports.mjs';

/**
 * THE AGENT-TURN WIRE (workAgentTurnReports.mjs, split out by SOLID F036).
 *
 * The held-body contract end to end through the lane lives in work.test.mjs;
 * these cases pin the module's own vocabulary directly: which answers count
 * as delivered, which refusal backs off, which a network blip leaves held,
 * and the roster clock that ages what is held.
 */
function stubFetch(t, respond) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), body: JSON.parse(opts.body) });
    return respond(calls.length);
  };
  t.after(() => {
    globalThis.fetch = real;
  });
  return calls;
}
const answer = (status, data = {}) => {
  const ok = status >= 200 && status < 300;
  return { ok, status, json: async () => (ok ? { data } : { error: 'REQUEST_REFUSED' }) };
};

test('only a 2xx is delivered; a refusal stays held and backs off; a blip stays held', async (t) => {
  const r = createAgentTurnReports({ REJECT_RETRY_MS: 60_000 });
  let next = () => answer(200, { review: true });
  const calls = stubFetch(t, () => next());
  assert.deepEqual(await r.postAgentTurn({ turnId: 't1', outcome: 'delivered' }), { review: true }, 'the reply is handed back');
  assert.ok(calls[0].url.endsWith('/agent-turn-done'));
  assert.equal(r.agentReported.has('t1'), false, 'delivered, so not held');

  next = () => answer(403);
  assert.equal(await r.postAgentTurn({ turnId: 't2', outcome: 'nothing' }), null);
  assert.equal(r.agentReported.has('t2'), true, 'a refused body is the skip-guard: it stays held');
  assert.ok(r.agentRejectedUntil.get('t2') > Date.now(), '…and waits out a backoff');

  next = () => answer(429);
  await r.postAgentTurn({ turnId: 't3', outcome: 'nothing' });
  assert.equal(r.agentReported.has('t3'), true);
  assert.equal(r.agentRejectedUntil.has('t3'), false, 'a 429 is retryable, not a refusal');

  next = () => {
    throw new Error('network down');
  };
  assert.equal(await r.postAgentTurn({ turnId: 't4', outcome: 'nothing' }), null);
  assert.equal(r.agentReported.has('t4'), true, 'a blip leaves the finished body held for the next offer');

  next = () => answer(200);
  await r.postAgentTurn({ turnId: 't2', outcome: 'nothing' });
  assert.equal(r.agentReported.has('t2'), false);
  assert.equal(r.agentRejectedUntil.has('t2'), false, 'a later success clears the backoff too');
});

test('the roster is the held bodies\' clock: offered ones are refreshed, the rest age out', async (t) => {
  const r = createAgentTurnReports({ REJECT_RETRY_MS: 60_000 });
  stubFetch(t, () => answer(404));
  await r.postAgentTurn({ turnId: 'kept', outcome: 'nothing' });
  await r.postAgentTurn({ turnId: 'gone', outcome: 'nothing' });
  const old = Date.now() - 31 * 60_000;
  r.agentReported.get('kept').at = old;
  r.agentReported.get('gone').at = old;
  r.pruneHeldReports([{ id: 'kept' }]);
  assert.ok(r.agentReported.get('kept').at > old, 'still offered, so still pending: its clock restarts');
  assert.equal(r.agentReported.has('gone'), false, 'no longer offered and past the grace: dropped');
  assert.equal(r.agentRejectedUntil.has('gone'), false, 'with its backoff');
  // Inside the grace, an un-offered body survives a racing final offer.
  await r.postAgentTurn({ turnId: 'fresh', outcome: 'nothing' });
  r.pruneHeldReports([]);
  assert.equal(r.agentReported.has('fresh'), true);
});

test('a trace batch is done on success or a permanent refusal, and retried on a blip', async (t) => {
  const r = createAgentTurnReports({ REJECT_RETRY_MS: 60_000 });
  let next = () => answer(404);
  stubFetch(t, () => next());
  assert.equal(await r.postAgentTrace({ turnId: 't', entries: [] }), true, 'an older server never learns the trace');
  next = () => answer(408);
  assert.equal(await r.postAgentTrace({ turnId: 't', entries: [] }), false);
  next = () => {
    throw new Error('blip');
  };
  assert.equal(await r.postAgentTrace({ turnId: 't', entries: [] }), false, 'the same entries go again');
});

test('the park names its CLI only when it knows it; the pulse and the park never throw', async (t) => {
  const r = createAgentTurnReports({ REJECT_RETRY_MS: 60_000 });
  let next = () => answer(200);
  const calls = stubFetch(t, () => next());
  await r.postAgentParked('usage limit reached', 'codex');
  await r.postAgentParked('usage limit reached');
  assert.deepEqual(calls[0].body, { reason: 'usage limit reached', runtime: 'codex' });
  assert.deepEqual(calls[1].body, { reason: 'usage limit reached' }, 'an unnamed park is every agent, as it always was');
  await r.postAgentActivity('ag-1', 'reading files');
  assert.deepEqual(calls[2].body, { agentId: 'ag-1', text: 'reading files' });
  next = () => {
    throw new Error('down');
  };
  await r.postAgentParked('x', 'claude');
  await r.postAgentActivity('ag-1', 'y');
});
