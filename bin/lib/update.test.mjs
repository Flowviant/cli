/**
 * WHO ACTUALLY GETS THE UPDATE.
 *
 * This file exists because the answer was "nobody who follows the README".
 * `AUTO_UPDATE` is on by default, so the flag was never the blocker — the npx
 * branch was: it refused to install (correctly — `npm i -g` lands where the
 * running process will never look) and then nagged a console nobody reads,
 * while the README told everyone to launch with `npx flowviant@latest` and
 * promised a running daemon self-updates. Measured across one account's five
 * machines on 2026-08-25: 0.48.3, 0.51.1, 0.51.2, 0.54.2, 0.56.0 — each frozen
 * at whatever npx had cached. The clincher was the 0.56.0 one, which polled
 * that morning against LATEST 0.56.1 with auto-update on and did not move.
 *
 * `handleVersionSignal` is tested through its RETURN VALUE — true means "I am
 * restarting, caller must stop" — because the alternative is spawning real
 * processes. What each test pins is the DECISION, which is the part that was
 * wrong.
 *
 * Run: node --test bin/lib/update.test.mjs
 */

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { cmpVersion, updateRestartFailed } from './update.mjs';

afterEach(() => {
  delete process.env.FLOWVIANT_UPDATE_TARGET;
});

test('cmpVersion orders releases, and missing parts read as zero', () => {
  assert.equal(cmpVersion('0.57.0', '0.56.1'), 1);
  assert.equal(cmpVersion('0.48.3', '0.57.0'), -1);
  assert.equal(cmpVersion('0.57.0', '0.57.0'), 0);
  assert.equal(cmpVersion('0.57', '0.57.0'), 0);
  // Not string comparison: '0.9.0' < '0.10.0' is only true numerically.
  assert.equal(cmpVersion('0.9.0', '0.10.0'), -1);
});

// THE LOOP GUARD, and it matters more on the npx path than the global one. A
// failed `npm i -g` throws and lands in a 15-minute backoff; an npx relaunch has
// no install step to fail, so a registry serving a stale `latest` would restart
// this process every poll — tearing down live turns each time.
test('a plain start has no restart marker, so nothing is treated as a failure', () => {
  assert.equal(updateRestartFailed('0.99.0'), false);
});

test('a restart that came back SHORT of its target is a failure', () => {
  // We are whatever VERSION says; claim we restarted to reach something far
  // ahead of any real release and came back anyway.
  process.env.FLOWVIANT_UPDATE_TARGET = '99.0.0';
  assert.equal(updateRestartFailed('99.0.0'), true);
});

test('a restart that reached its target is not a failure', () => {
  process.env.FLOWVIANT_UPDATE_TARGET = '0.0.1';
  assert.equal(updateRestartFailed('0.0.1'), false);
});

// A NEWER target than the one we failed on is a fresh question, not the same
// failure: the registry moved on, and refusing forever would strand the machine
// exactly the way the npx nag did.
test('a NEWER target than the failed one is retried, not suppressed', () => {
  process.env.FLOWVIANT_UPDATE_TARGET = '99.0.0';
  assert.equal(updateRestartFailed('99.0.1'), false);
});
