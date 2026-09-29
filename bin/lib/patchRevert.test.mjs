/**
 * THE PATCH REVERT LANE, against a real throwaway repo: a sha that is not a
 * bare object id is refused before git sees it, a clean revert lands, and a
 * revert that conflicts is aborted so the owner's tree is not left mid-revert.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { revertPatch, withPatchLock } from './patchRevert.mjs';

const git = (args, cwd) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function repo(t) {
  const dir = mkdtempSync(join(tmpdir(), 'fv-patch-revert-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  git(['init', '-q', '-b', 'main'], dir);
  git(['config', 'user.email', 't@t.t'], dir);
  git(['config', 'user.name', 'T'], dir);
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  git(['add', '-A'], dir);
  git(['commit', '-qm', 'base'], dir);
  return dir;
}

test('a value that is not a bare sha is refused and git is never asked', (t) => {
  const dir = repo(t);
  const head = git(['rev-parse', 'HEAD'], dir);
  for (const shas of [[], ['--hard'], ['HEAD~1..HEAD'], [head, 'main']]) {
    const r = revertPatch({ repoRoot: dir, shas });
    assert.deepEqual(r, { ok: false, error: 'refused: patch revert carried a non-sha value' });
  }
  assert.equal(git(['rev-parse', 'HEAD'], dir), head, 'nothing was reverted');
});

test('a clean revert lands as new commits, newest first, never a reset', (t) => {
  const dir = repo(t);
  writeFileSync(join(dir, 'b.txt'), 'two\n');
  git(['add', '-A'], dir);
  git(['commit', '-qm', 'patch one'], dir);
  const one = git(['rev-parse', 'HEAD'], dir);
  writeFileSync(join(dir, 'b.txt'), 'three\n');
  git(['commit', '-qam', 'patch two'], dir);
  const two = git(['rev-parse', 'HEAD'], dir);
  assert.deepEqual(revertPatch({ repoRoot: dir, shas: [one, two] }), { ok: true });
  assert.equal(existsSync(join(dir, 'b.txt')), false);
  const log = git(['log', '--format=%s', '-4'], dir).split('\n');
  assert.deepEqual(log, ['Revert "patch one"', 'Revert "patch two"', 'patch two', 'patch one']);
});

test('a revert that conflicts is aborted, leaving no revert in progress', (t) => {
  const dir = repo(t);
  writeFileSync(join(dir, 'a.txt'), 'patched\n');
  git(['commit', '-qam', 'patch'], dir);
  const patch = git(['rev-parse', 'HEAD'], dir);
  // The owner worked on top of the patch, on the same line.
  writeFileSync(join(dir, 'a.txt'), 'owner edit\n');
  git(['commit', '-qam', 'owner'], dir);
  const head = git(['rev-parse', 'HEAD'], dir);
  const r = revertPatch({ repoRoot: dir, shas: [patch] });
  assert.equal(r.ok, false);
  assert.ok(r.error);
  assert.equal(git(['rev-parse', 'HEAD'], dir), head, 'HEAD is where the owner left it');
  assert.equal(readFileSync(join(dir, 'a.txt'), 'utf8'), 'owner edit\n');
  assert.ok(!readdirSync(join(dir, '.git')).includes('REVERT_HEAD'), 'the revert was aborted');
});

test('the lock runs one job at a time and survives a throw', async () => {
  const order = [];
  const slow = withPatchLock(async () => {
    await new Promise((r) => setTimeout(r, 30));
    order.push('first');
    throw new Error('boom');
  });
  const next = withPatchLock(async () => order.push('second'));
  await assert.rejects(slow, /boom/);
  await next;
  assert.deepEqual(order, ['first', 'second']);
});
