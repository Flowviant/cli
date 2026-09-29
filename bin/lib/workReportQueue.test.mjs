import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkReportQueue } from './workReportQueue.mjs';

/**
 * EVERY TURN SETTLES — the queue driven directly (split out of work.mjs
 * 2026-09-26, SOLID F037) against a stubbed wire whose health each case sets.
 * The four delivery outcomes are the contract: ok and terminal forget the
 * report AND the attempts counter; reject and retry keep it (it is the guard
 * against re-running a side-effecting turn), and only reject backs off.
 */
function stubWire(t) {
  const real = globalThis.fetch;
  const calls = [];
  const wire = { status: 200, down: false };
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), body: JSON.parse(opts.body) });
    if (wire.down) throw new Error('network down');
    return { ok: wire.status < 300, status: wire.status, headers: { get: () => null } };
  };
  t.after(() => {
    globalThis.fetch = real;
  });
  return { calls, wire };
}

function queue(t) {
  const repoRoot = mkdtempSync(join(tmpdir(), 'fv-queue-'));
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));
  const g = (args) => execFileSync('git', args, { cwd: repoRoot, stdio: 'ignore' });
  g(['init', '-q', '-b', 'main']);
  g(['config', 'user.email', 't@t.t']);
  g(['config', 'user.name', 'T']);
  writeFileSync(join(repoRoot, 'a.txt'), 'one');
  g(['add', '-A']);
  g(['commit', '-qm', 'base']);
  const seen = { repoChanged: 0, reported: [], burst: [], observed: 0, retried: 0 };
  const workAttempts = new Map();
  const q = createWorkReportQueue({
    repoRoot,
    baseRef: () => 'main',
    workAttempts,
    artifacts: { retryPending: async () => void (seen.retried += 1) },
    landed: { observe: async () => void (seen.observed += 1) },
    onRepoChanged: () => void (seen.repoChanged += 1),
    reportPlaceWorktrees: async (id) => void seen.reported.push(id),
    burstListeners: (id) => void seen.burst.push(id),
  });
  return { q, workAttempts, seen };
}

test('an undelivered settle is held with its attempts, and the next flush delivers the same body', async (t) => {
  const { calls, wire } = stubWire(t);
  const { q, workAttempts, seen } = queue(t);
  workAttempts.set('turn-1', 1);
  wire.down = true;
  assert.equal(await q.settleWorkTurn('turn-1', { ok: true, answer: 'done' }), 'retry');
  assert.ok(q.pendingWorkReports.has('turn-1'));
  assert.equal(workAttempts.get('turn-1'), 1, 'the attempts counter survives an undelivered report');
  wire.down = false;
  await q.flushWorkReports();
  assert.equal(seen.retried, 1, 'held artifact uploads ride the same beat');
  assert.deepEqual(calls[1].body, calls[0].body);
  assert.deepEqual(calls[1].body, { turnId: 'turn-1', ok: true, answer: 'done' });
  assert.equal(q.pendingWorkReports.size, 0);
  assert.equal(workAttempts.has('turn-1'), false);
});

test('a terminal status forgets the report and the attempts; a reject keeps it and backs off', async (t) => {
  const { calls, wire } = stubWire(t);
  const { q, workAttempts } = queue(t);
  workAttempts.set('gone', 2);
  wire.status = 404;
  assert.equal(await q.settleWorkTurn('gone', { ok: false }), 'terminal');
  assert.equal(q.pendingWorkReports.has('gone'), false);
  assert.equal(workAttempts.has('gone'), false);
  wire.status = 400;
  assert.equal(await q.settleWorkTurn('refused', { ok: false }), 'reject');
  assert.ok(q.pendingWorkReports.has('refused'), 'the held body is the skip-guard');
  const before = calls.length;
  await q.flushWorkReports();
  assert.equal(calls.length, before, 'inside the backoff nothing is re-POSTed');
});

test('a delivered ship report re-measures the place, bursts listeners, and observes base', async (t) => {
  stubWire(t);
  const { q, seen } = queue(t);
  assert.equal(await q.settleShip('sess-1', { ok: true }), 'ok');
  assert.deepEqual(seen.reported, ['sess-1']);
  assert.deepEqual(seen.burst, ['sess-1']);
  assert.equal(seen.repoChanged, 1);
  assert.equal(seen.observed, 1);
  assert.equal(q.pendingShipReports.size, 0);
});

test('an undelivered ship report is held, and 409 is terminal for a ship', async (t) => {
  const { wire } = stubWire(t);
  const { q, seen } = queue(t);
  wire.down = true;
  assert.equal(await q.settleShip('sess-2', { ok: true }), 'retry');
  assert.ok(q.pendingShipReports.has('sess-2'));
  assert.equal(seen.repoChanged, 0, 'nothing downstream fires until the report lands');
  wire.down = false;
  wire.status = 409;
  await q.flushWorkReports();
  assert.equal(q.pendingShipReports.size, 0);
});

test('postBestEffort counts a considered 4xx as delivered and gives up on a 5xx at its bound', async (t) => {
  const { calls, wire } = stubWire(t);
  const { q } = queue(t);
  wire.status = 400;
  assert.equal(await q.postBestEffort('https://x.test/a', { a: 1 }), true);
  assert.equal(calls.length, 1, 'a refusal is never retried');
  wire.status = 503;
  assert.equal(await q.postBestEffort('https://x.test/b', { b: 1 }, { attempts: 1 }), false);
  assert.equal(q.REJECT_RETRY_MS, 10 * 60 * 1000);
});
