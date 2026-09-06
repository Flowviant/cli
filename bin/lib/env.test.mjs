/**
 * The materialization boundary — the two places a hostile targetFile could act.
 *
 * `knownTargetFiles` is refilled from the server bundle and from the on-disk
 * cache, and the stale sweep joins each entry to a worktree and calls rmSync.
 * The isTrackedInGit check cannot gate that: `ls-files` on a path OUTSIDE the
 * worktree throws, the catch reads as "not tracked", and the deletion
 * proceeds — so before the isSafeTarget gate, `../victim` in a cache file was
 * a delete primitive pointed anywhere on the box. The write path had the gate
 * all along; these tests pin that the delete path holds the same line, and
 * that `.git/**` is refused at intake so a value sealed to
 * `.git/hooks/pre-commit` can never become code git runs.
 *
 * The cache seeding reimplements writeCache the way grant.test.mjs
 * reimplements the minting side: only so this file can stand alone.
 *
 * Run: node --test bin/lib/env.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// HOME must move BEFORE env.mjs computes its keypair/cache paths at import —
// this test writes a keypair and a cache, and must never touch the real one.
const HOME = mkdtempSync(join(tmpdir(), 'fv-envhome-'));
process.env.HOME = HOME;

const env = await import('./env.mjs');
const sodium = (await import('libsodium-wrappers-sumo')).default;
await sodium.ready;
await env.ensureKeypair();

const B64 = sodium.base64_variants.ORIGINAL;
const HEADER = '# Materialized by flowviant env sync — DO NOT COMMIT.\nX=1\n';

/** writeCache's twin: encrypt a bundle payload under the key env.mjs derives
 *  from its own keypair, so loadCachedEnv accepts it as its own. */
function seedCache(projectId, payload) {
  const stored = JSON.parse(readFileSync(join(HOME, '.flowviant', 'env-keypair.json'), 'utf8'));
  const key = sodium.crypto_generichash(
    sodium.crypto_secretbox_KEYBYTES,
    sodium.from_base64(stored.priv, B64)
  );
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const box = sodium.crypto_secretbox_easy(
    sodium.from_string(JSON.stringify(payload)),
    nonce,
    key
  );
  const dir = join(HOME, '.flowviant', 'env-cache');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${projectId}.json`),
    JSON.stringify({ nonce: sodium.to_base64(nonce, B64), box: sodium.to_base64(box, B64) })
  );
}

function makeRepo(dir) {
  const git = (args) =>
    execFileSync('git', args, {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'T',
        GIT_AUTHOR_EMAIL: 't@e',
        GIT_COMMITTER_NAME: 'T',
        GIT_COMMITTER_EMAIL: 't@e',
      },
    });
  git(['init', '-q', '-b', 'main']);
  writeFileSync(join(dir, 'a.txt'), 'one');
  git(['add', '.']);
  git(['commit', '-qm', 'first']);
}

test('a hostile cache path never reaches rmSync, and .git never gets a secret', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'fv-envwt-'));
  const wt = join(parent, 'repo');
  mkdirSync(wt);
  makeRepo(wt);

  // The would-be victims: a file OUTSIDE the worktree that a traversal entry
  // would resolve to, and a planted file inside .git — both wearing our
  // header, which is exactly the disguise a real attack would use.
  const outside = join(parent, 'outside-pwn');
  writeFileSync(outside, HEADER);
  writeFileSync(join(wt, '.git', 'planted'), HEADER);
  // A legitimately stale materialized file: the sweep must still remove it,
  // or the gate has thrown the feature out with the attack.
  writeFileSync(join(wt, 'old.env'), HEADER);

  seedCache('proj-test', {
    bundleVersion: 3,
    values: [
      { name: 'API_KEY', env: 'dev', scope: 'app', targetFile: '.env', value: 'secret-value-1' },
      // Refused at grouping: a `.git` segment turns a materialized value into
      // code git runs on the operator's next commit.
      { name: 'EVIL', env: 'dev', scope: 'app', targetFile: '.git/hooks/pre-commit', value: 'pwn' },
    ],
    knownFiles: ['.env', 'old.env', '../outside-pwn', '.git/planted'],
  });

  assert.equal(await env.loadCachedEnv('proj-test'), true);
  env.materializeInto(wt);

  // The honest half still works end to end.
  const written = readFileSync(join(wt, '.env'), 'utf8');
  assert.match(written, /^# Materialized by flowviant env sync/);
  assert.match(written, /API_KEY=secret-value-1/);
  assert.equal(existsSync(join(wt, 'old.env')), false, 'a genuinely stale file must still be swept');

  // The gates: nothing outside the worktree was deleted, nothing landed in
  // .git, and the planted .git file was not "cleaned up" either.
  assert.equal(existsSync(outside), true, 'a traversal path in the cache must never be rmSync-ed');
  assert.equal(existsSync(join(wt, '.git', 'planted')), true, 'a .git path must never be rmSync-ed');
  assert.equal(existsSync(join(wt, '.git', 'hooks', 'pre-commit')), false, 'a .git target must never be written');
});
