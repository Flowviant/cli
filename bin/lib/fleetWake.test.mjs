/**
 * THE RECONCILE WAIT (fleetWake.mjs, split out of fleet.mjs 2026-09-26, SOLID
 * F038): a push wake ends the idle early, and a wake that lands while the loop
 * is busy is not lost — the next wait returns at once.
 *
 * Run: node --test bin/lib/fleetWake.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReconcileWait } from './fleetWake.mjs';

const settledWithin = (p, ms) =>
  Promise.race([p.then(() => true), new Promise((r) => setTimeout(() => r(false), ms).unref())]);

test('a wake that lands mid-reconcile is honoured by the next wait', async () => {
  const { fireWake, waitReconcile } = createReconcileWait();
  fireWake(); // the loop is busy, not idling
  assert.equal(await settledWithin(waitReconcile(), 50), true);
});

test('a wake while idling ends the wait early, and is spent by it', async () => {
  const { fireWake, waitReconcile } = createReconcileWait();
  const idle = waitReconcile();
  assert.equal(await settledWithin(idle, 30), false, 'nothing ends the idle on its own this fast');
  fireWake();
  assert.equal(await settledWithin(idle, 50), true);
  // Spent: the next wait idles again rather than returning at once.
  const next = waitReconcile();
  assert.equal(await settledWithin(next, 30), false);
  fireWake(); // release it so the test process can exit
  await next;
});
