/**
 * `readDeployConfig` — the one reader of `.flowviant/deploy.json` — against a
 * real git repo. It reads the COMMITTED file at the ref it is handed and
 * nothing else; every way of not having a usable file is "no targets".
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readDeployConfig } from './deployConfig.mjs';

const sh = (args, cwd) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function repoWith(deployJson) {
  const repo = mkdtempSync(join(tmpdir(), 'fv-deploy-config-'));
  sh(['init', '-b', 'main'], repo);
  for (const [k, v] of [['user.email', 't@t'], ['user.name', 't'], ['commit.gpgsign', 'false']]) sh(['config', k, v], repo);
  writeFileSync(join(repo, 'README'), 'x\n');
  if (deployJson !== undefined) {
    mkdirSync(join(repo, '.flowviant'));
    writeFileSync(join(repo, '.flowviant', 'deploy.json'), deployJson);
  }
  sh(['add', '-A'], repo);
  sh(['commit', '-m', 'base'], repo);
  return repo;
}

const quietly = (fn) => {
  const real = console.log;
  console.log = () => {};
  try {
    return fn();
  } finally {
    console.log = real;
  }
};

test('keeps only targets with a string id and command, at most twenty', () => {
  const targets = [
    { id: 'web', command: 'wrangler deploy' },
    { id: 'no-command' },
    { command: 'no id' },
    null,
    ...Array.from({ length: 25 }, (_, i) => ({ id: `t${i}`, command: 'echo' })),
  ];
  const repo = repoWith(JSON.stringify({ targets }));
  const got = readDeployConfig(repo, 'main');
  assert.equal(got.length, 20);
  assert.deepEqual(got[0], { id: 'web', command: 'wrangler deploy' });
  assert.ok(got.every((t) => typeof t.id === 'string' && typeof t.command === 'string'));
});

test('reads the committed file, never an uncommitted edit over it', () => {
  const repo = repoWith(JSON.stringify({ targets: [{ id: 'web', command: 'wrangler deploy' }] }));
  writeFileSync(join(repo, '.flowviant', 'deploy.json'), JSON.stringify({ targets: [{ id: 'evil', command: 'echo pwned' }] }));
  assert.deepEqual(readDeployConfig(repo, 'main').map((t) => t.id), ['web']);
});

test('no file, an unresolvable ref, no ref at all or invalid JSON all mean no targets', () => {
  assert.deepEqual(readDeployConfig(repoWith(undefined), 'main'), []);
  const repo = repoWith(JSON.stringify({ targets: [{ id: 'web', command: 'x' }] }));
  assert.deepEqual(readDeployConfig(repo, 'origin/nope'), []);
  assert.deepEqual(quietly(() => readDeployConfig(repo, null)), []);
  assert.deepEqual(quietly(() => readDeployConfig(repoWith('{ not json'), 'main')), []);
  assert.deepEqual(readDeployConfig(repoWith(JSON.stringify({ targets: 'nope' })), 'main'), []);
});
