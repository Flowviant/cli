import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createWorkPlaces, REPO_PLACE } from './workPlaces.mjs';

/**
 * WHERE A SESSION WORKS, driven directly (split out of work.mjs 2026-09-26,
 * SOLID F037) against a real repository: the place map's trust boundary, the
 * directory it resolves to, the worktree cut, and the per-tab marker path.
 */
const git = (args, cwd) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function setup(t) {
  const repoRoot = mkdtempSync(join(tmpdir(), 'fv-places-'));
  const baseDir = mkdtempSync(join(tmpdir(), 'fv-places-base-'));
  t.after(() => {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(baseDir, { recursive: true, force: true });
  });
  git(['init', '-q', '-b', 'main'], repoRoot);
  git(['config', 'user.email', 't@t.t'], repoRoot);
  git(['config', 'user.name', 'T'], repoRoot);
  writeFileSync(join(repoRoot, 'a.txt'), 'one');
  git(['add', '-A'], repoRoot);
  git(['commit', '-qm', 'base'], repoRoot);
  let repoChanged = 0;
  const places = createWorkPlaces({ repoRoot, baseDir, baseRef: () => 'main', onRepoChanged: () => (repoChanged += 1) });
  return { ...places, repoRoot, baseDir, repoChanged: () => repoChanged };
}

test('the roster map is validated at the boundary, and an explicit null unlearns', (t) => {
  const { learnPlaces, placeOf, placeDir, repoRoot, baseDir } = setup(t);
  assert.equal(REPO_PLACE, 'repo', 'a wire value, never a local convention');
  learnPlaces({ s1: 'repo', s2: 'u-alice', s3: '../../etc' });
  assert.equal(placeOf('s1'), 'repo');
  assert.equal(placeDir('s1'), repoRoot, 'the checkout is the checkout');
  assert.equal(placeDir('s2'), join(baseDir, 'sessions', 'u-alice'));
  assert.equal(placeOf('s3'), 's3', 'a traversal is never stored; the default place stands');
  learnPlaces({ s1: null });
  assert.equal(placeDir('s1'), join(baseDir, 'sessions', 's1'), 'null means its own worktree again');
  learnPlaces(undefined); // an older server said nothing
  assert.equal(placeOf('s2'), 'u-alice', 'absence changes nothing');
});

test('a fresh place is cut on its own branch off base; the second ask attaches, and the checkout is never cut', (t) => {
  const { placeWtFor, repoRoot, baseDir } = setup(t);
  assert.deepEqual(placeWtFor(REPO_PLACE), { wt: repoRoot, fresh: false });
  assert.equal(placeWtFor('../x'), null);
  const first = placeWtFor('sess-1');
  assert.deepEqual(first, { wt: join(baseDir, 'sessions', 'sess-1'), fresh: true });
  assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD'], first.wt), 'session/sess-1');
  assert.deepEqual(placeWtFor('sess-1'), { wt: first.wt, fresh: false });
  // A retired directory whose branch survives re-attaches to the branch.
  git(['worktree', 'remove', first.wt], repoRoot);
  const again = placeWtFor('sess-1');
  assert.equal(again.fresh, true);
  assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD'], again.wt), 'session/sess-1');
});

test('a repository with no commits says so in words', (t) => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'fv-places-empty-'));
  const baseDir = mkdtempSync(join(tmpdir(), 'fv-places-empty-base-'));
  t.after(() => {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(baseDir, { recursive: true, force: true });
  });
  git(['init', '-q', '-b', 'main'], repoRoot);
  const { placeWtFor } = createWorkPlaces({ repoRoot, baseDir, baseRef: () => 'main', onRepoChanged: () => {} });
  assert.equal(placeWtFor('sess-1'), null);
  assert.match(placeWtFor.lastError, /has no commits yet/);
});

test('a per-tab marker lives in the worktree\'s private git dir, scoped by a safe id only', (t) => {
  const { placeWtFor, sessionMetaPath } = setup(t);
  const { wt } = placeWtFor('sess-2');
  const scoped = sessionMetaPath(wt, 'flowviant-runtime', 'sess-2');
  assert.equal(scoped.endsWith('flowviant-runtime-sess-2'), true);
  assert.ok(realpathSync(dirname(scoped)).includes(join('.git', 'worktrees')), 'invisible to git status');
  assert.ok(sessionMetaPath(wt, 'flowviant-turn.lock').endsWith('flowviant-turn.lock'), 'the lock is per place');
  assert.ok(sessionMetaPath(wt, 'm', '../x').endsWith('/m'), 'an unsafe scope is dropped, not joined');
  assert.equal(sessionMetaPath(join(wt, 'nope'), 'm', 's'), null);
  assert.equal(existsSync(scoped), false, 'a path, not a write');
});
