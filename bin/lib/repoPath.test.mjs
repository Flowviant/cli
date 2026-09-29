import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { samePath } from './repoPath.mjs';

test('a symlink, a trailing slash and the real path are one checkout', (t) => {
  const base = mkdtempSync(join(tmpdir(), 'fv-repopath-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const repo = join(base, 'repo');
  mkdirSync(repo);
  symlinkSync(repo, join(base, 'link'));
  assert.equal(samePath(repo, `${repo}/`), true);
  assert.equal(samePath(repo, `${repo}///`), true);
  assert.equal(samePath(join(base, 'link'), repo), true);
  assert.equal(samePath(repo, join(base, 'other')), false);
});

test('a path that no longer exists still matches its own spelling', () => {
  const gone = join(tmpdir(), `fv-repopath-gone-${process.pid}-${Date.now()}`);
  assert.equal(samePath(gone, `${gone}/`), true);
  assert.equal(samePath(gone, `${gone}-x`), false);
});

test('a blank side matches nothing', () => {
  assert.equal(samePath('', ''), false);
  assert.equal(samePath(null, '/repo'), false);
  assert.equal(samePath('/repo', undefined), false);
});

const code = (file) =>
  readFileSync(new URL(`./${file}`, import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .join('\n');

test('repo identity has one home, and both deciders import it', () => {
  for (const file of ['instance.mjs', 'credentials.mjs']) {
    const src = code(file);
    assert.ok(!/function samePath/.test(src), `${file} holds its own samePath`);
    assert.ok(src.includes("import { samePath } from './repoPath.mjs';"), `${file} imports the one rule`);
    assert.ok(/samePath\(/.test(src.replace("import { samePath } from './repoPath.mjs';", '')), `${file} uses it`);
  }
});
