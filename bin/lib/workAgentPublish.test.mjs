import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkAgentPublish } from './workAgentPublish.mjs';
import { gitNet as gitNetIn } from './git.mjs';

/**
 * PUBLISHING AN AGENT'S BRANCH against a real bare remote (split out of
 * work.mjs 2026-09-26, SOLID F037). work.test.mjs holds the lane-level cases
 * (the settle, the begun-guard continue); these pin the module's records.
 */
const git = (args, cwd) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function setup(t) {
  const repoRoot = mkdtempSync(join(tmpdir(), 'fv-pub-'));
  const bare = mkdtempSync(join(tmpdir(), 'fv-pub-origin-'));
  t.after(() => {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(bare, { recursive: true, force: true });
  });
  git(['init', '-q', '--bare', '-b', 'main'], bare);
  git(['init', '-q', '-b', 'main'], repoRoot);
  git(['config', 'user.email', 't@t.t'], repoRoot);
  git(['config', 'user.name', 'T'], repoRoot);
  writeFileSync(join(repoRoot, 'a.txt'), 'one');
  git(['add', '-A'], repoRoot);
  git(['commit', '-qm', 'base'], repoRoot);
  git(['remote', 'add', 'origin', bare], repoRoot);
  git(['push', '-q', 'origin', 'main'], repoRoot);
  const pub = createWorkAgentPublish({ repoRoot, gitNet: (args, ms) => gitNetIn(args, repoRoot, ms) });
  return { ...pub, repoRoot, bare };
}

test('a push lands at the server\'s name, is recorded once, and a repeat is not news', async (t) => {
  const { publishAgentBranch, agentPublished, agentRemoteAt, repoRoot, bare } = setup(t);
  assert.equal(await publishAgentBranch('a-p1', 'flowviant/p1-3f9a21'), false, 'no local branch, nothing to publish');
  assert.equal(agentPublished.has('a-p1'), false);
  git(['branch', 'session/a-p1', 'main'], repoRoot);
  const sha = git(['rev-parse', 'session/a-p1'], repoRoot);
  assert.equal(await publishAgentBranch('a-p1', 'flowviant/p1-3f9a21'), true);
  assert.equal(git(['rev-parse', 'refs/heads/flowviant/p1-3f9a21'], bare), sha);
  assert.deepEqual(agentPublished.get('a-p1'), { ref: 'flowviant/p1-3f9a21', sha });
  assert.deepEqual(agentRemoteAt.get('a-p1'), { ref: 'flowviant/p1-3f9a21', sha });
  assert.equal(await publishAgentBranch('a-p1', 'flowviant/p1-3f9a21'), false, 'already there');
  assert.equal(await publishAgentBranch('a-p1', 'main'), false, 'a name not of the server\'s shape never reaches argv');
});

test('a fetch brings a published branch back only once the branch is measured here', (t) => {
  const { fetchPublishedBranch, agentRemoteAt, repoRoot } = setup(t);
  assert.equal(fetchPublishedBranch('a-f1', 'not/a-publish-ref'), null, 'nothing to try');
  const failed = fetchPublishedBranch('a-f1', 'flowviant/missing-3f9a21');
  assert.equal(failed.ok, false);
  assert.ok(failed.why.length > 0, 'relayed in git\'s own words');
  git(['push', '-q', 'origin', 'main:refs/heads/flowviant/f1-3f9a21'], repoRoot);
  assert.deepEqual(fetchPublishedBranch('a-f1', 'flowviant/f1-3f9a21'), { ok: true });
  const sha = git(['rev-parse', 'session/a-f1'], repoRoot);
  assert.deepEqual(agentRemoteAt.get('a-f1'), { ref: 'flowviant/f1-3f9a21', sha }, 'a sighting the next push leases against');
});
