import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ATTACHMENT_MAX_BYTES, createWorkAttachments } from './workAttachments.mjs';

/**
 * FILES THE HUMAN ATTACHED, driven directly (split out of work.mjs
 * 2026-09-26, SOLID F037) against a stubbed download and a real worktree, so
 * the git claim ("never committed by us") is measured, not asserted.
 */
function checkout(t) {
  const dir = mkdtempSync(join(tmpdir(), 'fv-attach-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const g = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  g(['init', '-q', '-b', 'main']);
  g(['config', 'user.email', 't@t.t']);
  g(['config', 'user.name', 'T']);
  writeFileSync(join(dir, 'a.txt'), 'one');
  g(['add', '-A']);
  g(['commit', '-qm', 'base']);
  return { dir, status: () => g(['status', '--porcelain', '--untracked-files=all']) };
}

function serve(t, files) {
  const real = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (url) => {
    const id = String(url).split('/').pop();
    asked.push(id);
    const body = files[id];
    if (body === undefined) return { ok: false, status: 404 };
    return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode(body).buffer };
  };
  t.after(() => {
    globalThis.fetch = real;
  });
  return asked;
}

test('attachments land under .flowviant/uploads, in order, colliding names kept apart, and git never sees them', async (t) => {
  const { dir, status } = checkout(t);
  const asked = serve(t, { aaaaaaaa1: 'first', bbbbbbbb2: 'second', cccccccc3: '' });
  const { fetchAttachments } = createWorkAttachments();
  const written = await fetchAttachments(dir, [
    { id: 'aaaaaaaa1', name: 'Screenshot.png', size: 5 },
    { id: 'bbbbbbbb2', name: 'Screenshot.png', size: 6 },
    { id: 'not an id!', name: 'x.txt', size: 1 },
    { id: 'dddddddd4', name: 'huge.bin', size: 21 * 1024 * 1024 },
    { id: 'cccccccc3', name: 'empty.txt', size: 0 },
    { id: 'eeeeeeee5', name: 'missing.txt', size: 1 },
  ]);
  assert.deepEqual(written, ['.flowviant/uploads/Screenshot.png', '.flowviant/uploads/Screenshot-bbbbbb.png']);
  assert.equal(readFileSync(join(dir, written[1]), 'utf8'), 'second');
  assert.deepEqual(asked, ['aaaaaaaa1', 'bbbbbbbb2', 'cccccccc3', 'eeeeeeee5'], 'a bad id or an oversize file is never fetched');
  assert.equal(status(), '', 'the uploads never make the worktree dirty');
});

test('no attachments is no work, and a server-sent name is re-sanitised here', async (t) => {
  const { dir } = checkout(t);
  serve(t, { ffffffff6: 'x' });
  const { fetchAttachments } = createWorkAttachments();
  assert.deepEqual(await fetchAttachments(dir, undefined), []);
  assert.deepEqual(await fetchAttachments(dir, []), []);
  const [only] = await fetchAttachments(dir, [{ id: 'ffffffff6', name: '../../escape.txt', size: 1 }]);
  assert.ok(only.startsWith('.flowviant/uploads/') && !only.includes('..'), only);
});

/**
 * AN AGENT TURN'S FILES (0.112.0) come from `/fleet/agent-file/:id` through
 * the same loop, split by origin, each one saying whether it landed — while
 * the Terminal's fetch still asks `/fleet/attachment/:id` and answers exactly
 * as it did (the regression half of this case).
 */
function serveUrls(t, files) {
  const real = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (url) => {
    // The route's own tail: the base is whatever FLEET_URL says on this box.
    asked.push(new URL(String(url)).pathname.replace(/^.*(?=\/fleet\/)/, ''));
    const body = files[String(url).split('/').pop()];
    if (body === undefined) return { ok: false, status: 410 };
    return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode(body).buffer };
  };
  t.after(() => {
    globalThis.fetch = real;
  });
  return asked;
}

test('an agent turn’s files come from agent-file, split by origin, a miss named — the Terminal still asks attachment', async (t) => {
  const { dir, status } = checkout(t);
  const asked = serveUrls(t, { aaaaaaaa1: 'shot', bbbbbbbb2: 'mock', cccccccc3: 'other mock' });
  const { fetchAttachments, fetchAgentFiles } = createWorkAttachments();
  const files = await fetchAgentFiles(dir, [
    { id: 'bbbbbbbb2', name: 'mock.png', size: 4, from: 'card' },
    { id: 'aaaaaaaa1', name: 'shot.png', size: 4, from: 'message' },
    { id: 'dddddddd4', name: 'gone.pdf', size: 4, from: 'card' },
    { id: 'cccccccc3', name: 'mock.png', size: 10, from: 'card' },
  ]);
  assert.deepEqual(files, {
    message: [{ path: '.flowviant/uploads/shot.png' }],
    card: [
      { path: '.flowviant/uploads/mock.png' },
      { missed: 'gone.pdf' },
      { path: '.flowviant/uploads/mock-cccccc.png' },
    ],
  });
  assert.deepEqual(asked, ['aaaaaaaa1', 'bbbbbbbb2', 'dddddddd4', 'cccccccc3'].map((id) => `/fleet/agent-file/${id}`), 'message first');
  assert.equal(readFileSync(join(dir, '.flowviant/uploads/mock-cccccc.png'), 'utf8'), 'other mock');
  assert.equal(status(), '', 'never committed by us');

  // THE NEXT TURN ABOUT THE CARD is handed the same files again: the same
  // bytes keep their names — `mock.png` is not re-landed as `mock-bbbbbb.png`.
  asked.length = 0;
  const again = await fetchAgentFiles(dir, [
    { id: 'bbbbbbbb2', name: 'mock.png', size: 4, from: 'card' },
    { id: 'cccccccc3', name: 'mock.png', size: 10, from: 'card' },
  ]);
  assert.deepEqual(again.card, [{ path: '.flowviant/uploads/mock.png' }, { path: '.flowviant/uploads/mock-cccccc.png' }]);
  assert.equal(asked.length, 2);
  assert.deepEqual(await fetchAgentFiles(dir, undefined), { message: [], card: [] });

  // The Terminal: its own route, and its collision rule untouched — the same
  // bytes under a taken name are still kept apart, as they always were.
  asked.length = 0;
  assert.deepEqual(await fetchAttachments(dir, [{ id: 'aaaaaaaa1', name: 'shot.png', size: 4 }]), ['.flowviant/uploads/shot-aaaaaa.png']);
  assert.deepEqual(asked, ['/fleet/attachment/aaaaaaaa1']);
});

/**
 * A FILE UP TO 20 MB (0.113.0, the owner 2026-09-29: "20 MB for every file").
 * 0.112.0 skipped anything over 10 MB without a word, on both lanes; the
 * ceiling is now the server's (`check-app-parity.mjs` rule 11), and past it a
 * file is still skipped — by its declared size before any fetch, and by its
 * bytes when the declared size understated them.
 */
test('a 15 MB file lands on both lanes; one over 20 MB never does', async (t) => {
  const MB = 1024 * 1024;
  assert.equal(ATTACHMENT_MAX_BYTES, 20 * MB);
  const { dir, status } = checkout(t);
  const bodies = { aaaaaaaa1: 15 * MB, bbbbbbbb2: 20 * MB, cccccccc3: 21 * MB, eeeeeeee5: 15 * MB };
  const real = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (url) => {
    const id = String(url).split('/').pop();
    asked.push(id);
    const n = bodies[id];
    if (n === undefined) return { ok: false, status: 404 };
    return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array(n).buffer };
  };
  t.after(() => {
    globalThis.fetch = real;
  });
  const { fetchAttachments, fetchAgentFiles } = createWorkAttachments();

  const written = await fetchAttachments(dir, [
    { id: 'aaaaaaaa1', name: 'shot.png', size: 15 * MB },
    { id: 'bbbbbbbb2', name: 'edge.png', size: 20 * MB },
    { id: 'dddddddd4', name: 'huge.png', size: 21 * MB },
    // Declared small, served big: the bytes decide.
    { id: 'cccccccc3', name: 'liar.png', size: 1 },
  ]);
  assert.deepEqual(written, ['.flowviant/uploads/shot.png', '.flowviant/uploads/edge.png']);
  assert.equal(statSync(join(dir, written[0])).size, 15 * MB);
  assert.deepEqual(asked, ['aaaaaaaa1', 'bbbbbbbb2', 'cccccccc3'], 'a file declared over 20 MB is never fetched');

  asked.length = 0;
  const files = await fetchAgentFiles(dir, [
    { id: 'eeeeeeee5', name: 'mock.png', size: 15 * MB, from: 'message' },
    { id: 'ffffffff6', name: 'huge.glb', size: 21 * MB, from: 'card' },
  ]);
  assert.deepEqual(files, {
    message: [{ path: '.flowviant/uploads/mock.png' }],
    card: [{ missed: 'huge.glb' }],
  });
  assert.deepEqual(asked, ['eeeeeeee5']);
  assert.equal(status(), '', 'never committed by us');
});
