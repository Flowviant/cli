/**
 * THE PLANNER'S SPEND RIDES EVERY REPORT THAT FOLLOWS ITS SPAWN (2026-09-28).
 *
 * A Deploy press runs one read-only planning turn, and until now nothing
 * counted it. Every post-turn report to `/fleet/agent-plan-done` — the
 * proposal, a reply that did not parse, a thrown turn — now carries the
 * turn's `usage`, tagged with the CLI that counted it (the agent lane's wire
 * shape). A report with nothing spent carries no key.
 *
 * `runTurn` and `pickRuntimeFor` are injected (a test must not spend a model
 * turn); the claim is the server's answer, so `fetch` is stubbed to grant it.
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

function planLane(runTurn) {
  const posted = [];
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
    runTurn,
    pickRuntimeFor: () => 'claude',
  });
  const run = async (id) => {
    lane.processAgentPlanJobs([{ id, tasks: [{ id: 'c1', title: 'Fix login' }], liveAgents: [] }]);
    for (let i = 0; i < 300 && !posted.length; i++) await new Promise((r) => setTimeout(r, 5));
    assert.equal(posted.length, 1, 'one report per press');
    assert.match(posted[0].url, /\/agent-plan-done$/);
    return posted[0].body;
  };
  return { run };
}

const SPENT = { input: 12, output: 340, cacheCreate: 900, cacheRead: 15000 };

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
