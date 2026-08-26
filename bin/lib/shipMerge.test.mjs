import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeOutward, isRaceRejection } from './shipMerge.mjs';

/**
 * AGAINST REAL GIT, with a real bare remote and two real clones.
 *
 * Both behaviours under test are about what git DOES when two writers meet —
 * a rejected push, a fast-forwardable branch — and a mock of git is a mock of
 * exactly the thing in question. `shipSweep.test.mjs` made the same call for
 * the same reason.
 */

const G = (args, cwd) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const ID = [
  '-c', 'user.email=t@t.t', '-c', 'user.name=T',
  '-c', 'commit.gpgsign=false',
];
const g = (args, cwd) => G([...ID, ...args], cwd);

function world() {
  const root = mkdtempSync(join(tmpdir(), 'shipmerge-'));
  const origin = join(root, 'origin.git');
  G(['init', '--bare', '-b', 'main', origin], root);

  const mine = join(root, 'mine');
  G(['clone', origin, mine], root);
  writeFileSync(join(mine, 'a.txt'), 'one\n');
  g(['add', '-A'], mine);
  g(['commit', '-m', 'base'], mine);
  g(['push', 'origin', 'main'], mine);

  return { root, origin, mine, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** A second clone standing in for a teammate's machine. */
function peer(w) {
  const dir = join(w.root, `peer-${Math.random().toString(36).slice(2, 8)}`);
  G(['clone', w.origin, dir], w.root);
  return dir;
}

/** Commit on `branch` in `repo` and return its sha. */
function work(repo, branch, file, body) {
  try {
    g(['checkout', branch], repo);
  } catch {
    g(['checkout', '-b', branch], repo);
  }
  writeFileSync(join(repo, file), body);
  g(['add', '-A'], repo);
  g(['commit', '-m', `${file}: ${body.trim()}`], repo);
  return g(['rev-parse', 'HEAD'], repo).trim();
}

const run = (w, over = {}) =>
  mergeOutward({
    count: 1,
    label: 'a tab',
    git: g,
    gitMerge: g,
    repoRoot: w.mine,
    tmpDir: join(w.root, 'throwaway'),
    baseRef: () => 'origin/main',
    warn: () => {},
    ...over,
  });

const onOrigin = (w) => g(['log', 'main', '--format=%s'], w.origin).split('\n').filter(Boolean);

test('carries the tip onto base and pushes it', () => {
  const w = world();
  try {
    const tip = work(w.mine, 'feat', 'b.txt', 'two\n');
    g(['checkout', 'main'], w.mine);
    run(w, { tip, branch: 'feat' });
    const log = onOrigin(w);
    assert.ok(log.some((l) => l.startsWith('ship(a tab): 1 commit')), log.join('|'));
    assert.ok(log.some((l) => l.includes('b.txt')), 'the work itself landed');
  } finally {
    w.cleanup();
  }
});

test('the throwaway worktree never survives', () => {
  const w = world();
  try {
    const tip = work(w.mine, 'feat', 'b.txt', 'two\n');
    g(['checkout', 'main'], w.mine);
    run(w, { tip, branch: 'feat' });
    assert.equal(existsSync(join(w.root, 'throwaway')), false);
    // And git agrees it is gone, so the next ship does not trip over it.
    assert.ok(!g(['worktree', 'list'], w.mine).includes('throwaway'));
  } finally {
    w.cleanup();
  }
});

test('retries once when a teammate pushed between the fetch and the push', () => {
  const w = world();
  try {
    const tip = work(w.mine, 'feat', 'b.txt', 'two\n');
    g(['checkout', 'main'], w.mine);
    // Our view of origin/main is current...
    g(['fetch', 'origin'], w.mine);
    // ...and THEN a teammate lands something. This is the race: two people
    // hold two different place locks, so nothing serialized them.
    const them = peer(w);
    work(them, 'main', 'c.txt', 'theirs\n');
    g(['push', 'origin', 'main'], them);

    let warned = '';
    run(w, { tip, branch: 'feat', warn: (m) => (warned = m) });

    const log = onOrigin(w);
    assert.ok(log.some((l) => l.includes('c.txt')), 'their work survived');
    assert.ok(log.some((l) => l.includes('b.txt')), 'ours landed too');
    assert.ok(log.some((l) => l.startsWith('ship(a tab)')), 'exactly through our ship merge');
    assert.match(warned, /base moved under us/);
  } finally {
    w.cleanup();
  }
});

test('a losing retry throws rather than reporting a ship that did not happen', () => {
  const w = world();
  try {
    const tip = work(w.mine, 'feat', 'b.txt', 'two\n');
    g(['checkout', 'main'], w.mine);
    g(['fetch', 'origin'], w.mine);
    const them = peer(w);
    work(them, 'main', 'c.txt', 'theirs\n');
    g(['push', 'origin', 'main'], them);

    /**
     * A peer landing something immediately before EVERY one of our pushes —
     * no longer a race, a repo under continuous write. One retry, then the
     * truth.
     *
     * The hook has to fire just before OUR push, not on our fetch: a fetch
     * followed by an uncontested push simply succeeds, which is what the first
     * draft of this test accidentally asserted. Only our own pushes are
     * intercepted — the peer's go through `g` directly.
     */
    const hostile = (args, cwd) => {
      if (args[0] === 'push' && String(args[2] ?? '').startsWith('HEAD:')) {
        work(them, 'main', `d${Math.random().toString(36).slice(2, 6)}.txt`, 'more\n');
        g(['push', 'origin', 'main'], them);
      }
      return g(args, cwd);
    };
    assert.throws(() => run(w, { tip, branch: 'feat', git: hostile }));
    // And it still cleaned up after itself.
    assert.equal(existsSync(join(w.root, 'throwaway')), false);
  } finally {
    w.cleanup();
  }
});

test('an unrecognised failure is NOT retried', () => {
  // Retrying an unknown error is how a real problem gets reported twice and
  // understood never.
  assert.equal(isRaceRejection({ stderr: '! [rejected] main -> main (non-fast-forward)' }), true);
  assert.equal(isRaceRejection({ stderr: 'Updates were rejected; fetch first' }), true);
  assert.equal(isRaceRejection({ stderr: 'Permission denied (publickey)' }), false);
  assert.equal(isRaceRejection({ stderr: 'CONFLICT (content): merge conflict in a.txt' }), false);
  assert.equal(isRaceRejection({}), false);
});

test('fast-forwards the ship place when its branch IS base — the operator', () => {
  const w = world();
  try {
    // The operator's tabs work in the project folder, which sits on main.
    const tip = work(w.mine, 'main', 'b.txt', 'two\n');
    run(w, { tip, branch: 'main', workingTree: w.mine });
    // The `--no-ff` merge exists on the remote; without the fast-forward the
    // folder is one commit behind it, and the rail reports the operator's own
    // ship back to them as "new on main since you branched".
    const behind = Number(g(['rev-list', '--count', 'HEAD..origin/main'], w.mine).trim());
    assert.equal(behind, 0);
  } finally {
    w.cleanup();
  }
});

test('leaves a teammate’s branch exactly where it was', () => {
  const w = world();
  try {
    const tip = work(w.mine, 'feat', 'b.txt', 'two\n');
    const before = g(['rev-parse', 'feat'], w.mine).trim();
    run(w, { tip, branch: 'feat', workingTree: w.mine });
    // Their branch is not base, so nothing moves — and it being genuinely
    // behind base afterwards is a fact the rail SHOULD keep telling them.
    assert.equal(g(['rev-parse', 'feat'], w.mine).trim(), before);
    assert.ok(Number(g(['rev-list', '--count', 'HEAD..origin/main'], w.mine).trim()) > 0);
  } finally {
    w.cleanup();
  }
});

test('a ship place that is gone does not stop the merge', () => {
  const w = world();
  try {
    const tip = work(w.mine, 'main', 'b.txt', 'two\n');
    // An ENDED session: the worktree was retired, so there is nothing to
    // fast-forward. The merge is what matters and must still land.
    run(w, { tip, branch: 'main', workingTree: null });
    assert.ok(onOrigin(w).some((l) => l.startsWith('ship(a tab)')));
  } finally {
    w.cleanup();
  }
});
