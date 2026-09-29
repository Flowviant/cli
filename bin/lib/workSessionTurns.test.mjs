import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkSessionTurns, PLAN_TURN_SENTENCE } from './workSessionTurns.mjs';
import { CODEX_RUNTIME } from './runtimeCodex.mjs';

/**
 * A WORKBENCH TAB'S TURN, driven directly (split out of work.mjs 2026-09-26,
 * SOLID F037). Every dependency is handed in by name, so the refusals that
 * happen before any CLI spawns — the ones whose ORDER is the lane's contract —
 * are reachable here with plain stubs; work.test.mjs drives the same lane
 * through the real manager.
 */
function lane(over = {}) {
  const settled = [];
  const said = [];
  const measured = [];
  const runs = [];
  const rejected = [];
  const deps = {
    repoRoot: '/repo',
    baseDir: '/base',
    getMcpUrl: () => 'http://127.0.0.1:0/mcp',
    getArtifactsAccepted: () => false,
    admit: Object.assign(() => null, { reserve: () => () => {} }),
    inPlace: (place, write, fn) => {
      runs.push(fn().catch((e) => rejected.push(e)));
    },
    workChildren: new Map(),
    workAttempts: new Map(),
    sessionPlaces: new Map(),
    placeOf: (id) => id,
    placeWtFor: () => null,
    sessionMetaPath: () => null,
    beforeArtifacts: () => null,
    artifacts: { report: async () => {} },
    settleWorkTurn: async (turnId, payload) => {
      settled.push({ turnId, ...payload });
      return 'ok';
    },
    pendingWorkReports: new Map(),
    workTokens: new Map(),
    mintWorkToken: async () => null,
    sessionRuntime: () => ({ id: null }),
    agyRegistryLookup: () => null,
    carryDirtyState: () => '',
    fetchAttachments: async () => [],
    makeNarrator: () => ({ line() {}, stop() {} }),
    sayTurnDeferred: (...a) => said.push(a),
    lastDeferSaid: new Map(),
    noteSessionGroup: () => {},
    reportPlaceWorktrees: async (id) => void measured.push(id),
    burstListeners: () => {},
    ...over,
  };
  const turns = createWorkSessionTurns(deps);
  const settle = async () => {
    await Promise.all(runs);
    await new Promise((r) => setTimeout(r, 5));
  };
  return { ...turns, deps, settled, said, measured, rejected, settle };
}

test('a deferred turn is said, not settled, and consumes nothing', async () => {
  const l = lane({ admit: Object.assign(() => ({ reason: 'the machine is at its ceiling' }), { reserve: () => () => {} }) });
  l.processWorkTurns([{ id: 't1', body: 'hi', sessionId: 's1' }]);
  await l.settle();
  assert.deepEqual(l.said, [['s1', 't1', 'the machine is at its ceiling']]);
  assert.deepEqual(l.settled, []);
  assert.equal(l.workAnswering.size, 0);
  assert.equal(l.deps.workAttempts.size, 0);
});

test('a turn whose answer is still queued for delivery is never run again', async () => {
  const l = lane();
  l.deps.pendingWorkReports.set('t1', { turnId: 't1' });
  l.processWorkTurns([{ id: 't1', body: 'hi', sessionId: 's1' }]);
  await l.settle();
  assert.deepEqual(l.settled, []);
  assert.equal(l.deps.sessionPlaces.size, 0);
});

test('a traversal place is settled in words and never stored', async () => {
  const l = lane();
  l.processWorkTurns([{ id: 't1', body: 'hi', sessionId: 's1', place: '../../etc' }]);
  await l.settle();
  assert.equal(l.settled.length, 1);
  assert.match(l.settled[0].answer, /working directory this machine refuses to use/);
  assert.equal(l.deps.sessionPlaces.size, 0);
  assert.equal(l.workAnswering.size, 0);
});

test('a place that cannot be opened settles, is remembered for the other beats, and is re-measured', async () => {
  const l = lane();
  l.processWorkTurns([{ id: 't1', body: 'hi', sessionId: 's1', place: 'u-alice' }]);
  await l.settle();
  assert.match(l.settled[0].answer, /session worktree could not be opened/);
  assert.equal(l.deps.sessionPlaces.get('s1'), 'u-alice');
  assert.deepEqual(l.measured, ['s1'], 'every turn — even a refused one — re-measures its place');
});

test('a turn out of local tries settles instead of stranding the tab', async () => {
  const l = lane();
  l.deps.workAttempts.set('t1', 3);
  l.processWorkTurns([{ id: 't1', body: 'hi', sessionId: 's1' }]);
  await l.settle();
  assert.match(l.settled[0].answer, /the turn failed 3 times on this machine/);
});

test('the plan sentence is exported beside the lane that appends it', () => {
  assert.match(PLAN_TURN_SENTENCE, /PLANNING TURN/);
});

/**
 * A TURN THAT THROWS STILL SETTLES, in its own words (2026-09-26). The catch
 * spread the turn's tool log into the failed settle — but the log was declared
 * inside the `try`, so the catch itself threw a ReferenceError: no settle, the
 * exception's sentence lost, an unhandled rejection, and the turn re-offered
 * and RE-RUN (side effects and all) until its local tries ran out. Found by
 * the lint pass over the F037 split; the scope bug predates it.
 */
test('a turn that throws is settled with its own message, and the lane never rejects', async () => {
  const l = lane({
    placeWtFor: () => {
      throw new Error('the disk said no');
    },
  });
  l.processWorkTurns([{ id: 't1', body: 'hi', sessionId: 's1' }]);
  await l.settle();
  assert.deepEqual(l.rejected, [], 'the settle contract needs the catch to complete');
  assert.equal(l.settled.length, 1);
  assert.equal(l.settled[0].ok, false);
  assert.equal(l.settled[0].answer, 'the disk said no');
  assert.equal('tools' in l.settled[0], false, 'nothing ran, so no log rides the settle');
  assert.equal(l.workAnswering.size, 0);
});

/**
 * WHAT A TAB TURN SPENT RIDES ITS SETTLE (2026-09-28). Terminal tabs and
 * capture chats were never counted; now every settle that follows a spawn
 * carries the turn's `usage` — SUMMED over the resume and its fresh retry,
 * because both spawns spent real tokens — tagged with the CLI that counted it.
 * The wire shape is the agent lane's. `runTurn` is injected: a test must not
 * spend a model turn.
 */
function spendingLane(runTurn) {
  return lane({
    placeWtFor: () => ({ wt: '/tmp/fv-session-wt', fresh: false }),
    sessionRuntime: () => ({ id: 'claude' }),
    mintWorkToken: async () => ({ token: 'tok' }),
    runTurn,
  });
}

test('a Codex capture turn carries read-only staging MCP, prompt and brain pins, then resumes its own thread', async (t) => {
  const calls = [];
  const narrated = [];
  const dir = mkdtempSync(join(tmpdir(), 'fv-capture-codex-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const l = lane({
    placeWtFor: () => ({ wt: '/tmp/fv-capture-wt', fresh: true }),
    sessionMetaPath: (_wt, name, sessionId) => join(dir, `${name}-${sessionId}`),
    sessionRuntime: () => ({ id: 'codex' }),
    mintWorkToken: async () => ({ token: 'capture-token' }),
    makeNarrator: () => ({ line: (word) => narrated.push(word), stop() {} }),
    runTurn: async (opts) => { calls.push(opts); opts.onActivity({ label: 'reading cards' }); opts.onThreadId('0199a1b2-c3d4-7e8f'); return 'one staged card'; },
  });
  l.processWorkTurns([{ id: 't-capture', body: 'add a card', sessionId: 's-capture', capture: true, runtime: 'codex', model: 'gpt-test', effort: 'high' }]);
  await l.settle();
  assert.equal(l.rejected.length, 0);
  assert.equal(calls.length, 1);
  const turn = calls[0];
  assert.equal(turn.profile, 'plan');
  assert.match(turn.system, /stage_card/);
  assert.match(turn.system, /flowviant\.stage_card/, 'Codex sees its own MCP tool spelling');
  assert.match(turn.prompt, /Continue the task-capture chat/);
  assert.equal(turn.model, 'gpt-test');
  assert.equal(turn.effort, 'high');
  assert.deepEqual(turn.mcpEnv, { FLOWVIANT_MCP_TOKEN: 'capture-token' });
  const argv = CODEX_RUNTIME.args({ ...turn, mcp: turn.mcpArgs });
  assert.ok(argv.includes('sandbox_mode="read-only"'));
  assert.ok(argv.some((x) => x.includes('mcp_servers.flowviant.url')));
  assert.ok(argv.includes('gpt-test'));
  assert.ok(argv.includes('model_reasoning_effort="high"'));
  assert.match(argv.at(-1), /stage_card/);
  assert.deepEqual(narrated, ['reading cards']);
  assert.equal(l.settled[0].answer, 'one staged card');
  l.processWorkTurns([{ id: 't-capture-2', body: 'another card', sessionId: 's-capture', capture: true, runtime: 'codex' }]);
  await l.settle();
  assert.equal(calls[1].resume, true);
  assert.equal(calls[1].resumeThreadId, '0199a1b2-c3d4-7e8f');
});

test('a resumed turn that came back empty and its fresh retry are BOTH charged, on the one settle', async () => {
  const calls = [];
  const l = spendingLane(async (opts) => {
    calls.push(opts.resume);
    if (opts.resume) {
      // The held conversation is gone: the CLI still spent something saying so.
      opts.onUsage({ input: 10, output: 1, cacheCreate: 200, cacheRead: 3000 });
      return '';
    }
    opts.onUsage({ input: 5, output: 40, cacheCreate: 0, cacheRead: 7000 });
    return 'hello from the fresh retry';
  });
  // The session spoke here before, so the first spawn resumes.
  l.processWorkTurns([{ id: 't1', body: 'hi', sessionId: 's1', sessionRef: '/tmp/fv-session-wt' }]);
  await l.settle();
  assert.deepEqual(calls, [true, false], 'canary: the resume, then the fresh retry');
  assert.equal(l.settled.length, 1);
  assert.equal(l.settled[0].ok, true);
  assert.deepEqual(l.settled[0].usage, { input: 15, output: 41, cacheCreate: 200, cacheRead: 10000, runtime: 'claude' });
});

test('a turn that throws after its CLI reported still carries what it spent', async () => {
  const l = spendingLane(async (opts) => {
    opts.onUsage({ input: 7, output: 3, cacheCreate: 0, cacheRead: 0 });
    throw new Error('the pipe broke');
  });
  l.processWorkTurns([{ id: 't1', body: 'hi', sessionId: 's1' }]);
  await l.settle();
  assert.equal(l.settled.length, 1);
  assert.equal(l.settled[0].ok, false);
  assert.equal(l.settled[0].answer, 'the pipe broke');
  assert.deepEqual(l.settled[0].usage, { input: 7, output: 3, cacheCreate: 0, cacheRead: 0, runtime: 'claude' });
});

test('a turn whose CLI reported nothing settles with no usage key — unknown, not zero', async () => {
  const l = spendingLane(async () => 'an answer');
  l.processWorkTurns([{ id: 't1', body: 'hi', sessionId: 's1' }]);
  await l.settle();
  assert.equal(l.settled[0].ok, true);
  assert.equal('usage' in l.settled[0], false);
});

/**
 * THE MODEL THE TURN RAN ON RIDES ITS SETTLE (2026-09-29), as the CLI named
 * it — on the answer and on a turn that threw after its CLI spoke. The fresh
 * retry's model is the one that answered. Unmeasured is no key at all.
 */
test('a tab turn carries the model its CLI named, and none when it named none', async () => {
  const l = spendingLane(async (opts) => {
    if (opts.resume) {
      opts.onModel('claude-sonnet-5');
      return '';
    }
    opts.onModel('claude-opus-5-5');
    return 'hello';
  });
  l.processWorkTurns([{ id: 't1', body: 'hi', sessionId: 's1', sessionRef: '/tmp/fv-session-wt' }]);
  await l.settle();
  assert.equal(l.settled[0].ok, true);
  assert.equal(l.settled[0].model, 'claude-opus-5-5', 'the spawn that answered');

  const threw = spendingLane(async (opts) => {
    opts.onModel('gpt-6-sol');
    throw new Error('the pipe broke');
  });
  threw.processWorkTurns([{ id: 't2', body: 'hi', sessionId: 's2' }]);
  await threw.settle();
  assert.equal(threw.settled[0].ok, false);
  assert.equal(threw.settled[0].model, 'gpt-6-sol');

  const silent = spendingLane(async () => 'an answer');
  silent.processWorkTurns([{ id: 't3', body: 'hi', sessionId: 's3' }]);
  await silent.settle();
  assert.equal('model' in silent.settled[0], false);
});
