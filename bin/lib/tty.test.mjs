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
