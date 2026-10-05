import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * THE LANE SETTLES A RUN THAT THREW — ONCE — AND NEVER RUNS IT TWICE (SOLID F036).
 *
 * Before the split, a throw inside the run escaped `runAgentTurn` with nothing
 * posted: the turn stayed pending and every roster offer ran it again. These
 * cases drive the real lane (`createWorkAgentTurns` with the real run, the real
 * settlement decision and the real held-body wire) against a fake `claude` on
 * PATH that COMMITS before it answers — the side effect a re-run would repeat —
 * and a stubbed fetch. HOME is a scratch directory so nothing here can read the
 * operator's credential store or touch their daemon state.
 */
const root = mkdtempSync(join(tmpdir(), 'fv-agentturns-'));
process.on('exit', () => rmSync(root, { recursive: true, force: true }));
process.env.HOME = join(root, 'home');
mkdirSync(process.env.HOME);
const bin = join(root, 'bin');
mkdirSync(bin);
const spawns = join(root, 'spawns');
writeFileSync(
  join(bin, 'claude'),
  `#!/usr/bin/env node
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
fs.appendFileSync(${JSON.stringify(spawns)}, process.cwd() + '\\n');
try {
  execFileSync('git', ['rev-parse', '--verify', 'MERGE_HEAD'], { stdio: 'ignore' });
  fs.writeFileSync('a.txt', 'resolved agent and base\\n');
} catch { /* ordinary task */ }
fs.writeFileSync('work-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.txt', 'x');
execFileSync('git', ['add', '-A'], { stdio: 'ignore' });
execFileSync('git', ['commit', '-qm', 'agent work'], { stdio: 'ignore' });
const say = (ev) => process.stdout.write(JSON.stringify(ev) + '\\n');
say({ type: 'system', subtype: 'init', session_id: 'sess-1', skills: [], model: 'claude-opus-5-5' });
say({ type: 'result', subtype: 'success', usage: { input_tokens: 10, output_tokens: 5 },
  result: JSON.stringify({ status: 'delivered', summary: 'done' }) });
`
);
chmodSync(join(bin, 'claude'), 0o755);
process.env.PATH = `${bin}:${process.env.PATH}`;
const { createWorkAgentTurns } = await import('./workAgentTurns.mjs');
const { createWorkAgentMerges } = await import('./workAgentMerges.mjs');

const git = (args, cwd) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const spawned = () => (existsSync(spawns) ? readFileSync(spawns, 'utf8').trim().split('\n').filter(Boolean).length : 0);

/** A real repo, a real worktree per place, every other collaborator a stub. */
function lane(t, over = {}) {
  const repoRoot = mkdtempSync(join(root, 'repo-'));
  const baseDir = mkdtempSync(join(root, 'base-'));
  git(['init', '-q', '-b', 'main'], repoRoot);
  git(['config', 'user.email', 't@t.t'], repoRoot);
  git(['config', 'user.name', 'T'], repoRoot);
  writeFileSync(join(repoRoot, 'a.txt'), 'one');
  git(['add', '-A'], repoRoot);
  git(['commit', '-qm', 'base'], repoRoot);
  rmSync(spawns, { force: true });
  const admit = () => null;
  admit.reserve = () => () => {};
  const m = createWorkAgentTurns({
    REJECT_RETRY_MS: 60_000,
    baseRef: () => 'main',
    inPlace: async (_p, _w, fn) => fn(),
    baseDir,
    repoRoot,
    fetchPublishedBranch: () => null,
    placeWtFor: (place) => {
      const wt = join(baseDir, 'sessions', place);
      if (!existsSync(wt)) git(['worktree', 'add', '-q', '-b', `session/${place}`, wt, 'main'], repoRoot);
      return { wt };
    },
    sessionMetaPath: (wt, name, id = '') => join(baseDir, `${name}${id ? `-${id}` : ''}`),
    beforeArtifacts: () => new Map(),
    getArtifactsAccepted: () => false,
    noteSessionGroup: () => {},
    reportSessionWorktree: async () => {},
    artifacts: { report: async () => {} },
    runReviewEntry: async () => {},
    publishAgentBranch: async () => false,
    admit,
    workChildren: new Map(),
    agentPublished: new Map(),
    agentRemoteAt: new Map(),
    ...over,
  });
  return { m, repoRoot, baseDir };
}

/** Every POST, recorded; `mode` 'down' is a network error, `reply` the data. */
function stubFetch(t) {
  const real = globalThis.fetch;
  const calls = [];
  const state = { mode: 'ok', reply: {} };
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), body: typeof opts.body === 'string' ? JSON.parse(opts.body) : null });
    if (state.mode === 'down') throw new Error('network down');
    return { ok: true, status: 200, json: async () => ({ data: state.reply }) };
  };
  t.after(() => {
    globalThis.fetch = real;
  });
  return { calls, state };
}
const settles = (calls) => calls.filter((c) => c.url.includes('agent-turn-done'));
const until = async (cond, ms = 15_000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
};
const job = { id: 'at-1', agentId: 'ag-1', placeId: 'a-ag-1', kind: 'human', body: 'go', runtime: 'claude' };

test('conflict → real resolve turn → retry lands the committed resolution', async (t) => {
  const { m, repoRoot, baseDir } = lane(t);
  const { calls, state } = stubFetch(t);
  state.reply = { claimed: true };
  const wt = join(baseDir, 'sessions', job.placeId);
  git(['worktree', 'add', '-q', '-b', `session/${job.placeId}`, wt, 'main'], repoRoot);
  const change = (cwd, text) => {
    writeFileSync(join(cwd, 'a.txt'), text);
    git(['add', '.'], cwd);
    git(['commit', '-qm', 'change'], cwd);
  };
  change(wt, 'agent changed\\n');
  change(repoRoot, 'base changed\\n');
  let checks = 0;
  const merges = createWorkAgentMerges({
    repoRoot, baseDir, baseRef: () => 'main',
    inPlace: async (_p, _w, fn) => fn(), gitNet: (args) => git(args, repoRoot),
    runReviewEntry: async () => { checks++; }, onRepoChanged: () => {},
    landed: { observe() {} }, agentRemoteAt: new Map(), agentPublished: new Map(),
  });
  const mergeJob = { agentId: job.agentId, placeId: job.placeId, stale: true };
  const mergeReports = () => calls.filter((c) => c.url.includes('agent-merge-done'));
  // One person's approval; subsequent work is the server's resolve/retry jobs.
  merges.processAgentMergeJobs([mergeJob]);
  await until(() => mergeReports().length === 1 && merges.agentMerges.size === 0);
  assert.equal(mergeReports()[0].body.conflict, true);
  assert.match(mergeReports()[0].body.detail, /CONFLICT.*a\.txt/);
  m.processAgentTurnJobs([{ ...job, kind: 'merge_resolve', body: 'Resolve and commit the conflict.' }]);
  await until(() => settles(calls).length === 1 && m.agentTurns.size === 0);
  const resolved = settles(calls)[0].body;
  assert.equal(resolved.outcome, 'delivered');
  assert.equal(resolved.mergeResolved, true, 'the real turn wire carries committed resolution evidence');
  assert.equal(resolved.commits, undefined, 'the resolution merge is not a card receipt');
  const tip = git(['rev-parse', 'HEAD'], wt);
  // The API test verifies this handout is queued without a second approval.
  merges.processAgentMergeJobs([mergeJob]);
  await until(() => mergeReports().length === 2 && merges.agentMerges.size === 0);
  assert.equal(mergeReports()[1].body.ok, true);
  assert.equal(checks, 1, 'the resolved tree is checked before landing');
  git(['merge-base', '--is-ancestor', tip, 'main'], repoRoot);
});

test('a run that throws after the CLI committed settles nothing once, and a re-offer re-POSTs — never re-runs', async (t) => {
  const { m, baseDir } = lane(t, {
    // A synchronous throw from a hook that runs after the CLI exits — the
    // shape of every escape the lane used to leave unsettled.
    artifacts: {
      report: () => {
        throw new Error('the artifact reporter broke');
      },
    },
  });
  const { calls, state } = stubFetch(t);
  state.mode = 'down';
  m.processAgentTurnJobs([job]);
  await until(() => settles(calls).length >= 1 && m.agentTurns.size === 0);
  assert.equal(spawned(), 1, 'canary: the CLI really ran');
  const [first] = settles(calls);
  const wt = join(baseDir, 'sessions', 'a-ag-1');
  assert.equal(first.body.turnId, 'at-1');
  assert.equal(first.body.outcome, 'nothing');
  assert.equal(first.body.answer, 'This machine could not finish the turn: the artifact reporter broke');
  // What the run measured before it threw rides along — the commit the CLI
  // made is on the branch and the report says so.
  assert.deepEqual(first.body.commits, [git(['rev-parse', 'HEAD'], wt)]);
  assert.equal(first.body.branch, 'session/a-ag-1');
  assert.equal(first.body.worktree, wt);
  assert.equal(first.body.usage?.runtime, 'claude', 'the CLI counted a spend, so the settle carries it');
  assert.equal(first.body.model, 'claude-opus-5-5', 'the CLI named its model, so the settle carries it');
  assert.equal(m.agentReported.has('at-1'), true, 'the unsent body is held');

  // The roster offers the same turn again: the held body goes, the CLI does not.
  state.mode = 'ok';
  m.processAgentTurnJobs([job]);
  await until(() => settles(calls).length >= 2 && m.agentTurns.size === 0);
  assert.deepEqual(settles(calls)[1].body, first.body, 'the same answer, re-sent');
  assert.equal(spawned(), 1, 'the CLI is never run a second time');
  assert.equal(m.agentReported.has('at-1'), false, 'delivered, so no longer held');
});

test('a throw AFTER the settle posts nothing more — the answer already sent outranks the crash', async (t) => {
  let beats = 0;
  const { m } = lane(t, {
    runReviewEntry: async () => {
      beats += 1;
      throw new Error('the check broke');
    },
  });
  const { calls, state } = stubFetch(t);
  state.reply = { review: true }; // the queue just emptied
  m.processAgentTurnJobs([job]);
  await until(() => beats === 1 && m.agentTurns.size === 0);
  const sent = settles(calls);
  assert.equal(sent.length, 1, 'exactly one settle');
  assert.equal(sent[0].body.outcome, 'delivered');
  assert.equal(sent[0].body.answer, 'done');
  assert.equal(sent[0].body.model, 'claude-opus-5-5', "the init's model rides the delivered settle");
});

test('a throw before the CLI settles nothing once, claiming no spend and no commits', async (t) => {
  let asked = 0;
  const { m, baseDir } = lane(t, {
    beforeArtifacts: () => {
      asked += 1;
      throw new Error('snapshot failed');
    },
  });
  const { calls } = stubFetch(t);
  m.processAgentTurnJobs([job]);
  await until(() => settles(calls).length >= 1 && m.agentTurns.size === 0);
  assert.equal(spawned(), 0, 'nothing ran');
  assert.equal(asked, 1);
  const [s] = settles(calls);
  assert.equal(settles(calls).length, 1);
  assert.equal(s.body.answer, 'This machine could not finish the turn: snapshot failed');
  assert.equal('usage' in s.body, false, 'no CLI, no spend');
  assert.equal('model' in s.body, false, 'no CLI, no model');
  assert.equal('commits' in s.body, false, 'no commits past the turn\'s start');
  assert.equal(s.body.worktree, join(baseDir, 'sessions', 'a-ag-1'), 'the worktree was measured, so it is named');
});
