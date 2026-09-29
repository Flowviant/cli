/**
 * THE AGENT APPROVE PATH IN PR MODE, end to end (review 2026-09-26, F040).
 *
 * `prWorkflow.mjs` holds the GitHub rules both merge paths run, and
 * prBase.test.mjs drives the SESSION lane through them. This drives the
 * AGENT lane — `processAgentMergeJobs` with `prMode` — against a real repo, a
 * real bare remote and a fake `gh` on PATH, so the agent's own sentences and
 * its PR-URL suffixing are exercised rather than source-pinned: a retargeted
 * PR, a refused merge carrying the PR's URL, gh saying yes while the tip is
 * not on base, and the merge that lands.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkManager } from './work.mjs';

const git = (args, cwd) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const PLACE = 'a-ag-p1';
const PR_URL = 'https://github.com/o/r/pull/9';

/**
 * A repo with `main` on a bare origin, and the agent's worktree one commit
 * ahead on `session/<place>`. `gh` answers `auth status`, logs every call, and
 * runs `script` (a shell `case` body over "$1 $2") for everything else.
 */
function setup(t, script) {
  const dir = mkdtempSync(join(tmpdir(), 'fv-agentpr-'));
  const origin = mkdtempSync(join(tmpdir(), 'fv-agentpr-origin-'));
  const baseDir = mkdtempSync(join(tmpdir(), 'fv-agentpr-base-'));
  const bin = mkdtempSync(join(tmpdir(), 'fv-agentpr-bin-'));
  t.after(() => {
    for (const d of [dir, origin, baseDir, bin]) rmSync(d, { recursive: true, force: true });
  });
  git(['init', '-q', '--bare', '-b', 'main'], origin);
  git(['init', '-q', '-b', 'main'], dir);
  git(['config', 'user.email', 't@t.t'], dir);
  git(['config', 'user.name', 'T'], dir);
  writeFileSync(join(dir, 'a.txt'), 'one');
  git(['add', '-A'], dir);
  git(['commit', '-qm', 'base'], dir);
  git(['remote', 'add', 'origin', origin], dir);
  git(['push', '-q', 'origin', 'main'], dir);
  git(['fetch', '-q', 'origin'], dir);
  const wt = join(baseDir, 'sessions', PLACE);
  git(['worktree', 'add', '-q', '-b', `session/${PLACE}`, wt, 'main'], dir);
  writeFileSync(join(wt, 'b.txt'), 'the agent’s work');
  git(['add', '-A'], wt);
  git(['commit', '-qm', 'agent work'], wt);
  const tip = git(['rev-parse', 'HEAD'], wt);

  const log = join(bin, 'gh.log');
  const gh = join(bin, 'gh');
  writeFileSync(
    gh,
    `#!/bin/sh
echo "$*" >> "${log}"
ORIGIN="${origin}"
case "$1 $2" in
  "auth status") exit 0 ;;
${script}
esac
exit 0
`
  );
  chmodSync(gh, 0o755);
  const realPath = process.env.PATH;
  process.env.PATH = `${bin}:${realPath}`;
  t.after(() => {
    process.env.PATH = realPath;
  });
  const m = createWorkManager({
    repoRoot: dir,
    baseDir,
    getBaseRef: () => 'origin/main',
    getMcpUrl: () => 'http://127.0.0.1:0/mcp',
    getLeaseTtl: () => 60,
  });
  const ghCalls = () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []);
  return { m, ghCalls, tip, origin };
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

async function approve(t, script) {
  const ctx = setup(t, script);
  const calls = stubFetch(t);
  ctx.m.processAgentMergeJobs([{ agentId: 'ag-p1', placeId: PLACE, agentName: 'auth', stale: false, prMode: true }]);
  await until(() => calls.some((c) => c.url.includes('agent-merge-done')));
  await until(() => !ctx.m.agentMerges?.size);
  return { ...ctx, settle: calls.find((c) => c.url.includes('agent-merge-done')).body };
}

test('an open PR into another base is refused in the agent’s words, and nothing is merged or created', async (t) => {
  const { settle, ghCalls } = await approve(
    t,
    `  "pr view") echo '{"url":"${PR_URL}","state":"OPEN","baseRefName":"staging"}' ;;`
  );
  assert.equal(settle.ok, false);
  assert.equal(
    settle.detail,
    `the open pull request for session/${PLACE} targets staging, not main — retarget or close it, then approve again`
  );
  // The person's to retarget, never the agent's: no resolve turn (0.108.0).
  assert.equal(settle.fix, 'person');
  const gh = ghCalls();
  assert.ok(gh.some((l) => l.startsWith('pr view')));
  assert.ok(!gh.some((l) => l.startsWith('pr merge')), 'nothing is merged into another branch');
  assert.ok(!gh.some((l) => l.startsWith('pr create')));
});

test('a merge GitHub refuses relays gh’s words and the PR’s URL', async (t) => {
  const { settle, ghCalls } = await approve(
    t,
    `  "pr view") echo 'no pull requests found' >&2; exit 1 ;;
  "pr create") echo 'Creating pull request'; echo '${PR_URL}' ;;
  "pr merge") echo 'X Pull request o/r#9 is not mergeable: the base branch policy prohibits the merge.' >&2; exit 1 ;;`
  );
  assert.equal(settle.ok, false);
  assert.equal(
    settle.detail,
    `X Pull request o/r#9 is not mergeable: the base branch policy prohibits the merge. — the pull request is at ${PR_URL}`
  );
  // Unclassed: a refused merge may be a conflict the agent can resolve.
  assert.equal(settle.fix, undefined);
  const gh = ghCalls();
  assert.ok(gh.includes(`pr create --head session/${PLACE} --base main --fill`), 'created into the base NAME, with --fill');
  assert.ok(gh.includes(`pr merge session/${PLACE} --merge`), 'merged with a merge commit, never squash');
});

test('gh saying yes while the tip is not on base is not a merge', async (t) => {
  const { settle } = await approve(
    t,
    `  "pr view") echo '{"url":"${PR_URL}","state":"OPEN","baseRefName":"main"}' ;;
  "pr merge") exit 0 ;;`
  );
  assert.equal(settle.ok, false);
  assert.match(settle.detail, /^GitHub accepted the merge, but this branch's tip is not on the base branch/);
  assert.ok(settle.detail.endsWith(` The pull request is at ${PR_URL}.`));
});

test('a merge that lands reports the tip', async (t) => {
  // GitHub's merge, played by moving the bare remote's main to the pushed tip.
  const { settle, tip, origin } = await approve(
    t,
    `  "pr view") echo '{"url":"${PR_URL}","state":"OPEN","baseRefName":"main"}' ;;
  "pr merge") git --git-dir="$ORIGIN" update-ref refs/heads/main "refs/heads/session/${PLACE}" || exit 1 ;;`
  );
  assert.deepEqual(settle.ok, true, settle.detail);
  assert.equal(settle.sha, tip);
  assert.equal(git(['rev-parse', 'refs/heads/main'], origin), tip);
});

test('a push the remote refuses is the person’s to fix, never a resolve turn (0.108.0)', async (t) => {
  const ctx = setup(t, '');
  // The remote is gone: every push fails, whatever the branch holds.
  rmSync(ctx.origin, { recursive: true, force: true });
  const calls = stubFetch(t);
  ctx.m.processAgentMergeJobs([{ agentId: 'ag-p1', placeId: PLACE, agentName: 'auth', stale: false, prMode: true }]);
  await until(() => calls.some((c) => c.url.includes('agent-merge-done')));
  await until(() => !ctx.m.agentMerges?.size);
  const settle = calls.find((c) => c.url.includes('agent-merge-done')).body;
  assert.equal(settle.ok, false);
  assert.equal(settle.fix, 'person');
  assert.ok(settle.detail, 'git’s own words are relayed');
});
