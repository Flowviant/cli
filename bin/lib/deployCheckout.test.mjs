/**
 * `linkCheckoutEnvironment` — what of the operator's untracked environment a
 * deploy worktree gets. Plain directories stand in for the checkout and the
 * worktree: "a directory base tracks" is one that exists in the worktree.
 * (`openDeployCheckout` itself runs against real git in deploy.test.mjs.)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { linkCheckoutEnvironment } from './deployCheckout.mjs';

test('env files are copied only where base has none, deps are linked per entry, untracked dirs are not walked', () => {
  const root = mkdtempSync(join(tmpdir(), 'fv-deploy-env-'));
  const repo = join(root, 'repo');
  const wt = join(root, 'wt');
  // The checkout: env files at the root and in a tracked app, deps, an
  // untracked build dir with an env file of its own, and a .git.
  mkdirSync(join(repo, 'apps', 'web'), { recursive: true });
  mkdirSync(join(repo, 'node_modules', 'dep'), { recursive: true });
  mkdirSync(join(repo, 'dist'), { recursive: true });
  mkdirSync(join(repo, '.git'), { recursive: true });
  writeFileSync(join(repo, '.env'), 'ROOT=checkout\n');
  writeFileSync(join(repo, '.dev.vars'), 'DEV=checkout\n');
  writeFileSync(join(repo, 'apps', 'web', '.env.production'), 'WEB=checkout\n');
  writeFileSync(join(repo, 'dist', '.env'), 'DIST=checkout\n');
  writeFileSync(join(repo, 'node_modules', 'dep', 'marker'), 'x');
  writeFileSync(join(repo, 'notes.txt'), 'not environment\n');
  // The worktree: base tracks apps/web and carries its own .dev.vars.
  mkdirSync(join(wt, 'apps', 'web'), { recursive: true });
  writeFileSync(join(wt, '.dev.vars'), 'DEV=base\n');

  const made = linkCheckoutEnvironment(repo, wt);

  assert.equal(readFileSync(join(wt, '.env'), 'utf8'), 'ROOT=checkout\n');
  assert.equal(readFileSync(join(wt, 'apps', 'web', '.env.production'), 'utf8'), 'WEB=checkout\n');
  assert.equal(readFileSync(join(wt, '.dev.vars'), 'utf8'), 'DEV=base\n', "base's own copy wins");
  assert.equal(existsSync(join(wt, 'dist')), false, 'an untracked dir is neither code nor environment');
  assert.equal(existsSync(join(wt, 'notes.txt')), false);
  assert.equal(existsSync(join(wt, '.git')), false);
  assert.ok(lstatSync(join(wt, 'node_modules')).isDirectory(), 'node_modules is a real directory…');
  assert.ok(lstatSync(join(wt, 'node_modules', 'dep')).isSymbolicLink(), '…of per-entry links');
  // Everything it made is reported, so cleanup can unlink it first.
  for (const p of [join(wt, '.env'), join(wt, 'apps', 'web', '.env.production'), join(wt, 'node_modules'), join(wt, 'node_modules', 'dep')]) {
    assert.ok(made.includes(p), `${p} is in the made list`);
  }
  assert.equal(made.includes(join(wt, '.dev.vars')), false);
});
