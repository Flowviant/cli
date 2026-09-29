import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isCurrent, syncVerifiedFile } from './knowledgeFileSync.mjs';

/** The five states of one verified file (SOLID F003) — see the module header. */
const sha = (s) => createHash('sha256').update(s).digest('hex');
const at = () => join(mkdtempSync(join(tmpdir(), 'fv-kfs-')), 'f.md');

test('current: a matching file is not fetched', async () => {
  const path = at();
  writeFileSync(path, 'a');
  let fetched = 0;
  const s = await syncVerifiedFile({ path, sha256: sha('a').toUpperCase(), bytes: 1, maxBytes: 10, fetch: async () => { fetched++; return Buffer.from('a'); } });
  assert.equal(s, 'current');
  assert.equal(fetched, 0);
});

test('wrote: fetched, verified, written — and the parent hook runs first', async () => {
  const path = at();
  const order = [];
  const s = await syncVerifiedFile({ path, sha256: sha('b'), bytes: 1, maxBytes: 10,
    fetch: async () => Buffer.from('b'), beforeWrite: () => order.push('parents') });
  assert.equal(s, 'wrote');
  assert.deepEqual(order, ['parents']);
  assert.equal(readFileSync(path, 'utf8'), 'b');
});

test('refused: over the declared cap is never fetched; an over-cap delivery refuses too', async () => {
  const path = at();
  assert.equal(await syncVerifiedFile({ path, sha256: sha('x'), bytes: 11, maxBytes: 10, fetch: async () => assert.fail('fetched') }), 'refused');
  assert.equal(await syncVerifiedFile({ path, sha256: sha('x'), maxBytes: 1, fetch: async () => Buffer.from('xx') }), 'refused');
});

test('an over-cap delivery FAILS instead when the cap is ours (a preview)', async () => {
  const path = at();
  assert.equal(await syncVerifiedFile({ path, sha256: sha('xx'), maxBytes: 1, oversizeFails: true, fetch: async () => Buffer.from('xx') }), 'failed');
});

test('stale vs failed: a hash mismatch or a throw keeps an older copy and says so', async () => {
  const path = at();
  assert.equal(await syncVerifiedFile({ path, sha256: sha('new'), maxBytes: 10, fetch: async () => Buffer.from('tampered') }), 'failed');
  writeFileSync(path, 'old');
  assert.equal(await syncVerifiedFile({ path, sha256: sha('new'), maxBytes: 10, fetch: async () => { throw new Error('offline'); } }), 'stale');
  assert.equal(readFileSync(path, 'utf8'), 'old', 'kept until the retry lands');
  assert.equal(isCurrent('stale'), false);
  assert.equal(isCurrent('failed'), false);
  assert.equal(isCurrent('refused'), false);
  assert.equal(isCurrent('current'), true);
  assert.equal(isCurrent('wrote'), true);
});

test('no manifest hash: always fetched, never current', async () => {
  const path = at();
  writeFileSync(path, 'same');
  assert.equal(await syncVerifiedFile({ path, maxBytes: 10, fetch: async () => Buffer.from('same') }), 'wrote');
});

test('an EMPTY manifest hash is a hash nothing matches — it fails, it does not skip the check', async () => {
  const path = at();
  assert.equal(
    await syncVerifiedFile({ path, sha256: '', maxBytes: 100, fetch: async () => Buffer.from('anything') }),
    'failed'
  );
  writeFileSync(path, 'older');
  assert.equal(
    await syncVerifiedFile({ path, sha256: '', maxBytes: 100, fetch: async () => Buffer.from('anything') }),
    'stale'
  );
  assert.equal(readFileSync(path, 'utf8'), 'older');
});
