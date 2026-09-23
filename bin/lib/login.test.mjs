/**
 * A SECOND PROJECT ON ONE REPO IS A QUESTION (0.95.0).
 *
 * The owner: "im not sure how it even allowed me to run npx flowviant login
 * twice and init a daemon twice on the same project/repository/directory in
 * the first place." It allowed it by never looking. Pinned here: the three
 * answers say their whole consequence; the store is consulted BEFORE the save
 * and the save is skipped on cancel; and a cancelled login starts no daemon.
 *
 * Run: node --test bin/lib/login.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const code = (url) =>
  readFileSync(url, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l))
    .join('\n');
const between = (src, from, to, what) => {
  const a = src.indexOf(from);
  assert.ok(a >= 0, `${what}: anchor not found — ${from}`);
  const b = src.indexOf(to, a + 1);
  assert.ok(b > a, `${what}: closing anchor not found after it — ${to}`);
  return src.slice(a, b);
};

test('the three answers each say their whole consequence', async () => {
  const { secondProjectOptions } = await import('./login.mjs');
  const clash = [{ projectId: 'fd716bf3', name: 'BRIF AI' }];
  const entry = { projectId: 'fdcec6a0', name: 'BRIF AI' };
  const rows = secondProjectOptions(clash, entry, '/home/whuang/brif-ai');
  assert.equal(rows.length, 3);
  assert.match(rows[0], /^keep both — every `npx flowviant` in \/home\/whuang\/brif-ai asks whether to serve BRIF AI or BRIF AI$/);
  assert.match(rows[1], /^replace — \/home\/whuang\/brif-ai serves BRIF AI from now on; this box is disconnected from BRIF AI \(its daemon here stopped, its credential forgotten here\)$/);
  assert.match(rows[2], /^cancel — save nothing; \/home\/whuang\/brif-ai stays connected to BRIF AI$/);
});

test('login consults the store before saving, and a cancel saves nothing and starts nothing', () => {
  const login = code(new URL('./login.mjs', import.meta.url));
  const approved = between(login, "if (poll.status === 'approved') {", 'saveLogin(entry);', 'the approved branch');
  assert.ok(approved.includes('boundElsewhere(listStoredProjects(), repoRoot, entry.projectId)'), 'asked of the store, for this repo, excluding the approved project');
  assert.ok(approved.includes("if (decision === 'cancel') {"), 'cancel is a branch');
  assert.ok(approved.includes('return { saved: false };'), '…that returns without saving');
  // Replace is the WHOLE disconnect, never a bare forget — see the options docblock.
  assert.ok(approved.includes("if (decision === 'replace') {") && approved.includes('disconnectHere(old, deps'));
  // Headless keeps both and says so; nothing here can hang a runner.
  assert.ok(login.includes("if (!canPrompt()) {") && login.includes("return 'keep';"));

  const cli = code(new URL('../cli.mjs', import.meta.url));
  assert.ok(cli.includes('if (noStart || !login?.saved) process.exit(0);'), 'the login command starts nothing after a cancel');
  assert.ok(cli.includes("if (!login?.saved) process.exit(0);"), 'nor does the picker’s inline login');
});
