/**
 * THE DAEMON'S LOCAL STATE — per-project CLI limits (daemonState.mjs, split out
 * of desktopContract.mjs 2026-09-26, SOLID F061). Cases moved with their
 * symbols.
 *
 * Run: node --test bin/lib/daemonState.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { daemonLockPid, daemonStatePath, setRuntimeLimit } from './daemonState.mjs';
import { instanceLockPath } from './instance.mjs';

const temp = () => mkdtempSync(join(tmpdir(), 'fv-desktop-'));

test('a limit stays in this project and clears only on a measured recovery', (t) => {
  const root = temp();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const before = process.env.HOME;
  process.env.HOME = root;
  try {
    assert.equal(setRuntimeLimit('p1', 'codex', 'Codex says wait'), true);
    assert.equal(setRuntimeLimit('p1', 'codex', 'Codex says wait'), false);
    assert.deepEqual(JSON.parse(readFileSync(daemonStatePath('p1'), 'utf8')).limits, { codex: 'Codex says wait' });
    assert.equal(setRuntimeLimit('p1', 'codex', null), true);
    assert.deepEqual(JSON.parse(readFileSync(daemonStatePath('p1'), 'utf8')).limits, {});
  } finally { if (before === undefined) delete process.env.HOME; else process.env.HOME = before; }
});

test("the lock pid is read from the instance lock's own path, null when absent", (t) => {
  const root = temp();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const before = process.env.HOME;
  process.env.HOME = root;
  try {
    assert.equal(daemonLockPid('fva_test'), null);
    mkdirSync(join(root, '.flowviant'));
    writeFileSync(instanceLockPath('fva_test'), JSON.stringify({ pid: 4242 }));
    assert.equal(daemonLockPid('fva_test'), 4242);
  } finally { if (before === undefined) delete process.env.HOME; else process.env.HOME = before; }
});
