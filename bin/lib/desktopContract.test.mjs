import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { desktopStatus, enableMachineEvents, emitMachineEvent, setRuntimeLimit, installDaemonLogging, daemonLogPath, daemonStatePath, MAX_DAEMON_LOG_BYTES } from './desktopContract.mjs';
import { standDownDisplaced } from './fleet.mjs';
import { daemonRunningFor, instanceLockPath } from './instance.mjs';

const cli = new URL('../cli.mjs', import.meta.url).pathname;
const temp = () => mkdtempSync(join(tmpdir(), 'fv-desktop-'));

function child(args, env) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [cli, ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    proc.stdout.on('data', (chunk) => { stdout += chunk; });
    proc.stderr.on('data', (chunk) => { stderr += chunk; });
    proc.on('error', reject);
    proc.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

test('status shape keeps unknown as null and reports measured empty separately', () => {
  const entry = { projectId: 'p1', name: null, repoRoot: null, fleetToken: 'secret' };
  const base = { entries: [entry], runtimes: [{ id: 'claude', installed: false, version: null, dispatchable: false }] };
  const unknown = desktopStatus({ ...base, runningFor: () => null, stateFor: () => ({}) });
  assert.equal(unknown.schema, 1);
  assert.equal(unknown.version.length > 0, true);
  assert.equal(unknown.projects[0].running, null);
  assert.equal(unknown.projects[0].holder, null);
  assert.equal(unknown.projects[0].lastPoll, null);
  assert.equal(unknown.projects[0].name, null);
  assert.equal(unknown.projects[0].dir, null);
  assert.equal(unknown.projects[0].runtimes[0].version, null);
  assert.equal(Object.hasOwn(unknown.projects[0].runtimes[0], 'parkedByLimit'), false);
  assert.match(unknown.projects[0].logFile, /daemon-[0-9a-f]+\.log$/);
  const empty = desktopStatus({ ...base, runningFor: () => false, stateFor: () => ({ lastPoll: '2026-09-24T00:00:00.000Z' }) });
  assert.equal(empty.projects[0].running, false);
  assert.equal(empty.projects[0].lastPoll, '2026-09-24T00:00:00.000Z');
  const live = desktopStatus({ ...base, runningFor: () => true, pidFor: () => 12,
    stateFor: () => ({ pid: 12, holder: 'serving', limits: { claude: 'Claude says wait' } }) });
  assert.equal(live.projects[0].holder, 'serving');
  assert.deepEqual(live.projects[0].runtimes[0], { id: 'claude', installed: false, version: null,
    dispatchable: false, parkedByLimit: true, message: 'Claude says wait' });
});

test('an absent lock is unknown; a dead holder is measured empty', (t) => {
  const root = temp();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const before = process.env.HOME;
  process.env.HOME = root;
  try {
    assert.equal(daemonRunningFor('fva_test'), null);
    mkdirSync(join(root, '.flowviant'));
    writeFileSync(instanceLockPath('fva_test'), JSON.stringify({ pid: 2147483000 }));
    assert.equal(daemonRunningFor('fva_test'), false);
  } finally { if (before === undefined) delete process.env.HOME; else process.env.HOME = before; }
});

test('npx channel is named from the launch channel', () => {
  const before = process.env.npm_config_user_agent;
  process.env.npm_config_user_agent = 'npm/10 node/v22 npx/10';
  try { assert.equal(desktopStatus({ entries: [], runtimes: [] }).installChannel, 'npx'); }
  finally { if (before === undefined) delete process.env.npm_config_user_agent; else process.env.npm_config_user_agent = before; }
});

test('machine event shapes include the moved sentence and a clean stop', async () => {
  const written = [];
  enableMachineEvents((chunk) => { written.push(String(chunk)); return true; });
  try {
    for (const event of ['serving', 'stopped']) emitMachineEvent({ event });
    emitMachineEvent({ event: 'update-applied', from: '0.98.0', to: '0.99.0' });
    emitMachineEvent({ event: 'limit-hit', runtime: 'codex', message: 'usage limit reached' });
    emitMachineEvent({ event: 'limit-cleared', runtime: 'codex' });
    await standDownDisplaced({
      by: 'Other box', settleAgentTurns: async () => {}, flushReports: async () => {}, teardown: () => {}, exit: () => {},
    });
  } finally { /* event writer is scoped to this test worker */ }
  const rows = written.map((line) => JSON.parse(line));
  assert.deepEqual(rows.map((row) => row.event), ['serving', 'stopped', 'update-applied', 'limit-hit', 'limit-cleared', 'displaced']);
  assert.equal(rows[5].message, "The project's machine moved to Other box while this turn was running.");
});

test('login JSONL opens on the host, binds the selected repo, and emits no human lines', async (t) => {
  const root = temp();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'repo');
  mkdirSync(repo);
  const { spawnSync } = await import('node:child_process');
  assert.equal(spawnSync('git', ['init', '-q', repo]).status, 0);
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: req.url.endsWith('/device/start')
      ? { deviceCode: 'device', userCode: 'ABCDEFGH', intervalSeconds: 0, expiresInSeconds: 10 }
      : { status: 'approved', machineToken: 'fva_secret', projectId: 'p1', projectName: 'Project One' } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const port = server.address().port;
  const result = await child(['login', '--json', '--dir', repo, '--no-start'], { HOME: root, FLOWVIANT_FLEET_URL: `http://127.0.0.1:${port}/api/fleet/agents` });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split('\n').map(JSON.parse), [
    { event: 'open_url', url: 'https://app.flowviant.com', code: 'ABCD-EFGH' },
    { event: 'bound', projectId: 'p1', name: 'Project One', dir: repo },
  ]);
  assert.match(readFileSync(join(root, '.flowviant', 'credentials.json'), 'utf8'), /p1/);
});

test('JSON forget requires yes and emits one document', async (t) => {
  const root = temp();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.flowviant'));
  writeFileSync(join(root, '.flowviant', 'credentials.json'), JSON.stringify({
    projectId: 'project-123', fleetToken: 'fva_secret', projects: { 'project-123': { fleetToken: 'fva_secret', name: 'One' } },
  }));
  const refused = await child(['machines', '--forget', 'project-123', '--json'], { HOME: root });
  assert.equal(refused.code, 1);
  assert.deepEqual(JSON.parse(refused.stdout), { ok: false, error: '--yes is required with --json' });
  const gone = await child(['machines', '--forget', 'project-123', '--yes', '--json'], { HOME: root });
  assert.equal(gone.code, 0, gone.stderr);
  assert.deepEqual(JSON.parse(gone.stdout), { ok: true, action: 'forget', projectId: 'project-123' });
});

test('login JSONL reports a directory error without beginning device auth', async (t) => {
  const root = temp();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const result = await child(['login', '--json', '--dir', root, '--no-start'], { HOME: root });
  assert.equal(result.code, 1);
  assert.deepEqual(JSON.parse(result.stdout), { event: 'error', message: `No git repository found in ${root}.` });
});

test('desktop start refuses a project bound to a different checkout', async (t) => {
  const root = temp();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'repo');
  mkdirSync(repo);
  const { spawnSync } = await import('node:child_process');
  assert.equal(spawnSync('git', ['init', '-q', repo]).status, 0);
  mkdirSync(join(root, '.flowviant'));
  writeFileSync(join(root, '.flowviant', 'credentials.json'), JSON.stringify({
    projectId: 'project-123', fleetToken: 'fva_secret',
    projects: { 'project-123': { fleetToken: 'fva_secret', repoRoot: '/some/other/repo', name: 'One' } },
  }));
  const result = await child(['--project', 'project-123', '--dir', repo, '--json-events'], { HOME: root });
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /not connected to this repository/);
});

test('a limit stays in this project and clears only on a measured recovery', (t) => {
  const root = temp();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const before = process.env.HOME;
  process.env.HOME = root;
  try {
    assert.equal(setRuntimeLimit('p1', 'codex', 'Codex says wait'), true);
    assert.equal(setRuntimeLimit('p1', 'codex', 'Codex says wait'), false);
    assert.deepEqual(JSON.parse(readFileSync(daemonStatePath('p1'), 'utf8')).limits, { codex: 'Codex says wait' });
    assert.equal(setRuntimeLimit('p1', 'codex', null), true);
    assert.deepEqual(JSON.parse(readFileSync(daemonStatePath('p1'), 'utf8')).limits, {});
  } finally { if (before === undefined) delete process.env.HOME; else process.env.HOME = before; }
});

test('daemon log has a named cap and rotates', async (t) => {
  const root = temp();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const before = process.env.HOME;
  process.env.HOME = root;
  const original = console.log;
  try {
    console.log = () => {};
    installDaemonLogging('test-project');
    const log = daemonLogPath('test-project');
    console.log('x'.repeat(MAX_DAEMON_LOG_BYTES - 2));
    console.log('next');
    assert.match(readFileSync(`${log}.1`, 'utf8'), /^x/);
    assert.equal(readFileSync(log, 'utf8'), 'next\n');
    console.log('y'.repeat(MAX_DAEMON_LOG_BYTES + 50));
    assert.equal(statSync(log).size, MAX_DAEMON_LOG_BYTES);
    assert.match(readFileSync(log, 'utf8').slice(-20), /\[truncated\]/);
  } finally { console.log = original; if (before === undefined) delete process.env.HOME; else process.env.HOME = before; }
});

test('JSON events reserve stdout while human and raw output go to stderr', async (t) => {
  const root = temp();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const script = `import { installDaemonLogging, emitMachineEvent } from ${JSON.stringify(new URL('./desktopContract.mjs', import.meta.url).href)};
installDaemonLogging('p1', { jsonEvents: true });
console.log('human'); process.stdout.write('raw\\n'); emitMachineEvent({ event: 'serving' });`;
  const result = await new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, HOME: root }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    proc.stdout.on('data', (part) => { stdout += part; });
    proc.stderr.on('data', (part) => { stderr += part; });
    proc.on('error', reject);
    proc.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { event: 'serving' });
  assert.match(result.stderr, /human/);
  assert.match(result.stderr, /raw/);
});
