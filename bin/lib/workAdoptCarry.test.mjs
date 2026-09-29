import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAdoptCarry } from './workAdoptCarry.mjs';

/**
 * ADOPTION'S DIRTY CARRY against real git (split out of work.mjs 2026-09-26,
 * SOLID F037): the terminal checkout's tracked and untracked changes arrive in
 * the adopt worktree, and the source is left exactly as it was.
 */
const git = (args, cwd) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

test('tracked and untracked changes carry over; the source checkout is untouched', (t) => {
  const src = mkdtempSync(join(tmpdir(), 'fv-carry-src-'));
  const wts = mkdtempSync(join(tmpdir(), 'fv-carry-wt-'));
  t.after(() => {
    rmSync(src, { recursive: true, force: true });
    rmSync(wts, { recursive: true, force: true });
  });
  git(['init', '-q', '-b', 'main'], src);
  git(['config', 'user.email', 't@t.t'], src);
  git(['config', 'user.name', 'T'], src);
  writeFileSync(join(src, 'a.txt'), 'one\n');
  git(['add', '-A'], src);
  git(['commit', '-qm', 'base'], src);
  writeFileSync(join(src, 'a.txt'), 'one\ntwo\n');
  writeFileSync(join(src, 'notes.md'), 'draft');
  const before = git(['status', '--porcelain'], src);
  const wt = join(wts, 'adopt');
  git(['worktree', 'add', '-q', '-b', 'session/s1', wt, 'HEAD'], src);
  const sessionMetaPath = (dir, name, scope) => join(git(['rev-parse', '--absolute-git-dir'], dir), `${name}-${scope}`);
  const { carryDirtyState } = createAdoptCarry({ sessionMetaPath });
  assert.equal(carryDirtyState(src, wt, 's1'), '', 'a clean carry says nothing');
  assert.equal(readFileSync(join(wt, 'a.txt'), 'utf8'), 'one\ntwo\n');
  assert.equal(readFileSync(join(wt, 'notes.md'), 'utf8'), 'draft');
  assert.equal(git(['status', '--porcelain'], src), before, 'the source is read-only');
});

test('a carry that cannot stage its patch says so in one bracketed line and never throws', (t) => {
  const src = mkdtempSync(join(tmpdir(), 'fv-carry-src2-'));
  t.after(() => rmSync(src, { recursive: true, force: true }));
  git(['init', '-q', '-b', 'main'], src);
  git(['config', 'user.email', 't@t.t'], src);
  git(['config', 'user.name', 'T'], src);
  writeFileSync(join(src, 'a.txt'), 'one\n');
  git(['add', '-A'], src);
  git(['commit', '-qm', 'base'], src);
  writeFileSync(join(src, 'a.txt'), 'changed\n');
  const { carryDirtyState } = createAdoptCarry({ sessionMetaPath: () => null });
  const line = carryDirtyState(src, join(src, 'no-such-worktree'), 's1');
  assert.match(line, /^\[ADOPTION NOTE from the daemon/);
  assert.match(line, /TRACKED changes did not carry over/);
});
