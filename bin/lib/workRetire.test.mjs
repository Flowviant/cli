import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkRetire } from './workRetire.mjs';

/**
 * THE MANAGER'S DISK HYGIENE against a real repository (split out of work.mjs
 * 2026-09-26, SOLID F037): what is held, what a closed tab gives back, what a
 * peer keeps, and what fast-forwarding a manual place may and may not touch.
 */
const git = (args, cwd) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function setup(t, over = {}) {
  const repoRoot = mkdtempSync(join(tmpdir(), 'fv-retire-'));
  const baseDir = mkdtempSync(join(tmpdir(), 'fv-retire-base-'));
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
  mkdirSync(join(baseDir, 'sessions'));
  const cut = (id) => {
    const wt = join(baseDir, 'sessions', id);
    git(['worktree', 'add', '-q', '-b', `session/${id}`, wt, 'main'], repoRoot);
    return wt;
  };
  const swept = [];
  const deps = {
    repoRoot,
    baseDir,
    baseRef: () => 'main',
    placeOf: (id) => id,
    placeLocks: new Map(),
    shipping: new Set(),
    workTokens: new Map(),
    agentChildren: new Map(),
    sweepMergedSessionBranch: (id) => swept.push(id),
    ...over,
  };
  return { ...createWorkRetire(deps), deps, cut, swept, repoRoot, baseDir };
}

test('a closed tab\'s clean worktree is returned — the branch is left to the sweep — and dirty, live, peer and busy ones stay', (t) => {
  const { retireWorkSessions, heldSessionIds, deps, cut, swept } = setup(t);
  const closed = cut('closed');
  const dirty = cut('dirty');
  writeFileSync(join(dirty, 'wip.txt'), 'mine');
  const live = cut('live');
  const peer = cut('peer');
  const busy = cut('busy');
  deps.workTokens.set('peer', { token: 'x' });
  deps.workTokens.set('closed', { token: 'y' });
  deps.placeLocks.set('busy', {});
  assert.deepEqual(heldSessionIds().sort(), ['busy', 'closed', 'dirty', 'live', 'peer']);
  retireWorkSessions(['live'], ['peer']);
  assert.equal(existsSync(closed), false);
  assert.deepEqual(swept, ['closed'], 'the branch is judged once its worktree is gone');
  assert.equal(deps.workTokens.has('closed'), false);
  assert.equal(deps.workTokens.has('peer'), false, 'a peer-held token is dropped so the next turn meets the mint');
  for (const kept of [dirty, live, peer, busy]) assert.ok(existsSync(kept), kept);
});

test('absence of the list is an older server, not a close', (t) => {
  const { retireWorkSessions, cut } = setup(t);
  const wt = cut('s1');
  retireWorkSessions(undefined);
  assert.ok(existsSync(wt));
});

test('a stopped agent\'s running CLI is SIGTERMed as its place drops out of the live list', (t) => {
  const signals = [];
  const { retireWorkSessions, deps, cut } = setup(t);
  cut('a-stop');
  deps.agentChildren.set('a-stop', { kill: (s) => signals.push(s) });
  retireWorkSessions([]);
  assert.deepEqual(signals, ['SIGTERM']);
  assert.equal(deps.agentChildren.has('a-stop'), false);
});

test('a person\'s clean manual place fast-forwards to base; a diverged, dirty or agent place is left alone', (t) => {
  const { freshenManualPlaces, cut, repoRoot } = setup(t);
  const clean = cut('u-alice');
  const diverged = cut('u-bob');
  writeFileSync(join(diverged, 'b.txt'), 'bob');
  git(['add', '-A'], diverged);
  git(['commit', '-qm', 'bob'], diverged);
  const bobTip = git(['rev-parse', 'HEAD'], diverged);
  const dirty = cut('u-carol');
  writeFileSync(join(dirty, 'a.txt'), 'uncommitted');
  const agent = cut('a-agent');
  writeFileSync(join(repoRoot, 'c.txt'), 'new on main');
  git(['add', '-A'], repoRoot);
  git(['commit', '-qm', 'main moves'], repoRoot);
  const main = git(['rev-parse', 'HEAD'], repoRoot);
  freshenManualPlaces();
  assert.equal(git(['rev-parse', 'HEAD'], clean), main);
  assert.equal(git(['rev-parse', 'HEAD'], diverged), bobTip, 'their commits are theirs');
  assert.notEqual(git(['rev-parse', 'HEAD'], dirty), main, 'uncommitted work outranks freshness');
  assert.notEqual(git(['rev-parse', 'HEAD'], agent), main, 'an agent branch is the reviewable unit');
});
