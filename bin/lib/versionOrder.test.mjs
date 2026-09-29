import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseVersion, compareVersions, versionBelow } from './versionOrder.mjs';

test('releases order numerically; missing parts read as zero; a v prefix is allowed', () => {
  assert.equal(compareVersions('0.57.0', '0.56.1'), 1);
  assert.equal(compareVersions('0.48.3', '0.57.0'), -1);
  assert.equal(compareVersions('0.57.0', '0.57.0'), 0);
  assert.equal(compareVersions('0.57', '0.57.0'), 0);
  assert.equal(compareVersions('0.9.0', '0.10.0'), -1);
  assert.equal(compareVersions('v22.11.0', 'v20.18.1'), 1);
  assert.equal(compareVersions('v1.2.3', '1.2.3'), 0);
  assert.deepEqual(parseVersion('1'), [1, 0, 0]);
  // A prerelease or build tail orders nothing (no rule this replaced read it).
  assert.equal(compareVersions('0.101.2-beta.1', '0.101.2'), 0);
  assert.equal(compareVersions('0.101.2+abc', '0.101.3'), -1);
});

test('a malformed version is UNKNOWN, never equal and never zero', () => {
  for (const bad of ['', 'abc', '0.x.1', '1.2.3.4', '1..2', '.1.2', '1.2.3 (dev)', 'v', null, undefined, {}]) {
    assert.equal(parseVersion(bad), null, String(bad));
    assert.equal(compareVersions(bad, '0.1.0'), null, String(bad));
    assert.equal(compareVersions('0.1.0', bad), null, String(bad));
    assert.equal(versionBelow(bad, '99.0.0'), false, 'unknown is not older');
    assert.equal(versionBelow('0.0.1', bad), false, 'nor is anything older than unknown');
  }
});

/** CODE ONLY — comments describe the rules this replaced. */
const code = (file) =>
  readFileSync(new URL(`./${file}`, import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .join('\n');

test('version order has one home: no caller keeps its own comparator', () => {
  for (const file of ['instance.mjs', 'update.mjs', 'views.mjs', 'loginPath.mjs', 'fleet.mjs', 'uninstall.mjs']) {
    const src = code(file);
    assert.ok(!/function cmpVersion|const cmpVersion|function olderVersion/.test(src), `${file} holds its own comparator`);
    assert.ok(!/split\('\.'\)\.map\(/.test(src), `${file} splits a version by hand`);
  }
  // Each caller reaches the one home.
  for (const file of ['instance.mjs', 'update.mjs', 'views.mjs', 'loginPath.mjs', 'fleet.mjs']) {
    assert.ok(code(file).includes("from './versionOrder.mjs'"), `${file} imports versionOrder`);
  }
});
