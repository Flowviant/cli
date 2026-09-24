/**
 * STOPPING ONE CREDENTIAL'S DAEMON (0.95.0) — `flowviant machines`'s
 * disconnect, which names ONE project and must touch exactly that project's
 * lock.
 *
 * `flowviant stop` sweeps every lock on the box because its asker does not
 * know what is running; the disconnect's asker has just picked a row. What is
 * worth pinning is that the two share ONE per-lock ritual (two hand-copies of
 * a SIGTERM-then-SIGKILL are two places to get the grace period wrong — the
 * argument `standDown` already makes) and that a lock naming a dead pid is
 * "already gone", counted as nothing, never a failure.
 *
 * Run: node --test bin/lib/instance.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const source = () =>
  readFileSync(new URL('./instance.mjs', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .join('\n');

test('stopAllDaemons and stopDaemonFor share one per-lock stop', () => {
  const src = source();
  // Exactly two callers of the shared function, and no second SIGTERM site.
  assert.equal(src.split('stopLock(').length - 1, 3, 'the definition and its two callers');
  assert.ok(src.includes('stopLock(instanceLockPath(fleetToken), log, tally);'), 'the named credential, no sweep');
  assert.ok(src.includes('for (const path of lockFiles()) stopLock(path, log, tally);'), 'the sweep');
  assert.equal(src.split("process.kill(holder.pid, 'SIGTERM')").length - 1, 1, 'one place signals');
});

/**
 * A lock naming a pid that is gone is the common shape after a crash or a
 * reboot. It is reported as "already gone", nothing is signalled, and the
 * tally says no daemon was running — which is what lets the disconnect carry
 * on to the leave and the forget instead of aborting on a corpse.
 */
test('a lock naming a dead pid is "already gone" — not running, not a failure', async () => {
  const before = process.env.HOME;
  const home = mkdtempSync(join(tmpdir(), 'fv-stopfor-'));
  try {
    process.env.HOME = home;
    mkdirSync(join(home, '.flowviant'), { recursive: true });
    const inst = await import(`./instance.mjs?stopfor=${Date.now()}`);
    // A pid no live process holds: spawn-and-reap would be exact, but a pid
    // beyond pid_max on any Linux is never allocated and `kill(pid, 0)` says
    // ESRCH; the same holds for every platform this runs on.
    const dead = 2 ** 22 + 7;
    writeFileSync(
      inst.instanceLockPath('fva_test'),
      JSON.stringify({ pid: dead, repoRoot: '/repo', startedAt: new Date().toISOString(), entry: 'cli.mjs', version: '0.95.0' })
    );
    const lines = [];
    const tally = inst.stopDaemonFor('fva_test', { log: (m) => lines.push(m) });
    assert.deepEqual(tally, { stopped: 0, unconfirmed: 0, failed: 0, running: 0 });
    assert.match(lines[0], new RegExp(`pid ${dead} in /repo is already gone`));
    // No lock at all is silence, not an error: a project connected here but not
    // running is the ordinary disconnect.
    const quiet = [];
    assert.deepEqual(inst.stopDaemonFor('fva_never', { log: (m) => quiet.push(m) }), { stopped: 0, unconfirmed: 0, failed: 0, running: 0 });
    assert.deepEqual(quiet, []);
  } finally {
    if (before === undefined) delete process.env.HOME;
    else process.env.HOME = before;
  }
});

// ── identity of a live holder ────────────────────────────────────────────────

const onLinux = process.platform === 'linux';
const INSTANCE_URL = new URL('./instance.mjs', import.meta.url).href;

/** Run `fn` with HOME pointed at a fresh directory holding ~/.flowviant. */
async function withHome(tag, fn) {
  const before = process.env.HOME;
  const home = mkdtempSync(join(tmpdir(), `fv-${tag}-`));
  mkdirSync(join(home, '.flowviant'), { recursive: true });
  process.env.HOME = home;
  try {
    return await fn(home);
  } finally {
    if (before === undefined) delete process.env.HOME;
    else process.env.HOME = before;
  }
}

/**
 * A SELF-UPDATE UNDER NPX IS NOT A RIVAL. `npx -y flowviant@latest` puts `npm
 * exec` (and a shell) between the old daemon and its successor, so the holder
 * is a GRANDPARENT; a ppid-only check read it as another daemon and the new one
 * SIGTERMed its own proxy. `--no-takeover` makes the old refusal observable
 * without signalling anything: before the fix this answered ok:false.
 */
test('a successor re-exec’d through a wrapper adopts the lock from its grandparent', { skip: !onLinux }, async () => {
  await withHome('reexec', async (home) => {
    const { spawn } = await import('node:child_process');
    const inst = await import(`./instance.mjs?reexec=${Date.now()}`);
    const repo = mkdtempSync(join(tmpdir(), 'fv-reexec-repo-'));
    // The holder is THIS process, identified exactly as a real lock would be:
    // its own command line, and its own start.
    writeFileSync(
      inst.instanceLockPath('fva_chain'),
      JSON.stringify({
        pid: process.pid,
        repoRoot: repo,
        startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
        entry: readFileSync('/proc/self/cmdline', 'utf8').replace(/\0/g, ' ').trim(),
        version: '99.0.0',
      })
    );
    const script = join(home, 'chain.mjs');
    writeFileSync(
      script,
      `const inst = await import(${JSON.stringify(INSTANCE_URL)});\n` +
        `const r = inst.acquireInstanceLock('fva_chain', ${JSON.stringify(repo)}, { noTakeover: true });\n` +
        `process.stdout.write(JSON.stringify({ ok: r.ok }));\n`
    );
    const run = (env) =>
      new Promise((resolve) => {
        // `; true` stops the shell exec'ing node in its own place, so the
        // chain really is test → sh → node, as npx's is.
        const c = spawn('sh', ['-c', `"${process.execPath}" "${script}"; true`], {
          env: { ...process.env, HOME: home, FLOWVIANT_REEXEC: '1', ...env },
          stdio: ['ignore', 'pipe', 'inherit'],
        });
        let out = '';
        c.stdout.on('data', (d) => (out += d));
        c.on('exit', () => resolve(JSON.parse(out || '{}')));
      });
    // Not named as the re-exec parent: a live, identified holder in the same
    // repo, and --no-takeover — refused, nothing signalled.
    assert.deepEqual(await run({}), { ok: false });
    // Named, and genuinely an ancestor: adopted.
    assert.deepEqual(await run({ FLOWVIANT_REEXEC_FROM: String(process.pid) }), { ok: true });
  });
});

/**
 * THE LOCK RECORDS WHEN THE PROCESS STARTED, not when the lock was written. The
 * start path waits on a person at the picker with no time limit, and a lock
 * written minutes after the process began put a live daemon outside the start
 * window — judged stale, run beside, skipped by stop.
 */
test('the lock’s startedAt is the process start, whatever the start path cost', async () => {
  await withHome('started', async () => {
    const inst = await import(`./instance.mjs?started=${Date.now()}`);
    const { PROCESS_STARTED_AT } = await import('./config.mjs');
    const repo = mkdtempSync(join(tmpdir(), 'fv-started-repo-'));
    await new Promise((r) => setTimeout(r, 30)); // the "prompt"
    const got = inst.acquireInstanceLock('fva_started', repo, { noTakeover: true });
    assert.equal(got.ok, true);
    const lock = JSON.parse(readFileSync(inst.instanceLockPath('fva_started'), 'utf8'));
    assert.equal(lock.startedAt, PROCESS_STARTED_AT);
    got.release();
  });
});

/**
 * A DAEMON STARTED BY A RELATIVE PATH IS STILL IDENTIFIED. Node resolves argv[1]
 * to an absolute path while /proc shows what was typed, so `node bin/cli.mjs`
 * was judged stale while alive and `stop` signalled nothing.
 */
test('a holder started as `node <relative path>` is stopped, not called stale', { skip: !onLinux }, async () => {
  await withHome('relative', async (home) => {
    const { spawn } = await import('node:child_process');
    const inst = await import(`./instance.mjs?relative=${Date.now()}`);
    const repo = mkdtempSync(join(tmpdir(), 'fv-relative-repo-'));
    writeFileSync(
      join(home, 'holder.mjs'),
      `const inst = await import(${JSON.stringify(INSTANCE_URL)});\n` +
        `const r = inst.acquireInstanceLock('fva_rel', ${JSON.stringify(repo)}, { noTakeover: true });\n` +
        `process.on('SIGTERM', () => process.exit(0));\n` +
        `process.stdout.write(r.ok ? 'ready' : 'refused');\n` +
        `setInterval(() => {}, 1000);\n`
    );
    const child = spawn(process.execPath, ['holder.mjs'], {
      cwd: home,
      env: { ...process.env, HOME: home },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    try {
      await new Promise((resolve, reject) => {
        child.stdout.on('data', (d) => (String(d).includes('ready') ? resolve() : reject(new Error(String(d)))));
        child.on('exit', () => reject(new Error('holder exited early')));
      });
      const lines = [];
      const tally = inst.stopDaemonFor('fva_rel', { log: (m) => lines.push(m) });
      assert.equal(tally.stopped, 1, lines.join('\n'));
    } finally {
      try {
        child.kill('SIGKILL');
      } catch {
        /* gone */
      }
    }
  });
});
