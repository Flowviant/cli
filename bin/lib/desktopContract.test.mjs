import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { desktopStatus } from './desktopContract.mjs';
import { daemonRunningFor, drainingFor, instanceLockPath } from './instance.mjs';

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
    dispatchable: false, signedIn: null, billing: null, subscriptionType: null,
    parkedByLimit: true, message: 'Claude says wait' });
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

/**
 * A STANDING-DOWN DAEMON FINISHING A DEPLOY (ruling 2026-09-26) is still
 * running, and says what it is finishing: the tray shows "finishing a deploy
 * (web → prod)" rather than idle, and waits it out. Read from the lock's
 * draining mark; asked only of a daemon measured running, and null otherwise.
 */
test('status says what a draining daemon is finishing, from its lock; nothing else claims a drain', (t) => {
  const entry = { projectId: 'p1', name: null, repoRoot: null, fleetToken: 'fva_drain' };
  const base = { entries: [entry], runtimes: [], pidFor: () => 12, stateFor: () => ({ pid: 12, holder: 'serving' }) };
  const asked = [];
  const drainFor = (token) => { asked.push(token); return 'web → prod'; };
  assert.equal(desktopStatus({ ...base, runningFor: () => true, drainFor }).projects[0].draining, 'web → prod');
  assert.deepEqual(asked, ['fva_drain']);
  assert.equal(desktopStatus({ ...base, runningFor: () => false, drainFor }).projects[0].draining, null, 'a stopped daemon drains nothing');
  assert.equal(desktopStatus({ ...base, runningFor: () => null, drainFor }).projects[0].draining, null, 'unknown claims nothing');
  assert.equal(asked.length, 1, 'the mark is read only of a running daemon');

  const root = temp();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const before = process.env.HOME;
  process.env.HOME = root;
  try {
    assert.equal(drainingFor('fva_drain'), null, 'no lock');
    mkdirSync(join(root, '.flowviant'));
    writeFileSync(instanceLockPath('fva_drain'), JSON.stringify({ pid: 12 }));
    assert.equal(drainingFor('fva_drain'), null, 'a lock with no mark (an older daemon too)');
    writeFileSync(instanceLockPath('fva_drain'), JSON.stringify({ pid: 12, draining: { what: 'web → prod', since: 'x' } }));
    assert.equal(drainingFor('fva_drain'), 'web → prod');
    writeFileSync(instanceLockPath('fva_drain'), JSON.stringify({ pid: 12, draining: { what: 7 } }));
    assert.equal(drainingFor('fva_drain'), null, 'an unreadable mark is unknown');
  } finally { if (before === undefined) delete process.env.HOME; else process.env.HOME = before; }
});

test('npx channel is named from the launch channel', () => {
  const before = process.env.npm_config_user_agent;
  process.env.npm_config_user_agent = 'npm/10 node/v22 npx/10';
  try { assert.equal(desktopStatus({ entries: [], runtimes: [] }).installChannel, 'npx'); }
  finally { if (before === undefined) delete process.env.npm_config_user_agent; else process.env.npm_config_user_agent = before; }
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
    { event: 'open_url', url: 'https://app.flowviant.com/connect?code=ABCD-EFGH', code: 'ABCD-EFGH' },
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
