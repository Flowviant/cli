import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkManager } from './work.mjs';
import { bootMark } from './procRegistry.mjs';
import { processesSupported } from './processes.mjs';

/**
 * THE SESSION-GROUP REGISTRY NAMES ONLY THIS DAEMON'S LIVE GROUPS, FROM THIS
 * BOOT. It is how a tab's Running list survives a daemon restart, and it had
 * three ways to name a group that was not the tab's or forget one that was:
 * one shared file every daemon on the box overwrote, entries believed across a
 * reboot (a recycled pgid is a stranger's shell — relayed as the tab's and
 * made stoppable), and a TTL restamped on every write so dead entries never
 * aged out and filled the cap.
 */
const skip = !processesSupported() && 'this platform cannot measure processes';

function setup(t) {
  const home = mkdtempSync(join(tmpdir(), 'fv-groups-home-'));
  const dir = mkdtempSync(join(tmpdir(), 'fv-groups-repo-'));
  const baseDir = mkdtempSync(join(tmpdir(), 'fv-groups-base-'));
  const realHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => {
    process.env.HOME = realHome;
    for (const d of [home, dir, baseDir]) rmSync(d, { recursive: true, force: true });
  });
  const g = (args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  g(['init', '-q', '-b', 'main']);
  g(['config', 'user.email', 't@t.t']);
  g(['config', 'user.name', 'T']);
  writeFileSync(join(dir, 'a.txt'), 'one');
  g(['add', '-A']);
  g(['commit', '-qm', 'base']);
  const fileFor = (repo) =>
    join(home, '.flowviant', `session-groups-${createHash('sha256').update(repo).digest('hex').slice(0, 16)}.json`);
  const make = () =>
    createWorkManager({
      repoRoot: dir,
      baseDir,
      getBaseRef: () => 'main',
      getMcpUrl: () => 'http://127.0.0.1:0/mcp',
      getLeaseTtl: () => 60,
    });
  return { home, dir, file: fileFor(dir), fileFor, make };
}

/** A process group whose leader stays up and has one child — the shape of a
 *  CLI that started a watcher. The leader is never reported; the child is. */
async function group(t) {
  const leader = spawn('sh', ['-c', 'sleep 30; true'], { detached: true, stdio: 'ignore' });
  t.after(() => {
    try {
      process.kill(-leader.pid, 'SIGKILL');
    } catch {
      /* gone */
    }
  });
  await new Promise((r) => leader.once('spawn', r));
  await new Promise((r) => setTimeout(r, 100)); // let `sleep` exist
  return leader.pid;
}

function stubFetch(t) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), body: typeof opts.body === 'string' ? JSON.parse(opts.body) : null });
    return { ok: true, status: 200, json: async () => ({ data: {} }) };
  };
  t.after(() => {
    globalThis.fetch = real;
  });
  return calls;
}

const until = async (cond, ms = 5000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
};

const repoReport = async (calls) => {
  await until(() => calls.some((c) => c.url.includes('session-worktrees')));
  return calls
    .filter((c) => c.url.includes('session-worktrees'))
    .flatMap((c) => c.body?.reports ?? [])
    .find((r) => r.sessionId === 'repo');
};

const writeRegistry = (file, entries) => {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, JSON.stringify(entries));
};

test('an entry written in another boot is not believed — a recycled pgid is a stranger', { skip }, async (t) => {
  const s = setup(t);
  const pgid = await group(t);
  writeRegistry(s.file, [{ sessionId: 'repo', pid: pgid, startedAt: Date.now(), boot: 'another-boot' }]);
  const calls = stubFetch(t);
  s.make().reportWorktrees(['repo']);
  const rep = await repoReport(calls);
  assert.ok(rep, 'the checkout is measured');
  assert.deepEqual(rep.processes, [], "another boot's group must not be relayed as this tab's");
});

test('an entry from this boot is believed, and a restart finds the live watcher again', { skip }, async (t) => {
  const s = setup(t);
  const pgid = await group(t);
  writeRegistry(s.file, [{ sessionId: 'repo', pid: pgid, startedAt: 1234, boot: bootMark() }]);
  const calls = stubFetch(t);
  s.make().reportWorktrees(['repo']);
  const rep = await repoReport(calls);
  assert.ok(rep.processes.length > 0, 'the watcher under the remembered group is reported');
});

test('the sweep forgets ids the roster stopped naming, keeps first-seen times, and never touches another repo\'s file', { skip }, async (t) => {
  const s = setup(t);
  const live = await group(t);
  const gone = await group(t);
  writeRegistry(s.file, [
    { sessionId: 'repo', pid: live, startedAt: 1234, boot: bootMark() },
    { sessionId: 'closed-tab', pid: gone, startedAt: 5678, boot: bootMark() },
    { sessionId: 'repo', pid: 2147483000, startedAt: 9, boot: bootMark() }, // a dead group
  ]);
  const other = s.fileFor('/some/other/checkout');
  const otherBody = JSON.stringify([{ sessionId: 'x', pid: gone, startedAt: 1, boot: bootMark() }]);
  writeFileSync(other, otherBody);
  const calls = stubFetch(t);
  s.make().reportWorktrees(['repo']);
  await repoReport(calls);
  const after = JSON.parse(readFileSync(s.file, 'utf8'));
  assert.deepEqual(
    after.map((e) => [e.sessionId, e.pid, e.startedAt]),
    [['repo', live, 1234]],
    'only the live group of a live id survives, with its first-seen time'
  );
  assert.equal(after[0].boot, bootMark());
  assert.equal(readFileSync(other, 'utf8'), otherBody, "another daemon's registry is its own");
  assert.equal(existsSync(join(s.home, '.flowviant', 'session-groups.json')), false);
});
