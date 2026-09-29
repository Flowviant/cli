/**
 * THE ARTIFACT REPORTER, against a real temp directory, a fake server and a
 * fake renderer (moved from artifacts.test.mjs with the reporter, 2026-09-26,
 * SOLID F051). The disk half is the REAL artifacts.mjs — handed in, the way
 * work.mjs hands it — so these remain integration cases over what was POSTed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ARTIFACT_DIR, buildArtifactUpload, changedSince, snapshotArtifacts } from './artifacts.mjs';
import { createArtifactReporter } from './artifactReporter.mjs';

/** The disk half, real; the renderer, a stand-in that never opens a browser
 *  (a real one is exercised in artifactPreview.test.mjs). */
const disk = {
  listChanged: changedSince,
  buildUpload: buildArtifactUpload,
  renderPreview: async () => ({ renderState: 'unavailable' }),
};

const place = () => {
  const d = mkdtempSync(join(tmpdir(), 'fv-artifact-reporter-'));
  mkdirSync(join(d, ARTIFACT_DIR), { recursive: true });
  return d;
};
const put = (d, name, content, mtimeSec) => {
  const p = join(d, ARTIFACT_DIR, name);
  writeFileSync(p, content);
  if (mtimeSec != null) utimesSync(p, mtimeSec, mtimeSec);
  return p;
};

/** A fake `/fleet/artifact` that records each multipart body it is handed and
 *  answers with the next scripted status (200 once the script runs out). */
function fakeServer(statuses = []) {
  const bodies = [];
  const script = [...statuses];
  return {
    bodies,
    fetchImpl: async (url, init) => {
      const form = init.body;
      const fields = {};
      let file = null;
      for (const [k, v] of form.entries()) {
        if (typeof v === 'string') fields[k] = v;
        else file = Buffer.from(await v.arrayBuffer()).toString('utf8');
      }
      bodies.push({ url, fields, file });
      const next = script.shift();
      if (next instanceof Error) throw next;
      const status = next ?? 200;
      return { ok: status >= 200 && status < 300, status };
    },
  };
}

const reporter = (srv, scrub = (s) => s, extra = {}) =>
  createArtifactReporter({
    ...disk,
    ...extra,
    fleetUrl: 'https://x.test/api/v2/fleet/agents',
    token: 't',
    userAgent: 'ua',
    scrub,
    fetchImpl: srv.fetchImpl,
  });

test('uploads what the turn changed to /fleet/artifact, owned by the session', async () => {
  const d = place();
  const before = snapshotArtifacts(d);
  put(d, 'chart.svg', '<svg/>');
  const srv = fakeServer();
  const n = await reporter(srv).report({ placeDir: d, before, sessionId: 's1', turnId: 't1' });
  assert.equal(n, 1);
  assert.equal(srv.bodies[0].url, 'https://x.test/api/v2/fleet/artifact');
  assert.equal(srv.bodies[0].fields.name, 'chart.svg');
  assert.equal(srv.bodies[0].file, '<svg/>');
});

test('a 4xx is delivered (an older server 404s the route); a 5xx is held and retried from the stored body', async () => {
  const d = place();
  put(d, 'a.md', 'first');
  const srv = fakeServer([404]);
  const r = reporter(srv);
  await r.report({ placeDir: d, before: new Map(), agentId: 'a1', turnId: 't' });
  assert.equal(r.pendingCount(), 0);

  const d2 = place();
  put(d2, 'b.md', 'as scrubbed at the time');
  const srv2 = fakeServer([503, new Error('network')]);
  const r2 = reporter(srv2);
  await r2.report({ placeDir: d2, before: new Map(), agentId: 'a1', turnId: 't' });
  assert.equal(r2.pendingCount(), 1);
  // The disk moves on; the retry sends what was built, never a fresh read.
  put(d2, 'b.md', 'changed after the turn');
  await r2.retryPending();
  assert.equal(r2.pendingCount(), 1);
  await r2.retryPending();
  assert.equal(r2.pendingCount(), 0);
  assert.equal(srv2.bodies.length, 3);
  assert.ok(srv2.bodies.every((b) => b.file === 'as scrubbed at the time'));
});

test('a held upload is dropped after its tries run out, not retried forever', async () => {
  const d = place();
  put(d, 'c.md', 'x');
  const srv = fakeServer([500, 500, 500, 500, 500, 500]);
  const r = reporter(srv);
  await r.report({ placeDir: d, before: new Map(), sessionId: 's', turnId: 't' });
  for (let i = 0; i < 6; i++) await r.retryPending();
  assert.equal(r.pendingCount(), 0);
  assert.equal(srv.bodies.length, 4);
});

test('the reporter skips a withheld binary with a warn line naming the file, and sends the rest', async () => {
  const d = place();
  writeFileSync(join(d, ARTIFACT_DIR, 'deck.pdf'), Buffer.from('%PDF-1.4\nBT (token sk-live-9f8e7d6c5b4a) Tj ET'));
  writeFileSync(join(d, ARTIFACT_DIR, 'ok.png'), Buffer.from([0x89, 0x50]));
  const srv = fakeServer();
  const lines = [];
  const r = createArtifactReporter({
    ...disk,
    fleetUrl: 'https://x.test/api/v2/fleet/agents',
    token: 't',
    userAgent: 'ua',
    scrub: (t) => t,
    secretIn: (buf) => (buf.includes('sk-live-9f8e7d6c5b4a') ? 'STRIPE_KEY' : null),
    fetchImpl: srv.fetchImpl,
    log: (l) => lines.push(l),
  });
  const n = await r.report({ placeDir: d, before: new Map(), agentId: 'a1', turnId: 't1' });
  assert.equal(n, 1);
  assert.deepEqual(srv.bodies.map((b) => b.fields.name), ['ok.png'], 'the PDF never left, not even by name');
  assert.deepEqual(lines, ["artifact deck.pdf: not uploaded — it contains the value of STRIPE_KEY from this machine's environment"]);
  assert.equal(r.pendingCount(), 0, 'withheld is not held for a retry');
});

test('a newer copy of a file wins over an older retry still in flight — it goes out after it, and the old answer decides nothing (audit 2026-09-24)', async () => {
  const d = place();
  put(d, 'landing.html', '<p>v1</p>');
  const order = [];
  let releaseOld;
  let call = 0;
  const fetchImpl = async (url, init) => {
    const text = Buffer.from(await init.body.get('file').arrayBuffer()).toString('utf8');
    call++;
    if (call === 1) return { ok: false, status: 503 }; // first upload is held
    if (call === 2) {
      // the retry of v1: a slow uplink, and it fails in the end
      await new Promise((r) => { releaseOld = r; });
      order.push(text);
      return { ok: false, status: 503 };
    }
    order.push(text);
    return { ok: true, status: 200 };
  };
  const r = createArtifactReporter({ ...disk, fleetUrl: 'https://x.test/api/v2/fleet/agents', token: 't', userAgent: 'ua', scrub: (s) => s, fetchImpl });
  await r.report({ placeDir: d, before: new Map(), agentId: 'a1', turnId: 't1' });
  assert.equal(r.pendingCount(), 1);
  const retry = r.retryPending(); // v1 goes out again and hangs
  await new Promise((res) => setImmediate(res));
  put(d, 'landing.html', '<p>v2</p>', Math.floor(Date.now() / 1000) + 60);
  const newer = r.report({ placeDir: d, before: new Map(), agentId: 'a1', turnId: 't2' });
  await new Promise((res) => setImmediate(res));
  releaseOld();
  await Promise.all([retry, newer]);
  // v2 reached the server LAST, and the failed v1 did not re-hold itself.
  assert.deepEqual(order, ['<p>v1</p>', '<p>v2</p>']);
  assert.equal(r.pendingCount(), 0);
  await r.retryPending();
  assert.equal(call, 3);
});

test('a preview that fails still posts the HTML artifact, marked unavailable (SOLID F051)', async () => {
  const d = place();
  put(d, 'landing.html', '<p>a page</p>');
  put(d, 'notes.md', 'no preview for markdown');
  const srv = fakeServer();
  const asked = [];
  const r = reporter(srv, (s) => s, {
    renderPreview: async (bytes) => {
      asked.push(bytes.toString('utf8'));
      return { renderState: 'unavailable' };
    },
  });
  const n = await r.report({ placeDir: d, before: new Map(), agentId: 'a1', turnId: 't1' });
  assert.equal(n, 2);
  assert.deepEqual(asked, ['<p>a page</p>'], 'only the HTML is rendered, from the scrubbed bytes');
  const html = srv.bodies.find((b) => b.fields.name === 'landing.html');
  assert.equal(html.fields.renderState, 'unavailable');
  assert.equal(html.file, '<p>a page</p>', 'the artifact itself still went out');
  assert.equal(srv.bodies.find((b) => b.fields.name === 'notes.md').fields.renderState, undefined);
  assert.equal(r.pendingCount(), 0);
});

test('a rendered preview rides beside the HTML as preview.png', async () => {
  const d = place();
  put(d, 'landing.html', '<p>a page</p>');
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
  const forms = [];
  const r = createArtifactReporter({
    ...disk,
    renderPreview: async () => ({ renderState: 'rendered', preview: png }),
    fleetUrl: 'https://x.test/api/v2/fleet/agents',
    token: 't',
    userAgent: 'ua',
    scrub: (s) => s,
    fetchImpl: async (url, init) => {
      forms.push(init.body);
      return { ok: true, status: 200 };
    },
  });
  await r.report({ placeDir: d, before: new Map(), agentId: 'a1', turnId: 't1' });
  assert.equal(forms[0].get('renderState'), 'rendered');
  assert.deepEqual(Buffer.from(await forms[0].get('preview').arrayBuffer()), png);
});
