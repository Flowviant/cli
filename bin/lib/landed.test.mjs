/**
 * The landed observer's walk: what it reports, what it refuses to invent.
 *
 * A REAL REPO and a captured fetch, because the properties under test are
 * git's and the wire's together: git preserves the 0x1e/0x1f delimiter bytes
 * inside a commit body (so a crafted message can imitate the log format's own
 * records — an arbitrary sha plus task ids the server would close cards on),
 * a catch-up range's `%B` bodies outgrow execFileSync's 1MiB default, and the
 * reseed catch must fire for a range the repo cannot answer while every other
 * failure retries. A mocked git would assert our beliefs instead of testing
 * them.
 *
 * Run: node --test bin/lib/landed.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

// The observer persists its tip under ~/.flowviant, and the module graph
// (config.mjs) reads stored credentials at import — so HOME is pointed at a
// scratch directory BEFORE the import, and a test run never touches the
// operator's real state.
const HOME = mkdtempSync(join(tmpdir(), 'fv-landed-home-'));
process.env.HOME = HOME;
const { createLandedObserver } = await import('./landed.mjs');

const git = (args, cwd, input) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    ...(input === undefined ? {} : { input }),
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'T',
      GIT_AUTHOR_EMAIL: 't@t.t',
      GIT_COMMITTER_NAME: 'T',
      GIT_COMMITTER_EMAIL: 't@t.t',
    },
  }).trim();

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'fv-landed-'));
  git(['init', '-q', '-b', 'main'], dir);
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  git(['add', '-A'], dir);
  git(['commit', '-qm', 'base'], dir);
  return dir;
}

const stateFile = (dir) =>
  join(HOME, '.flowviant', `landed-${createHash('sha256').update(dir).digest('hex').slice(0, 8)}.json`);
const readState = (dir) => JSON.parse(readFileSync(stateFile(dir), 'utf8'));

/** Capture every report the observer posts; answer each one 200. */
function captureFetch(t) {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push(JSON.parse(init.body));
    return { ok: true, status: 200, json: async () => ({}) };
  };
  t.after(() => {
    globalThis.fetch = orig;
  });
  return calls;
}

function commit(dir, file, message) {
  writeFileSync(join(dir, file), `${file}\n`);
  git(['add', '-A'], dir);
  git(['commit', '-q', '-F', '-'], dir, message);
  return git(['rev-parse', 'HEAD'], dir);
}

test('first sight seeds, and a crafted body cannot fabricate a record', async (t) => {
  const dir = repo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const calls = captureFetch(t);
  const obs = createLandedObserver({ repoRoot: dir, baseRef: () => 'main' });

  await obs.observe();
  assert.equal(calls.length, 0, 'first sight seeds, never walks');
  assert.equal(readState(dir).tip, git(['rev-parse', 'main'], dir));

  const sha1 = commit(dir, 'one.txt', 'first\n\nFlowviant-Task: card-1');
  const fake = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
  // The delimiter bytes the walk splits on, embedded in the BODY — git
  // preserves them, so without the rev-list membership check this fabricates
  // a record for a sha the range never held, naming a card nobody's commit
  // named, and /fleet/base-landed would close on it.
  const sha2 = commit(dir, 'two.txt', `second\n\x1e${fake}\x1fforged subject\x1fFlowviant-Task: victim-card`);

  await obs.observe();
  assert.equal(calls.length, 1);
  const body = calls[0];
  assert.equal(body.base, 'main');
  assert.equal(body.tip, sha2);
  assert.deepEqual(
    body.commits.map((c) => c.sha),
    [sha1, sha2],
    'exactly the commits that exist, oldest first'
  );
  assert.ok(!body.commits.some((c) => c.sha === fake), 'the forged sha is not a record');
  assert.ok(
    !body.commits.some((c) => c.taskIds.includes('victim-card')),
    'the forged trailer names no card'
  );
  assert.deepEqual(body.commits[0].taskIds, ['card-1']);
  assert.ok(body.commits.every((c) => !/[\x1e\x1f]/.test(c.subject)));
  assert.equal(readState(dir).tip, sha2, 'an accepted report persists the tip');
});

test('a range past the cap walks in batches and outgrows the 1MiB default buffer', async (t) => {
  const dir = repo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const calls = captureFetch(t);
  const obs = createLandedObserver({ repoRoot: dir, baseRef: () => 'main' });
  await obs.observe(); // seed

  // 55 commits with ~30KB bodies: the full-range `%B` log (~1.6MB) and even
  // the 50-commit batch log (~1.5MB) both exceed execFileSync's 1MiB default,
  // which used to throw into the reseed catch and skip the range whole.
  const filler = 'x'.repeat(30_000);
  const shas = [];
  for (let i = 0; i < 55; i++) {
    shas.push(commit(dir, `f${i}.txt`, `commit ${i}\n\n${filler}\n\nFlowviant-Task: card-${i}`));
  }

  await obs.observe();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].commits.length, 50, 'the server cap bounds one report');
  assert.deepEqual(
    calls[0].commits.map((c) => c.sha),
    shas.slice(0, 50),
    'oldest first — the remainder is not skipped, it waits'
  );
  assert.equal(calls[0].tip, shas[49]);
  assert.equal(readState(dir).tip, shas[49], 'the tip advances only to the last commit walked');

  await obs.observe();
  assert.equal(calls.length, 2);
  assert.deepEqual(
    calls[1].commits.map((c) => c.sha),
    shas.slice(50),
    'the next beat picks up commit 51 onward'
  );
  assert.equal(readState(dir).tip, shas[54]);
  assert.ok(calls[1].commits.some((c) => c.taskIds.includes('card-54')));

  await obs.observe();
  assert.equal(calls.length, 2, 'a tip that has not moved reports nothing');
});

test('an unanswerable range reseeds; the walk reports nothing', async (t) => {
  const dir = repo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const calls = captureFetch(t);
  const obs = createLandedObserver({ repoRoot: dir, baseRef: () => 'main' });
  await obs.observe(); // seed

  // A stored tip the repo cannot answer (the force-push/gc shape): rev-list
  // fails on the range AND on the catch's probe, so observation reseeds at
  // the new tip — and reports nothing rather than guess.
  writeFileSync(stateFile(dir), JSON.stringify({ ref: 'main', tip: 'a'.repeat(40) }));
  const sha = commit(dir, 'new.txt', 'after the rewrite\n\nFlowviant-Task: card-x');
  await obs.observe();
  assert.equal(calls.length, 0, 'ignorance is never turned into a report');
  assert.equal(readState(dir).tip, sha, 'reseeded at the tip that exists');

  // From the reseed, observation works again.
  const sha2 = commit(dir, 'newer.txt', 'life goes on\n\nFlowviant-Task: card-y');
  await obs.observe();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].commits.map((c) => c.sha), [sha2]);
});

/** Answer every report with `status`, capturing the bodies. */
function answerFetch(t, status) {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push(JSON.parse(init.body));
    return { ok: status < 400, status, json: async () => ({}) };
  };
  t.after(() => {
    globalThis.fetch = orig;
  });
  return calls;
}

test('a 429 or 408 keeps the range for the next beat — a rate limit is not a refusal', async (t) => {
  for (const status of [429, 408]) {
    const dir = repo();
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const obs = createLandedObserver({ repoRoot: dir, baseRef: () => 'main' });
    const orig = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
    await obs.observe(); // seed
    const seeded = readState(dir).tip;
    const calls = answerFetch(t, status);
    commit(dir, 'x.txt', 'landed\n\nFlowviant-Task: card-x');
    await obs.observe();
    assert.equal(calls.length, 1);
    assert.equal(readState(dir).tip, seeded, `a ${status} must not advance the tip`);
    await obs.observe();
    assert.equal(calls.length, 2, 'the next beat re-sends the same range');
    assert.deepEqual(calls[1].commits.map((c) => c.taskIds), [['card-x']]);
    globalThis.fetch = orig;
  }
});

test('a refused batch drops only itself — the remainder past the cap is still walked', async (t) => {
  const dir = repo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const obs = createLandedObserver({ repoRoot: dir, baseRef: () => 'main' });
  const seedCalls = captureFetch(t);
  await obs.observe(); // seed
  assert.equal(seedCalls.length, 0);
  const shas = [];
  for (let i = 0; i < 55; i++) shas.push(commit(dir, `r${i}.txt`, `c ${i}\n\nFlowviant-Task: card-${i}`));
  const calls = answerFetch(t, 400);
  await obs.observe();
  assert.equal(readState(dir).tip, shas[49], 'advanced past the refused batch, not to the tip');
  await obs.observe();
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].commits.map((c) => c.sha), shas.slice(50), 'the remainder is still sent');
});
