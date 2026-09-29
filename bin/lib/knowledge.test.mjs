/**
 * THE KNOWLEDGE DRIVER, against a real temp directory and a fake server
 * (2026-09-22, 0.94.0; the disk, the pure rules and the download moved to
 * their own test files with their modules 2026-09-26, SOLID F049).
 *
 * Behavioural throughout: rosters go in, and the claims are about when a sync
 * RUNS — an absent key never, the same rev only when the disk no longer holds
 * what the manifest names, a failing rev on a widening backoff, a new rev at
 * once — read off the disk and the fake server's call log.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KNOWLEDGE_DIR, LIBRARY_FILE } from './knowledgeLibrary.mjs';
import { readKnowledgeMarker, syncKnowledge } from './knowledgeFiles.mjs';
import { createKnowledgeSync } from './knowledge.mjs';

const sha = (s) => createHash('sha256').update(s).digest('hex');
const id = (n) => `0000000${n}-aaaa-bbbb-cccc-dddddddddddd`;

/** A fake `/fleet/knowledge/:id`: serves `files[id]`, counts every fetch. */
function fakeServer(files) {
  const calls = [];
  return {
    calls,
    fetchFile: async (fid) => {
      calls.push(fid);
      if (!(fid in files)) throw new Error('HTTP 404');
      const v = files[fid];
      if (v instanceof Error) throw v;
      return Buffer.from(v);
    },
  };
}

const checkout = () => mkdtempSync(join(tmpdir(), 'fv-knowledge-'));
const lib = (dir) => join(dir, KNOWLEDGE_DIR);
const ls = (dir) => readdirSync(lib(dir)).sort();

test('the driver: an ABSENT key leaves the directory alone; the same rev does nothing; a new rev syncs', async () => {
  const dir = checkout();
  const srv = fakeServer({ [id(1)]: 'a' });
  const excluded = [];
  const sync = createKnowledgeSync({ checkoutDir: dir, fetchFile: srv.fetchFile, onExclude: (d) => excluded.push(d) });
  const manifest = { rev: 3, instructions: null, files: [{ id: id(1), name: 'a.md', bytes: 1, sha256: sha('a') }] };
  await sync.onRoster(manifest);
  assert.deepEqual(ls(dir), ['a.md']);
  assert.equal(sync.rev, 3);
  assert.equal(readKnowledgeMarker(dir), 3);
  assert.deepEqual(excluded, [dir]);

  // ABSENT: an older server says this on every poll — it must never delete.
  assert.equal(await sync.onRoster(undefined), null);
  assert.deepEqual(ls(dir), ['a.md']);

  // Same rev: no work at all.
  assert.equal(await sync.onRoster(manifest), null);
  assert.deepEqual(srv.calls, [id(1)]);

  // A restart reads the marker and does not re-sync what is already there.
  const again = createKnowledgeSync({ checkoutDir: dir, fetchFile: srv.fetchFile });
  assert.equal(again.rev, 3);
  assert.equal(await again.onRoster(manifest), null);
});

test('the driver backs off a failing rev, but a NEW rev is tried at once', async () => {
  const dir = checkout();
  let t = 0;
  const srv = fakeServer({ [id(1)]: new Error('HTTP 500'), [id(2)]: 'b' });
  const sync = createKnowledgeSync({ checkoutDir: dir, fetchFile: srv.fetchFile, now: () => t });
  const bad = { rev: 1, instructions: null, files: [{ id: id(1), name: 'a.md', bytes: 1, sha256: sha('a') }] };
  const r = await sync.onRoster(bad);
  assert.equal(r.ok, false);
  assert.equal(sync.rev, null);
  t = 1000;
  assert.equal(await sync.onRoster(bad), null); // inside the backoff
  const good = { rev: 2, instructions: null, files: [{ id: id(2), name: 'b.md', bytes: 1, sha256: sha('b') }] };
  const r2 = await sync.onRoster(good);
  assert.equal(r2.ok, true);
  assert.equal(sync.rev, 2);
});

test('every turn the daemon spawns composes its contract through withProjectContext', () => {
  // The tab lane is workSessionTurns.mjs (SOLID F037); the agent lane's run is
  // workAgentTurnExecution.mjs (SOLID F036).
  const src = ['work.mjs', 'workSessionTurns.mjs', 'workAgentTurnExecution.mjs']
    .map((file) => readFileSync(new URL(`./${file}`, import.meta.url), 'utf8'))
    .join('\n');
  // The tab lane (work / plain / capture) and the agent lane.
  // (Re-anchored 2026-09-22 when the ARTIFACTS flag joined the same options
  // object: the pin is that the knowledge dir reaches both lanes, and it moved
  // with the call it pins rather than being loosened to a bare name match.)
  assert.ok(/withProjectContext\(\s*plainTab \? SYSTEM_WORK_PLAIN : captureTab \? SYSTEM_CAPTURE : SYSTEM_WORK,[\s\S]{0,300}?\{ knowledgeDir, artifacts: !captureTab && getArtifactsAccepted\(\) \}/.test(src));
  // (Re-anchored 2026-09-23 when the agent lane started picking its contract
  // by the card's kind — `SYSTEM_AGENT_FOR(taskKind)` is SYSTEM_AGENT itself
  // for a code card, and the pin is still that the knowledge dir reaches it.)
  assert.ok(/system: withProjectContext\(SYSTEM_AGENT_FOR\(taskKind\), \{\s*knowledgeDir: knowledgeDirFor\(repoRoot\),/.test(src));
  // …and nowhere is a bare contract left behind for either lane.
  assert.equal((src.match(/system: SYSTEM_AGENT,/g) ?? []).length, 0);
  // Claude is told the directory is readable, so a curated profile does not
  // refuse the path it was just handed.
  const rt = readFileSync(new URL('./runtimeClaude.mjs', import.meta.url), 'utf8');
  assert.ok(rt.includes("if (knowledgeDir) a.push('--add-dir', knowledgeDir);"));
  // And the fleet loop hands every roster's key to the sync.
  const fleet = readFileSync(new URL('./fleet.mjs', import.meta.url), 'utf8');
  assert.ok(fleet.includes('void knowledgeSync.onRoster(roster.knowledge);'));
});

test('the same rev over a DELETED library directory re-syncs it (2026-09-23)', async () => {
  const dir = checkout();
  const srv = fakeServer({ [id(1)]: 'a' });
  const sync = createKnowledgeSync({ checkoutDir: dir, fetchFile: srv.fetchFile });
  const manifest = { rev: 4, instructions: 'brief', files: [{ id: id(1), name: 'a.md', bytes: 1, sha256: sha('a') }] };
  await sync.onRoster(manifest);
  assert.deepEqual(ls(dir), ['INSTRUCTIONS.md', 'a.md']);
  // Same rev, directory intact: nothing runs.
  assert.equal(await sync.onRoster(manifest), null);
  rmSync(lib(dir), { recursive: true, force: true });
  await sync.onRoster(manifest);
  assert.deepEqual(ls(dir), ['INSTRUCTIONS.md', 'a.md']);
});

// ── THE KEPT LIBRARY (2026-09-23, 0.97.0) ──────────────────────────────────

const item = (n, over = {}) => ({
  id: id(n),
  name: `designs/landing-v${n}.html`,
  kind: 'design',
  title: 'Landing mockup',
  taskId: 'card-1',
  taskTitle: 'Redesign landing page',
  createdAt: '2026-09-23T10:00:00.000Z',
  bytes: 3,
  sha256: sha(`<${n}>`),
  supersedes: null,
  ...over,
});

test('a measured preview syncs beside HTML and an absent preview is not fetched', async () => {
  const dir = checkout();
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
  const calls = [];
  const fetchFile = async (fid, opts) => {
    calls.push(opts?.preview === true ? 'preview' : 'html');
    return opts?.preview ? png : Buffer.from('<1>');
  };
  const preview = { name: 'designs/landing-v1.png', bytes: png.length, sha256: sha(png) };
  const manifest = { rev: 1, instructions: null, files: [], library: { items: [item(1, { preview })] } };
  const sync = createKnowledgeSync({ checkoutDir: dir, fetchFile });
  assert.equal((await sync.onRoster(manifest)).ok, true);
  assert.deepEqual(readFileSync(join(lib(dir), preview.name)), png);
  assert.deepEqual(calls, ['html', 'preview']);
  assert.equal(await sync.onRoster(manifest), null);
  rmSync(join(lib(dir), preview.name));
  assert.equal((await sync.onRoster(manifest)).ok, true);
  assert.deepEqual(calls, ['html', 'preview', 'preview']);
  const unknown = { ...manifest, rev: 2, library: { items: [item(1)] } };
  assert.equal((await sync.onRoster(unknown)).ok, true);
  assert.deepEqual(readFileSync(join(lib(dir), preview.name)), png);
  const measuredEmpty = { ...manifest, rev: 3, library: { items: [item(1, { preview: null })] } };
  assert.equal((await sync.onRoster(measuredEmpty)).ok, true);
  assert.equal(existsSync(join(lib(dir), preview.name)), false);
});

// ── THE SAME REV OVER A LIBRARY THE DISK DOES NOT HOLD (2026-09-23) ────────

test('an upgrade from a daemon that ignored the library re-syncs it though the rev is unchanged', async () => {
  const dir = checkout();
  const srv = fakeServer({ [id(1)]: 'a', [id(7)]: '<7>' });
  const shelf = [{ id: id(1), name: 'a.md', bytes: 1, sha256: sha('a') }];
  // What a 0.96.0 box left behind: the shelf synced, the marker at rev 5 with
  // no `:lib`, and no library on disk — it did not know the key existed.
  await syncKnowledge({ checkoutDir: dir, manifest: { rev: 5, instructions: null, files: shelf }, fetchFile: srv.fetchFile });
  writeFileSync(join(dir, '.flowviant/knowledge.rev'), '5\n');
  const sync = createKnowledgeSync({ checkoutDir: dir, fetchFile: srv.fetchFile });
  assert.equal(sync.rev, 5);
  // The 0.97.0 roster: SAME rev, now carrying the library.
  const r = await sync.onRoster({ rev: 5, instructions: null, files: shelf, library: { items: [item(7)] } });
  assert.ok(r, 'the same rev did not stop the sync');
  assert.equal(readFileSync(join(lib(dir), 'designs', 'landing-v7.html'), 'utf8'), '<7>');
  assert.ok(existsSync(join(lib(dir), LIBRARY_FILE)));
  // The marker now says the library was part of this rev…
  assert.equal(readFileSync(join(dir, '.flowviant/knowledge.rev'), 'utf8'), '5:lib\n');
  assert.equal(readKnowledgeMarker(dir), 5, 'and still reads as the rev');
  // …so the next poll is a no-op, and a restart agrees.
  assert.equal(await sync.onRoster({ rev: 5, instructions: null, files: shelf, library: { items: [item(7)] } }), null);
  const again = createKnowledgeSync({ checkoutDir: dir, fetchFile: srv.fetchFile });
  assert.equal(await again.onRoster({ rev: 5, instructions: null, files: shelf, library: { items: [item(7)] } }), null);
});

test('rev unchanged + a library named + its file missing → the sync runs and fetches only the missing one', async () => {
  const dir = checkout();
  const srv = fakeServer({ [id(1)]: '<1>', [id(2)]: '<2>' });
  const sync = createKnowledgeSync({ checkoutDir: dir, fetchFile: srv.fetchFile });
  const manifest = { rev: 9, instructions: null, files: [], library: { items: [item(1), item(2)] } };
  await sync.onRoster(manifest);
  assert.deepEqual(srv.calls, [id(1), id(2)]);
  assert.equal(await sync.onRoster(manifest), null, 'canary: intact, nothing runs');
  // One item deleted by hand.
  rmSync(join(lib(dir), 'designs', 'landing-v2.html'));
  assert.ok(await sync.onRoster(manifest));
  assert.deepEqual(srv.calls, [id(1), id(2), id(2)], 'only the missing file is fetched again');
  assert.ok(existsSync(join(lib(dir), 'designs', 'landing-v2.html')));
  // The whole designs/ directory deleted by hand.
  rmSync(join(lib(dir), 'designs'), { recursive: true, force: true });
  assert.ok(await sync.onRoster(manifest));
  assert.deepEqual(readdirSync(join(lib(dir), 'designs')).sort(), ['landing-v1.html', 'landing-v2.html']);
  // LIBRARY.md deleted by hand: re-synced, nothing fetched.
  const before = srv.calls.length;
  rmSync(join(lib(dir), LIBRARY_FILE));
  assert.ok(await sync.onRoster(manifest));
  assert.ok(existsSync(join(lib(dir), LIBRARY_FILE)));
  assert.equal(srv.calls.length, before);
});

test('an item refused for size is not EXPECTED on disk — the same rev does not re-fetch it every poll', async () => {
  const dir = checkout();
  const srv = fakeServer({ [id(1)]: '<1>' });
  const sync = createKnowledgeSync({ checkoutDir: dir, fetchFile: srv.fetchFile });
  const manifest = {
    rev: 2,
    instructions: null,
    files: [],
    library: { items: [item(1), item(2, { bytes: 11 * 1024 * 1024 })] },
  };
  const r = await sync.onRoster(manifest);
  assert.deepEqual(r.refused, ['designs/landing-v2.html']);
  assert.equal(await sync.onRoster(manifest), null);
  assert.deepEqual(srv.calls, [id(1)]);
});

test('an ABSENT library key expects nothing — an older server over a plain shelf is still a no-op', async () => {
  const dir = checkout();
  const srv = fakeServer({ [id(1)]: 'a' });
  const sync = createKnowledgeSync({ checkoutDir: dir, fetchFile: srv.fetchFile });
  const manifest = { rev: 1, instructions: null, files: [{ id: id(1), name: 'a.md', bytes: 1, sha256: sha('a') }] };
  await sync.onRoster(manifest);
  assert.equal(readFileSync(join(dir, '.flowviant/knowledge.rev'), 'utf8'), '1\n', 'no `:lib` without a library key');
  assert.equal(await sync.onRoster(manifest), null);
});

test('the driver retries a failed fetch after its backoff, on a widening delay, and lands it', async () => {
  const dir = checkout();
  let t = 0;
  const files = { [id(1)]: new Error('HTTP 500') };
  const srv = fakeServer(files);
  const lines = [];
  const sync = createKnowledgeSync({ checkoutDir: dir, fetchFile: srv.fetchFile, now: () => t, log: (l) => lines.push(l) });
  const manifest = { rev: 1, instructions: null, files: [{ id: id(1), name: 'a.md', bytes: 1, sha256: sha('a') }] };
  assert.equal((await sync.onRoster(manifest)).ok, false);
  assert.equal(readKnowledgeMarker(dir), null, 'a failed rev writes no marker');
  // First backoff is 30s: inside it nothing is fetched.
  t = 29_999;
  assert.equal(await sync.onRoster(manifest), null);
  assert.equal(srv.calls.length, 1);
  // Past it: tried again, fails again — the next wait doubles to 60s.
  t = 30_000;
  assert.equal((await sync.onRoster(manifest)).ok, false);
  assert.equal(srv.calls.length, 2);
  t = 30_000 + 59_999;
  assert.equal(await sync.onRoster(manifest), null);
  assert.equal(srv.calls.length, 2);
  // The server recovers; past the second backoff the file lands and the rev advances.
  files[id(1)] = 'a';
  t = 30_000 + 60_000;
  const r = await sync.onRoster(manifest);
  assert.equal(r.ok, true);
  assert.equal(sync.rev, 1);
  assert.equal(readKnowledgeMarker(dir), 1);
  assert.equal(readFileSync(join(lib(dir), 'a.md'), 'utf8'), 'a');
  assert.ok(lines.some((l) => l.includes('retrying')), 'the failure was said');
  // …and the same rev is quiet again.
  assert.equal(await sync.onRoster(manifest), null);
  assert.equal(srv.calls.length, 3);
});

/**
 * The driver is the driver: the disk is knowledgeFiles.mjs's and the network
 * knowledgeFetch.mjs's, so neither comes back into this module by a copy.
 */
test('knowledge.mjs touches neither the disk nor the network itself', () => {
  const src = readFileSync(new URL('./knowledge.mjs', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  assert.ok(src.includes('export function createKnowledgeSync('), 'canary: the driver is here');
  assert.ok(src.includes("from './knowledgeFiles.mjs'"), 'canary: the disk is asked');
  assert.doesNotMatch(src, /from 'node:fs'/);
  assert.doesNotMatch(src, /\bfetch\(/);
  assert.doesNotMatch(src, /fleetEndpoint/);
});
