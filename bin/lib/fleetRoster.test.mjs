/**
 * THE ROSTER POLL, DRIVEN AGAINST A REAL SERVER (2026-09-26, SOLID F038).
 *
 * `fetchRoster` was only ever proved by source slices spread over seven test
 * files — what it sends and how it reads the answer are DECISIONS about a
 * query string and an HTTP status, so they are asserted here over the wire: a
 * `node:http` server on an ephemeral port, the daemon pointed at it through
 * `FLOWVIANT_FLEET_URL`, and a fake `claude` on PATH so the `runtimes` report
 * is this test's fact rather than the box's.
 *
 * Each scenario that cares about the one machine ask imports fleetRoster.mjs
 * under its OWN query string, so it gets a fresh `machineAskSpent`; every
 * other module (runtimeDetection.mjs's and runtimeCapabilities.mjs's caches
 * included) is the shared graph.
 *
 * Run: node --test bin/lib/fleetRoster.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// HOME, PATH and the server URL are settled BEFORE anything imports
// config.mjs: FLEET_URL is read once at import, the keypair lives under HOME,
// and runtime detection runs `<bin> --version` off PATH.
process.env.HOME = mkdtempSync(join(tmpdir(), 'fv-roster-home-'));
delete process.env.FLOWVIANT_REEXEC; // a re-exec is born with the ask spent
const fakeBin = join(process.env.HOME, 'bin');
mkdirSync(fakeBin);
writeFileSync(join(fakeBin, 'claude'), '#!/bin/sh\necho "2.1.0 (Claude Code)"\n');
chmodSync(join(fakeBin, 'claude'), 0o755);
process.env.PATH = fakeBin;

/** Answers queued per request to the roster route; everything else is 200 {}. */
const answers = [];
const received = [];
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  received.push({ path: url.pathname, params: url.searchParams, auth: req.headers.authorization, raw: req.url });
  req.resume();
  const next = url.pathname === '/api/fleet/agents' ? answers.shift() : null;
  const { status = 200, type = 'application/json', body = { success: true, data: {} } } =
    next ?? (url.pathname === '/api/fleet/boxes' ? boxesAnswer : {});
  res.writeHead(status, { 'Content-Type': type });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
process.env.FLOWVIANT_FLEET_URL = `http://127.0.0.1:${server.address().port}/api/fleet/agents`;
process.env.FLOWVIANT_FLEET = 'fva_roster_test';
test.after(() => server.close());

let boxesAnswer = { body: { success: true, data: { boxes: [], me: null } } };
const ROSTER_OK = { body: { success: true, data: { agents: [], mcpUrl: 'http://mcp' } } };

const { MACHINE_HOST } = await import('./config.mjs');
const detection = await import('./runtimeDetection.mjs');
const capabilities = await import('./runtimeCapabilities.mjs');
const limits = await import('./runtimeLimits.mjs');
const fresh = (tag) => import(`./fleetRoster.mjs?case=${tag}`);
const lastPoll = () => received.filter((r) => r.path === '/api/fleet/agents').at(-1).params;

test('what a poll says about the box: identity always, readouts only once measured, `have` never', async () => {
  const { fetchRoster } = await fresh('identity');
  answers.push(ROSTER_OK);
  await fetchRoster([], [], undefined, '/srv/checkout', null);
  const p = lastPoll();
  assert.equal(received.at(-1).auth, 'Bearer fva_roster_test');
  assert.equal(p.get('mh'), MACHINE_HOST ?? null, 'the hostname when readable, absent when not');
  assert.equal(p.get('cp'), '/srv/checkout');
  assert.equal(p.get('pid'), String(process.pid));
  for (const k of ['dv', 'safe', 'di', 'st', 'capacity', 'envpub']) assert.ok(p.has(k), `${k} rides every poll`);
  // Always set, even empty: '' is "serving none", absent is an older daemon.
  assert.equal(p.get('pv'), '');
  assert.equal(p.get('ws'), '');
  assert.equal(p.get('runtimes'), 'claude', 'the CLI this box can drive');
  // No admission offered: no `pr`, and no `mt` riding it.
  assert.equal(p.has('pr'), false);
  assert.equal(p.has('mt'), false);
  // Not taught by any turn yet: absent, never an asserted empty.
  assert.equal(p.has('skills'), false);
  assert.equal(p.has('mcp'), false);
  assert.equal(p.has('rtl'), false, 'no plan window learned and no plan known: absent');
  assert.equal(p.has('have'), false, 'the dispatch-era token list is gone from the wire');
});

test('measured-empty is sent as a fact: no CLI, no skills', async () => {
  const { fetchRoster } = await fresh('empty');
  rmSync(join(fakeBin, 'claude'));
  detection.detectRuntimes({ refresh: true });
  capabilities.recordSkills([]);
  capabilities.recordMcpServers([{ name: 'linear', status: 'needs-auth' }, { name: 'gh', status: 'connected' }]);
  try {
    answers.push(ROSTER_OK);
    await fetchRoster(['s1', 's2'], ['w1'], undefined, null, null);
    const p = lastPoll();
    assert.equal(p.get('runtimes'), '', 'looked, and can drive none');
    assert.equal(p.get('skills'), '', 'a turn taught us: none installed');
    assert.deepEqual(JSON.parse(p.get('mcp')), [{ n: 'linear', s: 'needs-auth' }], 'a connected server stays on the box');
    assert.equal(p.get('pv'), 's1,s2');
    assert.equal(p.get('ws'), 'w1');
    assert.equal(p.has('cp'), false, 'no checkout named, none claimed');
  } finally {
    writeFileSync(join(fakeBin, 'claude'), '#!/bin/sh\necho "2.1.0 (Claude Code)"\n');
    chmodSync(join(fakeBin, 'claude'), 0o755);
    detection.detectRuntimes({ refresh: true });
  }
});

test('the churn admission rides as `pr` with its bound, and says so positively when fine', async () => {
  const { fetchRoster } = await fresh('admission');
  answers.push(ROSTER_OK, ROSTER_OK);
  await fetchRoster([], [], null, null, null);
  assert.equal(lastPoll().get('pr'), '-', 'asked, and nothing holds');
  assert.match(lastPoll().get('mt'), /^\d+$/);
  await fetchRoster([], [], { reason: 'the machine is already running 2 CLI turns' }, null, null);
  assert.equal(lastPoll().get('pr'), 'the machine is already running 2 CLI turns');
  assert.ok(lastPoll().has('mt'));
});

test('the machine ask is sent until a poll is ANSWERED, then never again', async () => {
  const { fetchRoster, machineAskPending } = await fresh('claim');
  assert.equal(machineAskPending(), true);
  answers.push({ status: 502, type: 'text/html', body: '<html>bad gateway</html>' });
  await assert.rejects(fetchRoster([], []), (e) => !e.auth && /failed \(502\)/.test(e.message));
  assert.equal(lastPoll().get('claim'), '1');
  assert.equal(machineAskPending(), true, 'a failed poll does not spend the ask');
  answers.push(ROSTER_OK);
  await fetchRoster([], []);
  assert.equal(lastPoll().get('claim'), '1', 'the retry still asks');
  assert.equal(machineAskPending(), false);
  answers.push(ROSTER_OK);
  await fetchRoster([], []);
  assert.equal(lastPoll().has('claim'), false, 'asked once per process');
});

test('a malformed 200 is a RETRYABLE error, never a credential exit', async () => {
  const { fetchRoster } = await fresh('shape');
  for (const body of [{ success: true, data: {} }, { success: false, error: 'boom' }, { success: true, data: { agents: 'x' } }]) {
    answers.push({ body });
    await assert.rejects(fetchRoster([], []), (e) => !e.auth && /unexpected shape/.test(e.message));
  }
});

test('a roster agent with an unsafe id is dropped before anything uses it as a path', async () => {
  const { fetchRoster } = await fresh('ids');
  answers.push({ body: { success: true, data: { agents: [{ agentId: '../escape' }, { agentId: 'agent-1' }, null] } } });
  const roster = await fetchRoster([], []);
  assert.deepEqual(roster.agents, [{ agentId: 'agent-1' }]);
});

test("only the API's own refusal sets e.auth; an edge 401/403 is retried", async () => {
  const { fetchRoster } = await fresh('auth');
  answers.push({ status: 401, body: { success: false, error: 'Token revoked' } });
  await assert.rejects(fetchRoster([], []), (e) => e.auth === true);
  answers.push({ status: 403, type: 'text/html', body: '<html>challenge</html>' });
  await assert.rejects(fetchRoster([], []), (e) => !e.auth && /in front of the API \(403\)/.test(e.message));
});

test('the first answered poll names the project and the other boxes, once, off the poll path', async () => {
  const { announceFirstPoll } = await fresh('announce');
  boxesAnswer = {
    body: { success: true, data: { boxes: [{ boxId: 'b1', boxName: 'mac-mini', role: 'holder' }, { boxId: 'me' }], me: 'me' } },
  };
  const lines = [];
  const original = console.log;
  console.log = (m) => lines.push(String(m));
  try {
    const before = received.length;
    announceFirstPoll({ project: { id: 'proj-1', name: 'Contoso' } });
    assert.ok(lines.some((l) => l.includes('Contoso') && l.includes('proj-1')), 'the project is named');
    for (let i = 0; i < 200 && !lines.some((l) => l.includes('mac-mini')); i++) await new Promise((r) => setTimeout(r, 10));
    const boxes = received.slice(before).filter((r) => r.path === '/api/fleet/boxes');
    assert.equal(boxes.length, 1, 'one listing read');
    assert.ok(boxes[0].params.get('envpub'), 'asked as this box');
    const other = lines.find((l) => l.includes('other machines on this project'));
    assert.ok(other?.includes('mac-mini'), 'the other box is named');
  } finally {
    console.log = original;
  }
});

test('an older server with no boxes route prints nothing about other boxes', async () => {
  const { announceFirstPoll } = await fresh('announce-old');
  boxesAnswer = { status: 404, body: { success: false, error: 'Not found' } };
  const lines = [];
  const original = console.log;
  console.log = (m) => lines.push(String(m));
  try {
    const before = received.length;
    announceFirstPoll({});
    for (let i = 0; i < 200 && !received.slice(before).some((r) => r.path === '/api/fleet/boxes'); i++)
      await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(lines, [], 'no project, no boxes: nothing said');
  } finally {
    console.log = original;
  }
});

// MEASURED on Claude Code 2.1.283, 2026-09-28 — the rate_limit_event's info, verbatim.
const MEASURED_RATE_INFO = JSON.parse(
  '{"status":"allowed","resetsAt":1790619000,"rateLimitType":"five_hour","overageStatus":"rejected","overageDisabledReason":"out_of_credits","isUsingOverage":false,"unifiedWindows":{"five_hour":{"utilization":0.03,"resetsAt":1790619000},"seven_day":{"utilization":0.48,"resetsAt":1791028800}}}'
);

test('the plan windows ride as `rtl` once a turn taught them, and not before', async () => {
  const { fetchRoster } = await fresh('limits');
  limits.resetRuntimeLimitsForTest();
  answers.push(ROSTER_OK);
  await fetchRoster([], [], undefined, null, null);
  assert.equal(lastPoll().has('rtl'), false, 'nothing learned: absent');
  limits.recordClaudeRateLimit(MEASURED_RATE_INFO);
  try {
    answers.push(ROSTER_OK);
    await fetchRoster([], [], undefined, null, null);
    const rtl = JSON.parse(lastPoll().get('rtl'));
    assert.deepEqual(Object.keys(rtl), ['claude']);
    assert.equal(rtl.claude.status, 'allowed');
    assert.deepEqual(rtl.claude.windows.map((w) => [w.id, w.usedPct]), [['five_hour', 3], ['seven_day', 48]]);
    assert.ok(Buffer.byteLength(lastPoll().get('rtl')) <= limits.RUNTIME_LIMITS_PARAM_MAX);
  } finally {
    limits.resetRuntimeLimitsForTest();
  }
});

test('`rtl` is the readout that stays home when the poll URL is already long', async () => {
  const { fetchRoster } = await fresh('limits-long');
  limits.resetRuntimeLimitsForTest();
  limits.recordClaudeRateLimit(MEASURED_RATE_INFO);
  try {
    answers.push(ROSTER_OK);
    await fetchRoster([], [], undefined, null, null);
    const base = received.at(-1).raw.length;
    const rtlLen = encodeURIComponent(lastPoll().get('rtl')).length;
    assert.ok(rtlLen > 100, 'canary: a short poll carries it');
    // Enough preview ids that the URL fits under the budget only WITHOUT rtl.
    const id = 's'.repeat(36);
    const perId = id.length + 3; // the id and its encoded comma
    const room = 14_000 - (base - rtlLen);
    const n = Math.floor((room - rtlLen / 2) / perId);
    answers.push(ROSTER_OK);
    await fetchRoster(Array(n).fill(id), [], undefined, null, null);
    const p = lastPoll();
    assert.equal(p.get('pv').split(',').length, n, 'the poll itself still went out whole');
    assert.equal(p.has('rtl'), false, 'the plan windows stayed home');
    assert.ok(received.at(-1).raw.length <= 14_000);
  } finally {
    limits.resetRuntimeLimitsForTest();
  }
});
