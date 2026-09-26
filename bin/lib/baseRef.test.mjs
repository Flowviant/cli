import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectBaseRef, git, gitFailure, hasCommits, usableBaseRef } from './git.mjs';

const repo = ({ commit = true, remote = false } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'fv-base-'));
  const run = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  run('init', '-q', '-b', 'master');
  if (commit) run('commit', '-q', '--allow-empty', '-m', 'first');
  if (remote) {
    const bare = mkdtempSync(join(tmpdir(), 'fv-origin-'));
    execFileSync('git', ['init', '-q', '--bare', bare]);
    run('remote', 'add', 'origin', bare);
    run('push', '-q', 'origin', 'master');
    run('fetch', '-q', 'origin');
  }
  return dir;
};

test('a repo with no remote bases agents on its local branch, not a missing origin/<branch>', (t) => {
  const dir = repo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // This was `origin/master`, which does not exist here, so every worktree
  // failed and every agent turn ended "nothing" (Death Note - Roblox, 2026-09-25).
  assert.equal(detectBaseRef(dir), 'master');
  assert.equal(usableBaseRef(dir, 'origin/master'), 'master');
  git(['worktree', 'add', '-q', '-b', 'session/a-1', join(dir, '.wt'), detectBaseRef(dir)], dir);
});

test('a repo with an origin keeps the remote-tracking base', (t) => {
  const dir = repo({ remote: true });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(usableBaseRef(dir, 'origin/master'), 'origin/master');
  assert.equal(detectBaseRef(dir), 'origin/master');
});

test('a repo with no commits is named as such, and git failures keep their words', (t) => {
  const dir = repo({ commit: false });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(hasCommits(dir), false);
  assert.equal(hasCommits(repo()), true);
  try {
    git(['worktree', 'add', '-b', 'x', join(dir, '.wt'), 'origin/master'], dir);
    assert.fail('worktree add should fail with no commits');
  } catch (e) {
    assert.match(gitFailure(e), /origin\/master|invalid reference|not a valid/i);
  }
});
