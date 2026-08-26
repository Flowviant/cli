import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sweepMergedBranch } from './shipSweep.mjs';

/**
 * A REAL REPO, not a mock. This function DELETES REFS, and the properties that
 * make it safe — `-d` refusing an unmerged branch, `-d` refusing one checked
 * out in a worktree — are git's behaviour rather than ours. A mocked `git`
 * would assert our beliefs about git instead of testing them.
 */
const git = (args, cwd) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'fv-sweep-'));
  git(['init', '-q', '-b', 'main'], dir);
  git(['config', 'user.email', 't@t.t'], dir);
  git(['config', 'user.name', 'T'], dir);
  writeFileSync(join(dir, 'a.txt'), 'one');
  git(['add', '-A'], dir);
  git(['commit', '-qm', 'base'], dir);
  return dir;
}

/** A session branch with one commit on it. */
function branchWithWork(dir, id, file = `${id}.txt`) {
  git(['checkout', '-q', '-b', `session/${id}`], dir);
  writeFileSync(join(dir, file), 'work');
  git(['add', '-A'], dir);
  git(['commit', '-qm', `work on ${id}`], dir);
  git(['checkout', '-q', 'main'], dir);
}

const refs = (dir) => git(['branch', '--format=%(refname:short)'], dir).split('\n').filter(Boolean);
const sweep = (dir, id, over = {}) =>
  sweepMergedBranch(id, { git, repoRoot: dir, baseRef: 'main', note: () => {}, ...over });

test('a merged session branch is retired', (t) => {
  const dir = repo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  branchWithWork(dir, 'abc');
  git(['merge', '--no-ff', '--no-edit', '-q', 'session/abc'], dir);
  assert.equal(sweep(dir, 'abc'), true);
  assert.ok(!refs(dir).includes('session/abc'));
});

test('an UNMERGED session branch survives — git refuses, and git is right', (t) => {
  const dir = repo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  branchWithWork(dir, 'abc');
  // Never merged. The commit exists nowhere else; deleting is losing work.
  assert.equal(sweep(dir, 'abc'), false);
  assert.ok(refs(dir).includes('session/abc'));
});

test('a branch CHECKED OUT in a worktree survives, merged or not', (t) => {
  const dir = repo();
  const wt = join(dir, '..', `wt-${Date.now()}`);
  t.after(() => {
    try {
      git(['worktree', 'remove', '--force', wt], dir);
    } catch {
      /* gone */
    }
    rmSync(dir, { recursive: true, force: true });
  });
  branchWithWork(dir, 'abc');
  git(['merge', '--no-ff', '--no-edit', '-q', 'session/abc'], dir);
  git(['worktree', 'add', '-q', wt, 'session/abc'], dir);
  // Merged, so it holds nothing — but somebody is standing in it. This is the
  // live-tab case, and git enforces it without us tracking liveness.
  assert.equal(sweep(dir, 'abc'), false);
  assert.ok(refs(dir).includes('session/abc'));
});

test('a branch we did not create is never in scope', (t) => {
  const dir = repo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  git(['checkout', '-q', '-b', 'feature/x'], dir);
  writeFileSync(join(dir, 'x.txt'), 'x');
  git(['add', '-A'], dir);
  git(['commit', '-qm', 'x'], dir);
  git(['checkout', '-q', 'main'], dir);
  git(['merge', '--no-ff', '--no-edit', '-q', 'feature/x'], dir);
  // Merged and unoccupied — every git-level condition met. It survives because
  // the NAME is not ours, which is the one condition git cannot judge.
  assert.equal(sweep(dir, 'feature/x'), false);
  assert.ok(refs(dir).includes('feature/x'));
});

test('AN UNDELIVERED SHIP REPORT BLOCKS THE SWEEP', (t) => {
  const dir = repo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  branchWithWork(dir, 'abc');
  git(['merge', '--no-ff', '--no-edit', '-q', 'session/abc'], dir);
  // Ship's idempotency path recovers from a lost report by asking
  // `branchExists && ancestorOfBase(branch)`. Delete the branch first and a
  // re-offered job answers "nothing to ship — this session has no branch on
  // this machine" for work that shipped, and the reconciliation backstop
  // silently never books the commits no card claimed.
  assert.equal(sweep(dir, 'abc', { isReportPending: () => true }), false);
  assert.ok(refs(dir).includes('session/abc'));
  // …and the moment it lands, the same call succeeds.
  assert.equal(sweep(dir, 'abc', { isReportPending: () => false }), true);
});

test('a path-shaped id is refused before it reaches git', (t) => {
  const dir = repo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const bad of ['../../etc', 'a/b', '', null, 'x'.repeat(200)]) {
    assert.equal(sweep(dir, bad), false);
  }
});

test('a branch that is already gone is a no-op, not a throw', (t) => {
  const dir = repo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(sweep(dir, 'never-existed'), false);
});
