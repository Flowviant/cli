/**
 * THE DAEMON'S START (fleetStartup.mjs), split out of fleet.mjs 2026-09-26
 * (SOLID F038).
 *
 *   · the worktree home is per CHECKOUT (basename + a hash of the path), under
 *     HOME, and created on the spot;
 *   · the startup reap removes only `task-*` checkouts idle a fortnight;
 *   · the lock refusal, the reap and the signal handlers have one home.
 *
 * Run: node --test bin/lib/fleetStartup.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

process.env.HOME = mkdtempSync(join(tmpdir(), 'fv-start-home-'));
const { tidyWorktreeHome, worktreeHome } = await import('./fleetStartup.mjs');

test('the worktree home is keyed per checkout and created under HOME', () => {
  const a = worktreeHome('/srv/one/app');
  const b = worktreeHome('/srv/two/app');
  assert.match(a.repoKey, /^app-[0-9a-f]{8}$/);
  assert.notEqual(a.repoKey, b.repoKey, 'two checkouts with one basename never share a home');
  assert.equal(a.baseDir, join(process.env.HOME, '.flowviant', 'worktrees', a.repoKey));
  assert.ok(existsSync(a.baseDir));
  assert.deepEqual(worktreeHome('/srv/one/app'), a, 'stable across restarts');
});

test('the startup reap takes only task checkouts idle past a fortnight', () => {
  const repo = mkdtempSync(join(tmpdir(), 'fv-start-repo-'));
  const git = (args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  git(['init', '-q']);
  git(['-c', 'user.email=t@example.com', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'x']);
  const { baseDir } = worktreeHome(repo);
  const stale = join(baseDir, 'task-old');
  const fresh = join(baseDir, 'task-new');
  git(['worktree', 'add', '-q', '--detach', stale]);
  git(['worktree', 'add', '-q', '--detach', fresh]);
  mkdirSync(join(baseDir, 'wiki'), { recursive: true });
  const old = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000);
  utimesSync(stale, old, old);
  utimesSync(join(baseDir, 'wiki'), old, old);
  tidyWorktreeHome(baseDir, repo);
  assert.equal(existsSync(stale), false, 'idle > 14d goes, through git');
  assert.equal(existsSync(fresh), true);
  assert.equal(existsSync(join(baseDir, 'wiki')), true, 'only task-* is ever reaped');
  assert.ok(!git(['worktree', 'list']).includes(basename(stale)), 'the registration went too');
});

/**
 * ONE HOME FOR THE START STEPS, over the whole daemon rather than over
 * fleet.mjs alone — a second lock refusal or signal handler in work.mjs would
 * pass a pin that only read the loop. The walk has a canary (it must find the
 * daemon and the home), and each ban keys on the rule's shape: a CALL of the
 * lock (not its definition in instance.mjs), a SIGINT/SIGTERM handler (tty.mjs
 * legitimately owns SIGTTIN/SIGTTOU), and the age reap's `task-` sweep.
 */
test('the start sequence has one home across the daemon: the lock, the reap and the stop handlers', () => {
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
  assert.deepEqual(where(/(?<!function )acquireInstanceLock\(/), ['fleetStartup.mjs'], 'one caller takes the lock');
  assert.deepEqual(where(/process\.(on|once)\(\s*'SIG(INT|TERM)'/), ['fleetStartup.mjs'], 'one pair of stop handlers');
  assert.deepEqual(where(/startsWith\('task-'\)/), ['fleetStartup.mjs'], 'one age reap of task checkouts');
  const fleet = files.find((x) => x.f === 'fleet.mjs').src;
  assert.ok(!fleet.includes("'worktree', 'remove'"), 'the loop removes no worktree itself');
});
