/**
 * A STAND-DOWN LETS AN IN-FLIGHT DEPLOY FINISH AND REPORT (owner ruling
 * 2026-09-26).
 *
 * Driven end to end where it matters: a real deploy lease (deploy.mjs) runs a
 * real command in a real git checkout against a `node:http` stand-in for
 * `/fleet`, and the stand-down arrives the way the roster sends it
 * (`obeyRosterCommands`, a displaced box) while the command is still running.
 * The command must not be stopped, the outcome must reach `/fleet/deploy-report`,
 * and only then may the process exit. A Disconnect rotates the credential under
 * a running deploy, so the 401 case is driven too: said in words, never thrown.
 *
 * The signal half (Ctrl+C / SIGTERM) and a takeover's or stop's refusal to
 * signal a draining daemon are driven in child processes running the real
 * signal handlers and the real `leave`, because they are about a process that
 * stays alive. The real daemon's loop under a signal mid-deploy is driven end
 * to end in fleet.test.mjs.
 *
 * Run: node --test bin/lib/standDownExit.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ── the /fleet stand-in, bound before config.mjs reads FLOWVIANT_FLEET_URL ──

const hits = [];
/** Answers `/fleet/deploy-report` gives before it lands, oldest first. */
const reportAnswers = [];
const server = createServer((req, res) => {
  let raw = '';
  req.on('data', (d) => (raw += d));
  req.on('end', () => {
    const tail = req.url.split('/').pop();
    let body = null;
    try {
      body = JSON.parse(raw);
    } catch {
      /* none */
    }
    hits.push({ tail, body, auth: req.headers.authorization ?? null });
    res.setHeader('Content-Type', 'application/json');
    if (tail === 'deploy-claim') return res.end(JSON.stringify({ success: true, data: { claimed: true } }));
    if (tail === 'deploy-report' && reportAnswers.length) {
      const a = reportAnswers.shift();
      res.statusCode = a.status;
      res.setHeader('Content-Type', a.type);
      return res.end(a.body);
    }
    res.end(JSON.stringify({ success: true, data: {} }));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
process.env.FLOWVIANT_FLEET_URL = `http://127.0.0.1:${server.address().port}/fleet/agents`;
process.env.FLOWVIANT_FLEET = 'fva_standdown_test';

const { processDeployJobs, deploysInFlight, deploysInFlightLabels, whenDeploysSettle, reportDeploysAbandoned, ABANDONED_DEPLOY_WORDS } =
  await import('./deploy.mjs');
const { createLeave } = await import('./standDownExit.mjs');
const { obeyRosterCommands } = await import('./holder.mjs');

test.after(() => server.close());

const sh = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** A repo whose base declares one target: a command that takes a while and
 *  leaves a mark only if it runs to its end. */
function scene(tag, seconds = 0.6) {
  const root = mkdtempSync(join(tmpdir(), `fv-standdown-${tag}-`));
  const origin = join(root, 'origin.git');
  const seed = join(root, 'seed');
  const mark = join(root, 'finished.txt');
  sh(['init', '--bare', '-b', 'main', origin], root);
  sh(['clone', origin, seed], root);
  for (const [k, v] of [['user.email', 't@t'], ['user.name', 't'], ['commit.gpgsign', 'false']]) sh(['config', k, v], seed);
  mkdirSync(join(seed, '.flowviant'));
  writeFileSync(
    join(seed, '.flowviant', 'deploy.json'),
    JSON.stringify({ targets: [{ id: 'web', command: `sleep ${seconds} && echo ran > ${JSON.stringify(mark)}` }] })
  );
  sh(['add', '-A'], seed);
  sh(['commit', '-m', 'base'], seed);
  sh(['push', 'origin', 'main'], seed);
  const repo = join(root, 'repo');
  sh(['clone', origin, repo], root);
  return { repo, mark, worktreeDir: join(root, 'wt-home') };
}

const until = async (cond, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
};

/** The stand-down, as fleet.mjs wires it — with the process exit recorded. */
function standDownRig() {
  const exits = [];
  const busy = [];
  const drained = [];
  const lines = [];
  const announced = [];
  const leave = createLeave({
    inFlight: deploysInFlight,
    labels: deploysInFlightLabels,
    settled: whenDeploysSettle,
    abandon: reportDeploysAbandoned,
    markDraining: (what) => drained.push(what),
    announce: (what) => announced.push(what),
    reportBusy: () => busy.push(deploysInFlight() > 0),
    exit: (code) => exits.push(code),
    log: { note: (m) => lines.push(m), warn: (m) => lines.push(m) },
  });
  const deps = {
    settleAgentTurns: async () => {},
    flushWorkReports: async () => {},
    teardown: () => lines.push('teardown'),
    exit: (code) => leave(code),
    log: { warn: () => {}, note: () => {} },
  };
  return { exits, busy, drained, announced, lines, leave, deps };
}

test('a stand-down during a deploy leaves the command running, posts its outcome, and only then exits', async () => {
  hits.length = 0;
  const { repo, mark, worktreeDir } = scene('ok');
  processDeployJobs([{ id: 'job-sd-1', kind: 'deploy', targetId: 'web', env: 'prod' }], {
    repoRoot: repo,
    baseRef: 'origin/main',
    worktreeDir,
    myPubB64: () => 'pub',
  });
  await until(() => hits.some((h) => h.tail === 'deploy-claim'));
  assert.equal(deploysInFlight(), 1, 'the deploy is claimed and running');

  const rig = standDownRig();
  // The roster says another box took the machine — a stand-down.
  const going = await obeyRosterCommands({ displaced: { by: 'other-box' } }, rig.deps);
  assert.equal(going, true, 'the loop stops taking work');
  assert.ok(rig.lines.includes('teardown'), 'the teardown still runs in full');
  assert.deepEqual(rig.exits, [], 'but the process does not leave under a running deploy');
  assert.deepEqual(rig.drained, ['web → prod'], 'the lock is marked draining, naming what it waits on');
  assert.equal(rig.busy[0], true, 'and the tray is told the box is still working');
  assert.deepEqual(rig.announced, ['web → prod'], 'at once, by a `draining` event after the stand-down’s `stopped`');
  assert.match(rig.lines.join('\n'), /waiting for a deploy \(web → prod\) to finish and report before stopping — the command is not stopped\./);
  assert.equal(existsSync(mark), false, 'the command is still mid-run');

  await until(() => rig.exits.length > 0);
  assert.equal(readFileSync(mark, 'utf8').trim(), 'ran', 'the command ran to its end — a stand-down never stops it');
  const report = hits.find((h) => h.tail === 'deploy-report');
  assert.ok(report, 'the outcome was posted to /fleet after the stand-down began');
  assert.equal(report.body.jobId, 'job-sd-1');
  assert.equal(report.body.ok, true);
  assert.equal(report.auth, 'Bearer fva_standdown_test');
  assert.deepEqual(rig.exits, [0], 'and only then did it exit, with the stand-down’s own code');
  assert.equal(rig.busy.at(-1), false, 'the last busy it writes is the measured idle');
  assert.equal(deploysInFlight(), 0);
});

const API_REFUSAL = {
  status: 401,
  type: 'application/json',
  body: JSON.stringify({ success: false, error: { code: 'UNAUTHORIZED', message: 'Token revoked' } }),
};

test('a report refused because the credential was rotated (a Disconnect) is said in words, never thrown', async () => {
  hits.length = 0;
  reportAnswers.push(API_REFUSAL, API_REFUSAL, API_REFUSAL);
  const { repo, worktreeDir } = scene('401');
  const printed = [];
  const origErr = console.error;
  const origLog = console.log;
  console.error = (...a) => printed.push(a.join(' '));
  console.log = (...a) => printed.push(a.join(' '));
  try {
    processDeployJobs([{ id: 'job-sd-2', kind: 'deploy', targetId: 'web', env: 'prod' }], {
      repoRoot: repo,
      baseRef: 'origin/main',
      worktreeDir,
      myPubB64: () => 'pub',
    });
    await until(() => hits.some((h) => h.tail === 'deploy-claim'));
    const rig = standDownRig();
    await obeyRosterCommands({ standDown: { project: 'Demo' } }, rig.deps);
    assert.deepEqual(rig.exits, []);
    await until(() => rig.exits.length > 0);
    assert.equal(hits.filter((h) => h.tail === 'deploy-report').length, 1, 'the API’s own refusal is not retried');
    assert.deepEqual(rig.exits, [0], 'the stand-down still completes');
  } finally {
    console.error = origErr;
    console.log = origLog;
    reportAnswers.length = 0;
  }
  assert.match(
    printed.join('\n'),
    /web → prod finished, but its outcome could not be reported — the app refused this machine's credential \(HTTP 401\)\. The result is only in this log\./
  );
});

test('an EDGE 401/403 on the report is a blip: retried, and the outcome lands', async () => {
  hits.length = 0;
  // Cloudflare's own answers — an HTML challenge page, and its JSON error
  // shape — wear the same statuses as the API's refusal and are not one.
  reportAnswers.push(
    { status: 403, type: 'text/html; charset=UTF-8', body: '<!DOCTYPE html><title>Attention Required! | Cloudflare</title>' },
    { status: 401, type: 'application/json', body: JSON.stringify({ error_code: 1020 }) }
  );
  const { repo, worktreeDir } = scene('edge', 0.1);
  const printed = [];
  const origErr = console.error;
  const origLog = console.log;
  console.error = (...a) => printed.push(a.join(' '));
  console.log = (...a) => printed.push(a.join(' '));
  try {
    processDeployJobs([{ id: 'job-edge', kind: 'deploy', targetId: 'web', env: 'prod' }], {
      repoRoot: repo,
      baseRef: 'origin/main',
      worktreeDir,
      myPubB64: () => 'pub',
    });
    await whenDeploysSettle();
  } finally {
    console.error = origErr;
    console.log = origLog;
    reportAnswers.length = 0;
  }
  const reports = hits.filter((h) => h.tail === 'deploy-report');
  assert.equal(reports.length, 3, `two edge refusals retried, the third lands:\n${printed.join('\n')}`);
  assert.equal(reports.at(-1).body.ok, true);
  assert.doesNotMatch(printed.join('\n'), /refused this machine's credential/, 'an edge page never blames the credential');
});

test('a SECOND Ctrl+C during the drain says the outcome is unknown, then leaves; the command is not stopped', async () => {
  hits.length = 0;
  const { repo, mark, worktreeDir } = scene('insist', 1.2);
  processDeployJobs([{ id: 'job-sd-3', kind: 'deploy', targetId: 'web', env: 'prod' }], {
    repoRoot: repo,
    baseRef: 'origin/main',
    worktreeDir,
    myPubB64: () => 'pub',
  });
  await until(() => hits.some((h) => h.tail === 'deploy-claim'));
  await new Promise((r) => setTimeout(r, 100)); // the claim's answer is in
  const rig = standDownRig();
  void rig.leave(130, { signal: 'SIGINT' });
  assert.match(rig.lines.join('\n'), /Ctrl\+C again leaves now, without its outcome\./, 'the first Ctrl+C says how to insist');
  assert.deepEqual(rig.exits, []);
  void rig.leave(130, { signal: 'SIGINT' });
  await until(() => rig.exits.length > 0);
  assert.deepEqual(rig.exits, [130]);
  const said = hits.filter((h) => h.tail === 'deploy-report');
  assert.equal(said.length, 1, 'one post, before the exit');
  assert.deepEqual(
    { jobId: said[0].body.jobId, ok: said[0].body.ok, outcome: said[0].body.outcome, message: said[0].body.message },
    { jobId: 'job-sd-3', ok: false, outcome: 'unknown', message: ABANDONED_DEPLOY_WORDS }
  );
  assert.equal(ABANDONED_DEPLOY_WORDS, 'outcome unknown: operator left mid-deploy');
  assert.match(rig.lines.join('\n'), /the app is told its outcome is unknown, so it is never run again/);
  assert.equal(existsSync(mark), false, 'the command was still running when it left');
  // The command runs on to its end (nothing here stops it) and the job's own
  // report never follows the `unknown` one.
  await whenDeploysSettle();
  assert.equal(readFileSync(mark, 'utf8').trim(), 'ran');
  assert.equal(hits.filter((h) => h.tail === 'deploy-report').length, 1, 'one outcome per job');
});

test('with no deploy in flight the stand-down exits at once, as it always did', () => {
  const rig = standDownRig();
  rig.leave(143, { signal: 'SIGTERM' });
  assert.deepEqual(rig.exits, [143]);
  assert.deepEqual(rig.drained, [], 'nothing to mark');
  assert.deepEqual(rig.busy, []);
  assert.deepEqual(rig.announced, [], 'and nothing to announce');
});

test('a second Ctrl+C while the real outcome is already being reported does not race it with `unknown`', async () => {
  hits.length = 0;
  // The command ends at once; its report meets a 500 and waits to retry.
  reportAnswers.push({ status: 500, type: 'application/json', body: '{"success":false}' });
  const { repo, mark, worktreeDir } = scene('reporting', 0.05);
  try {
    processDeployJobs([{ id: 'job-sd-4', kind: 'deploy', targetId: 'web', env: 'prod' }], {
      repoRoot: repo,
      baseRef: 'origin/main',
      worktreeDir,
      myPubB64: () => 'pub',
    });
    await until(() => hits.some((h) => h.tail === 'deploy-report'));
    assert.equal(readFileSync(mark, 'utf8').trim(), 'ran');
    assert.equal(deploysInFlight(), 1, 'still held: the report is between retries');
    const rig = standDownRig();
    void rig.leave(130, { signal: 'SIGINT' });
    void rig.leave(130, { signal: 'SIGINT' });
    await until(() => rig.exits.length > 0);
    assert.deepEqual(rig.exits, [130]);
    assert.ok(!hits.some((h) => h.tail === 'deploy-report' && h.body?.outcome === 'unknown'), 'no `unknown` post over a real outcome on its way');
    await whenDeploysSettle();
    const reports = hits.filter((h) => h.tail === 'deploy-report');
    assert.equal(reports.length, 2, 'the refused post, then its retry');
    assert.equal(reports.at(-1).body.ok, true, 'the real outcome is the one that lands');
  } finally {
    reportAnswers.length = 0;
  }
});

test('while draining only a SECOND Ctrl+C insists: a SIGTERM or a repeated roster command changes nothing', async () => {
  let release;
  const exits = [];
  const lines = [];
  let abandoned = 0;
  const leave = createLeave({
    inFlight: () => 1,
    labels: () => ['web → prod'],
    settled: () => new Promise((r) => (release = r)),
    abandon: async () => {
      abandoned++;
    },
    markDraining: () => {},
    reportBusy: () => {},
    exit: (code) => exits.push(code),
    log: { note: (m) => lines.push(m), warn: (m) => lines.push(m) },
  });
  // A stand-down the ROSTER began: no Ctrl+C hint, nobody at a terminal asked.
  void leave(0);
  assert.equal(leave.leaving(), true);
  assert.doesNotMatch(lines[0], /Ctrl\+C/);
  void leave(143, { signal: 'SIGTERM' }); // `flowviant stop`, a takeover, systemd
  void leave(0); // the roster repeating itself
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(exits, [], 'a SIGTERM on a drain is the same stand-down asked again');
  void leave(130, { signal: 'SIGINT' }); // the first Ctrl+C here
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(exits, []);
  assert.match(lines.at(-1), /Ctrl\+C again leaves now, without its outcome\./);
  void leave(130, { signal: 'SIGINT' }); // a person insisting
  await until(() => exits.length > 0);
  assert.deepEqual(exits, [130]);
  assert.equal(abandoned, 1, 'the outcome is settled as unknown first');
  release();
  await leave.drained();
  assert.deepEqual(exits, [130], 'it leaves once');
});

test('a SIGTERM-begun drain offers no Ctrl+C', () => {
  const lines = [];
  const leave = createLeave({
    inFlight: () => 1,
    labels: () => ['web → prod'],
    settled: () => new Promise(() => {}),
    markDraining: () => {},
    reportBusy: () => {},
    exit: () => {},
    log: { note: (m) => lines.push(m), warn: (m) => lines.push(m) },
    beatMs: 60_000,
  });
  void leave(143, { signal: 'SIGTERM' });
  assert.match(lines[0], /waiting for a deploy \(web → prod\) to finish and report before stopping — the command is not stopped\.$/);
});

const onLinux = process.platform === 'linux';
const STARTUP_URL = new URL('./fleetStartup.mjs', import.meta.url).href;
const LEAVE_URL = new URL('./standDownExit.mjs', import.meta.url).href;
const INSTANCE_URL = new URL('./instance.mjs', import.meta.url).href;

/**
 * A HOLDER THAT IS THE DAEMON'S OWN STAND-DOWN, minus the loop: the instance
 * lock, the real signal handlers (fleetStartup.mjs), the real `leave`
 * (standDownExit.mjs) marking the real lock — as fleet.mjs wires them. Its
 * "deploy" settles when the test writes `done`, and prints `reported` as its
 * outcome lands. Every SIGTERM it receives is counted out loud, so a test can
 * tell "not signalled" from "signalled and ignored".
 */
function spawnHolder(home, repo, { rosterDrain = false } = {}) {
  const done = join(home, `deploy-done-${Date.now()}`);
  const script = join(home, `holder-${Date.now()}.mjs`);
  writeFileSync(
    script,
    `const inst = await import(${JSON.stringify(INSTANCE_URL)});\n` +
      `const { installSignalHandlers } = await import(${JSON.stringify(STARTUP_URL)});\n` +
      `const { createLeave } = await import(${JSON.stringify(LEAVE_URL)});\n` +
      `const { existsSync } = await import('node:fs');\n` +
      `const say = (m) => process.stdout.write(m + '\\n');\n` +
      `const r = inst.acquireInstanceLock('fva_drain', ${JSON.stringify(repo)}, { noTakeover: true });\n` +
      `let sigterms = 0;\n` +
      `process.on('SIGTERM', () => say('sigterm ' + ++sigterms));\n` +
      `let inFlight = 1;\n` +
      `const settled = () => new Promise((res) => { const t = setInterval(() => { if (existsSync(${JSON.stringify(done)})) { inFlight = 0; clearInterval(t); say('reported'); res(); } }, 20); });\n` +
      `const leave = createLeave({ inFlight: () => inFlight, labels: () => ['web → prod'], settled, abandon: async () => say('abandoned'), ` +
      `markDraining: (w) => inst.markLockDraining('fva_drain', w), reportBusy: () => {}, exit: (c) => process.exit(c), log: { note: say, warn: say } });\n` +
      `installSignalHandlers(() => say('teardown'), leave);\n` +
      (rosterDrain ? `void leave(0);\n` : '') +
      `say(r.ok ? 'ready' : 'refused');\n` +
      `setInterval(() => {}, 1000);\n`
  );
  const child = spawn(process.execPath, [script], { env: { ...process.env, HOME: home }, stdio: ['ignore', 'pipe', 'inherit'] });
  const h = { child, out: '', done: () => writeFileSync(done, ''), exited: new Promise((r) => child.on('exit', (code) => r(code))) };
  child.stdout.on('data', (d) => (h.out += d));
  return h;
}

/** A second `flowviant` start in the same repo: the takeover, in its own
 *  process (it blocks while it waits, as the real start does). */
function spawnTaker(home, repo) {
  const script = join(home, `taker-${Date.now()}.mjs`);
  writeFileSync(
    script,
    `const inst = await import(${JSON.stringify(INSTANCE_URL)});\n` +
      `const r = inst.acquireInstanceLock('fva_drain', ${JSON.stringify(repo)}, { log: (m) => process.stdout.write(m + '\\n') });\n` +
      `process.stdout.write(r.ok ? 'took ' + process.pid + '\\n' : 'refused ' + r.takeoverFailed + '\\n');\n` +
      `if (r.ok) setInterval(() => {}, 1000);\n`
  );
  const child = spawn(process.execPath, [script], { env: { ...process.env, HOME: home }, stdio: ['ignore', 'pipe', 'inherit'] });
  const t = { child, out: '', exited: new Promise((r) => child.on('exit', (code, sig) => r(sig ?? code))) };
  child.stdout.on('data', (d) => (t.out += d));
  return t;
}

function lockScene() {
  const home = mkdtempSync(join(tmpdir(), 'fv-standdown-lock-'));
  mkdirSync(join(home, '.flowviant'), { recursive: true });
  const repo = mkdtempSync(join(tmpdir(), 'fv-standdown-lock-repo-'));
  const before = process.env.HOME;
  process.env.HOME = home; // stopDaemonFor and instanceLockPath read the lock under HOME
  const killers = [];
  return {
    home,
    repo,
    track: (c) => killers.push(c),
    restore() {
      for (const c of killers) {
        try {
          c.kill('SIGKILL');
        } catch {
          /* gone */
        }
      }
      if (before === undefined) delete process.env.HOME;
      else process.env.HOME = before;
    },
  };
}

const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));

test('SIGTERM with a deploy in flight: the daemon stays up until it reports, then exits 143; a second SIGTERM changes nothing', { skip: !onLinux }, async () => {
  const sc = lockScene();
  try {
    const h = spawnHolder(sc.home, sc.repo);
    sc.track(h.child);
    await until(() => h.out.includes('ready'));
    h.child.kill('SIGTERM');
    await until(() => h.out.includes('waiting for a deploy'));
    assert.doesNotMatch(h.out, /Ctrl\+C/, 'no Ctrl+C hint on a SIGTERM — nobody is at a terminal');
    h.child.kill('SIGTERM'); // systemd, a tray, a second `flowviant stop` asking again
    await until(() => h.out.includes('sigterm 2'));
    await settle();
    assert.equal(h.child.exitCode, null, 'a stand-down does not leave under a running deploy');
    assert.doesNotMatch(h.out, /leaving without/, 'a SIGTERM never insists');
    assert.equal(h.out.split('teardown').length - 1, 1, 'the teardown ran once');
    h.done();
    assert.equal(await h.exited, 143);
    assert.ok(h.out.indexOf('reported') < h.out.indexOf('the deploy is done — stopping.'), 'it left after the outcome landed');
  } finally {
    sc.restore();
  }
});

test('`flowviant stop` twice and then a takeover: the draining daemon is signalled once, the takeover waits, the report lands', { skip: !onLinux }, async () => {
  const sc = lockScene();
  try {
    const h = spawnHolder(sc.home, sc.repo);
    sc.track(h.child);
    await until(() => h.out.includes('ready'));
    const inst = await import(`./instance.mjs?drain=${Date.now()}`);

    // The first stop is the one SIGTERM: it begins the drain, and is obeyed.
    const lines = [];
    const first = inst.stopDaemonFor('fva_drain', { log: (m) => lines.push(m) });
    assert.deepEqual(first, { stopped: 1, unconfirmed: 0, failed: 0, running: 1, draining: 1 }, lines.join('\n'));
    assert.match(lines.at(-1), /finishing a deploy \(web → prod\) and stops by itself once its outcome is reported — it was not forced/);
    const lock = JSON.parse(readFileSync(inst.instanceLockPath('fva_drain'), 'utf8'));
    assert.equal(lock.pid, h.child.pid, 'the draining daemon keeps its lock, so status --json still shows it');
    assert.equal(lock.draining.what, 'web → prod');

    // The second reads the mark BEFORE it signals, and does not.
    const again = [];
    const second = inst.stopDaemonFor('fva_drain', { log: (m) => again.push(m) });
    assert.deepEqual(second, { stopped: 1, unconfirmed: 0, failed: 0, running: 1, draining: 1 }, again.join('\n'));
    assert.ok(!again.some((l) => /asking daemon pid/.test(l)), 'no stand-down asked of a draining daemon');

    // A new start in the same repo waits for it, saying so once.
    const t = spawnTaker(sc.home, sc.repo);
    sc.track(t.child);
    await until(() => t.out.includes('— waiting…'));
    assert.match(t.out, new RegExp(`pid ${h.child.pid} is finishing a deploy \\(web → prod\\) — waiting…`));
    await settle(1500);
    assert.equal(t.out.split('waiting…').length - 1, 1, 'one line, not one per look');
    assert.equal(h.out.split('sigterm').length - 1, 1, 'signalled exactly once, by the first stop');
    assert.doesNotMatch(h.out, /leaving without/);
    assert.equal(h.child.exitCode, null, 'still draining');

    h.done();
    assert.equal(await h.exited, 143, 'it left by itself, with its own code');
    assert.match(h.out, /reported/, 'after its outcome landed');
    await until(() => t.out.includes('took'), 15_000);
    const now = JSON.parse(readFileSync(inst.instanceLockPath('fva_drain'), 'utf8'));
    assert.equal(now.pid, t.child.pid, 'and the new start took the lock once it cleared');
  } finally {
    sc.restore();
  }
});

test('a roster-begun drain ignores a SIGTERM; Ctrl+C on a waiting start abandons the wait, never the deploy', { skip: !onLinux }, async () => {
  const sc = lockScene();
  try {
    const h = spawnHolder(sc.home, sc.repo, { rosterDrain: true });
    sc.track(h.child);
    await until(() => h.out.includes('ready') && h.out.includes('waiting for a deploy'));
    h.child.kill('SIGTERM'); // an older tray or a service manager, after the roster began it
    await until(() => h.out.includes('sigterm 1'));
    await settle();
    assert.equal(h.child.exitCode, null, 'a SIGTERM on a drain no signal began does not end it');
    assert.doesNotMatch(h.out, /leaving without/);

    const t = spawnTaker(sc.home, sc.repo);
    sc.track(t.child);
    await until(() => t.out.includes('— waiting…'));
    t.child.kill('SIGINT'); // the person at the new start's terminal gives up waiting
    const gone = await t.exited;
    assert.ok(gone === 'SIGINT' || gone === 130, `the waiting start ended (${gone})`);
    assert.ok(!t.out.includes('took'), 'it took nothing');
    await settle();
    assert.equal(h.child.exitCode, null, 'the draining daemon is untouched');
    assert.equal(h.out.split('sigterm').length - 1, 1, 'and was never signalled by the waiting start');
    const inst = await import(`./instance.mjs?drain2=${Date.now()}`);
    const lock = JSON.parse(readFileSync(inst.instanceLockPath('fva_drain'), 'utf8'));
    assert.equal(lock.pid, h.child.pid);
    assert.equal(lock.draining.what, 'web → prod');

    h.done();
    assert.equal(await h.exited, 0, 'the roster stand-down leaves with its own code once the outcome lands');
    assert.match(h.out, /reported/);
  } finally {
    sc.restore();
  }
});

/**
 * EVERY STAND-DOWN LEAVES THROUGH `leave` — one home for "exit after the
 * deploys report". A walk over the daemon's modules (with a canary) finds the
 * builder of `leave` only in standDownExit.mjs and its one caller in fleet.mjs;
 * in the three files the stand-downs live in, `process.exit` is written once,
 * as the `exit` handed to `createLeave`, and the signal handlers call `leave`.
 */
test('every stand-down exits through the one `leave`', async () => {
  const { readdirSync } = await import('node:fs');
  const dir = new URL('./', import.meta.url);
  const strip = (raw) =>
    raw
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*)/.test(l))
      .join('\n');
  const daemon = readdirSync(dir)
    .filter((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs'))
    .map((f) => [f, strip(readFileSync(new URL(f, dir), 'utf8'))]);
  assert.ok(daemon.length > 40 && daemon.some(([f]) => f === 'fleet.mjs'), 'the walk found the daemon (canary)');
  const holding = (needle) => daemon.filter(([, s]) => s.includes(needle)).map(([f]) => f);
  assert.deepEqual(holding('export function createLeave('), ['standDownExit.mjs']);
  assert.deepEqual(holding('= createLeave({'), ['fleet.mjs'], 'one live leave');
  assert.deepEqual(holding('whenDeploysSettle'), ['deploy.mjs', 'fleet.mjs'], 'the wait asks the lease, nothing else');
  const src = (f) => daemon.find(([n]) => n === f)[1];
  const fleet = src('fleet.mjs');
  assert.equal(fleet.split('process.exit(').length - 1, 1, 'fleet.mjs exits in one place');
  const a = fleet.indexOf('const leave = createLeave({');
  assert.ok(a > -1, 'anchor');
  const b = fleet.indexOf('installSignalHandlers(teardown, leave);', a);
  assert.ok(b > a, 'terminator');
  assert.ok(fleet.slice(a, b).includes('exit: (code) => process.exit(code),'), 'and it is the exit leave is given');
  assert.ok(fleet.includes('exit: (code) => leave(code),'), 'the roster stand-downs leave through it');
  assert.ok(fleet.includes('await leave(0);'), 'the revoked credential leaves through it');
  // THE LOOP STOPS TAKING WORK ON A STAND-DOWN (behaviour: fleet.test.mjs). The
  // gate is asked at the loop's top and after each of its awaits — the poll,
  // the poll's failure, the roster commands and the update — and nowhere else.
  const loopAt = fleet.indexOf('const standingDown = () => leave.leaving();');
  assert.ok(loopAt > -1, 'anchor');
  const loopEnd = fleet.indexOf('await waitReconcile();', loopAt);
  assert.ok(loopEnd > loopAt, 'terminator');
  assert.equal(fleet.slice(loopAt, loopEnd).split('if (standingDown()) return leave.drained();').length - 1, 5);
  assert.equal(fleet.split('abandon: reportDeploysAbandoned,').length - 1, 1, 'a second Ctrl+C settles the deploys as unknown');
  assert.equal(src('holder.mjs').split('process.exit(').length - 1, 0, 'the roster stand-downs never exit by themselves');
  const startup = src('fleetStartup.mjs');
  const h = startup.indexOf('export function installSignalHandlers(teardown, leave) {');
  assert.ok(h > -1, 'anchor: `leave` is a required parameter, with no default');
  const hEnd = startup.indexOf("process.on('unhandledRejection',", h);
  assert.ok(hEnd > h, 'terminator');
  const handlers = startup.slice(h, hEnd);
  assert.ok(!handlers.includes('process.exit('), 'the signal handlers never exit by themselves: only through leave');
  assert.equal(handlers.split('void leave(code, { signal });').length - 1, 2, 'both handler paths hand leave the signal');
  // THE WORK LANES STOP AT THE TEARDOWN (standDownGate.mjs; behaviour:
  // fleet.test.mjs and runTurn.test.mjs). One closer, first in the teardown;
  // the two lane spawns ask it; the deploy lane asks it only about a late claim.
  assert.deepEqual(holding('stopWorkLanes('), ['fleet.mjs', 'standDownGate.mjs']);
  const td = fleet.indexOf('const teardown = () => {');
  assert.ok(td > -1, 'anchor');
  const tdEnd = fleet.indexOf('daemonAlive = false;', td);
  assert.ok(tdEnd > td, 'terminator');
  assert.equal(fleet.slice(td, tdEnd).replace(/\s+/g, ' ').trim(), 'const teardown = () => { stopWorkLanes();', 'the gate closes before anything is killed');
  assert.deepEqual(holding('workLanesStopped()'), ['deploy.mjs', 'runTurn.mjs', 'standDownGate.mjs', 'workAgentCheck.mjs']);
});
