import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkEnv, clearNonArtifacts } from './work.mjs';

/**
 * THE PROJECT'S CHECK NEVER RUNS A FILE A NON-CODE TURN PLANTED.
 *
 * A design or research turn may write only under `.flowviant/artifacts/`, and
 * the check — the repo's own command, run unattended in that same worktree —
 * is usually a test runner whose DEFAULT discovery collects
 * `.flowviant/artifacts/x.test.js`. So a card steered by text it read could
 * have the machine execute arbitrary code before anyone reviewed it. Before
 * the check, everything in that directory that is not a showable artifact
 * (a top-level regular file of an allowlisted type) is removed.
 */
function worktree(t) {
  const wt = mkdtempSync(join(tmpdir(), 'fv-check-'));
  t.after(() => rmSync(wt, { recursive: true, force: true }));
  const dir = join(wt, '.flowviant', 'artifacts');
  mkdirSync(dir, { recursive: true });
  return { wt, dir };
}

test('a planted test file, a subdirectory and a symlink are removed; real artifacts stay', (t) => {
  const { wt, dir } = worktree(t);
  writeFileSync(join(dir, 'landing.html'), '<p>mock</p>');
  writeFileSync(join(dir, 'notes.md'), '# notes');
  writeFileSync(join(dir, 'pwn.test.js'), 'require("child_process").execSync("id")');
  writeFileSync(join(dir, '.hidden.spec.ts'), 'x');
  mkdirSync(join(dir, 'sub'));
  writeFileSync(join(dir, 'sub', 'deep.test.mjs'), 'x');
  symlinkSync('/etc/hostname', join(dir, 'link.md'));
  const removed = clearNonArtifacts(wt).sort();
  assert.deepEqual(removed, ['.hidden.spec.ts', 'link.md', 'pwn.test.js', 'sub']);
  assert.equal(readFileSync(join(dir, 'landing.html'), 'utf8'), '<p>mock</p>');
  assert.ok(existsSync(join(dir, 'notes.md')));
  assert.ok(!existsSync(join(dir, 'pwn.test.js')));
  assert.ok(!existsSync(join(dir, 'sub')));
});

test('no artifacts directory, or a .flowviant that is not ours, is left alone', (t) => {
  const bare = mkdtempSync(join(tmpdir(), 'fv-check-bare-'));
  t.after(() => rmSync(bare, { recursive: true, force: true }));
  assert.deepEqual(clearNonArtifacts(bare), []);
  const target = mkdtempSync(join(tmpdir(), 'fv-check-target-'));
  t.after(() => rmSync(target, { recursive: true, force: true }));
  mkdirSync(join(target, 'artifacts'));
  writeFileSync(join(target, 'artifacts', 'x.test.js'), 'x');
  symlinkSync(target, join(bare, '.flowviant'));
  assert.deepEqual(clearNonArtifacts(bare), []);
  assert.ok(existsSync(join(target, 'artifacts', 'x.test.js')), 'never reached through a symlinked .flowviant');
});

test('the check runs without the machine credential and with everything else the turn saw', () => {
  const env = checkEnv({
    PATH: '/usr/bin',
    JAVA_HOME: '/opt/jdk',
    DATABASE_URL: 'postgres://localhost/test',
    FLOWVIANT_MACHINE_TOKEN: 'fv_secret',
    FLOWVIANT_FLEET: 'fv_legacy',
  });
  assert.equal(env.FLOWVIANT_MACHINE_TOKEN, undefined);
  assert.equal(env.FLOWVIANT_FLEET, undefined);
  // A check stripped of the operator's shell fails where the agent's own run
  // passed — a verdict the product manufactured. These stay.
  assert.equal(env.JAVA_HOME, '/opt/jdk');
  assert.equal(env.DATABASE_URL, 'postgres://localhost/test');
  assert.equal(env.PATH, '/usr/bin');
});

test('the check clears the directory first and runs under checkEnv', () => {
  const src = readFileSync(new URL('./work.mjs', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .join('\n');
  const i = src.indexOf('const runCheck = ');
  assert.ok(i > -1, 'runCheck must exist');
  const j = src.indexOf('\n  const ', i + 10);
  assert.ok(j > i);
  const body = src.slice(i, j);
  const clearAt = body.indexOf('clearNonArtifacts(wt)');
  const spawnAt = body.indexOf('child = spawn(cmd, {');
  assert.ok(clearAt > -1 && spawnAt > -1 && clearAt < spawnAt, 'cleared before the command starts');
  assert.ok(body.includes('env: checkEnv(),'), 'never the daemon’s own environment with its credential');
});
