/**
 * WHOSE FIX A FAILED MERGE IS (0.108.0) — through the real merge job.
 *
 * On a repository with no remote the merge lands on the base in the project
 * folder itself, and is refused while that checkout has uncommitted changes
 * (`shipMerge.mjs`, a 2026-09-25 ruling). Nothing on the agent's branch is
 * wrong then, so the report says `fix: 'person'` and the server queues no
 * merge-resolve turn — the agent cannot commit somebody else's checkout.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkManager } from './work.mjs';

const git = (args, cwd) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const PLACE = 'a-ag-fix';

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'fv-agentfix-'));
  const baseDir = mkdtempSync(join(tmpdir(), 'fv-agentfix-base-'));
  t.after(() => {
    for (const d of [dir, baseDir]) rmSync(d, { recursive: true, force: true });
  });
  git(['init', '-q', '-b', 'main'], dir);
  git(['config', 'user.email', 't@t.t'], dir);
  git(['config', 'user.name', 'T'], dir);
  writeFileSync(join(dir, 'a.txt'), 'one');
  git(['add', '-A'], dir);
  git(['commit', '-qm', 'base'], dir);
  const wt = join(baseDir, 'sessions', PLACE);
  git(['worktree', 'add', '-q', '-b', `session/${PLACE}`, wt, 'main'], dir);
  writeFileSync(join(wt, 'b.txt'), 'the agent’s work');
  git(['add', '-A'], wt);
  git(['commit', '-qm', 'agent work'], wt);
  const m = createWorkManager({
    repoRoot: dir,
    baseDir,
    getBaseRef: () => 'main',
    getMcpUrl: () => 'http://127.0.0.1:0/mcp',
    getLeaseTtl: () => 60,
  });
  return { m, dir };
}

function stubFetch(t) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), body: typeof opts.body === 'string' ? JSON.parse(opts.body) : null });
    return { ok: true, status: 200, json: async () => ({ data: { claimed: true } }) };
  };
  t.after(() => {
    globalThis.fetch = real;
  });
  return calls;
}

const until = async (cond, ms = 15_000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
};

async function approve(t, dirty) {
  const ctx = setup(t);
  if (dirty) writeFileSync(join(ctx.dir, 'a.txt'), 'edited, not committed');
  const calls = stubFetch(t);
  ctx.m.processAgentMergeJobs([{ agentId: 'ag-fix', placeId: PLACE, agentName: 'fix', stale: false }]);
  await until(() => calls.some((c) => c.url.includes('agent-merge-done')));
  await until(() => !ctx.m.agentMerges?.size);
  return { ...ctx, settle: calls.find((c) => c.url.includes('agent-merge-done')).body };
}

test('no remote and a dirty checkout: refused in words, and it is the person’s fix', async (t) => {
  const { settle, dir } = await approve(t, true);
  assert.equal(settle.ok, false);
  assert.match(settle.detail, /no remote.*uncommitted changes.*approve again/);
  assert.equal(settle.fix, 'person');
  // Nothing moved under the person's edits.
  assert.equal(git(['log', '--format=%s', '-1', 'main'], dir), 'base');
});

test('no remote and a clean checkout: the merge lands on the local base', async (t) => {
  const { settle, dir } = await approve(t, false);
  assert.equal(settle.ok, true);
  assert.equal(settle.fix, undefined);
  assert.match(git(['log', '--format=%s', '-1', 'main'], dir), /^ship\(fix\): 1 commit/);
});
