/**
 * A DEPLOY BUILDS THE BASE COMMIT (audit 2026-09-24), against real git repos.
 *
 * The operator's checkout is left on a feature branch with an uncommitted edit
 * — the state that used to be deployed — and the assertions read what the
 * deploy command actually saw.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDeployCheckout, reportDeployConfig, runDeploy } from './deploy.mjs';

const sh = (args, cwd) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function scene() {
  const root = mkdtempSync(join(tmpdir(), 'fv-deploy-'));
  const origin = join(root, 'origin.git');
  const seed = join(root, 'seed');
  sh(['init', '--bare', '-b', 'main', origin], root);
  sh(['clone', origin, seed], root);
  for (const [k, v] of [['user.email', 't@t'], ['user.name', 't'], ['commit.gpgsign', 'false']]) sh(['config', k, v], seed);
  mkdirSync(join(seed, '.flowviant'));
  const out = join(root, 'deployed.txt');
  const cmd = `cat app.txt > ${JSON.stringify(out)} && (test -e node_modules/dep/marker && echo deps >> ${JSON.stringify(out)} || true) && (cat .env.production >> ${JSON.stringify(out)} 2>/dev/null || true)`;
  writeFileSync(
    join(seed, '.flowviant', 'deploy.json'),
    JSON.stringify({
      targets: [
        {
          id: 'web',
          command: cmd,
          // The env-isolation guard (audit 2026-09-24) refuses a non-prod
          // trigger with no per-env override, so the scenes below that
          // deploy env:'dev' need one that resolves to the same command —
          // this target is meant to be genuinely reachable at that env.
          commands: { dev: cmd },
        },
      ],
    })
  );
  writeFileSync(join(seed, 'app.txt'), 'v1-on-main\n');
  writeFileSync(join(seed, '.gitignore'), 'node_modules\n.env.production\n');
  sh(['add', '-A'], seed);
  sh(['commit', '-m', 'base'], seed);
  sh(['push', 'origin', 'main'], seed);
  // The operator's checkout: a feature branch, an uncommitted edit, and the
  // untracked environment a build needs.
  const repo = join(root, 'repo');
  sh(['clone', origin, repo], root);
  for (const [k, v] of [['user.email', 't@t'], ['user.name', 't'], ['commit.gpgsign', 'false']]) sh(['config', k, v], repo);
  sh(['checkout', '-b', 'feature'], repo);
  writeFileSync(join(repo, 'app.txt'), "OPERATOR'S UNCOMMITTED WIP\n");
  mkdirSync(join(repo, 'node_modules', 'dep'), { recursive: true });
  writeFileSync(join(repo, 'node_modules', 'dep', 'marker'), 'x');
  writeFileSync(join(repo, '.env.production'), 'VITE_API=https://api\n');
  return { root, repo, out, worktreeDir: join(root, 'wt-home') };
}

test('a deploy runs the base tip, not the checkout it was triggered from', async () => {
  const { repo, out, worktreeDir } = scene();
  const res = await runDeploy(
    { id: 'job-1', kind: 'deploy', targetId: 'web', env: 'dev' },
    { repoRoot: repo, baseRef: 'origin/main', worktreeDir }
  );
  assert.equal(res.ok, true, res.message);
  const seen = readFileSync(out, 'utf8');
  assert.match(seen, /^v1-on-main$/m);
  assert.doesNotMatch(seen, /WIP/);
  // …with the checkout's installed deps and env file brought along.
  assert.match(seen, /^deps$/m);
  assert.match(seen, /VITE_API=https:\/\/api/);
  assert.equal(res.sha, sh(['rev-parse', 'origin/main'], repo));
  // The throwaway is gone, and it took nothing of the operator's with it.
  assert.deepEqual(readdirSync(join(worktreeDir, 'deploy')), []);
  assert.ok(existsSync(join(repo, 'node_modules', 'dep', 'marker')));
  assert.equal(readFileSync(join(repo, 'app.txt'), 'utf8'), "OPERATOR'S UNCOMMITTED WIP\n");
  assert.equal(sh(['worktree', 'list', '--porcelain'], repo).split('\n').filter((l) => l.startsWith('worktree ')).length, 1);
});

test('the target is read from the same commit the build runs — an uncommitted deploy.json is not there', async () => {
  const { repo, worktreeDir } = scene();
  writeFileSync(
    join(repo, '.flowviant', 'deploy.json'),
    JSON.stringify({ targets: [{ id: 'evil', command: 'echo pwned' }] })
  );
  const res = await runDeploy(
    { id: 'job-2', kind: 'deploy', targetId: 'evil', env: 'dev' },
    { repoRoot: repo, baseRef: 'origin/main', worktreeDir }
  );
  assert.equal(res.ok, false);
  assert.match(res.message, /not in \.flowviant\/deploy\.json/);
});

test('a corpse from a crashed deploy is cleared without following its node_modules link', async () => {
  const { repo, worktreeDir } = scene();
  const first = await openDeployCheckout({ repoRoot: repo, baseRef: 'origin/main', jobId: 'j', worktreeDir });
  assert.ok(lstatSync(join(first.dir, 'node_modules', 'dep')).isSymbolicLink());
  // No cleanup — the daemon died. The next attempt must clear it safely.
  const second = await openDeployCheckout({ repoRoot: repo, baseRef: 'origin/main', jobId: 'j', worktreeDir });
  assert.equal(second.dir, first.dir);
  assert.ok(existsSync(join(repo, 'node_modules', 'dep', 'marker')));
  second.cleanup();
  assert.ok(existsSync(join(repo, 'node_modules', 'dep', 'marker')));
  assert.equal(existsSync(second.dir), false);
});

test('an unresolvable base deploys nothing and says so', async () => {
  const { repo, worktreeDir } = scene();
  const res = await runDeploy(
    { id: 'job-3', kind: 'deploy', targetId: 'web', env: 'dev' },
    { repoRoot: repo, baseRef: 'origin/nope', worktreeDir }
  );
  assert.equal(res.ok, false);
  assert.match(res.message, /does not resolve/);
});

test("another job's corpse past three hours is swept, the checkout's deps untouched", async () => {
  const { utimesSync } = await import('node:fs');
  const { repo, worktreeDir } = scene();
  const old = await openDeployCheckout({ repoRoot: repo, baseRef: 'origin/main', jobId: 'crashed', worktreeDir });
  const t = (Date.now() - 4 * 60 * 60 * 1000) / 1000;
  utimesSync(old.dir, t, t);
  const fresh = await openDeployCheckout({ repoRoot: repo, baseRef: 'origin/main', jobId: 'next', worktreeDir });
  assert.equal(existsSync(old.dir), false);
  assert.ok(existsSync(join(repo, 'node_modules', 'dep', 'marker')));
  fresh.cleanup();
});

test("a WORKSPACE package resolves to base's copy, never the checkout's working tree (review, audit 2026-09-24)", async () => {
  const { root, repo, worktreeDir } = scene();
  // Base carries packages/shared; the checkout's node_modules links to it the
  // way npm/yarn/pnpm workspaces do, and the operator has an uncommitted edit.
  const seed = join(root, 'seed');
  mkdirSync(join(seed, 'packages', 'shared'), { recursive: true });
  writeFileSync(join(seed, 'packages', 'shared', 'index.js'), 'base-shared\n');
  sh(['add', '-A'], seed);
  sh(['commit', '-m', 'shared'], seed);
  sh(['push', 'origin', 'main'], seed);
  mkdirSync(join(repo, 'packages', 'shared'), { recursive: true });
  writeFileSync(join(repo, 'packages', 'shared', 'index.js'), 'WIP-shared\n');
  mkdirSync(join(repo, 'node_modules', '@x'), { recursive: true });
  symlinkSync('../../packages/shared', join(repo, 'node_modules', '@x', 'shared'));
  symlinkSync('../../packages/only-on-feature', join(repo, 'node_modules', '@x', 'gone'));
  mkdirSync(join(repo, 'packages', 'only-on-feature'), { recursive: true });
  const co = await openDeployCheckout({ repoRoot: repo, baseRef: 'origin/main', jobId: 'ws', worktreeDir });
  try {
    assert.equal(readFileSync(join(co.dir, 'node_modules', '@x', 'shared', 'index.js'), 'utf8'), 'base-shared\n');
    // A package base does not have is left out, not borrowed from the checkout.
    assert.equal(existsSync(join(co.dir, 'node_modules', '@x', 'gone')), false);
    // Third-party deps still come along.
    assert.ok(existsSync(join(co.dir, 'node_modules', 'dep', 'marker')));
  } finally {
    co.cleanup();
  }
  assert.equal(existsSync(co.dir), false);
  assert.equal(readFileSync(join(repo, 'packages', 'shared', 'index.js'), 'utf8'), 'WIP-shared\n');
  assert.ok(existsSync(join(repo, 'node_modules', 'dep', 'marker')));
  assert.ok(lstatSync(join(repo, 'node_modules', '@x', 'shared')).isSymbolicLink());
});

// A8 CROSS 4 (the audit): the server already refuses this at TRIGGER time
// against its own mirror of the file; this is the daemon re-asking the same
// question against the file it is actually about to build and run, which
// closes the window between the two.
function addBareTarget(root) {
  const seed = join(root, 'seed');
  const cfg = JSON.parse(readFileSync(join(seed, '.flowviant', 'deploy.json'), 'utf8'));
  // Only the base `command` — no per-env override at all — is exactly the
  // shape `commands?.[env] || command` would fall back to production for.
  cfg.targets.push({ id: 'bare', command: 'echo THIS IS PROD' });
  writeFileSync(join(seed, '.flowviant', 'deploy.json'), JSON.stringify(cfg));
  sh(['add', '-A'], seed);
  sh(['commit', '-m', 'add a target with no per-env commands'], seed);
  sh(['push', 'origin', 'main'], seed);
}

test('a non-prod deploy with no per-env override refuses rather than falling back to the prod command', async () => {
  const { root, repo, worktreeDir } = scene();
  addBareTarget(root);
  const res = await runDeploy(
    { id: 'job-env-1', kind: 'deploy', targetId: 'bare', env: 'dev' },
    { repoRoot: repo, baseRef: 'origin/main', worktreeDir }
  );
  assert.equal(res.ok, false);
  assert.match(res.message, /declares no dev command/);
  assert.match(res.message, /refusing to fall back to the prod command/);
});

test('a non-prod rollback with no rollback:<env> override refuses rather than running the bare default (which targets prod)', async () => {
  const { root, repo, worktreeDir } = scene();
  addBareTarget(root);
  const res = await runDeploy(
    { id: 'job-env-2', kind: 'rollback', targetId: 'bare', env: 'preview' },
    { repoRoot: repo, baseRef: 'origin/main', worktreeDir }
  );
  assert.equal(res.ok, false);
  assert.match(res.message, /declares no preview command/);
  assert.match(res.message, /refusing to fall back to the prod command/);
});

test('prod is exempt from the env-isolation guard on both deploy and rollback', async () => {
  const { root, repo, worktreeDir } = scene();
  addBareTarget(root);
  const deploy = await runDeploy(
    { id: 'job-env-3', kind: 'deploy', targetId: 'bare', env: 'prod' },
    { repoRoot: repo, baseRef: 'origin/main', worktreeDir }
  );
  assert.equal(deploy.ok, true, deploy.message);
  const rollback = await runDeploy(
    { id: 'job-env-4', kind: 'rollback', targetId: 'bare', env: 'prod' },
    { repoRoot: repo, baseRef: 'origin/main', worktreeDir }
  );
  // No real `npx wrangler` here, so this fails on execution rather than on
  // the guard — the point is that it got PAST the guard.
  assert.doesNotMatch(rollback.message, /refusing to fall back/);
});

test('a target WITH its own per-env override still runs it (the guard only refuses the silent fallback)', async () => {
  const { repo, out, worktreeDir } = scene();
  const res = await runDeploy(
    { id: 'job-env-5', kind: 'deploy', targetId: 'web', env: 'dev' },
    { repoRoot: repo, baseRef: 'origin/main', worktreeDir }
  );
  assert.equal(res.ok, true, res.message);
  assert.match(readFileSync(out, 'utf8'), /^v1-on-main$/m);
});

test('reportDeployConfig normalizes a numeric-string healthStatus and omits empty label/healthcheck/build', async () => {
  const { root, repo } = scene();
  const seed = join(root, 'seed');
  writeFileSync(
    join(seed, '.flowviant', 'deploy.json'),
    JSON.stringify({
      targets: [
        { id: 'web', command: 'wrangler deploy', label: '', build: null, healthcheck: '', healthStatus: '200' },
      ],
    })
  );
  sh(['add', '-A'], seed);
  sh(['commit', '-m', 'lenient target'], seed);
  sh(['push', 'origin', 'main'], seed);
  // readDeployConfig reads the LOCAL origin/main ref (no fetch of its own,
  // unlike openDeployCheckout) — the checkout has to be told the new commit
  // exists before reportDeployConfig can see it.
  sh(['fetch', 'origin'], repo);

  const posted = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    posted.push(JSON.parse(opts.body));
    return { ok: true, json: async () => ({ success: true, data: { targets: 1 } }) };
  };
  try {
    await reportDeployConfig(repo, 'origin/main');
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(posted.length, 1);
  const target = posted[0].targets.find((t) => t.id === 'web');
  assert.equal(target.healthStatus, 200);
  assert.equal('label' in target, false);
  assert.equal('build' in target, false);
  assert.equal('healthcheck' in target, false);
});

test('reportDeployConfig warns once per changed config on a rejected target, and still remembers the report so it does not re-post the same file', async () => {
  const { root, repo } = scene();
  const seed = join(root, 'seed');
  writeFileSync(
    join(seed, '.flowviant', 'deploy.json'),
    JSON.stringify({ targets: [{ id: 'bad', command: 'echo hi', healthStatus: 'not-a-number' }] })
  );
  sh(['add', '-A'], seed);
  sh(['commit', '-m', 'rejectable target'], seed);
  sh(['push', 'origin', 'main'], seed);
  sh(['fetch', 'origin'], repo);

  const posted = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    posted.push(JSON.parse(opts.body));
    return {
      ok: true,
      json: async () => ({
        success: true,
        data: { targets: 1, rejected: [{ id: 'bad', reason: 'healthStatus: expected a number' }] },
      }),
    };
  };
  const logged = [];
  const realLog = console.log;
  console.log = (...args) => logged.push(args.join(' '));
  try {
    await reportDeployConfig(repo, 'origin/main');
    await reportDeployConfig(repo, 'origin/main'); // the same file — must not re-post or re-warn
  } finally {
    globalThis.fetch = realFetch;
    console.log = realLog;
  }
  assert.equal(posted.length, 1);
  assert.equal(posted[0].targets[0].id, 'bad');
  const warnings = logged.filter((l) => l.includes('"bad"') && l.includes('healthStatus'));
  assert.equal(warnings.length, 1);
});
