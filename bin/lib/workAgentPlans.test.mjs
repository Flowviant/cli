/**
 * THE PLANNER'S SPEND RIDES EVERY REPORT THAT FOLLOWS ITS SPAWN (2026-09-28).
 *
 * A Deploy press runs one read-only planning turn, and until now nothing
 * counted it. Every post-turn report to `/fleet/agent-plan-done` — the
 * proposal, a reply that did not parse, a thrown turn — now carries the
 * turn's `usage`, tagged with the CLI that counted it (the agent lane's wire
 * shape). A report with nothing spent carries no key.
 *
 * `runTurn`, `detectRuntimes` and `pickRuntimeFor` are injected (a test must
 * not spend a model turn); `fetch` is stubbed to grant the server's claim.
 *
 * Run: node --test bin/lib/workAgentPlans.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.HOME = mkdtempSync(join(tmpdir(), 'fv-plans-home-'));
process.env.FLOWVIANT_FLEET_URL = 'http://127.0.0.1:9/api/fleet/agents';
process.env.FLOWVIANT_FLEET = 'fva_plans_test';

const { createWorkAgentPlans } = await import('./workAgentPlans.mjs');
const { RUNTIMES } = await import('./runtimes.mjs');

// The claim is granted; narration lines are swallowed. Nothing leaves the box.
const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => ({
  ok: true,
  status: 200,
  json: async () => (String(url).endsWith('/agent-plan-claim') ? { data: { claimed: true } } : {}),
});
test.after(() => {
  globalThis.fetch = realFetch;
});

function planLane(runTurn = async () => PROPOSAL, {
  pickRuntimeFor = () => 'claude',
  detectRuntimes = () => [{ id: 'claude', installed: true }, { id: 'codex', installed: true }],
} = {}) {
  const posted = [];
  const turns = [];
  const lane = createWorkAgentPlans({
    postBestEffort: async (url, body) => {
      posted.push({ url, body });
    },
    baseDir: mkdtempSync(join(tmpdir(), 'fv-plans-base-')),
    baseRef: () => 'main',
    inPlace: (place, write, fn) => fn(),
    repoRoot: mkdtempSync(join(tmpdir(), 'fv-plans-repo-')),
    admit: Object.assign(() => null, { reserve: () => () => {} }),
    placeLocks: new Map(),
    workChildren: new Map(),
    runTurn: (opts) => {
      turns.push(opts);
      return runTurn(opts);
    },
    pickRuntimeFor,
    detectRuntimes,
  });
  const run = async (id, job = {}) => {
    lane.processAgentPlanJobs([{ id, tasks: [{ id: 'c1', title: 'Fix login' }], liveAgents: [], ...job }]);
    for (let i = 0; i < 300 && !posted.length; i++) await new Promise((r) => setTimeout(r, 5));
    assert.equal(posted.length, 1, 'one report per press');
    assert.match(posted[0].url, /\/agent-plan-done$/);
    return posted[0].body;
  };
  return { run, turns };
}

const SPENT = { input: 12, output: 340, cacheCreate: 900, cacheRead: 15000 };
const PROPOSAL = JSON.stringify({ agents: [{ tempId: 'a1', name: 'auth', taskIds: ['c1'] }] });

test('a job naming installed Codex runs on Codex ahead of the picker', async () => {
  const lane = planLane(async (opts) => {
    opts.onUsage(SPENT);
    return PROPOSAL;
  }, { pickRuntimeFor: () => assert.fail('a named CLI must not take the picker') });
  const body = await lane.run('picked', { runtime: 'codex' });
  assert.ok(body.proposal);
  assert.equal(lane.turns.length, 1);
  assert.equal(lane.turns[0].runtime, 'codex');
  assert.equal(lane.turns[0].profile, 'consult');
  assert.equal('mcpArgs' in lane.turns[0], false);
  assert.deepEqual(body.usage, { ...SPENT, runtime: 'codex' });
});

test('a job naming an uninstalled CLI settles in words and spawns nothing', async () => {
  const lane = planLane(undefined, {
    detectRuntimes: () => [{ id: 'claude', installed: true }, { id: 'codex', installed: false }],
    pickRuntimeFor: () => assert.fail('a missing pick must not fall back'),
  });
  const body = await lane.run('missing', { runtime: 'codex' });
  assert.equal(body.id, 'missing');
  assert.equal(body.error, 'Codex is not installed on this machine');
  assert.equal(lane.turns.length, 0);
  assert.equal('usage' in body, false);
});

test('an installed CLI without consult support settles in words and spawns nothing', async (t) => {
  const profiles = RUNTIMES.codex.profiles;
  t.after(() => { RUNTIMES.codex.profiles = profiles; });
  RUNTIMES.codex.profiles = profiles.filter((profile) => profile !== 'consult');
  const lane = planLane(undefined, {
    pickRuntimeFor: () => assert.fail('an unsupported pick must not fall back'),
  });
  const body = await lane.run('unsupported', { runtime: 'codex' });
  assert.equal(body.error, "Codex can't run a read-only turn on this machine");
  assert.equal(lane.turns.length, 0);
});

for (const runtime of ['future-cli', 'toString', '__proto__']) {
  test(`an unknown runtime ${runtime} settles in words and spawns nothing`, async () => {
    const lane = planLane(undefined, {
      detectRuntimes: () => assert.fail('an unknown CLI must not be probed'),
      pickRuntimeFor: () => assert.fail('an unknown pick must not fall back'),
    });
    const body = await lane.run('unknown', { runtime });
    assert.equal(body.error, `${runtime} is not a CLI this machine knows`);
    assert.equal(lane.turns.length, 0);
  });
}

test('a job without a runtime takes the consult picker and leaves knobs absent', async () => {
  const profiles = [];
  const lane = planLane(undefined, {
    pickRuntimeFor: (profile) => { profiles.push(profile); return 'codex'; },
    detectRuntimes: () => assert.fail('the fallback picker handles detection'),
  });
  assert.ok((await lane.run('fallback')).proposal);
  assert.deepEqual(profiles, ['consult']);
  assert.equal(lane.turns.length, 1);
  assert.equal(lane.turns[0].runtime, 'codex');
  assert.equal('model' in lane.turns[0], false);
  assert.equal('effort' in lane.turns[0], false);
});

for (const pin of [{ model: 'opus' }, { effort: 'max' }, { model: 'opus', effort: 'max' }]) {
  const name = JSON.stringify(pin);
  test(`a pin without a runtime ${name} settles in words when Claude is missing`, async () => {
    const lane = planLane(undefined, {
      detectRuntimes: () => [{ id: 'claude', installed: false }, { id: 'codex', installed: true }],
      pickRuntimeFor: () => 'codex',
    });
    const body = await lane.run('missing-claude', pin);
    assert.equal(body.id, 'missing-claude');
    assert.equal(body.error, 'Claude Code is not installed on this machine');
    assert.equal(lane.turns.length, 0);
    assert.equal('usage' in body, false);
  });

  test(`a pin without a runtime ${name} runs on installed Claude with its pin`, async () => {
    const lane = planLane(undefined, { pickRuntimeFor: () => 'codex' });
    assert.ok((await lane.run('pinned-claude', pin)).proposal);
    assert.equal(lane.turns.length, 1);
    assert.equal(lane.turns[0].runtime, 'claude');
    assert.equal(lane.turns[0].profile, 'consult');
    assert.equal('mcpArgs' in lane.turns[0], false);
    for (const key of ['model', 'effort']) {
      assert.equal(lane.turns[0][key], pin[key]);
      assert.equal(key in lane.turns[0], key in pin);
    }
  });
}

test('null model and effort without a runtime keep the consult picker', async () => {
  const lane = planLane(undefined, {
    pickRuntimeFor: () => 'codex',
    detectRuntimes: () => assert.fail('the fallback picker handles detection'),
  });
  assert.ok((await lane.run('null-brain', { model: null, effort: null })).proposal);
  assert.equal(lane.turns.length, 1);
  assert.equal(lane.turns[0].runtime, 'codex');
  assert.equal('model' in lane.turns[0], false);
  assert.equal('effort' in lane.turns[0], false);
});

test('the picked model and effort reach the read-only planning turn', async () => {
  const lane = planLane();
  assert.ok((await lane.run('brain', { runtime: 'codex', model: 'gpt-5.4', effort: 'xhigh' })).proposal);
  assert.equal(lane.turns.length, 1);
  assert.equal(lane.turns[0].model, 'gpt-5.4');
  assert.equal(lane.turns[0].effort, 'xhigh');
});

test('a proposal carries what the planning turn spent, tagged with its CLI', async () => {
  const body = await planLane(async (opts) => {
    opts.onUsage(SPENT);
    return JSON.stringify({ agents: [{ tempId: 'a1', name: 'auth', taskIds: ['c1'] }] });
  }).run('p1');
  assert.ok(body.proposal, 'canary: this is the proposal report');
  assert.deepEqual(body.usage, { ...SPENT, runtime: 'claude' });
});

test('a reply that did not parse still carries its spend', async () => {
  const body = await planLane(async (opts) => {
    opts.onUsage(SPENT);
    return 'I could not decide how to split these.';
  }).run('p2');
  assert.match(body.error, /did not come back as JSON/);
  assert.deepEqual(body.usage, { ...SPENT, runtime: 'claude' });
});

test('a turn that threw after its CLI reported still carries its spend', async () => {
  const body = await planLane(async (opts) => {
    opts.onUsage(SPENT);
    throw new Error('the pipe broke');
  }).run('p3');
  assert.equal(body.error, 'the pipe broke');
  assert.deepEqual(body.usage, { ...SPENT, runtime: 'claude' });
});

test('a turn whose CLI reported nothing carries no usage key — unknown, not zero', async () => {
  const body = await planLane(async () => JSON.stringify({ agents: [{ tempId: 'a1', taskIds: ['c1'] }] })).run('p4');
  assert.ok(body.proposal);
  assert.equal('usage' in body, false);
});
