/**
 * THE VAULT SYNC PLAN — carry-forward, never-inferred deletion, and the request
 * series, driven directly (SOLID F063), plus one integration case through
 * syncVault against a local server: the sync state advances only after EVERY
 * POST lands.
 *
 * Run: node --test bin/lib/vaultDiff.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHUNK_FILES, MAX_DELETIONS_PER_REQ, MAX_FILE_BYTES, planVaultSync } from './vaultDiff.mjs';
import { syncVault } from './vault.mjs';

const sha = (t) => createHash('sha256').update(t).digest('hex');
const reader = (pages) => (p) => (p in pages ? pages[p] : null);

test('an unreadable subtree carries its pages forward: no deletion this pass', () => {
  const prev = { 'a.md': sha('a'), 'docs/b.md': sha('b'), 'docs/c.md': sha('c') };
  const plan = planVaultSync({ found: ['a.md'], walkErrors: 1, prev, read: reader({ 'a.md': 'a2' }) });
  assert.equal(plan.deleted, 0);
  assert.deepEqual(plan.state, { 'a.md': sha('a2'), 'docs/b.md': sha('b'), 'docs/c.md': sha('c') });
  assert.deepEqual(plan.requests, [{ files: [{ path: 'a.md', content: 'a2' }], deletions: [] }]);
  assert.match(plan.warnings.at(-1), /1 unreadable directory — carrying missing pages forward/);
});

test('an unreadable root sends nothing', () => {
  const plan = planVaultSync({ found: [], walkErrors: 2, prev: { 'a.md': 'x' }, read: reader({}), dir: '/v' });
  assert.deepEqual(plan.result, { pages: 0, uploaded: 0, deleted: 0, skipped: true });
  assert.deepEqual(plan.warnings, ['vault at /v is unreadable — skipping sync; check the vault dir']);
});

test('an oversized known page keeps its last synced copy; an oversized new one is not synced', () => {
  const big = 'x'.repeat(MAX_FILE_BYTES + 1);
  const prev = { 'log.md': sha('old log') };
  const plan = planVaultSync({ found: ['log.md', 'new.md'], prev, read: reader({ 'log.md': big, 'new.md': big }), finalize: true });
  assert.deepEqual(plan.state, { 'log.md': sha('old log') });
  assert.equal(plan.deleted, 0, 'the log crossing the cap never erases itself');
  assert.deepEqual(plan.requests, [{ files: [], deletions: [], finalize: { manifest: ['log.md'] } }]);
  assert.deepEqual(plan.warnings, [
    'vault page log.md: exceeds 256KB — keeping the last synced copy',
    'vault page new.md: exceeds 256KB — not synced',
  ]);
});

test('an unreadable known page is carried, not deleted', () => {
  const plan = planVaultSync({ found: ['a.md'], prev: { 'a.md': sha('a') }, read: reader({}) });
  assert.deepEqual(plan.result, { pages: 1, uploaded: 0, deleted: 0, skipped: true });
});

test('a readable vault presenting zero pages refuses to mass-delete', () => {
  const plan = planVaultSync({ found: [], prev: { 'a.md': sha('a'), 'b.md': sha('b') }, read: reader({}), dir: '/v' });
  assert.deepEqual(plan.result, { pages: 0, uploaded: 0, deleted: 0, skipped: true });
  assert.match(plan.warnings[0], /presents 0 pages but 2 were synced — refusing to delete/);
});

test('a page that verifiably vanished from a readable vault is the one deletion', () => {
  const plan = planVaultSync({ found: ['a.md'], prev: { 'a.md': sha('a'), 'gone.md': sha('g') }, read: reader({ 'a.md': 'a' }) });
  assert.deepEqual(plan.requests, [{ files: [], deletions: ['gone.md'] }]);
  assert.equal(plan.deleted, 1);
});

test('finalize-only: an unchanged vault still sends one request carrying the manifest and sha', () => {
  const plan = planVaultSync({ found: ['a.md'], prev: { 'a.md': sha('a') }, read: reader({ 'a.md': 'a' }), finalize: true, groundedAtSha: 'abc1234', repoFullName: 'o/r' });
  assert.deepEqual(plan.requests, [{ files: [], deletions: [], finalize: { manifest: ['a.md'] }, groundedAtSha: 'abc1234', repoFullName: 'o/r' }]);
  assert.equal(plan.finalized, true);
  // Unchanged and not finalizing sends nothing.
  assert.equal(planVaultSync({ found: ['a.md'], prev: { 'a.md': sha('a') }, read: reader({ 'a.md': 'a' }) }).result.skipped, true);
});

test('batches: file chunks then deletion batches, finalize on the LAST request only', () => {
  const found = Array.from({ length: CHUNK_FILES + 1 }, (_, i) => `p${String(i).padStart(3, '0')}.md`);
  const pages = Object.fromEntries(found.map((p) => [p, p]));
  const prev = Object.fromEntries(Array.from({ length: MAX_DELETIONS_PER_REQ + 1 }, (_, i) => [`old${i}.md`, 'h']));
  const plan = planVaultSync({ found, prev, read: reader(pages), finalize: true });
  assert.deepEqual(plan.requests.map((r) => [r.files.length, r.deletions.length]), [[CHUNK_FILES, 0], [1, 0], [0, MAX_DELETIONS_PER_REQ], [0, 1]]);
  assert.deepEqual(plan.requests.map((r) => 'finalize' in r), [false, false, false, true]);
});

test('syncVault advances its state only after every POST lands', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fv-vault-'));
  const bodies = [];
  let failAt = 2;
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      bodies.push(JSON.parse(raw));
      res.statusCode = bodies.length === failAt ? 500 : 200;
      res.end('{}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/api/fleet/wiki-vault`;
  try {
    mkdirSync(join(dir, 'docs'));
    for (let i = 0; i <= CHUNK_FILES; i++) writeFileSync(join(dir, 'docs', `p${i}.md`), `page ${i}`);
    const args = { dir, url, token: 't', userAgent: 'test', finalize: false };
    await assert.rejects(syncVault(args), /wiki-vault sync failed \(500\)/);
    assert.equal(bodies.length, 2, 'the series stops at the failure');
    assert.equal(existsSync(join(dir, '.flowviant-sync.json')), false, 'no state after a partial sync');
    failAt = 0;
    bodies.length = 0;
    const r = await syncVault(args);
    assert.deepEqual(r, { pages: CHUNK_FILES + 1, uploaded: CHUNK_FILES + 1, deleted: 0 });
    assert.equal(bodies.length, 2, 'everything re-uploads after a partial failure');
    const state = JSON.parse(readFileSync(join(dir, '.flowviant-sync.json'), 'utf8'));
    assert.equal(Object.keys(state).length, CHUNK_FILES + 1);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the sync policy has one home: vault.mjs plans nothing itself', () => {
  const src = readFileSync(new URL('./vault.mjs', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  assert.ok(src.includes('planVaultSync('), 'anchor: vault.mjs asks the planner');
  for (const banned of ['MAX_DELETIONS_PER_REQ', 'MAX_FILE_BYTES', 'createHash', 'finalize: { manifest']) {
    assert.ok(!src.includes(banned), `vault.mjs must not carry the policy (${banned})`);
  }
});

test('the sync contract and carry-forward words live in vaultDiff.mjs alone, anywhere in bin/', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith('.mjs') && !e.name.endsWith('.test.mjs') ? [join(d, e.name)] : []);
  const sources = walk(root).map((f) => [f.slice(root.length).replace(/^\//, ''), strip(readFileSync(f, 'utf8'))]);
  for (const banned of ['MAX_DELETIONS_PER_REQ', 'MAX_FILE_BYTES', 'keeping the last synced copy']) {
    // Canary: the walk finds the one home.
    assert.deepEqual(sources.filter(([, src]) => src.includes(banned)).map(([f]) => f), ['lib/vaultDiff.mjs'], banned);
  }
});
