import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkSessionRuntime, CODEX_THREAD_RE, AGY_CONV_RE } from './workSessionRuntime.mjs';

/**
 * WHICH CLI A TAB SPEAKS, driven directly (split out of work.mjs 2026-09-26,
 * SOLID F037). The marker path is handed in, so these cases need no git and
 * no installed CLI: every branch taken here decides before `detectRuntimes`
 * would be asked.
 */
function dir(t) {
  const d = mkdtempSync(join(tmpdir(), 'fv-rt-'));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  return d;
}
const metaIn = (d) => (wt, name, scope) => join(d, `${name}-${scope}`);

test('a pinned tab the server now calls a different brain settles as a mismatch, in labels', (t) => {
  const d = dir(t);
  const { sessionRuntime } = createWorkSessionRuntime({ sessionMetaPath: metaIn(d) });
  writeFileSync(join(d, 'flowviant-runtime-s1'), 'claude');
  assert.deepEqual(sessionRuntime('/wt', 'codex', 's1'), { mismatch: { pin: 'Claude Code', runtime: 'Codex' } });
});

test('a server-named runtime no tab can run on is unsupported, and nothing is pinned', (t) => {
  const d = dir(t);
  const { sessionRuntime } = createWorkSessionRuntime({ sessionMetaPath: metaIn(d) });
  assert.deepEqual(sessionRuntime('/wt', 'nope', 's1'), { unsupported: 'nope' });
  assert.throws(() => readFileSync(join(d, 'flowviant-runtime-s1')), 'nothing was pinned');
});

test('the pin is scoped per tab: two tabs in one directory keep their own', (t) => {
  const d = dir(t);
  const { sessionRuntime } = createWorkSessionRuntime({ sessionMetaPath: metaIn(d) });
  writeFileSync(join(d, 'flowviant-runtime-a'), 'claude');
  writeFileSync(join(d, 'flowviant-runtime-b'), 'codex');
  assert.equal(sessionRuntime('/wt', 'codex', 'a').mismatch?.pin, 'Claude Code');
  assert.equal(sessionRuntime('/wt', 'claude', 'b').mismatch?.pin, 'Codex');
});

test('a resume id must have an argv-safe shape before it is trusted', () => {
  assert.ok(CODEX_THREAD_RE.test('0199a1b2-c3d4-7e8f'));
  assert.ok(!CODEX_THREAD_RE.test('-rf-everything'), 'a leading dash parses as a flag');
  assert.ok(!CODEX_THREAD_RE.test('short'));
  assert.ok(AGY_CONV_RE.test('0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b'));
  assert.ok(!AGY_CONV_RE.test('0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b; rm'));
});

test("agy's cwd registry answers only a UUID for this directory", (t) => {
  const home = dir(t);
  const realHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => {
    process.env.HOME = realHome;
  });
  const { agyRegistryLookup } = createWorkSessionRuntime({ sessionMetaPath: () => null });
  assert.equal(agyRegistryLookup('/wt'), null, 'no registry yet');
  const cache = join(home, '.gemini', 'antigravity-cli', 'cache');
  mkdirSync(cache, { recursive: true });
  const id = '0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b';
  writeFileSync(join(cache, 'last_conversations.json'), JSON.stringify({ '/wt': id, '/other': 'not-a-uuid' }));
  assert.equal(agyRegistryLookup('/wt'), id);
  assert.equal(agyRegistryLookup('/other'), null);
  assert.equal(agyRegistryLookup('/elsewhere'), null);
});
