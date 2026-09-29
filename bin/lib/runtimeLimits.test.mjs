/**
 * THE PLAN-LIMIT RELAY (2026-09-28, 0.109.0) — what each CLI said about its
 * plan windows, cached per process and reported on the roster poll as `rtl`.
 *
 * The two vendor lines below are MEASURED, pasted verbatim, and they pin the
 * one unit decision each CLI forces:
 *
 *  · Claude: MEASURED on Claude Code 2.1.283, 2026-09-28 (`claude -p "say hi"
 *    --model haiku --output-format stream-json --verbose`). `utilization` is a
 *    0–1 fraction (0.03 → 3%), so CLAUDE_UTILIZATION_SCALE is 100; `resetsAt`
 *    is epoch seconds. It fired on an ordinary turn, before the result line.
 *  · Codex: MEASURED on Codex 0.156.1, 2026-09-28 — no limits on `codex exec
 *    --json` stdout; the rollout's last `event_msg`/`token_count` payload
 *    carries `rate_limits` (`used_percent` 4.0, `window_minutes` 10080,
 *    `resets_at` seconds, `plan_type` 'prolite').
 *
 * Run: node --test bin/lib/runtimeLimits.test.mjs
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CLAUDE_UTILIZATION_SCALE,
  RUNTIME_LIMITS_PARAM_MAX,
  RUNTIME_LIMIT_ID_MAX,
  RUNTIME_LIMIT_PLAN_MAX,
  RUNTIME_LIMIT_WINDOWS_MAX,
  fitRuntimeLimits,
  learnCodexLimits,
  recordClaudeRateLimit,
  recordCodexRateLimits,
  resetRuntimeLimitsForTest,
  runtimeLimitsReport,
} from './runtimeLimits.mjs';
import { isoFromStamp } from './isoStamp.mjs';

// MEASURED on Claude Code 2.1.283, 2026-09-28 — verbatim.
const MEASURED_CLAUDE_LINE =
  '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1790619000,"rateLimitType":"five_hour","overageStatus":"rejected","overageDisabledReason":"out_of_credits","isUsingOverage":false,"unifiedWindows":{"five_hour":{"utilization":0.03,"resetsAt":1790619000},"seven_day":{"utilization":0.48,"resetsAt":1791028800}}},"uuid":"9c1e60ee-7c8d-491d-871f-b161560b90a9","session_id":"0fce9895-c1d7-462d-99ba-afdbe08fab1a"}';
// MEASURED on Codex 0.156.1, 2026-09-28 — the `rate_limits` of the last
// token_count in a real rollout, verbatim.
const MEASURED_CODEX_RATE_LIMITS =
  '{"limit_id":"codex","limit_name":null,"primary":{"used_percent":4.0,"window_minutes":10080,"resets_at":1791084105},"secondary":null,"credits":{"has_credits":false,"unlimited":false,"balance":"0"},"individual_limit":null,"spend_control_reached":null,"plan_type":"prolite","rate_limit_reached_type":null}';

const CLAUDE_HERE = [{ id: 'claude', installed: true }];
const NOW = Date.parse('2026-09-28T12:00:00.000Z');
const report = (over = {}) => runtimeLimitsReport({ detected: CLAUDE_HERE, plan: null, now: NOW, ...over });

beforeEach(() => resetRuntimeLimitsForTest());

test('the bounds are the app’s, and Claude’s scale is the measured one', () => {
  assert.equal(CLAUDE_UTILIZATION_SCALE, 100);
  assert.equal(RUNTIME_LIMITS_PARAM_MAX, 2000);
  assert.equal(RUNTIME_LIMIT_WINDOWS_MAX, 6);
  assert.equal(RUNTIME_LIMIT_ID_MAX, 40);
  assert.equal(RUNTIME_LIMIT_PLAN_MAX, 32);
});

test('nothing learned is null — no param, never an asserted empty', () => {
  assert.equal(report(), null);
  assert.equal(runtimeLimitsReport({ detected: [], plan: null }), null);
});

test('the MEASURED Claude line: 3% and 48% used, resets in seconds, allowed', () => {
  recordClaudeRateLimit(JSON.parse(MEASURED_CLAUDE_LINE).rate_limit_info, NOW);
  const r = report();
  assert.deepEqual(Object.keys(r), ['claude']);
  assert.equal(r.claude.status, 'allowed');
  assert.equal(r.claude.plan, null);
  assert.equal(r.claude.at, '2026-09-28T12:00:00.000Z');
  assert.deepEqual(r.claude.windows, [
    { id: 'five_hour', minutes: 300, usedPct: 3, resetsAt: new Date(1790619000 * 1000).toISOString(), at: '2026-09-28T12:00:00.000Z' },
    { id: 'seven_day', minutes: 10080, usedPct: 48, resetsAt: new Date(1791028800 * 1000).toISOString(), at: '2026-09-28T12:00:00.000Z' },
  ]);
  assert.equal(isoFromStamp(1790619000), '2026-09-28T18:10:00.000Z', 'seconds, not milliseconds');
});

test('an older CLI with only rateLimitType is read as that one window', () => {
  recordClaudeRateLimit({ status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 0.91, resetsAt: 1790619000 }, NOW);
  assert.deepEqual(report().claude.windows, [
    { id: 'five_hour', minutes: 300, usedPct: 91, resetsAt: '2026-09-28T18:10:00.000Z', at: '2026-09-28T12:00:00.000Z' },
  ]);
  assert.equal(report().claude.status, 'allowed_warning');
});

test('absent or garbage numbers are NULL, never 0; an unknown status is `other`', () => {
  recordClaudeRateLimit(
    {
      status: 'throttled_somehow',
      unifiedWindows: {
        five_hour: {},
        seven_day: { utilization: 'lots', resetsAt: 'soon' },
        seven_day_opus: { utilization: -0.2, resetsAt: -5 },
        overage: { utilization: 11, resetsAt: 0 },
      },
    },
    NOW
  );
  const r = report();
  assert.equal(r.claude.status, 'other');
  for (const w of r.claude.windows) {
    assert.equal(w.usedPct, null, `${w.id}: not said, not measured`);
    assert.equal(w.resetsAt, null, w.id);
  }
  assert.equal(r.claude.windows.find((w) => w.id === 'seven_day_opus').minutes, null, 'only the two known windows have a length');
});

test('windows merge by id: an event about one window keeps what was said about the other', () => {
  recordClaudeRateLimit(JSON.parse(MEASURED_CLAUDE_LINE).rate_limit_info, NOW);
  recordClaudeRateLimit({ status: 'rejected', rateLimitType: 'seven_day', utilization: 1, resetsAt: 1791028800 }, NOW + 60_000);
  const r = report();
  assert.equal(r.claude.status, 'rejected');
  const byId = Object.fromEntries(r.claude.windows.map((w) => [w.id, w]));
  assert.equal(byId.five_hour.usedPct, 3, 'the other window survives');
  assert.equal(byId.five_hour.at, '2026-09-28T12:00:00.000Z', 'with its own reading time');
  assert.equal(byId.seven_day.usedPct, 100);
  assert.equal(byId.seven_day.at, '2026-09-28T12:01:00.000Z');
  assert.equal(r.claude.at, '2026-09-28T12:01:00.000Z');
});

test('the MEASURED Codex rate_limits: seven-day window, 4%, prolite', () => {
  recordCodexRateLimits(JSON.parse(MEASURED_CODEX_RATE_LIMITS), NOW);
  const r = report();
  assert.deepEqual(r.codex, {
    plan: 'prolite',
    status: 'allowed',
    at: '2026-09-28T12:00:00.000Z',
    windows: [{ id: 'seven_day', minutes: 10080, usedPct: 4, resetsAt: new Date(1791084105 * 1000).toISOString(), at: '2026-09-28T12:00:00.000Z' }],
  });
});

test('codex: 300 minutes is five_hour, other lengths m<N>; a reached limit is rejected; the snapshot replaces', () => {
  recordCodexRateLimits(
    {
      primary: { used_percent: 99.94, window_minutes: 300, resets_at: 1790619000 },
      secondary: { used_percent: 12, window_minutes: 1440, resets_at: 1791028800 },
      plan_type: 'pro',
      rate_limit_reached_type: 'primary',
    },
    NOW
  );
  let r = report();
  assert.equal(r.codex.status, 'rejected');
  assert.deepEqual(r.codex.windows.map((w) => [w.id, w.minutes, w.usedPct]), [['five_hour', 300, 99.9], ['m1440', 1440, 12]]);
  recordCodexRateLimits(JSON.parse(MEASURED_CODEX_RATE_LIMITS), NOW);
  r = report();
  assert.deepEqual(r.codex.windows.map((w) => w.id), ['seven_day'], 'a window the plan no longer has does not linger');
  assert.equal(r.codex.status, 'allowed');
});

test('the Claude entry needs Claude installed, and a plan or a window', () => {
  assert.equal(report({ plan: 'max' }).claude.plan, 'max');
  assert.equal(report({ plan: 'max' }).claude.status, null, 'a plan with no reading has no status to relay');
  assert.deepEqual(report({ plan: 'max' }).claude.windows, []);
  assert.equal(runtimeLimitsReport({ detected: [{ id: 'claude', installed: false }], plan: 'max' }), null);
  assert.equal(report({ plan: 'not a slug!' }), null, 'a plan off the slug shape is dropped, not relayed');
});

// ── learnCodexLimits: the rollout, found by name ─────────────────────────────

const THREAD = '01a0e0e1-f12a-7363-9eff-8b81940366fc';
const tokenCount = (rateLimits) =>
  JSON.stringify({
    timestamp: '2026-09-27T04:55:15.853Z',
    type: 'event_msg',
    payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 1 } }, rate_limits: rateLimits },
  });

function codexHome() {
  const home = mkdtempSync(join(tmpdir(), 'fv-codex-home-'));
  const day = (y, m, d) => {
    const dir = join(home, 'sessions', y, m, d);
    mkdirSync(dir, { recursive: true });
    return dir;
  };
  return { home, day, env: { CODEX_HOME: home } };
}

test('a rollout is found across date directories by its thread id, and its last rate_limits learned', async () => {
  const { day, env } = codexHome();
  // The thread started days ago; newer days hold other threads' rollouts.
  writeFileSync(join(day('2026', '09', '28'), 'rollout-2026-09-28T10-00-00-01a0ffff-0000-7000-8000-000000000000.jsonl'), tokenCount({ primary: { used_percent: 77, window_minutes: 300 } }) + '\n');
  const older = day('2026', '09', '26');
  writeFileSync(
    join(older, `rollout-2026-09-26T23-21-38-${THREAD}.jsonl`),
    [
      JSON.stringify({ type: 'session_meta', payload: { id: THREAD } }),
      tokenCount({ primary: { used_percent: 1, window_minutes: 10080 }, plan_type: 'prolite' }),
      tokenCount(JSON.parse(MEASURED_CODEX_RATE_LIMITS)),
      tokenCount(null), // a later token_count with no rate_limits is skipped
      JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'done' } }),
    ].join('\n') + '\n'
  );
  day('2025', '12', '31');
  assert.equal(await learnCodexLimits(THREAD, { env, now: NOW }), true);
  const r = report();
  assert.equal(r.codex.plan, 'prolite');
  assert.deepEqual(r.codex.windows.map((w) => [w.id, w.usedPct]), [['seven_day', 4]], 'the LAST non-null rate_limits');
});

test('only the last 256KB of a big rollout is read', async () => {
  const { day, env } = codexHome();
  const dir = day('2026', '09', '27');
  // An early token_count the 256KB tail cannot reach, then >256KB of other
  // events, then the reading the tail must find.
  const filler = JSON.stringify({ type: 'response_item', payload: { type: 'message', text: 'x'.repeat(4000) } });
  const lines = [tokenCount({ primary: { used_percent: 55, window_minutes: 300 }, plan_type: 'early' })];
  for (let i = 0; i < 80; i++) lines.push(filler);
  lines.push(tokenCount({ primary: { used_percent: 9.5, window_minutes: 300 }, plan_type: 'late' }));
  for (let i = 0; i < 10; i++) lines.push(filler);
  const body = lines.join('\n') + '\n';
  assert.ok(Buffer.byteLength(body) > 300 * 1024, 'canary: the file is bigger than the tail');
  writeFileSync(join(dir, `rollout-2026-09-27T01-00-00-${THREAD}.jsonl`), body);
  assert.equal(await learnCodexLimits(THREAD, { env, now: NOW }), true);
  assert.equal(report().codex.plan, 'late');
  assert.equal(report().codex.windows[0].usedPct, 9.5);

  // The early reading alone, beyond the tail: nothing is learned.
  resetRuntimeLimitsForTest();
  const onlyEarly = [lines[0], ...Array(80).fill(filler)].join('\n') + '\n';
  writeFileSync(join(dir, `rollout-2026-09-27T01-00-00-${THREAD}.jsonl`), onlyEarly);
  assert.equal(await learnCodexLimits(THREAD, { env, now: NOW }), false);
  assert.equal(report(), null);
});

test('a missing rollout, a bad id or a missing CODEX_HOME changes nothing and never throws', async () => {
  const { day, env } = codexHome();
  recordCodexRateLimits(JSON.parse(MEASURED_CODEX_RATE_LIMITS), NOW);
  const before = report();
  day('2026', '09', '28');
  assert.equal(await learnCodexLimits(THREAD, { env }), false);
  assert.equal(await learnCodexLimits('../../etc/passwd', { env }), false);
  assert.equal(await learnCodexLimits('-rf', { env }), false);
  assert.equal(await learnCodexLimits(undefined, { env }), false);
  assert.equal(await learnCodexLimits(THREAD, { env: { CODEX_HOME: join(tmpdir(), 'fv-no-such-codex-home') } }), false);
  assert.deepEqual(report(), before);
});

test('the walk stops at 62 day directories, newest first', async () => {
  const { day, env } = codexHome();
  for (let d = 1; d <= 31; d++) day('2026', '09', String(d).padStart(2, '0'));
  for (let d = 1; d <= 31; d++) day('2026', '08', String(d).padStart(2, '0'));
  const july = day('2026', '07', '31');
  writeFileSync(join(july, `rollout-2026-07-31T01-00-00-${THREAD}.jsonl`), tokenCount(JSON.parse(MEASURED_CODEX_RATE_LIMITS)) + '\n');
  assert.equal(await learnCodexLimits(THREAD, { env }), false, 'the 63rd day is not walked');
  const aug = join(env.CODEX_HOME, 'sessions', '2026', '08', '01');
  writeFileSync(join(aug, `rollout-2026-08-01T01-00-00-${THREAD}.jsonl`), tokenCount(JSON.parse(MEASURED_CODEX_RATE_LIMITS)) + '\n');
  assert.equal(await learnCodexLimits(THREAD, { env }), true, 'the 62nd is');
});

// ── the bounds ───────────────────────────────────────────────────────────────

test('bounds: at most six windows (newest kept), a bad id dropped', () => {
  const unifiedWindows = {};
  for (let i = 0; i < 7; i++) unifiedWindows[`w${i}`] = { utilization: i / 10, resetsAt: 1790619000 };
  unifiedWindows['Bad-Id'] = { utilization: 0.5 };
  unifiedWindows['x'.repeat(RUNTIME_LIMIT_ID_MAX + 1)] = { utilization: 0.5 };
  recordClaudeRateLimit({ status: 'allowed', unifiedWindows }, NOW);
  // A newer reading of one window, so "oldest first" has something to mean.
  recordClaudeRateLimit({ status: 'allowed', rateLimitType: 'w0', utilization: 0.01 }, NOW + 1000);
  const ids = report().claude.windows.map((w) => w.id);
  assert.equal(ids.length, RUNTIME_LIMIT_WINDOWS_MAX);
  assert.ok(ids.includes('w0'), 'the newest reading is kept');
  assert.ok(!ids.includes('Bad-Id'));
  assert.ok(ids.every((id) => /^[a-z0-9_]{1,40}$/.test(id)));
});

test('bounds: an oversize report sheds its oldest windows, and one that cannot fit is null', () => {
  const w = (id, at) => ({ id, minutes: 300, usedPct: 1, resetsAt: null, at });
  const big = {
    claude: { plan: 'max', status: 'allowed', at: 'A', windows: [w('old', '2026-09-28T10:00:00.000Z'), w('new', '2026-09-28T11:00:00.000Z')] },
    codex: { plan: 'pro', status: 'allowed', at: 'A', windows: [w('mid', '2026-09-28T10:30:00.000Z')] },
  };
  const full = Buffer.byteLength(JSON.stringify(big));
  const one = Buffer.byteLength(JSON.stringify(w('old', '2026-09-28T10:00:00.000Z')));
  const fitted = fitRuntimeLimits(big, full - 1);
  assert.deepEqual(fitted.claude.windows.map((x) => x.id), ['new'], 'the oldest reading went first');
  assert.deepEqual(fitted.codex.windows.map((x) => x.id), ['mid']);
  assert.ok(Buffer.byteLength(JSON.stringify(fitted)) <= full - 1);
  assert.deepEqual(fitRuntimeLimits(big, full - one - 2).codex.windows, [], 'then the next oldest');
  assert.equal(fitRuntimeLimits(big, 40), null, 'no windows left and still too big: not sent');
  assert.equal(big.claude.windows.length, 2, 'the input is not mutated');
  // The real report is always within the param bound.
  recordClaudeRateLimit(JSON.parse(MEASURED_CLAUDE_LINE).rate_limit_info, NOW);
  recordCodexRateLimits(JSON.parse(MEASURED_CODEX_RATE_LIMITS), NOW);
  assert.ok(Buffer.byteLength(JSON.stringify(report({ plan: 'max' }))) <= RUNTIME_LIMITS_PARAM_MAX);
});

test('bounds: a plan longer than the cap is dropped', () => {
  recordCodexRateLimits({ ...JSON.parse(MEASURED_CODEX_RATE_LIMITS), plan_type: 'p'.repeat(RUNTIME_LIMIT_PLAN_MAX + 1) }, NOW);
  assert.equal(report().codex.plan, null);
  recordCodexRateLimits({ ...JSON.parse(MEASURED_CODEX_RATE_LIMITS), plan_type: 'p'.repeat(RUNTIME_LIMIT_PLAN_MAX) }, NOW);
  assert.equal(report().codex.plan.length, RUNTIME_LIMIT_PLAN_MAX);
});
