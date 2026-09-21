/**
 * The picker menu's key handling, exercised as the pure reducer it is —
 * `selectMenu` itself needs a real pty, but every decision it makes lives here.
 *
 * Run: node --test bin/lib/tty.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { menuKey } from './tty.mjs';

const at = (index, count = 4) => ({ index, count });

test('arrows move and WRAP in both directions', () => {
  assert.deepEqual(menuKey('\x1b[B', at(0)), { index: 1 }); // down
  assert.deepEqual(menuKey('\x1b[A', at(0)), { index: 3 }); // up wraps to last
  assert.deepEqual(menuKey('\x1b[B', at(3)), { index: 0 }); // down wraps to first
});

test('vim k/j mirror up/down', () => {
  assert.deepEqual(menuKey('k', at(2)), { index: 1 });
  assert.deepEqual(menuKey('j', at(2)), { index: 3 });
});

test('g/G and Home/End jump to the ends', () => {
  assert.deepEqual(menuKey('g', at(2)), { index: 0 });
  assert.deepEqual(menuKey('G', at(2)), { index: 3 });
  assert.deepEqual(menuKey('\x1b[H', at(2)), { index: 0 });
  assert.deepEqual(menuKey('\x1b[F', at(2)), { index: 3 });
});

test('Enter takes the current highlight, wherever it is', () => {
  assert.deepEqual(menuKey('\r', at(2)), { choose: 2 });
  assert.deepEqual(menuKey('\n', at(0)), { choose: 0 });
});

test('a number jumps to and takes that row', () => {
  assert.deepEqual(menuKey('1', at(0)), { choose: 0 });
  assert.deepEqual(menuKey('3', at(0)), { choose: 2 });
});

test('a number PAST the end is ignored, not clamped', () => {
  // Pressing 9 in a 4-row list must not silently select row 4.
  assert.equal(menuKey('9', at(0, 4)), null);
  assert.equal(menuKey('5', at(0, 4)), null);
  // The last real row still works.
  assert.deepEqual(menuKey('4', at(0, 4)), { choose: 3 });
});

test('Esc, q and Ctrl-C all cancel', () => {
  assert.deepEqual(menuKey('\x1b', at(1)), { cancel: true });
  assert.deepEqual(menuKey('q', at(1)), { cancel: true });
  assert.deepEqual(menuKey('Q', at(1)), { cancel: true });
  assert.deepEqual(menuKey('\x03', at(1)), { cancel: true });
});

test('an unhandled key is ignored', () => {
  assert.equal(menuKey('x', at(1)), null);
  assert.equal(menuKey('\t', at(1)), null);
  assert.equal(menuKey('0', at(1)), null); // 0 is not a 1-based shortcut
});

// ---------------------------------------------------------------------------
// NO ANSWER TIME LIMIT ON THE START PATH (2026-09-20, the owner: "why is there
// an answer time limit, remove that"). The timer is a caller's option now, and
// the start path passes none. Pinned at both ends: the helper arms nothing
// without a finite positive budget, and cli.mjs hands neither prompt one.
// ---------------------------------------------------------------------------

test('boundedTimer arms nothing unless a caller passed a real budget', async () => {
  const { boundedTimer } = await import('./tty.mjs');
  for (const none of [undefined, null, 0, -1, NaN, Infinity, 'soon']) {
    assert.equal(boundedTimer(none, () => {}), null, `no timer for ${String(none)}`);
  }
  const t = boundedTimer(50, () => {});
  assert.ok(t !== null, 'a finite positive budget arms a timer');
  clearTimeout(t);
});

test('the picker and the binding confirm pass NO timeout', async () => {
  const { readFileSync } = await import('node:fs');
  const cli = readFileSync(new URL('../cli.mjs', import.meta.url), 'utf8');
  // The constants that carried the budgets are gone outright, not zeroed.
  assert.ok(!cli.includes('PICK_TIMEOUT_MS'), 'PICK_TIMEOUT_MS is deleted');
  assert.ok(!cli.includes('CONFIRM_TIMEOUT_MS'), 'CONFIRM_TIMEOUT_MS is deleted');
  assert.ok(!cli.includes('no answer in'), 'no start-path sentence blames a clock');
  // Every start-path ask is a one-argument call; every menu carries no timeoutMs.
  const asks = cli.match(/askWithTimeout\(\s*`[^`]*`\s*(,[^)]*)?\)/gs) ?? [];
  assert.equal(asks.length, 2, 'the picker fallback and the binding confirm');
  for (const call of asks) assert.ok(!/,\s*\w/.test(call.slice(call.indexOf('`', 1) + 1)), `no budget: ${call.slice(0, 60)}`);
  assert.ok(!cli.includes('timeoutMs:'), 'selectMenu is called without a budget');
  // …and the install prompt, which is NOT on the start path, keeps its own
  // bounded "silence is no" — the option still exists for a reason.
  const install = readFileSync(new URL('./install.mjs', import.meta.url), 'utf8');
  assert.ok(/askWithTimeout\([\s\S]*?30_000/.test(install), 'promptYesNo keeps its bound');
});
