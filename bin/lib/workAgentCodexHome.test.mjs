import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

/**
 * A CODEX AGENT'S NEXT TURN FINDS ITS THREAD (2026-09-29), through the real
 * agent lane — worktree, preparation, spawn, resume, settle, marker — against
 * a fake `codex` that keeps Codex 0.156's one habit the bug lived in: its
 * thread index (shared through the home's link, as `state_5.sqlite` is) files
 * each rollout under the CODEX_HOME in force, AS THAT PATH, and a resume whose
 * filed path is gone fails "no rollout found" on stderr, exit 1, no event.
 *
 * The old lane gave every turn a home in /tmp that died with it: the second
 * turn's resume failed, no resume-lost phrase matched Codex's words, and the
 * agent settled `nothing` — Stuck. Both cases below fail on that code.
 *
 * A file of its own, because the fake rides PATH for the whole process. HOME
 * is a scratch one, so a turn that settles cannot touch this box's daemon
 * state; TMPDIR is a scratch one too, so "not under the temp dir" is a claim
 * about the home and not about where the test put the repository.
 */
const scratch = mkdtempSync(join(tmpdir(), 'fv-codex-lane-'));
process.on('exit', () => rmSync(scratch, { recursive: true, force: true }));
for (const d of ['bin', 'home', 'tmp', 'personal/sessions']) mkdirSync(join(scratch, d), { recursive: true });
process.env.HOME = join(scratch, 'home');
process.env.TMPDIR = join(scratch, 'tmp');
const personal = join(scratch, 'personal');
process.env.CODEX_HOME = personal;
const index = join(personal, 'index.json');
writeFileSync(index, '{}');
const spawns = join(scratch, 'spawns');
const LOST_WARNING =
  'WARNING: proceeding, even though we could not create PATH aliases: Refusing to create helper binaries under temporary dir "/tmp" (codex_home: AbsolutePathBuf("/tmp/flowviant-agent-tools-BEpCig/codex-home"))';
writeFileSync(
  join(scratch, 'bin', 'codex'),
  `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const argv = process.argv.slice(2);
const home = process.env.CODEX_HOME;
const index = path.join(home, 'index.json'); // reached through the home's link
const threads = JSON.parse(fs.readFileSync(index, 'utf8'));
const log = (thread) => fs.appendFileSync(${JSON.stringify(spawns)}, JSON.stringify({ argv, home, thread }) + '\\n');
const at = argv.indexOf('resume');
let id;
if (at >= 0) {
  id = argv[at + 1];
  if (!threads[id] || !fs.existsSync(threads[id])) {
    log(null);
    process.stderr.write(${JSON.stringify(LOST_WARNING)} + '\\nError: thread/resume: thread/resume failed: no rollout found for thread id ' + id + ' (code -32600)\\n');
    process.exit(1);
  }
} else {
  id = require('node:crypto').randomUUID();
  // Filed under the home in force, unresolved — Codex 0.156's own habit.
  threads[id] = path.join(home, 'sessions', 'rollout-' + id + '.jsonl');
  fs.writeFileSync(threads[id], '{}\\n');
  fs.writeFileSync(index, JSON.stringify(threads));
}
log(id);
const say = (ev) => process.stdout.write(JSON.stringify(ev) + '\\n');
say({ type: 'thread.started', thread_id: id });
say({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ status: 'delivered', summary: 'done on ' + id }) } });
say({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });
`
);
chmodSync(join(scratch, 'bin', 'codex'), 0o755);
process.env.PATH = `${join(scratch, 'bin')}:${process.env.PATH}`;
const { createWorkManager } = await import('./work.mjs');

const git = (args, cwd) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function managerIn(t) {
  const repoRoot = mkdtempSync(join(scratch, 'repo-'));
  git(['init', '-q', '-b', 'main'], repoRoot);
  git(['config', 'user.email', 't@t.t'], repoRoot);
  git(['config', 'user.name', 'T'], repoRoot);
  writeFileSync(join(repoRoot, 'a.txt'), 'one');
  git(['add', '-A'], repoRoot);
  git(['commit', '-qm', 'base'], repoRoot);
  const baseDir = mkdtempSync(join(scratch, 'base-'));
  const m = createWorkManager({
    repoRoot,
    baseDir,
    getBaseRef: () => 'main',
    getMcpUrl: () => 'http://127.0.0.1:0/mcp',
    getLeaseTtl: () => 60,
  });
  t.after(() => {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(baseDir, { recursive: true, force: true });
  });
  return { m, repoRoot, baseDir };
}

function stubFetch(t) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), body: typeof opts.body === 'string' ? JSON.parse(opts.body) : null });
    return { ok: true, status: 200, json: async () => ({ data: { claimed: true } }) };
  };
  t.after(() => {
    globalThis.fetch = real;
  });
  return calls;
}

const until = async (cond, ms = 10_000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
};
const spawned = () =>
  existsSync(spawns) ? readFileSync(spawns, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
const settles = (calls) => calls.filter((c) => c.url.includes('agent-turn-done')).map((c) => c.body);
const CARD = { id: 'card-1', title: 'Make the header', description: 'A header.' };
const job = (id, agentId, extra) => ({ id, agentId, placeId: `a-${agentId}`, runtime: 'codex', agentName: 'Ada', ...extra });
const gitDir = (wt) => git(['rev-parse', '--absolute-git-dir'], wt);

test("a Codex agent's next turn resumes its thread from the home it keeps, and the home goes with its worktree", async (t) => {
  const { m, baseDir } = managerIn(t);
  const calls = stubFetch(t);
  rmSync(spawns, { force: true });
  m.processAgentTurnJobs([job('at-1', 'ag1', { kind: 'task', task: CARD })]);
  await until(() => settles(calls).length === 1 && !m.workBusy());
  m.processAgentTurnJobs([job('at-2', 'ag1', { kind: 'human', body: 'and the footer too', task: CARD })]);
  await until(() => settles(calls).length === 2 && !m.workBusy());

  const [first, second, ...more] = spawned();
  assert.deepEqual(more, [], 'one CLI per turn: the resume found its thread');
  assert.ok(!first.argv.includes('resume'), 'canary: the first turn starts a thread');
  assert.deepEqual(second.argv.slice(1, 3), ['resume', first.thread], 'the second resumes it by id');
  assert.equal(second.thread, first.thread);
  const wt = join(baseDir, 'sessions', 'a-ag1');
  const home = join(gitDir(wt), 'flowviant-agent-codex-home-ag1');
  assert.equal(first.home, home, "the agent's home, in its worktree's private git dir");
  assert.equal(second.home, home, 'the same home, turn after turn');
  assert.ok(!home.startsWith(tmpdir() + sep), 'never under the temp dir');
  assert.deepEqual(settles(calls).map((s) => s.outcome), ['delivered', 'delivered']);
  assert.equal(readFileSync(join(gitDir(wt), 'flowviant-agent-codex-thread-ag1'), 'utf8'), first.thread);

  // The agent retires: it drops out of the live list, and its worktree — the
  // home inside its git dir with it — is removed. The person's store, which
  // the home only linked to, keeps the rollout.
  m.retireWorkSessions([], []);
  assert.ok(!existsSync(wt), 'canary: the worktree was retired');
  assert.ok(!existsSync(home), 'the home went with it');
  assert.ok(existsSync(join(personal, 'sessions', `rollout-${first.thread}.jsonl`)), 'nothing was followed out of it');
});

test('a thread filed under a home that is gone runs the turn once fresh and pins the new thread', async (t) => {
  const { m, repoRoot, baseDir } = managerIn(t);
  const calls = stubFetch(t);
  rmSync(spawns, { force: true });
  // An agent from before this fix: its worktree, its pinned thread, and the
  // thread's rollout filed under a per-turn home that no longer exists.
  const wt = join(baseDir, 'sessions', 'a-ag2');
  mkdirSync(join(baseDir, 'sessions'), { recursive: true });
  git(['worktree', 'add', '-q', '-b', 'session/a-ag2', wt, 'main'], repoRoot);
  const marker = join(gitDir(wt), 'flowviant-agent-codex-thread-ag2');
  writeFileSync(marker, 'deadthread0001');
  const threads = JSON.parse(readFileSync(index, 'utf8'));
  threads.deadthread0001 = '/tmp/flowviant-agent-tools-GONE00/codex-home/sessions/rollout-deadthread0001.jsonl';
  writeFileSync(index, JSON.stringify(threads));

  m.processAgentTurnJobs([job('at-3', 'ag2', { kind: 'task', task: CARD })]);
  await until(() => settles(calls).length === 1);
  // Not busy afterwards: BOTH children the turn spawned are let go, not only
  // the retry's — a leaked first one held the machine busy for ever.
  await until(() => !m.workBusy(), 3_000).catch(() =>
    assert.fail(`still busy after the turn, ${m.liveTurnCount()} live turn(s): a spawned child was never let go`)
  );
  assert.equal(m.liveTurnCount(), 0, 'no phantom live turn left behind');

  const [lost, fresh, ...more] = spawned();
  assert.deepEqual(more, [], 'once fresh, never twice');
  assert.deepEqual(lost.argv.slice(1, 3), ['resume', 'deadthread0001'], 'canary: it resumed the dead thread first');
  assert.equal(lost.thread, null);
  assert.ok(!fresh.argv.includes('resume'), 'the retry is a fresh thread');
  assert.equal(fresh.home, lost.home, 'in the same home and the same worktree');
  const [settle] = settles(calls);
  assert.equal(settle.outcome, 'delivered', 'not Stuck');
  assert.match(settle.answer, new RegExp(`done on ${fresh.thread}`));
  assert.equal(readFileSync(marker, 'utf8'), fresh.thread, 'the new thread is pinned for the next card');
});
