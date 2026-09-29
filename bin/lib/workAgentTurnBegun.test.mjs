import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { begunTurnRefusal } from './workAgentTurnBegun.mjs';

/**
 * THE BEGUN-GUARD ON ITS OWN (workAgentTurnBegun.mjs, split out by SOLID F036).
 *
 * The lane's round trips (work.test.mjs) reach it through a whole manager;
 * these cases drive each of its measurements directly against a real repo:
 * the directory, the branch ref's three states, and the published fallback.
 */
const git = (args, cwd) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function setup(t) {
  const repoRoot = mkdtempSync(join(tmpdir(), 'fv-begun-'));
  const baseDir = mkdtempSync(join(tmpdir(), 'fv-begun-base-'));
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
  return { repoRoot, baseDir };
}
const noFetch = () => null;

test('a begun turn with neither directory nor branch here is refused, naming only what was recorded', (t) => {
  const { repoRoot, baseDir } = setup(t);
  const deps = { repoRoot, baseDir, fetchPublishedBranch: noFetch };
  assert.equal(
    begunTurnRefusal({ begun: true }, 'a-1', deps),
    "This machine does not hold this agent's worktree or branch. Stop the agent to re-plan it here."
  );
  assert.equal(
    begunTurnRefusal({ begun: true, begunOn: '  box-b  ' }, 'a-1', deps),
    "This machine does not hold this agent's worktree or branch — its work is on box-b. Stop the agent to re-plan it here."
  );
});

test('the directory alone, or the branch alone, is enough to continue', (t) => {
  const { repoRoot, baseDir } = setup(t);
  const deps = { repoRoot, baseDir, fetchPublishedBranch: noFetch };
  mkdirSync(join(baseDir, 'sessions', 'a-dir'), { recursive: true });
  assert.equal(begunTurnRefusal({ begun: true }, 'a-dir', deps), null);
  git(['branch', 'session/a-br'], repoRoot);
  assert.equal(begunTurnRefusal({ begun: true }, 'a-br', deps), null);
});

test('an unreadable repo is not an absent branch: the guard stands down', (t) => {
  const { baseDir } = setup(t);
  const notARepo = mkdtempSync(join(tmpdir(), 'fv-begun-none-'));
  t.after(() => rmSync(notARepo, { recursive: true, force: true }));
  assert.equal(begunTurnRefusal({ begun: true }, 'a-1', { repoRoot: notARepo, baseDir, fetchPublishedBranch: noFetch }), null);
});

test('published work is fetched instead of refused, and a failed fetch says how it went', (t) => {
  const { repoRoot, baseDir } = setup(t);
  const asked = [];
  const ok = (place, ref) => {
    asked.push([place, ref]);
    return { ok: true };
  };
  assert.equal(begunTurnRefusal({ begun: true, publishedRef: 'flowviant/x' }, 'a-1', { repoRoot, baseDir, fetchPublishedBranch: ok }), null);
  assert.deepEqual(asked, [['a-1', 'flowviant/x']]);
  const failed = () => ({ ok: false, why: 'remote hung up' });
  assert.equal(
    begunTurnRefusal({ begun: true }, 'a-1', { repoRoot, baseDir, fetchPublishedBranch: failed }),
    "This machine does not hold this agent's worktree or branch. Stop the agent to re-plan it here. Its published branch could not be fetched (remote hung up)."
  );
});

/** ONE HOME: nothing else in the agent-turn lane re-reads the session ref. */
test('the begun measurement has one home', () => {
  const dir = new URL('.', import.meta.url);
  const files = readdirSync(dir).filter((f) => /^workAgentTurn\w*\.mjs$/.test(f));
  assert.ok(files.includes('workAgentTurnBegun.mjs') && files.includes('workAgentTurnExecution.mjs'), 'canary: the walk sees the lane');
  const holders = files.filter((f) => readFileSync(new URL(f, dir), 'utf8').includes('refs/heads/session/${place}'));
  assert.deepEqual(holders, ['workAgentTurnBegun.mjs']);
});
