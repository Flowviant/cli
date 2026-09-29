/**
 * A PREVIEW'S ENDED REPORT NAMES THE SHARE IT ENDS (SOLID F017, 2026-09-26).
 *
 * The stop job is keyed by session; a re-share of the same session can rotate
 * the share id while the stop is in flight. The server's `endPreview` checks
 * `shareId` when the report carries one, so the daemon echoes the id of the
 * share it actually tore down — and sends nothing when the live entry had
 * none (an older server), the old rule. A daemon→server report field: no floor.
 *
 * Driven against a `node:http` stand-in for `/fleet`, with the tunnel and the
 * port attribution injected (no dev server, no cloudflared).
 *
 * Run: node --test bin/lib/workPreviews.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

const hits = [];
const server = createServer((req, res) => {
  let raw = '';
  req.on('data', (d) => (raw += d));
  req.on('end', () => {
    hits.push({ tail: req.url.split('/').pop(), body: JSON.parse(raw || '{}') });
    res.setHeader('Content-Type', 'application/json');
    if (req.url.endsWith('/preview-claim')) return res.end(JSON.stringify({ success: true, data: { claimed: true } }));
    res.end(JSON.stringify({ success: true, data: { settled: true } }));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
process.env.FLOWVIANT_FLEET_URL = `http://127.0.0.1:${server.address().port}/fleet/agents`;
process.env.FLOWVIANT_FLEET = 'fva_previews_test';
const { createWorkPreviews } = await import('./workPreviews.mjs');
test.after(() => server.close());

const until = async (cond, ms = 5_000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
};

function lane() {
  const stopped = [];
  const previews = createWorkPreviews({
    placeDir: () => '/nowhere',
    originFor: () => ({}),
    openTunnel: async () => ({
      url: 'https://x.trycloudflare.com',
      user: 'u',
      password: 'p',
      gateMode: 'password',
      stop: () => stopped.push(true),
    }),
  });
  return { previews, stopped };
}

const ended = () => hits.filter((h) => h.tail === 'preview-done' && h.body.ended === true);
/** The open has settled (its claim is released only after the settle POST
 *  answers, and a stop for a session mid-claim waits for the next tick). */
const opened = async (sessionId) => {
  await until(() => hits.some((h) => h.tail === 'preview-done' && h.body.sessionId === sessionId && h.body.url));
  await new Promise((r) => setTimeout(r, 50));
};

test('a stop confirms the teardown with the shareId of the share it ended', async () => {
  hits.length = 0;
  const { previews, stopped } = lane();
  previews.processPreviewJobs([{ sessionId: 's1', port: 5173, shareId: 'share-a' }]);
  await opened('s1');
  assert.ok(previews.livePreviewIds().includes('s1'));
  previews.processPreviewJobs([{ sessionId: 's1', action: 'stop' }]);
  await until(() => ended().length === 1);
  assert.equal(stopped.length, 1, 'the tunnel was torn down here');
  const { body } = ended()[0];
  assert.equal(body.sessionId, 's1');
  assert.equal(body.endedReason, 'stopped');
  assert.equal(body.shareId, 'share-a', 'the report names the share it ended');
});

test('a closed tab ends its share by id too', async () => {
  hits.length = 0;
  const { previews } = lane();
  previews.processPreviewJobs([{ sessionId: 's2', port: 3000, shareId: 'share-b' }]);
  await opened('s2');
  assert.ok(previews.livePreviewIds().includes('s2'));
  previews.retirePreviews([]);
  await until(() => ended().length === 1);
  assert.equal(ended()[0].body.endedReason, 'tab_closed');
  assert.equal(ended()[0].body.shareId, 'share-b');
});

test('a share opened without an id (an older server) ends without one — absence stays absence', async () => {
  hits.length = 0;
  const { previews } = lane();
  previews.processPreviewJobs([{ sessionId: 's3', port: 8080 }]);
  await opened('s3');
  assert.ok(previews.livePreviewIds().includes('s3'));
  previews.processPreviewJobs([{ sessionId: 's3', action: 'stop' }]);
  await until(() => ended().length === 1);
  assert.equal(Object.hasOwn(ended()[0].body, 'shareId'), false);
});

test('a daemon holding nothing confirms nothing', async () => {
  hits.length = 0;
  const { previews } = lane();
  previews.processPreviewJobs([{ sessionId: 's4', action: 'stop' }]);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(ended().length, 0);
});
