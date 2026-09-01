/**
 * The structured tool-event builder behind the transcript's tool cards.
 * Everything asserted here is a field the CLI itself emitted — the builder
 * adds counts and previews from the input's own strings, never a guess.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countLines, toolEventOf } from './runtimes.mjs';

test('Read → path, worktree-relative', () => {
  assert.deepEqual(toolEventOf('Read', { file_path: '/wt/src/a.ts' }, '/wt'), {
    t: 'read',
    p: 'src/a.ts',
  });
});

test('Edit → counts from the input strings plus a bounded preview', () => {
  const e = toolEventOf(
    'Edit',
    {
      file_path: '/wt/src/auth/token.ts',
      old_string: 'const s = readCookie(req)',
      new_string: 'const s = await tokens.verify(req)\nif (!s) return unauthenticated()',
    },
    '/wt'
  );
  assert.equal(e.t, 'edit');
  assert.equal(e.p, 'src/auth/token.ts');
  assert.equal(e.d, 1);
  assert.equal(e.a, 2);
  assert.deepEqual(e.dl, [
    '- const s = readCookie(req)',
    '+ const s = await tokens.verify(req)',
    '+ if (!s) return unauthenticated()',
  ]);
});

test('Edit preview is capped at 2 old + 3 new lines, 160 chars each', () => {
  const e = toolEventOf(
    'Edit',
    {
      file_path: '/wt/x.ts',
      old_string: Array.from({ length: 10 }, (_, i) => `old${i}`).join('\n'),
      new_string: `${'y'.repeat(500)}\n1\n2\n3\n4`,
    },
    '/wt'
  );
  assert.equal(e.dl.length, 5);
  assert.ok(e.dl.every((l) => l.length <= 160));
  assert.equal(e.a, 5);
  assert.equal(e.d, 10);
});

test('empty strings count zero lines, not one', () => {
  const w = toolEventOf('Write', { file_path: '/wt/new.ts', content: '' }, '/wt');
  assert.equal(w.a, 0);
});

test('TodoWrite → one plan event; statuses map done/active/open; empty is null', () => {
  const e = toolEventOf('TodoWrite', {
    todos: [
      { content: 'Map call sites', status: 'completed' },
      { content: 'Cut over /api/session', status: 'in_progress' },
      { content: 'Delete the shim', status: 'pending' },
    ],
  });
  assert.deepEqual(e, {
    t: 'plan',
    items: [
      { x: 'Map call sites', s: 'done' },
      { x: 'Cut over /api/session', s: 'active' },
      { x: 'Delete the shim', s: 'open' },
    ],
  });
  assert.equal(toolEventOf('TodoWrite', { todos: [] }), null);
});

test('unknown tools are silent — a card is never invented', () => {
  assert.equal(toolEventOf('WebFetch', { url: 'https://x' }), null);
  assert.equal(toolEventOf('NotebookEdit', {}), null);
});

test('SCRUB BEFORE CAP: a secret at the cap boundary is replaced whole, never leaked as a prefix', () => {
  const secret = 'S3CR3T-'.repeat(10); // 70 chars
  const scrub = (s) => s.split(secret).join('[REDACTED:TOKEN]');
  // The secret starts at char 180 — under the old cap-then-scrub order the
  // 200-cap cut it at char 200, leaving 20 unmatched secret chars on the wire.
  const cmd = `${'x'.repeat(179)} ${secret} --flag`;
  const e = toolEventOf('Bash', { command: cmd }, '', scrub);
  assert.ok(!e.c.includes('S3CR3T'));
  assert.ok(e.c.length <= 200);
});

test('a scrub replacement that GROWS the string still lands under the cap', () => {
  const scrub = (s) => s.split('pw').join('[REDACTED:DATABASE_PASSWORD]');
  const e = toolEventOf('Bash', { command: `${'y'.repeat(190)} pw` }, '', scrub);
  assert.ok(e.c.length <= 200);
});

test('the mini-diff lines are scrubbed too, and counts come from the raw string', () => {
  const scrub = (s) => s.split('hunter2secret').join('[REDACTED:PW]');
  const e = toolEventOf(
    'Edit',
    {
      file_path: '/wt/x.ts',
      old_string: 'const pw = "hunter2secret"',
      new_string: 'const pw = env.PW\nrest\nof\nit\nmore',
    },
    '/wt',
    scrub
  );
  assert.equal(e.dl[0], '- const pw = "[REDACTED:PW]"');
  assert.equal(e.d, 1);
  assert.equal(e.a, 5);
});

test('countLines never materializes a split and matches split-length semantics', () => {
  assert.equal(countLines(''), 0);
  assert.equal(countLines('one'), 1);
  assert.equal(countLines('a\nb\nc'), 3);
  assert.equal(countLines('a\n'), 2);
});
