/**
 * The repo scan.
 *
 * The parsing here is the part that can quietly lie. `git worktree list` in its
 * HUMAN form aligns columns with spaces, so a path containing a space splits
 * into the wrong fields and the surface confidently shows the wrong branch on
 * the wrong directory — which is why the porcelain form is parsed instead, and
 * why that is worth a test rather than a comment.
 *
 * Run: node --test bin/lib/repoState.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isSessionBranch, repoState } from './repoState.mjs';

test('a session branch is one WE cut, and nothing else', () => {
  assert.equal(isSessionBranch('session/abc-123'), true);
  assert.equal(isSessionBranch('main'), false);
  // Not a substring match: a person's branch that merely mentions the word is
  // theirs, and marking it as ours would misattribute their work.
  assert.equal(isSessionBranch('feature/session-timeout'), false);
  assert.equal(isSessionBranch('my-session/x'), false);
});

test('reads a real repo: its branches, which are ours, and the totals', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fv-repo-'));
  try {
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
    git(['branch', 'session/abc']);
    git(['branch', 'feature/x']);

    const s = repoState(dir, 'main');
    assert.ok(s, 'a readable repo must report something');
    assert.equal(s.base, 'main');
    assert.equal(s.branchesTotal, 3);
    // Only the `session/` one counts as ours — `feature/x` is somebody's work.
    assert.equal(s.sessionBranches, 1);
    assert.deepEqual(
      s.branches.map((b) => b.name).sort(),
      ['feature/x', 'main', 'session/abc']
    );
    assert.equal(s.worktreesTotal, 1);
    assert.equal(s.worktrees[0].branch, 'main');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The whole reason the porcelain form is parsed: the human one is
// space-aligned, so a path with a space in it lands in the wrong field and the
// surface shows the wrong branch against the wrong directory.
test('a worktree path containing a space stays one path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fv-repo-'));
  try {
    const git = (args, cwd = dir) =>
      execFileSync('git', args, {
        cwd,
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
    const spaced = join(dir, 'work tree with spaces');
    git(['worktree', 'add', '-q', '-b', 'session/spaced', spaced, 'main']);

    const s = repoState(dir, 'main');
    const found = s.worktrees.find((w) => w.path.endsWith('work tree with spaces'));
    assert.ok(found, `the spaced worktree survived parsing: ${JSON.stringify(s.worktrees)}`);
    assert.equal(found.branch, 'session/spaced');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// It runs in the poll loop's best-effort tail: a directory that is not a repo
// is a thing to say nothing about, never an error to raise.
test('a directory that is not a repo reports null rather than throwing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fv-norepo-'));
  try {
    assert.equal(repoState(dir, 'main'), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
