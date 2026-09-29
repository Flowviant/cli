/**
 * THE DESIGN PREVIEW (moved from artifacts.test.mjs with the function,
 * 2026-09-26, SOLID F051). The capture is handed in, so no browser launches.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { renderDesignPreview } from './artifactPreview.mjs';

test('rendering measures PNG, cannot render, and rejects an invalid image', async () => {
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
  const render = async ({ out }) => { writeFileSync(out, png); return { ok: true }; };
  assert.deepEqual(await renderDesignPreview(Buffer.from('<p/>'), render), { renderState: 'rendered', preview: png });
  assert.deepEqual(await renderDesignPreview(Buffer.from('<p/>'), async () => ({ ok: false })), { renderState: 'unavailable' });
  assert.deepEqual(await renderDesignPreview(Buffer.from('<p/>'), async ({ out }) => { writeFileSync(out, 'bad'); return { ok: true }; }), { renderState: 'unavailable' });
});

