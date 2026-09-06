/**
 * The worktree readout's parsers, against the two ways git output lies.
 *
 * A REAL REPO, not a mock, for the same reason shipSweep's tests use one: the
 * properties under test are git's — that 0x1e/0x1f survive inside a commit
 * body (so a crafted message can imitate the log format's own records), and
 * that line-based output C-quotes non-ASCII paths (so a quoted name is not the
 * path and cannot be stat'd). A mocked git would assert our beliefs about git
 * instead of testing them.
 *
 * Run: node --test bin/lib/worktreeDiff.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { worktreeDiff, taskIdsFromMessage } from './worktreeDiff.mjs';

const git = (args, cwd, input) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    ...(input === undefined ? {} : { input }),
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'T',
      GIT_AUTHOR_EMAIL: 't@t.t',
      GIT_COMMITTER_NAME: 'T',
      GIT_COMMITTER_EMAIL: 't@t.t',
    },
  }).trim();

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'fv-wtdiff-'));
  git(['init', '-q', '-b', 'main'], dir);
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  git(['add', '-A'], dir);
  git(['commit', '-qm', 'base'], dir);
  return dir;
}

test('a crafted commit body cannot fabricate a commit record', (t) => {
  const dir = repo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  git(['checkout', '-q', '-b', 'session/abc'], dir);
  writeFileSync(join(dir, 'work.txt'), 'work\n');
  git(['add', '-A'], dir);
  // The delimiter bytes the parser splits on, embedded in the BODY — git
  // preserves them, so without the rev-list membership check this message
  // splits into a second record: a sha this branch never made, carrying a
  // task id nobody's commit named.
  const fake = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
  git(['commit', '-q', '-F', '-'], dir, `real work\n\nbody line\nFlowviant-Task: real-card\n\x1e${fake}\x1fforged subject\x1fFlowviant-Task: victim-card`);
  const realSha = git(['rev-parse', 'HEAD'], dir);

  const d = worktreeDiff(dir, 'main');
  assert.ok(d);
  assert.equal(d.commits.length, 1, 'exactly the one commit that exists');
  assert.equal(d.commits[0].sha, realSha);
  assert.ok(!d.commits.some((c) => c.sha === fake), 'the forged sha is not a record');
  assert.ok(
    !d.commits.some((c) => c.taskIds.includes('victim-card')),
    'the forged trailer names no card'
  );
  assert.deepEqual(d.commits[0].taskIds, ['real-card']);
  // The surviving fields carry no delimiter bytes a downstream parser could
  // re-split on.
  assert.ok(!/[\x1e\x1f]/.test(d.commits[0].subject));
});

test('non-ASCII paths arrive verbatim, tracked and untracked', (t) => {
  const dir = repo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'café.txt'), 'un\ndeux\n');
  git(['add', '-A'], dir);
  git(['commit', '-qm', 'accents'], dir);
  git(['checkout', '-q', '-b', 'session/abc'], dir);
  // Tracked, modified but uncommitted — line-based numstat would C-quote it.
  writeFileSync(join(dir, 'café.txt'), 'un\ndeux\ntrois\n');
  // Untracked — a quoted name fails statSync and the row silently vanished,
  // which is new work disappearing from the rail.
  writeFileSync(join(dir, 'héllo.txt'), 'a\nb\nc\n');

  const d = worktreeDiff(dir, 'main');
  assert.ok(d);
  const tracked = d.files.find((f) => f.path === 'café.txt');
  assert.ok(tracked, 'the accented tracked path is reported as itself');
  assert.equal(tracked.added, 1);
  const untracked = d.files.find((f) => f.path === 'héllo.txt');
  assert.ok(untracked, 'the accented untracked file is reported, not dropped');
  assert.equal(untracked.added, 3);
  assert.ok(
    !d.files.some((f) => f.path.includes('\\303')),
    'no C-quoted escape sequences reach the report'
  );
});

test('a rename reports the post-rename path, never "old => new"', (t) => {
  const dir = repo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'renamed-from.txt'), 'l1\nl2\nl3\nl4\n');
  git(['add', '-A'], dir);
  git(['commit', '-qm', 'file to rename'], dir);
  git(['checkout', '-q', '-b', 'session/abc'], dir);
  git(['mv', 'renamed-from.txt', 'renamed-to.txt'], dir);
  git(['commit', '-qm', 'rename it'], dir);

  const d = worktreeDiff(dir, 'main');
  assert.ok(d);
  assert.ok(d.files.some((f) => f.path === 'renamed-to.txt'), 'the name that exists now');
  assert.ok(!d.files.some((f) => f.path.includes('=>')), 'no arrow pseudo-path');
  assert.ok(!d.files.some((f) => f.path === 'renamed-from.txt'));
});

test('trailer ids parse tolerantly and reject noise', () => {
  assert.deepEqual(
    taskIdsFromMessage('did it\n\nFlowviant-Task: abc-123, def_456\nflowviant-task: #ghi\n'),
    ['abc-123', 'def_456', 'ghi']
  );
  assert.deepEqual(taskIdsFromMessage('mentions Flowviant-Task: x mid-line\nno trailer'), []);
});
