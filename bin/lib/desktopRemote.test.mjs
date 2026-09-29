import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { desktopStatus, desktopStatusRemote } from './desktopContract.mjs';

const entry = { projectId: 'p1', name: 'One', repoRoot: '/repo', fleetToken: 'secret' };
const agent = { id: 'a1', name: 'Build', status: 'working', runtime: 'codex', delivered: 2, total: 3, asks: true, parked: false, since: '2026-09-25T10:00:00.000Z' };
const boxes = { data: { boxes: [
  { boxId: 'other', boxName: 'server', role: 'serving', daemonVersion: '0.99.0' },
  { boxId: 'mine', boxName: 'laptop', role: 'inactive', daemonVersion: '0.98.0' },
], latest: '1.0.0', me: 'mine' } };
const live = { data: { agents: [agent], pressure: { reason: 'Memory is busy', at: '2026-09-25T10:01:00.000Z' } } };
const response = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const deps = { entries: [entry], runtimes: [], runningFor: () => null, stateFor: () => ({}),
  envpub: 'pub', host: 'fallback', fleetUrl: 'https://api.test/fleet/agents',
  now: () => '2026-09-25T10:02:00.000Z', log: () => {} };

function fetchFor(boxAnswer = response(200, boxes), liveAnswer = response(200, live), calls = []) {
  return async (url, init) => {
    calls.push({ url: String(url), init });
    return String(url).includes('/live-agents') ? liveAnswer : boxAnswer;
  };
}

test('plain status JSON keeps the existing project bytes', () => {
  const status = desktopStatus(deps);
  const expected = { schema: 1, version: status.version, installChannel: status.installChannel,
    // `busy` joined the contract 2026-09-26 (SOLID F034): the daemon's own
    // measurement, null = unknown — additive, the tray reads it by name.
    // `draining` joined it the same day (ruling 2026-09-26: a stand-down lets
    // a deploy finish): what a draining daemon is finishing, null otherwise.
    projects: [{ id: 'p1', name: 'One', dir: '/repo', running: null, holder: null, busy: null, draining: null,
      lastPoll: null, logFile: status.projects[0].logFile, runtimes: [] }], runtimes: [] };
  assert.equal(JSON.stringify(status), JSON.stringify(expected));
});

test('both reads pass through this box, the serving box, and live agents', async () => {
  const calls = [];
  const status = await desktopStatusRemote({ ...deps, fetchImpl: fetchFor(undefined, undefined, calls) });
  assert.equal(status.schema, 1);
  assert.deepEqual(status.projects[0].remote, {
    at: '2026-09-25T10:02:00.000Z', boxName: 'laptop', role: 'inactive',
    servingBoxName: 'server', daemonVersion: '0.98.0', latest: '1.0.0',
    agents: [agent], pressure: live.data.pressure,
  });
  assert.deepEqual(calls.map((call) => call.url), [
    'https://api.test/fleet/boxes?envpub=pub', 'https://api.test/fleet/live-agents',
  ]);
  assert(calls.every((call) => call.init.headers.Authorization === 'Bearer secret'));
  assert(calls.every((call) => call.init.signal instanceof AbortSignal));
});

test('a 404 live-agents route keeps the box fields and marks live data unknown', async () => {
  const status = await desktopStatusRemote({ ...deps, fetchImpl: fetchFor(response(200, boxes), response(404)) });
  assert.equal(status.projects[0].remote.boxName, 'laptop');
  assert.equal(status.projects[0].remote.agents, null);
  assert.equal(status.projects[0].remote.pressure, null);
});

test('a box without a registry row uses the measured host and no role', async () => {
  const answer = { data: { ...boxes.data, me: 'not-listed' } };
  const status = await desktopStatusRemote({ ...deps, fetchImpl: fetchFor(response(200, answer)) });
  assert.equal(status.projects[0].remote.boxName, 'fallback');
  assert.equal(status.projects[0].remote.role, null);
  assert.equal(status.projects[0].remote.daemonVersion, null);
});

test('failed boxes keep live agents, and two failures or no credential give null', async () => {
  const logs = [];
  const one = await desktopStatusRemote({ ...deps, fetchImpl: fetchFor(response(500), response(200, live)), log: (line) => logs.push(line) });
  assert.deepEqual(one.projects[0].remote, {
    at: '2026-09-25T10:02:00.000Z', boxName: null, role: null, servingBoxName: null,
    daemonVersion: null, latest: null, agents: [agent], pressure: live.data.pressure,
  });
  assert.deepEqual(logs, ['status --remote p1 boxes: HTTP 500']);
  const both = await desktopStatusRemote({ ...deps, fetchImpl: fetchFor(response(500), response(404)) });
  assert.equal(both.projects[0].remote, null);
  const empty = await desktopStatusRemote({ ...deps, entries: [{ ...entry, fleetToken: '' }],
    fetchImpl: () => { throw new Error('must not fetch'); } });
  assert.equal(empty.projects[0].remote, null);
});

test('malformed live agent rows are dropped without changing reported words', async () => {
  const answer = { data: { agents: [agent, { ...agent, id: null }, { ...agent, total: '3' }, { ...agent, name: '' }, { ...agent, asks: 1 }], pressure: live.data.pressure } };
  const status = await desktopStatusRemote({ ...deps, fetchImpl: fetchFor(response(200, boxes), response(200, answer)) });
  assert.deepEqual(status.projects[0].remote.agents, [agent]);
  assert.deepEqual(status.projects[0].remote.pressure, live.data.pressure);
});

test('an unanswered request is aborted at its deadline and other projects finish in parallel', async () => {
  const signals = [];
  const fetchImpl = (url, init) => {
    if (String(url).includes('/boxes')) return response(200, boxes);
    signals.push(init.signal);
    return new Promise(() => {});
  };
  const started = Date.now();
  const status = await desktopStatusRemote({ ...deps, entries: [entry, { ...entry, projectId: 'p2' }],
    fetchImpl, timeoutMs: 20 });
  assert(Date.now() - started < 1000);
  assert.equal(signals.length, 2);
  assert(signals.every((signal) => signal.aborted));
  assert(status.projects.every((project) => project.remote.agents === null));
});

test('the live-agents read is refused in the boxes read\'s classes, and logged in its words', async () => {
  const typed = (status, type, body) => ({
    ok: false, status, headers: { get: (h) => (h.toLowerCase() === 'content-type' ? type : null) },
    json: async () => body,
  });
  const cases = [
    [typed(401, 'application/json', { success: false, error: {} }), 'credential rejected'],
    [typed(403, 'text/html', null), 'HTTP 403 from something in front of the app'],
    [response(404), 'HTTP 404'],
    [response(502), 'HTTP 502'],
  ];
  for (const [answer, words] of cases) {
    const logs = [];
    const status = await desktopStatusRemote({ ...deps, fetchImpl: fetchFor(response(200, boxes), answer), log: (l) => logs.push(l) });
    assert.equal(status.projects[0].remote.agents, null);
    assert.deepEqual(logs, [`status --remote p1 live-agents: ${words}`]);
  }
});

test('the tray reads classify through machines.mjs and spell no status rule of their own', () => {
  const code = readFileSync(new URL('./desktopContract.mjs', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l))
    .join('\n');
  assert.match(code, /async function fetchLiveAgentsFor/, 'reading the real module (canary)');
  assert.ok(code.includes('await classifyMachineResponse(res)'));
  assert.ok(!code.includes('HTTP ${res.status}'), 'no status rule of its own');
  assert.ok(!code.includes('credentialRejected'));
});
