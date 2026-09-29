/**
 * DISCONNECTING THIS BOX — stop, then leave, then forget (`machineDisconnect.mjs`,
 * split out of `machines.mjs` by the SOLID audit 2026-09-26, F056; its tests
 * moved with it). The order is the contract: a daemon that would not stop
 * aborts before either of the others, and a leave the server fails never
 * keeps a stopped box's credential.
 *
 * Run: node --test bin/lib/machineDisconnect.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsForPin from 'node:fs';
import { disconnectHere, disconnectShortfall, leaveOutcomeOf, removeOnMachinesPage } from './machineDisconnect.mjs';
import { leaveBoxFor } from './machines.mjs';

const entry = (o = {}) => ({
  projectId: 'f1000003-1111-2222-3333-444455556666',
  fleetToken: 'fva_x',
  name: 'Northwind One',
  repoRoot: '/home/dev/code/northwind-one',
  savedAt: null,
  ...o,
});

/**
 * THE DISCONNECT IS THREE STEPS IN ONE ORDER — stop, leave, forget — and a
 * daemon that would not stop ABORTS before either of the others. Forgetting a
 * credential under a running daemon changes nothing about the daemon, and a
 * leave under a still-polling box is a row that comes back in ten seconds.
 * Injected deps: the order is the contract, and it is provable without a lock
 * directory, a socket or a credential file.
 */
test('disconnect stops, then leaves, then forgets — and a daemon that would not stop aborts it', async () => {
  const order = [];
  const lines = [];
  const e = entry({ name: 'Acme App', savedAt: '2026-09-16T12:00:00Z' });
  const deps = (stopTally, leaveShape) => ({
    stopDaemon: (token) => { order.push(`stop:${token}`); return stopTally; },
    leave: async (en) => { order.push(`leave:${en.projectId}`); return leaveShape; },
    forget: (id) => { order.push(`forget:${id}`); return { entry: e }; },
  });
  const log = (m) => lines.push(m);

  // The ordinary case: a daemon was running, it stopped, the app removed the row.
  let res = await disconnectHere(e, deps({ stopped: 1, unconfirmed: 0, failed: 0, running: 1 }, { removed: true, wasHolder: true }), { log });
  assert.equal(res.ok, true);
  assert.deepEqual(order, ['stop:fva_x', `leave:${e.projectId}`, `forget:${e.projectId}`]);
  assert.match(lines.join('\n'), /removed this box from Acme App \(f1000003…, connected Sep 16\)’s machines list in the app/);
  assert.match(lines.join('\n'), /has none until another polls/);
  assert.match(lines.join('\n'), /forgot Acme App .* credential on this box/);
  assert.ok(!lines.some((l) => /no daemon .* was running/.test(l)), 'a running daemon is not described as absent');

  // Nothing running here is the ORDINARY disconnect, and says so.
  order.length = 0; lines.length = 0;
  res = await disconnectHere(e, deps({ stopped: 0, unconfirmed: 0, failed: 0, running: 0 }, { removed: false }), { log });
  assert.equal(res.ok, true);
  assert.match(lines[0], /no daemon for Acme App .* was running here/);
  assert.match(lines[1], /the app was not listing this box/);

  // A daemon alive and NOT stopped: abort, nothing left, nothing forgotten.
  order.length = 0; lines.length = 0;
  res = await disconnectHere(e, deps({ stopped: 0, unconfirmed: 1, failed: 1, running: 1 }, { removed: true }), { log });
  assert.equal(res.ok, false);
  assert.deepEqual(order, ['stop:fva_x']);
  assert.match(lines[0], /not disconnected .* still running here and was not stopped/);

  // The four server shapes each get their own sentence, and the forget still
  // happens under every one of them — the daemon is stopped, so the store is
  // the last thing left to clean.
  for (const [shape, words] of [
    [{ skipped: true }, /never run a daemon, so the app has no row/],
    [{ rejected: true }, /already disconnected or deleted .* nothing to leave/],
    [{ unsupported: true }, /older server.*remove it on the project's Machines page\./],
    [{ error: 'HTTP 500' }, /could not tell the app .*HTTP 500/],
  ]) {
    order.length = 0; lines.length = 0;
    res = await disconnectHere(e, deps({ stopped: 0, unconfirmed: 0, failed: 0, running: 0 }, shape), { log });
    assert.equal(res.ok, true, JSON.stringify(shape));
    assert.match(lines.join('\n'), words);
    assert.equal(order[order.length - 1], `forget:${e.projectId}`, JSON.stringify(shape));
  }
});

/**
 * A FAILED LEAVE, END TO END: the real `leaveBoxFor` over a server that
 * answers 500, inside the real `disconnectHere`. The daemon is already stopped,
 * so the credential is still forgotten, and the person is told the app's row
 * goes quiet on its own — never that the box was removed.
 */
test('a leave the server fails still forgets the credential, and says the row goes quiet', async () => {
  const lines = [];
  const order = [];
  const e = entry({ name: 'Acme App' });
  const res = await disconnectHere(
    e,
    {
      stopDaemon: () => ({ stopped: 1, unconfirmed: 0, failed: 0, running: 1 }),
      leave: (en) => {
        order.push('leave');
        return leaveBoxFor(en, {
          url: 'https://x/fleet/boxes/leave',
          envpub: 'ME',
          fetchImpl: async () => ({ status: 500, ok: false, headers: { get: () => 'text/plain' }, json: async () => ({}) }),
        });
      },
      forget: (id) => {
        order.push(`forget:${id}`);
        return { entry: e };
      },
    },
    { log: (m) => lines.push(m) }
  );
  assert.equal(res.ok, true);
  assert.deepEqual(order, ['leave', `forget:${e.projectId}`]);
  const text = lines.join('\n');
  assert.match(text, /could not tell the app this box has left Acme App .*\(HTTP 500\) — its row goes quiet on its own/);
  assert.doesNotMatch(text, /removed this box/);
  assert.match(text, /forgot Acme App .* credential on this box/);
});

// ── What a disconnect ACHIEVED: the outcome contract (SOLID F004) ─────────

const alpha = { projectId: 'p1', fleetToken: 'fva_1', name: 'Alpha' };
const depsOf = (tally, left, forget = () => ({})) => ({
  stopDaemon: () => tally,
  leave: async () => left,
  forget,
});
const quiet = { log: () => {} };
const idle = { stopped: 0, unconfirmed: 0, failed: 0, running: 0 };

test('the leave answer is one word', () => {
  assert.equal(leaveOutcomeOf({ skipped: true }), 'skipped');
  assert.equal(leaveOutcomeOf({ rejected: true }), 'rejected');
  assert.equal(leaveOutcomeOf({ unsupported: true }), 'unsupported');
  assert.equal(leaveOutcomeOf({ error: 'HTTP 500' }), 'failed');
  assert.equal(leaveOutcomeOf({ removed: false }), 'not-listed');
  assert.equal(leaveOutcomeOf({ removed: true, wasHolder: true }), 'left');
});

test('disconnectHere returns what happened at each step, beside its sentences', async () => {
  assert.deepEqual(await disconnectHere(alpha, depsOf({ ...idle, running: 1, stopped: 1 }, { removed: true }), quiet), {
    ok: true, stop: 'stopped', leave: 'left', forget: 'forgotten',
  });
  assert.deepEqual(await disconnectHere(alpha, depsOf({ ...idle, running: 1, failed: 1 }, { removed: true }), quiet), {
    ok: false, stop: 'failed', leave: 'not-run', forget: 'not-run',
  });
  // The machines verbs' rule: a failed leave still forgets.
  assert.deepEqual(await disconnectHere(alpha, depsOf(idle, { error: 'HTTP 500' }), quiet), {
    ok: true, stop: 'none', leave: 'failed', leaveError: 'HTTP 500', forget: 'forgotten',
  });
  assert.deepEqual(await disconnectHere(alpha, depsOf(idle, { removed: false }, () => ({ error: 'EACCES' })), quiet), {
    ok: false, stop: 'none', leave: 'not-listed', forget: 'failed', forgetError: 'EACCES',
  });
});

/**
 * A DAEMON FINISHING A DEPLOY IS OBEYED BUT STILL ALIVE (ruling 2026-09-26:
 * a stand-down lets a deploy finish and report). `stopLock` counts it
 * `stopped` AND `draining`; the disconnect must not go on to leave (which
 * deletes the app's row of this box, the row the app's own Disconnect refusal
 * reads) or forget (the credential its report needs). `uninstall --purge`
 * reads the same outcome through `disconnectShortfall` and keeps ~/.flowviant.
 */
test('a daemon finishing a deploy aborts the disconnect: nothing left, nothing forgotten, wait said', async () => {
  const order = [];
  const lines = [];
  const res = await disconnectHere(
    alpha,
    {
      stopDaemon: () => ({ stopped: 1, unconfirmed: 0, failed: 0, running: 1, draining: 1 }),
      leave: async () => { order.push('leave'); return { removed: true }; },
      forget: () => { order.push('forget'); return {}; },
    },
    { log: (m) => lines.push(m) }
  );
  assert.deepEqual(res, { ok: false, stop: 'draining', leave: 'not-run', forget: 'not-run' });
  assert.deepEqual(order, [], 'neither the leave nor the forget ran');
  assert.match(lines.join('\n'), /not disconnected from Alpha.*: a deploy is in flight on this box; wait for it to finish, then run this again/);
  assert.deepEqual(disconnectShortfall(res), {
    reason: 'a daemon for it is finishing a deploy here; wait for it to finish',
    retryable: true,
  });
  // A tally from an older shape (no `draining`) reads as none draining.
  assert.equal((await disconnectHere(alpha, depsOf({ ...idle, running: 1, stopped: 1 }, { removed: true }), quiet)).stop, 'stopped');
});

test('asked to, a failed leave keeps the credential and says so', async () => {
  const lines = [];
  let forgot = false;
  const res = await disconnectHere(alpha, depsOf(idle, { error: 'ECONNRESET' }, () => { forgot = true; return {}; }), {
    log: (m) => lines.push(m),
    forgetAfterFailedLeave: false,
  });
  assert.equal(forgot, false);
  assert.deepEqual(res, { ok: false, stop: 'none', leave: 'failed', leaveError: 'ECONNRESET', forget: 'kept' });
  assert.match(lines.at(-1), /kept Alpha.*credential on this box, so the leave can be tried again/);
  // …and a leave that worked still forgets under the same option.
  const ok = await disconnectHere(alpha, depsOf(idle, { removed: true }), { ...quiet, forgetAfterFailedLeave: false });
  assert.equal(ok.forget, 'forgotten');
});

test('the shortfall reading: what is retryable, what is only reported, what is complete', () => {
  assert.equal(disconnectShortfall({ ok: true, stop: 'none', leave: 'left', forget: 'forgotten' }), null);
  assert.equal(disconnectShortfall({ ok: true, stop: 'none', leave: 'skipped', forget: 'forgotten' }), null);
  assert.equal(disconnectShortfall({ ok: true, stop: 'none', leave: 'rejected', forget: 'forgotten' }), null);
  assert.equal(disconnectShortfall({ ok: true, stop: 'none', leave: 'not-listed', forget: 'forgotten' }), null);
  assert.equal(disconnectShortfall({ ok: true }), null, 'an outcome without fields is read by ok');
  assert.deepEqual(disconnectShortfall({ ok: false }), { reason: 'failed', retryable: true });
  assert.equal(disconnectShortfall({ ok: false, stop: 'failed' }).retryable, true);
  assert.deepEqual(disconnectShortfall({ ok: true, stop: 'none', leave: 'failed', leaveError: 'HTTP 500', forget: 'forgotten' }), {
    reason: 'could not tell the app this box has left (HTTP 500)', retryable: true,
  });
  assert.equal(disconnectShortfall({ ok: false, stop: 'none', leave: 'left', forget: 'failed', forgetError: 'EACCES' }).retryable, true);
  assert.equal(disconnectShortfall({ ok: true, stop: 'none', leave: 'unsupported', forget: 'forgotten' }).retryable, false);
  assert.equal(disconnectShortfall(undefined).retryable, true);
});

test("the Machines page pointer has one spelling, and no sentence sends a person to settings for it", () => {
  const { readdirSync, readFileSync } = fsForPin;
  const dir = new URL('./', import.meta.url);
  const code = (src) =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.mjs') || name.endsWith('.test.mjs')) continue;
    const src = code(readFileSync(new URL(name, dir), 'utf8'));
    assert.equal(src.includes('settings → Machines'), false, `${name} points at the retired settings page`);
    if (name !== 'machineDisconnect.mjs')
      assert.equal(/on the project's Machines page/.test(src), false, `${name} spells the pointer itself`);
  }
  assert.equal(removeOnMachinesPage(), "remove it on the project's Machines page");
});
