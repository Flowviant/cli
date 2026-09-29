/**
 * THE LIVING-WIKI RUNNER, DRIVEN (2026-09-26, SOLID F038).
 *
 * The runner was a closure inside `runFleetDaemon` until the split, so its
 * only proofs were source pins. Here it runs for real against a real git
 * checkout and a real `node:http` server standing in for the API: only the CLI
 * turn itself is faked (`runTurn`), because a test must not spend a model turn.
 *
 * What is proved is the lane's contract with the loop that owns it:
 *   · a held admission leaves the queue INTACT (nothing claimed, nothing run);
 *   · while a turn runs the lane counts as busy and as one live CLI, and the
 *     machine's own report keeps posting on the same beat;
 *   · a completed sweep syncs the vault and clears the busy flag;
 *   · a re-ground resolves the shipped commit's files and consumes its job.
 *
 * The LOOP's half — the tick that hands the runner its roster also reports the
 * machine, and keeps reporting while the sweep is held — is driven through the
 * real daemon in fleet.test.mjs.
 *
 * Run: node --test bin/lib/wikiRunner.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// HOME and the server URL are settled BEFORE anything imports config.mjs:
// every endpoint is derived from FLEET_URL at import, and the vault lives
// under HOME.
process.env.HOME = mkdtempSync(join(tmpdir(), 'fv-wiki-home-'));

const received = [];
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => {
    body += c;
  });
  req.on('end', () => {
    received.push({ url: req.url, body });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, data: {} }));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
process.env.FLOWVIANT_FLEET_URL = `http://127.0.0.1:${server.address().port}/api/fleet/agents`;
process.env.FLOWVIANT_FLEET = 'fva_test_credential';
test.after(() => server.close());

const { createWikiRunner } = await import('./wikiRunner.mjs');
const { reportMachine } = await import('./fleetReports.mjs');

const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

/** A checkout with one commit, and the sha of that commit. */
function checkout() {
  const dir = mkdtempSync(join(tmpdir(), 'fv-wiki-repo-'));
  git(['init', '-q'], dir);
  git(['config', 'user.email', 't@example.com'], dir);
  git(['config', 'user.name', 'T'], dir);
  writeFileSync(join(dir, 'app.js'), 'export const x = 1;\n');
  git(['add', '-A'], dir);
  git(['commit', '-q', '-m', 'first'], dir);
  return { dir, sha: git(['rev-parse', 'HEAD'], dir) };
}

/** A CLI turn held open until the test says so. */
function heldTurn() {
  const calls = [];
  let release;
  const runTurn = (opts) => {
    calls.push(opts);
    opts.onSpawn?.({ kill() {} });
    opts.onActivity?.({ kind: 'read', label: 'reading app.js' });
    // The turn writes a page into the vault it was handed, as the real
    // cartographer does.
    writeFileSync(join(opts.vaultDir, 'overview.md'), '# Overview\n');
    return new Promise((resolve) => {
      release = resolve;
    });
  };
  return { calls, runTurn, finish: (out) => release(out) };
}

const until = async (cond, what) => {
  for (let i = 0; i < 400; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail(`timed out waiting for ${what}`);
};

test('a held admission leaves the queue intact; the next drain runs it', async () => {
  const repo = checkout();
  const turn = heldTurn();
  let hold = { reason: 'the machine is already running 1 CLI turn' };
  const wiki = createWikiRunner({
    repoRoot: repo.dir,
    baseDir: mkdtempSync(join(tmpdir(), 'fv-wiki-base-')),
    repoKey: 'held',
    getBaseRef: () => 'HEAD',
    admit: () => hold,
    runTurn: turn.runTurn,
    pickRuntimeFor: () => 'claude',
  });
  wiki.onRoster({ codeMapJob: { requestedAt: 'r1' } });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(turn.calls.length, 0, 'nothing ran under a held admission');
  assert.equal(wiki.busy(), false, 'the busy flag was not set and stranded');
  assert.equal(wiki.liveTurns(), 0);

  hold = null;
  void wiki.drainWiki();
  await until(() => turn.calls.length === 1, 'the queued sweep to start');
  turn.finish('WIKI_DONE');
  await until(() => !wiki.busy(), 'the drain to finish');
});

test('a wiki sweep runs while the machine report keeps posting, then syncs and goes idle', async () => {
  const repo = checkout();
  const baseDir = mkdtempSync(join(tmpdir(), 'fv-wiki-base-'));
  const turn = heldTurn();
  const wiki = createWikiRunner({
    repoRoot: repo.dir,
    baseDir,
    repoKey: 'sweep',
    getBaseRef: () => 'HEAD',
    admit: () => null,
    runTurn: turn.runTurn,
    pickRuntimeFor: () => 'claude',
  });
  wiki.setProjectId('proj-1');
  received.length = 0;

  wiki.onRoster({ codeMapJob: { requestedAt: 'r1' }, regroundJobs: [] });
  await until(() => turn.calls.length === 1, 'the sweep turn to spawn');
  // Mid-turn: the lane is working and counts as one live CLI…
  assert.equal(wiki.busy(), true);
  assert.equal(wiki.liveTurns(), 1);
  assert.equal(turn.calls[0].profile, 'wiki');
  assert.equal(turn.calls[0].cwd, join(baseDir, 'wiki'), 'the shared wiki worktree');
  assert.equal(turn.calls[0].vaultDir, join(process.env.HOME, '.flowviant', 'vaults', 'proj-1'));
  // …and the machine's own report is not held behind it.
  reportMachine({ worktreeDir: baseDir, liveTurns: () => [] });
  await until(() => received.some((r) => r.url === '/api/fleet/machine'), 'the machine report');
  assert.ok(received.some((r) => r.url === '/api/fleet/wiki-progress'), 'progress streamed mid-turn');
  // The same Regenerate offered again while it runs is not queued twice.
  wiki.onRoster({ codeMapJob: { requestedAt: 'r1' } });
  assert.equal(turn.calls.length, 1);

  turn.finish('narration\nWIKI_DONE\n');
  await until(() => !wiki.busy(), 'the drain to finish');
  assert.equal(wiki.liveTurns(), 0);
  const sync = received.filter((r) => r.url === '/api/fleet/wiki-vault');
  assert.ok(sync.length >= 1, 'the vault was synced');
  assert.ok(sync.some((r) => r.body.includes('overview.md')), 'with the page the turn wrote');
  const frames = received.filter((r) => r.url === '/api/fleet/wiki-progress').map((r) => JSON.parse(r.body));
  assert.equal(frames.at(-1).done, true, 'a terminal frame clears the canvas cover');
  assert.equal(received.filter((r) => r.url === '/api/fleet/wiki-abandoned').length, 0);
});

test('a re-ground reads the shipped commit and consumes its job', async () => {
  const repo = checkout();
  const turn = heldTurn();
  const wiki = createWikiRunner({
    repoRoot: repo.dir,
    baseDir: mkdtempSync(join(tmpdir(), 'fv-wiki-base-')),
    repoKey: 'reground',
    getBaseRef: () => 'HEAD',
    admit: () => null,
    runTurn: turn.runTurn,
    pickRuntimeFor: () => 'claude',
  });
  received.length = 0;
  wiki.onRoster({
    regroundJobs: [null, { taskId: 'task-1', title: 'Ship x', shas: [repo.sha], dirtiesPages: ['a\u0007b'] }],
  });
  await until(() => turn.calls.length === 1, 'the re-ground turn');
  assert.ok(turn.calls[0].prompt.includes('app.js'), 'the changed file reaches the prompt');
  turn.finish('REGROUND_DONE');
  await until(() => !wiki.busy(), 'the drain to finish');
  const done = received.filter((r) => r.url === '/api/fleet/reground-done');
  assert.equal(done.length, 1);
  assert.deepEqual(JSON.parse(done[0].body), { taskId: 'task-1' });
});

/**
 * WHAT A WIKI TURN SPENT RIDES ITS DONE FRAME, AND ONLY THAT ONE (2026-09-28).
 * The done frame is sent exactly once per task, which is what lets the server
 * charge it without a claim; the throttled mid-turn frames stay a readout.
 */
test('a sweep and a re-ground each put their turn\'s usage on the done frame alone, tagged with the CLI', async () => {
  const repo = checkout();
  const spent = { input: 30, output: 900, cacheCreate: 1200, cacheRead: 88000 };
  const runTurn = async (opts) => {
    opts.onActivity?.({ kind: 'read', label: 'reading app.js' });
    opts.onUsage?.(spent);
    writeFileSync(join(opts.vaultDir, 'overview.md'), '# Overview\n');
    return 'WIKI_DONE\nREGROUND_DONE\n';
  };
  const wiki = createWikiRunner({
    repoRoot: repo.dir,
    baseDir: mkdtempSync(join(tmpdir(), 'fv-wiki-base-')),
    repoKey: 'spend',
    getBaseRef: () => 'HEAD',
    admit: () => null,
    runTurn,
    pickRuntimeFor: () => 'codex',
  });
  for (const roster of [
    { codeMapJob: { requestedAt: 'spend-1' } },
    { regroundJobs: [{ taskId: 'task-spend', title: 'Ship y', shas: [repo.sha] }] },
  ]) {
    received.length = 0;
    wiki.onRoster(roster);
    await until(() => received.some((r) => r.url === '/api/fleet/wiki-progress' && JSON.parse(r.body).done), 'the done frame');
    await until(() => !wiki.busy(), 'the drain to finish');
    const frames = received.filter((r) => r.url === '/api/fleet/wiki-progress').map((r) => JSON.parse(r.body));
    assert.ok(frames.length >= 2, 'canary: mid-turn frames went out too');
    const done = frames.filter((f) => f.done);
    assert.equal(done.length, 1);
    assert.deepEqual(done[0].usage, { ...spent, runtime: 'codex' });
    assert.ok(frames.filter((f) => !f.done).every((f) => !('usage' in f)), 'no mid-turn frame charges anything');
  }
});

/**
 * ONE HOME FOR THE WIKI LANE, over the whole daemon: a second cartographer
 * drain in work.mjs would pass a pin that read only the loop. Keyed on the
 * lane's shape — the cartographer's prompt CALLED (prompts.mjs defines it), a
 * vault sync CALLED (vault.mjs defines it), a turn run under the `wiki`
 * profile — with a canary that the walk found the daemon and the home.
 */
test('the wiki lane has one home across the daemon: the loop runs no cartographer of its own', () => {
  const dirs = [new URL('./', import.meta.url), new URL('../', import.meta.url)];
  const code = (src) =>
    src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((l) => !/^\s*\/\//.test(l))
      .join('\n');
  const files = dirs.flatMap((d) =>
    readdirSync(d)
      .filter((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs'))
      .map((f) => ({ f, src: code(readFileSync(new URL(f, d), 'utf8')) }))
  );
  assert.ok(files.length > 40 && files.some((x) => x.f === 'fleet.mjs'), 'the walk found the daemon (canary)');
  const where = (re) => files.filter((x) => re.test(x.src)).map((x) => x.f);
  assert.deepEqual(where(/async function drainWiki\(\)/), ['wikiRunner.mjs'], 'canary: the drain lives here');
  assert.deepEqual(where(/SYSTEM_WIKI\(/), ['wikiRunner.mjs'], 'one lane speaks the cartographer prompt');
  assert.deepEqual(where(/(?<!function )syncVault\(/), ['wikiRunner.mjs'], 'one lane syncs the vault');
  assert.deepEqual(where(/profile:\s*'wiki'/), ['wikiRunner.mjs'], 'one lane runs wiki turns');
  const fleet = files.find((x) => x.f === 'fleet.mjs').src;
  assert.ok(!/wikiQueue|drainWiki/.test(fleet), 'the loop holds no wiki queue');
  assert.ok(fleet.includes('wiki.onRoster(roster);'), 'the loop hands the runner its roster');
});
