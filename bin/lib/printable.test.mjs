import { test } from 'node:test';
import assert from 'node:assert/strict';
import { printable } from './printable.mjs';

test('strips C0, DEL, and the 8-bit C1 range (CSI/OSC/ST) — the server’s own class', () => {
  assert.equal(printable('a\x1bb'), 'ab'); // ESC
  assert.equal(printable('a\x07b'), 'ab'); // BEL
  assert.equal(printable('a\x7fb'), 'ab'); // DEL
  assert.equal(printable('a\u009bb'), 'ab'); // 8-bit CSI
  assert.equal(printable('a\u009db'), 'ab'); // 8-bit OSC
  assert.equal(printable('a\u009cb'), 'ab'); // 8-bit ST
});

test('strips the bidi/format controls a C0/C1-only scrub misses', () => {
  assert.equal(printable('evil‮txt.crt⁦'), 'eviltxt.crt');
  assert.equal(printable('a‎b‏c'), 'abc');
  assert.equal(printable('a⁩b'), 'ab');
});

test('leaves ordinary text untouched', () => {
  assert.equal(printable('BRIF AI'), 'BRIF AI');
  assert.equal(printable(''), '');
});

test('is a no-op on a non-string — a scrub, not a coercion', () => {
  assert.equal(printable(undefined), undefined);
  assert.equal(printable(null), null);
  assert.equal(printable(42), 42);
});
