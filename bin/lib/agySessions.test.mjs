/**
 * ANTIGRAVITY PRESENCE — the last-conversation-per-directory subset and the
 * tri-state liveness (agySessions.mjs), plus the coordinator's shared fence
 * and cap across both readers (localSessions.mjs). SOLID F062.
 *
 * Run: node --test bin/lib/agySessions.test.mjs
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, utimesSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isAgyConversationLive, scanAgyConversations } from './agySessions.mjs';
import { scanLocalSessions } from './localSessions.mjs';

let home;
let was;
before(() => {
  was = process.env.HOME;
  home = mkdtempSync(join(tmpdir(), 'fv-agy-home-'));
  process.env.HOME = home;
});
after(() => {
  if (was === undefined) delete process.env.HOME; else process.env.HOME = was;
  rmSync(home, { recursive: true, force: true });
});

const uuid = (n) => `${String(n).padStart(8, '0')}-1111-2222-3333-444444444444`;
const agyDir = () => join(home, '.gemini', 'antigravity-cli');

/** Register `map` ({cwd → id}) as agy's cwd cache and give each id a store
 *  written `ageMs` ago. */
function registry(map, ageMs = 0) {
  mkdirSync(join(agyDir(), 'cache'), { recursive: true });
  mkdirSync(join(agyDir(), 'conversations'), { recursive: true });
  writeFileSync(join(agyDir(), 'cache', 'last_conversations.json'), JSON.stringify(map));
  const t = (Date.now() - ageMs) / 1000;
  for (const id of Object.values(map)) {
    const db = join(agyDir(), 'conversations', `${id}.db`);
    writeFileSync(db, '');
    utimesSync(db, t, t);
  }
}

function repoWith(...subdirs) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'fv-agy-repo-')));
  for (const d of subdirs) mkdirSync(join(root, d), { recursive: true });
  return root;
}

const fence = (root, extra = {}) => ({
  ours: (p) => p === root || p.startsWith(`${root}/`),
  mine: new Set(),
  cutoff: Date.now() - 48 * 60 * 60 * 1000,
  ...extra,
});

test('the report is the last conversation per directory inside the repo, fresh only', () => {
  const root = repoWith('a', 'b');
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'fv-agy-out-')));
  registry({ [join(root, 'a')]: uuid(1), [join(root, 'b')]: uuid(2), [outside]: uuid(3), [join(root, 'gone')]: uuid(4) });
  const rows = scanAgyConversations(fence(root, { processAlive: () => false }));
  assert.deepEqual(rows.map((r) => r.id).sort(), [uuid(1), uuid(2)]);
  assert.ok(rows.every((r) => r.runtime === 'antigravity' && r.live === false));
  // Our own tab's conversation is never offered.
  const mine = scanAgyConversations(fence(root, { processAlive: () => false, mine: new Set([uuid(1)]) }));
  assert.deepEqual(mine.map((r) => r.id), [uuid(2)]);
  // Aged past the cutoff: history, not presence.
  registry({ [join(root, 'a')]: uuid(1) }, 72 * 60 * 60 * 1000);
  assert.deepEqual(scanAgyConversations(fence(root, { processAlive: () => false })), []);
});

test('unknowable liveness reads live (refuse adoption); measured absence reads ended', () => {
  const root = repoWith('a');
  registry({ [join(root, 'a')]: uuid(5) });
  assert.equal(scanAgyConversations(fence(root, { processAlive: () => null }))[0].live, true);
  assert.equal(scanAgyConversations(fence(root, { processAlive: () => false }))[0].live, false);
  assert.equal(scanAgyConversations(fence(root, { processAlive: () => true }))[0].live, true);
  assert.equal(isAgyConversationLive(uuid(5), { processAlive: () => null }), true);
  assert.equal(isAgyConversationLive(uuid(5), { processAlive: () => false }), false);
  assert.equal(isAgyConversationLive(uuid(5), { processAlive: () => true }), true);
  assert.equal(isAgyConversationLive(uuid(999), { processAlive: () => true }), false, 'no store, not live');
});

test('no registry reports nothing and never measures liveness', () => {
  rmSync(agyDir(), { recursive: true, force: true });
  let asked = 0;
  assert.deepEqual(scanAgyConversations(fence('/nowhere', { processAlive: () => { asked++; return true; } })), []);
  assert.equal(asked, 0);
});

test('coordinator: one fence and one cap across both readers, Claude first', () => {
  const root = repoWith('wt', ...Array.from({ length: 32 }, (_, i) => `d${i}`));
  // One ended Claude session at the root.
  const cid = 'cccccccc-1111-2222-3333-444444444444';
  const cdir = join(home, '.claude', 'projects', root.replace(/[^a-zA-Z0-9]/g, '-'));
  mkdirSync(cdir, { recursive: true });
  writeFileSync(join(cdir, `${cid}.jsonl`), `${JSON.stringify({ type: 'user', cwd: root, sessionId: cid })}\n`);
  const map = Object.fromEntries(Array.from({ length: 32 }, (_, i) => [join(root, `d${i}`), uuid(100 + i)]));
  map[join(root, 'wt')] = uuid(200);
  registry(map);
  const rows = scanLocalSessions({ repoRoot: root, excludeDirs: [join(root, 'wt')], excludeIds: [uuid(100)] });
  assert.equal(rows.length, 30, 'the report cap holds across both readers');
  assert.equal(rows[0].id, cid, 'Claude rows lead');
  assert.ok(rows.slice(1).every((r) => r.runtime === 'antigravity'));
  assert.ok(!rows.some((r) => r.id === uuid(200)), 'excludeDirs fences agy too');
  assert.ok(!rows.some((r) => r.id === uuid(100)), 'excludeIds fences agy too');
  // An unresolvable root: agy reports nothing (its registry is global).
  assert.deepEqual(scanLocalSessions({ repoRoot: join(root, 'no-such-dir') }).filter((r) => r.runtime === 'antigravity'), []);
});

test('the coordinator reads no CLI store itself', () => {
  const src = readFileSync(new URL('./localSessions.mjs', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  assert.ok(src.includes('scanClaudeSessions(') && src.includes('scanAgyConversations('), 'anchor: it asks both readers');
  for (const banned of ["'.claude'", "'.gemini'", 'last_conversations', '/proc']) {
    assert.ok(!src.includes(banned), `localSessions.mjs must not read a CLI's store (${banned})`);
  }
});
