/**
 * THE SHARED GITHUB RULES (SOLID audit 2026-09-26, F040), against a scripted
 * `gh` and a scripted `git` — adopt only an open PR into base, create with
 * `--fill`, merge with `--merge`, and believe "merged" only once the tip is
 * measured on base, including when the fetch lags GitHub's merge.
 *
 * Both callers are driven elsewhere, end to end with a fake `gh` on PATH: the
 * session lane in prBase.test.mjs, the agent approve path in
 * agentMergePr.test.mjs. The pins at the foot keep the rules from growing a
 * second copy in either — or a third merge anywhere in the daemon.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import {
  ensureOpenPr,
  findOpenPr,
  ghFirstLine,
  ghReady,
  mergeAndVerifyTip,
  PR_URL_RE,
  prTargetsOtherBase,
  tipReachedBase,
} from './prWorkflow.mjs';

/** A `gh` that answers from a table keyed on "verb noun" and logs each call. */
function fakeGh(answers) {
  const calls = [];
  const gh = (args, opts) => {
    calls.push({ args, opts });
    const key = `${args[0]} ${args[1]}`;
    const a = answers[key];
    if (a instanceof Error) throw a;
    if (typeof a === 'function') return Buffer.from(a(args));
    return Buffer.from(a ?? '');
  };
  return { gh, calls, verbs: () => calls.map((c) => `${c.args[0]} ${c.args[1]}`) };
}
const ghError = (stderr, code) => Object.assign(new Error('gh failed'), { stderr: Buffer.from(stderr), code });
const view = (o) => JSON.stringify({ url: 'https://github.com/o/r/pull/7', state: 'OPEN', baseRefName: 'main', ...o });

test('only an OPEN pull request is found, and gh saying nothing is "none"', () => {
  assert.deepEqual(findOpenPr('b', { gh: fakeGh({ 'pr view': view() }).gh }), {
    url: 'https://github.com/o/r/pull/7',
    base: 'main',
  });
  assert.equal(findOpenPr('b', { gh: fakeGh({ 'pr view': view({ state: 'MERGED' }) }).gh }), null);
  assert.equal(findOpenPr('b', { gh: fakeGh({ 'pr view': ghError('no pull requests found') }).gh }), null);
  assert.deepEqual(findOpenPr('b', { gh: fakeGh({ 'pr view': view({ baseRefName: undefined }) }).gh }).base, null);
});

test('a PR retargeted at another branch is refused and nothing is created; an unmeasured base adopts', () => {
  const retargeted = fakeGh({ 'pr view': view({ baseRefName: 'staging' }) });
  assert.deepEqual(ensureOpenPr('flowviant/x', 'main', { cwd: '/r', gh: retargeted.gh }), { wrongBase: 'staging' });
  assert.deepEqual(retargeted.verbs(), ['pr view'], 'never created, never merged');
  for (const base of [undefined, '']) {
    const adopt = fakeGh({ 'pr view': view({ baseRefName: base }) });
    assert.deepEqual(ensureOpenPr('b', 'main', { gh: adopt.gh }), { url: 'https://github.com/o/r/pull/7', adopted: true });
    assert.deepEqual(adopt.verbs(), ['pr view']);
  }
  assert.equal(prTargetsOtherBase(null, 'main'), null);
  assert.equal(prTargetsOtherBase({ base: 'main' }, 'main'), null);
});

test('no open PR: one is created from the branch’s own commits, into the base branch name', () => {
  const g = fakeGh({
    'pr view': view({ state: 'CLOSED' }),
    'pr create': 'Creating pull request…\nhttps://github.com/o/r/pull/8\n',
  });
  const r = ensureOpenPr('flowviant/x', 'main', { cwd: '/repo', gh: g.gh });
  assert.deepEqual(r, { url: 'https://github.com/o/r/pull/8', adopted: false });
  const create = g.calls.find((c) => c.args[1] === 'create');
  assert.deepEqual(create.args, ['pr', 'create', '--head', 'flowviant/x', '--base', 'main', '--fill']);
  assert.equal(create.opts.cwd, '/repo');
  assert.ok(create.opts.timeout > 0, 'every gh call is timed');
  const refused = fakeGh({ 'pr view': ghError('none'), 'pr create': ghError('\nGraphQL: base invalid (createPullRequest)\n') });
  assert.deepEqual(ensureOpenPr('b', 'main', { gh: refused.gh }), { error: 'GraphQL: base invalid (createPullRequest)' });
});

/** A git that says "not yet" `lag` times before the tip is on base. */
function lagging(lag) {
  let asked = 0;
  const gitImpl = (args) => {
    assert.deepEqual(args.slice(0, 2), ['merge-base', '--is-ancestor']);
    asked++;
    if (asked <= lag) throw new Error('not an ancestor');
    return '';
  };
  return { gitImpl, asked: () => asked };
}

test('a merge is believed only once base has the tip — one retry for a fetch that lags GitHub', async () => {
  const fetches = [];
  const sleeps = [];
  const late = lagging(1);
  const r = await mergeAndVerifyTip('b', {
    cwd: '/r',
    tip: 'abc1234',
    baseRef: () => 'origin/main',
    repoRoot: '/r',
    fetchOrigin: () => fetches.push('fetch'),
    sleep: async (ms) => sleeps.push(ms),
    gitImpl: late.gitImpl,
    gh: fakeGh({ 'pr merge': '' }).gh,
  });
  assert.deepEqual(r, { ok: true });
  assert.deepEqual(fetches, ['fetch', 'fetch']);
  assert.deepEqual(sleeps, [2000]);

  const never = lagging(99);
  const stale = await mergeAndVerifyTip('b', {
    tip: 'abc1234',
    baseRef: () => 'origin/main',
    fetchOrigin: () => {
      throw new Error('offline');
    },
    sleep: async () => {},
    gitImpl: never.gitImpl,
    gh: fakeGh({ 'pr merge': '' }).gh,
  });
  assert.deepEqual(stale, { notOnBase: true }, 'gh exiting 0 is not the fact "merged" claims');
  assert.equal(never.asked(), 2, 'one retry, then the honest answer');
});

test('"already merged" is a success still verified; any other refusal is gh’s own words', async () => {
  const base = { tip: 'abc1234', baseRef: () => 'main', fetchOrigin: () => {}, sleep: async () => {} };
  const merged = await mergeAndVerifyTip('b', {
    ...base,
    gitImpl: lagging(0).gitImpl,
    gh: fakeGh({ 'pr merge': ghError('! Pull request #7 was already merged') }).gh,
  });
  assert.deepEqual(merged, { ok: true });
  const refused = fakeGh({ 'pr merge': ghError('X Pull request #7 is not mergeable: the merge commit cannot be cleanly created.') });
  const r = await mergeAndVerifyTip('b', { ...base, gitImpl: lagging(0).gitImpl, gh: refused.gh });
  assert.deepEqual(r, { error: 'X Pull request #7 is not mergeable: the merge commit cannot be cleanly created.' });
  assert.deepEqual(refused.calls[0].args, ['pr', 'merge', 'b', '--merge'], 'a merge commit, never squash');
  assert.equal(await tipReachedBase({ ...base, tip: null, gitImpl: () => '' }), false, 'no tip is never on base');
});

test('gh missing and gh signed out are told apart', () => {
  assert.equal(ghReady({ gh: () => '' }), null);
  assert.deepEqual(ghReady({ gh: () => { throw ghError('', 'ENOENT'); } }), { missing: true, error: 'gh failed' });
  assert.deepEqual(ghReady({ gh: () => { throw ghError('You are not logged into any GitHub hosts.'); } }), {
    missing: false,
    error: 'You are not logged into any GitHub hosts.',
  });
  assert.equal(ghFirstLine({}), 'failed');
  assert.ok(PR_URL_RE.test('https://github.com/o/r/pull/12'));
  assert.ok(!PR_URL_RE.test('Creating pull request for x into main'));
});

/** CODE ONLY — the callers' comments still describe the rules they follow. */
const code = (f) =>
  readFileSync(new URL(`./${f}`, import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .join('\n');

test('neither merge path spells a GitHub rule of its own', () => {
  const shared = code('prWorkflow.mjs');
  assert.ok(shared.includes("'--fill'") && shared.includes('already merged'), 'reading the real rules (canary)');
  for (const f of ['workPullRequests.mjs', 'workAgentMerges.mjs']) {
    const src = code(f);
    assert.ok(src.includes("from './prWorkflow.mjs'"), `${f} imports the shared rules`);
    for (const banned of ["'--fill'", 'already merged', "'auth', 'status'", "'pr', 'view'", "'pr', 'merge'", "'--is-ancestor'", "state !== 'OPEN'", "state === 'OPEN'"]) {
      assert.ok(!src.includes(banned), `${f} spells ${banned} again`);
    }
  }
});

/**
 * ONE `gh pr merge` IN THE DAEMON (review 2026-09-26). The dispatch-era merge
 * lane in fleet.mjs ran `gh pr merge --squash` outside this file for months
 * after the never-squash law, unseen by a pin that read only the two callers.
 * So the walk covers every module under bin/.
 */
test('the daemon merges a pull request in one place, and never squashes', () => {
  const dirs = ['../', './'];
  const files = dirs.flatMap((d) =>
    readdirSync(new URL(d, import.meta.url))
      .filter((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs'))
      .map((f) => `${d}${f}`)
  );
  assert.ok(files.includes('./prWorkflow.mjs') && files.includes('./fleet.mjs') && files.includes('../cli.mjs'), 'the walk found the tree (canary)');
  const merging = files.filter((f) => code(f).includes("'pr', 'merge'"));
  assert.deepEqual(merging, ['./prWorkflow.mjs']);
  const squashing = files.filter((f) => code(f).includes("'--squash'"));
  assert.deepEqual(squashing, []);
});
