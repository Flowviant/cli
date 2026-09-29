import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createWorkAgentReview } from './workAgentReview.mjs';
import { createWorkAgentCheck } from './workAgentCheck.mjs';
import { limitLine } from './cliLimit.mjs';
import { workModuleFiles } from './workModules.test.mjs';

/**
 * THE REVIEW ENTRY BEAT ONLY SEQUENCES (SOLID F039): the check first, then the
 * pre-review, and neither may throw past it. A failed check is a label on the
 * row, never a reason to skip the reading — and never a throw that would stop
 * `runAgentMerge` reporting a claimed merge after this returns.
 */
test('a check that fails (or throws) still lets the pre-review report, after it', async () => {
  const calls = [];
  const { runReviewEntry } = createWorkAgentReview({
    runCheck: async (agentId, wt) => {
      calls.push(['check', agentId, wt]);
      throw new Error('check exploded');
    },
    runPrecheck: async (agentId, wt, agentName) => {
      calls.push(['precheck', agentId, wt, agentName]);
    },
  });
  await runReviewEntry('a1', '/wt', 'Ada');
  assert.deepEqual(calls, [
    ['check', 'a1', '/wt'],
    ['precheck', 'a1', '/wt', 'Ada'],
  ]);
});

test('a pre-review that throws never escapes the beat', async () => {
  const { runReviewEntry } = createWorkAgentReview({
    runCheck: async () => {},
    runPrecheck: async () => {
      throw new Error('model call failed');
    },
  });
  await runReviewEntry('a1', '/wt', 'Ada'); // resolves
});

function repo(t) {
  const root = mkdtempSync(join(tmpdir(), 'fv-check-run-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], {
    cwd: root,
  });
  return root;
}

function checker(root) {
  const posts = [];
  const workChildren = new Map();
  const groupKillChildren = new Set();
  const { runCheck } = createWorkAgentCheck({
    repoRoot: root,
    postBestEffort: async (url, body) => {
      posts.push({ url, body });
    },
    workChildren,
    groupKillChildren,
  });
  return { runCheck, posts, workChildren, groupKillChildren };
}

test('no check.json is a measured "none", with the head it was measured at', async (t) => {
  const root = repo(t);
  const { runCheck, posts } = checker(root);
  await runCheck('a1', root);
  assert.equal(posts.length, 1);
  assert.match(posts[0].url, /\/agent-check-done$/);
  assert.equal(posts[0].body.status, 'none');
  assert.match(posts[0].body.headSha, /^[0-9a-f]{40}$/);
});

test('the repo command runs without the machine credential; its exit code is the verdict', async (t) => {
  const root = repo(t);
  mkdirSync(join(root, '.flowviant'));
  // Passes only when the credential is absent from the command's environment.
  writeFileSync(
    join(root, '.flowviant', 'check.json'),
    JSON.stringify({ command: 'test -z "$FLOWVIANT_MACHINE_TOKEN" && test -z "$FLOWVIANT_FLEET" && echo clean' })
  );
  process.env.FLOWVIANT_MACHINE_TOKEN = 'fva_machine';
  process.env.FLOWVIANT_FLEET = 'fva_fleet';
  try {
    const { runCheck, posts, workChildren } = checker(root);
    await runCheck('a1', root);
    assert.equal(posts[0].body.status, 'passed');
    assert.match(posts[0].body.output, /clean/);
    assert.equal(workChildren.size, 0, 'the child is untracked once it closes');

    writeFileSync(join(root, '.flowviant', 'check.json'), JSON.stringify({ command: 'echo nope; exit 3' }));
    const second = checker(root);
    await second.runCheck('a1', root);
    assert.equal(second.posts[0].body.status, 'failed');
    assert.match(second.posts[0].body.output, /nope/);
  } finally {
    delete process.env.FLOWVIANT_MACHINE_TOKEN;
    delete process.env.FLOWVIANT_FLEET;
  }
});

test('the limit trigger relays the CLI line verbatim, and nothing else', () => {
  assert.equal(limitLine('working…\n  Claude usage limit reached. Resets at 5pm  \nbye'), 'Claude usage limit reached. Resets at 5pm');
  assert.equal(limitLine('All done.'), null);
  assert.equal(limitLine(undefined), null);
});

/** CODE ONLY — comments name the workers they explain. */
const code = (file) =>
  readFileSync(new URL(`./${file}`, import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .join('\n');

test('each worker has one home and the entry beat owns neither', () => {
  // Every work lane by walk (a copy regrowing in any sibling counts, the agent
  // turn's run, wire, begun-guard and settlement of SOLID F036 included), plus
  // the limit rule's own home.
  const files = [...workModuleFiles(), 'cliLimit.mjs'];
  assert.ok(files.includes('workAgentPrecheck.mjs') && files.includes('workSessionTurns.mjs'), 'canary: the walk reaches the lanes');
  for (const f of ['workAgentTurnExecution.mjs', 'workAgentTurnOutcome.mjs', 'workAgentTurnReports.mjs', 'workAgentTurnBegun.mjs'])
    assert.ok(files.includes(f), `canary: the walk reaches ${f}`);
  const count = (re) => files.reduce((n, f) => n + (code(f).match(re) ?? []).length, 0);
  assert.equal(count(/const runCheck = /g), 1);
  assert.ok(code('workAgentCheck.mjs').includes('const runCheck = '));
  assert.equal(count(/const runPrecheck = /g), 1);
  assert.ok(code('workAgentPrecheck.mjs').includes('const runPrecheck = '));
  assert.equal(count(/const LIMIT_PHRASES = /g), 1);
  assert.ok(code('cliLimit.mjs').includes('const LIMIT_PHRASES = '));
  const entry = code('workAgentReview.mjs');
  assert.ok(!/^import /m.test(entry), 'the entry beat imports nothing: it is handed its two workers');
  assert.ok(!code('workAgentPrecheck.mjs').includes('spawn('), 'the pre-review never runs a repo command');
  assert.ok(!code('workAgentCheck.mjs').includes('runTurn('), 'the check never runs a model');
});
