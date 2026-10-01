/** Real Git reproduction of a stale approval failing, then succeeding after resolution. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentMergeFailureDetail, createWorkAgentMerges } from './workAgentMerges.mjs';

const git = (args, cwd) => execFileSync('git', args, {
  cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
}).trim();

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'fv-merge-diagnostics-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const origin = join(root, 'origin');
  const repo = join(root, 'repo');
  const baseDir = join(root, 'work');
  git(['init', '--bare', '-q', '-b', 'main', origin], root);
  git(['clone', '-q', origin, repo], root);
  git(['config', 'user.email', 'test@example.com'], repo);
  git(['config', 'user.name', 'Test'], repo);
  writeFileSync(join(repo, 'shared.txt'), 'base\n');
  git(['add', '.'], repo);
  git(['commit', '-qm', 'base'], repo);
  git(['push', '-q', 'origin', 'main'], repo);
  const wt = join(baseDir, 'sessions', 'a-test');
  git(['worktree', 'add', '-q', '-b', 'session/a-test', wt, 'main'], repo);
  const reports = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('agent-merge-done')) reports.push(JSON.parse(opts.body));
    return { json: async () => ({ data: { claimed: true } }) };
  };
  t.after(() => { globalThis.fetch = realFetch; });
  let checks = 0;
  const manager = createWorkAgentMerges({
    repoRoot: repo, baseDir, baseRef: () => 'origin/main',
    inPlace: async (_place, _write, fn) => fn(),
    gitNet: (args) => git(args, repo),
    runReviewEntry: async () => { checks++; },
    onRepoChanged: () => {}, landed: { observe() {} },
    agentRemoteAt: new Map(), agentPublished: new Map(),
  });
  const approve = async () => {
    const previous = reports.length;
    manager.processAgentMergeJobs([{ agentId: 'test', placeId: 'a-test', stale: true }]);
    const deadline = Date.now() + 5000;
    while (manager.agentMerges.size) {
      if (Date.now() > deadline) throw new Error('merge never settled');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(reports.length, previous + 1);
    return reports.at(-1);
  };
  const commit = (cwd, content) => {
    writeFileSync(join(cwd, 'shared.txt'), content);
    git(['add', '.'], cwd);
    git(['commit', '-qm', 'change'], cwd);
  };
  return { repo, wt, approve, commit, checks: () => checks };
}

test('conflict diagnostics survive the stale fold; retry only succeeds after a committed resolution', async (t) => {
  const { repo, wt, approve, commit, checks } = setup(t);
  commit(wt, 'agent\n');
  commit(repo, 'base moved\n');
  git(['push', '-q', 'origin', 'main'], repo);
  const first = await approve();
  assert.equal(first.ok, false);
  assert.equal(first.fix, undefined); // server must still queue merge_resolve
  assert.equal(checks(), 0);
  assert.equal(git(['diff', '--name-only', '--diff-filter=U'], wt), 'shared.txt');
  assert.match(first.detail, /CONFLICT.*shared\.txt/);
  assert.match(first.detail, /Automatic merge failed/);
  // Waiting alone does not resolve Git's index or finish MERGE_HEAD.
  const unchanged = await approve();
  assert.equal(unchanged.ok, false);
  assert.match(unchanged.detail, /unmerged|resolve your current index|not possible/i);
  commit(wt, 'agent and base resolved\n');
  const resolvedTip = git(['rev-parse', 'HEAD'], wt);
  const retried = await approve();
  assert.equal(retried.ok, true);
  assert.equal(checks(), 1);
  git(['fetch', '-q', 'origin'], repo);
  git(['merge-base', '--is-ancestor', resolvedTip, 'origin/main'], repo);
});

test('a stale fold refused over uncommitted edits names the file and preserves those edits', async (t) => {
  const { repo, wt, approve, commit } = setup(t);
  commit(repo, 'base moved\n');
  git(['push', '-q', 'origin', 'main'], repo);
  writeFileSync(join(wt, 'shared.txt'), 'uncommitted\n');
  const refused = await approve();
  assert.equal(refused.ok, false);
  assert.match(refused.detail, /local changes.*overwritten/s);
  assert.match(refused.detail, /shared\.txt/);
  assert.equal(git(['diff', '--name-only'], wt), 'shared.txt');
});


test('diagnostics preserve both streams and bounded non-Git fallbacks', () => {
  assert.equal(agentMergeFailureDetail({ stdout: Buffer.from('CONFLICT in file\n'), stderr: 'fatal: unfinished merge\n', message: 'Command failed' }),
    'CONFLICT in file\nfatal: unfinished merge');
  assert.equal(agentMergeFailureDetail(new Error('worktree unavailable')), 'worktree unavailable');
  assert.equal(agentMergeFailureDetail({ stdout: 'x'.repeat(3000) }).length, 2000);
});
