import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkManager } from './work.mjs';

/**
 * THE SESSION PR LANE ADOPTS ONLY A PR INTO THE PROJECT'S BASE.
 *
 * A PR somebody opened by hand from the session branch into `staging` was
 * adopted on Deliver, and Approve then ran `gh pr merge <branch>` — merging the
 * unreviewed branch INTO staging. The agent merge path has refused this since
 * it shipped. A fake `gh` on PATH answers `pr view` with an OPEN PR into
 * `staging` and logs every call, so the test can assert what was NOT run.
 */
const git = (args, cwd) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'fv-prbase-'));
  const origin = mkdtempSync(join(tmpdir(), 'fv-prbase-origin-'));
  const baseDir = mkdtempSync(join(tmpdir(), 'fv-prbase-base-'));
  const bin = mkdtempSync(join(tmpdir(), 'fv-prbase-bin-'));
  t.after(() => {
    for (const d of [dir, origin, baseDir, bin]) rmSync(d, { recursive: true, force: true });
  });
  git(['init', '-q', '--bare'], origin);
  git(['init', '-q', '-b', 'main'], dir);
  git(['config', 'user.email', 't@t.t'], dir);
  git(['config', 'user.name', 'T'], dir);
  writeFileSync(join(dir, 'a.txt'), 'one');
  git(['add', '-A'], dir);
  git(['commit', '-qm', 'base'], dir);
  git(['remote', 'add', 'origin', origin], dir);
  git(['branch', 'session/sess-1'], dir);
  const log = join(bin, 'gh.log');
  const gh = join(bin, 'gh');
  writeFileSync(
    gh,
    `#!/bin/sh
echo "$*" >> "${log}"
case "$1 $2" in
  "pr view") echo '{"url":"https://github.com/o/r/pull/7","state":"OPEN","baseRefName":"staging"}' ;;
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
    getBaseRef: () => 'main',
    getMcpUrl: () => 'http://127.0.0.1:0/mcp',
    getLeaseTtl: () => 60,
  });
  const ghCalls = () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []);
  return { m, ghCalls };
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

const until = async (cond, ms = 5000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
};

for (const kind of ['open', 'merge']) {
  test(`the ${kind} job refuses an open PR that targets another base, and never merges or creates`, async (t) => {
    const { m, ghCalls } = setup(t);
    const calls = stubFetch(t);
    m.processPrJobs([{ id: `pr-${kind}`, sessionId: 'sess-1', kind }]);
    await until(() => calls.some((c) => c.url.includes('pr-done')));
    const settle = calls.find((c) => c.url.includes('pr-done')).body;
    assert.equal(settle.outcome, 'failed');
    assert.match(settle.detail, /targets staging, not main/);
    assert.equal(settle.prUrl, undefined, 'the foreign PR must not be recorded as this delivery');
    const gh = ghCalls();
    assert.ok(gh.some((l) => l.startsWith('pr view')), 'the base was asked');
    assert.ok(!gh.some((l) => l.startsWith('pr merge')), 'nothing is merged into another branch');
    assert.ok(!gh.some((l) => l.startsWith('pr create')));
  });
}
