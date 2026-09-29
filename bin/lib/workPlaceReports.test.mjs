import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkPlaceReports } from './workPlaceReports.mjs';

/**
 * THE WORKTREE READOUT, driven directly (split out of work.mjs 2026-09-26,
 * SOLID F037) against real worktrees and a recording wire: the sweep measures
 * every live place in chunks of the endpoint's twenty, a first sight jumps the
 * throttle, and the publish records are bounded to the live set.
 */
const git = (args, cwd) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function setup(t) {
  const repoRoot = mkdtempSync(join(tmpdir(), 'fv-reports-'));
  const baseDir = mkdtempSync(join(tmpdir(), 'fv-reports-base-'));
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
  const placeDir = (id) => join(baseDir, 'sessions', id);
  const cut = (id) => git(['worktree', 'add', '-q', '-b', `session/${id}`, placeDir(id), 'main'], repoRoot);
  const real = globalThis.fetch;
  const posts = [];
  globalThis.fetch = async (url, opts = {}) => {
    posts.push({ url: String(url), body: JSON.parse(opts.body) });
    return { ok: true, status: 200 };
  };
  t.after(() => {
    globalThis.fetch = real;
  });
  const pushed = [];
  const pruned = [];
  const agentPublished = new Map();
  const agentRemoteAt = new Map();
  const reports = createWorkPlaceReports({
    repoRoot,
    baseRef: () => 'main',
    placeOf: (id) => id,
    placeDir,
    sessionMetaPath: () => null,
    sessionProcesses: () => null,
    pruneSessionGroups: (ids) => pruned.push(ids),
    agentPublished,
    agentRemoteAt,
    publishAgentBranch: async (id, ref) => void pushed.push([id, ref]),
    landed: { observe: async () => {} },
  });
  return { ...reports, cut, posts, pushed, pruned, agentPublished, agentRemoteAt };
}
const until = async (cond, ms = 5000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
};

test('the sweep measures every live place, twenty to a request, and keeps a known publication current', async (t) => {
  const s = setup(t);
  const ids = Array.from({ length: 21 }, (_, i) => `sess-${String(i).padStart(2, '0')}`);
  for (const id of ids) s.cut(id);
  s.agentPublished.set('sess-03', { ref: 'flowviant/x-3f9a21', sha: 'abc' });
  s.agentPublished.set('a-gone', { ref: 'flowviant/y-3f9a21', sha: 'def' });
  s.agentRemoteAt.set('a-gone', { ref: 'flowviant/y-3f9a21', sha: 'def' });
  s.reportWorktrees(ids);
  await until(() => s.posts.length === 2);
  assert.ok(s.posts.every((p) => p.url.endsWith('/session-worktrees')));
  assert.deepEqual(s.posts.map((p) => p.body.reports.length), [20, 1]);
  assert.deepEqual(s.posts.flatMap((p) => p.body.reports.map((r) => r.sessionId)), ids);
  const one = s.posts[0].body.reports[0];
  assert.equal(one.listeningSupported !== undefined && one.processesSupported !== undefined, true);
  assert.equal('box' in one, false, 'a tab report names no box');
  assert.deepEqual(s.pushed, [['sess-03', 'flowviant/x-3f9a21']]);
  assert.equal(s.agentPublished.has('a-gone'), false, 'an agent the roster stopped naming is forgotten');
  assert.equal(s.agentRemoteAt.has('a-gone'), false);
  assert.deepEqual(s.pruned, [ids]);
});

test('inside the throttle nothing is re-measured, but a place seen for the first time jumps it', async (t) => {
  const s = setup(t);
  s.cut('old');
  s.reportWorktrees(['old']);
  await until(() => s.posts.length === 1);
  s.reportWorktrees(['old']);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(s.posts.length, 1, 'throttled');
  s.cut('new');
  s.reportWorktrees(['old', 'new']);
  await until(() => s.posts.length === 2);
  assert.deepEqual(s.posts[1].body.reports.map((r) => r.sessionId), ['old', 'new']);
  s.reportWorktrees([]); // nothing live is nothing to do
  assert.equal(s.posts.length, 2);
});

test('a place with no worktree reports nothing; one that exists reports itself', async (t) => {
  const s = setup(t);
  s.cut('here');
  await s.reportSessionWorktree('nowhere');
  assert.equal(s.posts.length, 0, 'unmeasured renders nothing — no empty report');
  await s.reportSessionWorktree('here');
  assert.deepEqual(s.posts[0].body.reports.map((r) => r.sessionId), ['here']);
});
