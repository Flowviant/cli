/**
 * THE MERGE IDENTITY — one probe, one fallback, both merge lanes (SOLID F165).
 *
 * Real temporary repositories with the operator's global and system git config
 * hidden, so "no identity" is the machine under test, not this box.
 *
 * Run: node --test bin/lib/gitMergeIdentity.test.mjs
 */

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DAEMON_GIT_IDENTITY, gitMergeIn, mergeIdentityEnv } from './gitMergeIdentity.mjs';

before(() => {
  // Hide every identity this box has: an empty global, no system config, and
  // no identity variables inherited from the shell running the suite.
  const empty = join(mkdtempSync(join(tmpdir(), 'fv-gid-home-')), 'gitconfig');
  writeFileSync(empty, '');
  process.env.GIT_CONFIG_GLOBAL = empty;
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  for (const k of Object.keys(DAEMON_GIT_IDENTITY)) delete process.env[k];
  delete process.env.EMAIL;
});

const g = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** A repo with one commit on `main` and a diverged `side`, written under an
 *  explicit -c identity so the repo itself configures none. */
function repoWithSide() {
  const dir = mkdtempSync(join(tmpdir(), 'fv-gid-'));
  const id = ['-c', 'user.name=Setup', '-c', 'user.email=setup@example.com'];
  g(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'a'), '1');
  g(dir, 'add', 'a');
  g(dir, ...id, 'commit', '-q', '-m', 'a');
  g(dir, 'checkout', '-q', '-b', 'side');
  writeFileSync(join(dir, 'b'), '1');
  g(dir, 'add', 'b');
  g(dir, ...id, 'commit', '-q', '-m', 'b');
  g(dir, 'checkout', '-q', 'main');
  writeFileSync(join(dir, 'c'), '1');
  g(dir, 'add', 'c');
  g(dir, ...id, 'commit', '-q', '-m', 'c');
  return dir;
}

test('a machine with no git identity merges as the daemon', () => {
  const dir = repoWithSide();
  assert.deepEqual(mergeIdentityEnv(dir), DAEMON_GIT_IDENTITY);
  gitMergeIn(dir)(['merge', '--no-ff', '--no-edit', 'side'], dir);
  assert.equal(g(dir, 'log', '-1', '--format=%an <%ae> / %cn <%ce>'), 'Flowviant <daemon@flowviant.com> / Flowviant <daemon@flowviant.com>');
});

test("the operator's own identity wins when the repo names one", () => {
  const dir = repoWithSide();
  g(dir, 'config', 'user.name', 'Operator');
  g(dir, 'config', 'user.email', 'op@example.com');
  assert.equal(mergeIdentityEnv(dir), null);
  gitMergeIn(dir)(['merge', '--no-ff', '--no-edit', 'side'], dir);
  assert.equal(g(dir, 'log', '-1', '--format=%an <%ae>'), 'Operator <op@example.com>');
});

test('both merge lanes take gitMerge from the one home; nothing in bin/ keeps a copy', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = join(here, '..');
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  for (const f of ['workShip.mjs', 'workAgentMerges.mjs']) {
    assert.ok(strip(readFileSync(join(here, f), 'utf8')).includes('gitMergeIn(repoRoot)'), `${f} takes its gitMerge from gitMergeIdentity.mjs`);
  }
  const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith('.mjs') && !e.name.endsWith('.test.mjs') ? [join(d, e.name)] : []);
  const sources = walk(root).map((f) => [f.slice(root.length + 1), strip(readFileSync(f, 'utf8'))]);
  for (const banned of ['daemon@flowviant.com', 'GIT_AUTHOR_EMAIL', "'config', 'user.email'"]) {
    // Canary: the walk finds the one home.
    assert.deepEqual(sources.filter(([, src]) => src.includes(banned)).map(([f]) => f), ['lib/gitMergeIdentity.mjs'], banned);
  }
});
