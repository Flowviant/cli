import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { cutKeepingExtension, fnv1a8, safeFileName, SAFE_NAME_MAX } from './safeFileName.mjs';

/**
 * THE CROSS-REPO PARITY TABLE. The SAME rows are pinned against the server's
 * own `safeFileName` in apps/api/src/routes/sessionsAttachments.routes.test.ts
 * ("the daemon parity table"); change a row here and that test must change
 * with it, or the two sides store one file under two names.
 */
const PARITY = [
  ['Screenshot 2026-08-18.png', 'Screenshot_2026-08-18.png'],
  ['../etc/passwd', 'passwd'],
  ['C:\\Windows\\cmd.exe', 'cmd.exe'],
  ['.bashrc', 'bashrc'],
  ['--flag', 'flag'],
  ['', 'attachment'],
  ['a.b.c', 'a.b.c'],
  [`${'a'.repeat(77)}.md`, `${'a'.repeat(77)}.md`],
  [`${'x'.repeat(90)}.html`, `${'x'.repeat(66)}-994582ac.html`],
  ['y'.repeat(200), `${'y'.repeat(71)}-e8433edd`],
  [`${'z'.repeat(90)}.verylongextension`, `${'z'.repeat(71)}-1489700c`],
  [`${'my design '.repeat(9)}.html`, 'my_design_my_design_my_design_my_design_my_design_my_design_my_des-52a37a6e.html'],
  [`.${'q'.repeat(100)}.pdf`, `${'q'.repeat(67)}-8e36d7c5.pdf`],
  [`${'é'.repeat(85)}.png`, `${'_'.repeat(67)}-8db388bb.png`],
];

test('safeFileName matches the server’s canonical outputs, row for row', () => {
  for (const [raw, want] of PARITY) assert.equal(safeFileName(raw, 'attachment'), want, JSON.stringify(raw));
});

test('every output is at most 80 characters and idempotent', () => {
  for (const [raw] of PARITY) {
    const out = safeFileName(raw, 'attachment');
    assert.ok(out.length <= SAFE_NAME_MAX);
    assert.equal(safeFileName(out, 'attachment'), out);
  }
});

test('each caller names its own fallback; the cut alone keeps what the caller already allowed', () => {
  assert.equal(safeFileName('', 'file'), 'file');
  assert.equal(safeFileName('///', 'attachment'), 'attachment');
  // cutKeepingExtension is the cut ONLY — no sanitising, so an artifact bundle
  // component keeps its safe spaces when it fits, and is cut when it does not.
  assert.equal(cutKeepingExtension('my page.html'), 'my page.html');
  assert.equal(cutKeepingExtension(`${'x'.repeat(90)}.html`), `${'x'.repeat(66)}-994582ac.html`);
  assert.equal(fnv1a8(''), '811c9dc5');
});

/**
 * ONE HOME. The three former copies were called `fnv1a8`, `artifactFnv1a8`
 * and `safeUploadFnv1a8`, so the pin matches the SHAPE — the FNV-1a offset
 * basis — rather than a name.
 */
test('the FNV-1a name hash has exactly one daemon home', () => {
  const dir = new URL('./', import.meta.url);
  const hits = readdirSync(dir)
    .filter((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs'))
    .filter((f) => /0x811c9dc5/.test(readFileSync(new URL(f, dir), 'utf8')));
  assert.deepEqual(hits, ['safeFileName.mjs']);
});
