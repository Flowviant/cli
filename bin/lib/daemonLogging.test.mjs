/**
 * THE DAEMON'S OUTPUT — machine events, the bounded log, and stdout reserved
 * for JSONL in desktop mode (daemonLogging.mjs, split out of
 * desktopContract.mjs 2026-09-26, SOLID F061). Cases moved with their symbols.
 *
 * Run: node --test bin/lib/daemonLogging.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { enableMachineEvents, emitMachineEvent, installDaemonLogging, MAX_DAEMON_LOG_BYTES } from './daemonLogging.mjs';
import { daemonLogPath, daemonStatePath, writeDaemonState } from './daemonState.mjs';
import { desktopStatus } from './desktopContract.mjs';
import { standDownDisplaced } from './holder.mjs';

const temp = () => mkdtempSync(join(tmpdir(), 'fv-desktop-'));

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

test('daemon log has a named cap and rotates', async (t) => {
  const root = temp();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const before = process.env.HOME;
  process.env.HOME = root;
  const original = console.log;
  try {
    console.log = () => {};
    const log = daemonLogPath('test-project');
    installDaemonLogging(log);
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
  const script = `import { installDaemonLogging, emitMachineEvent } from ${JSON.stringify(new URL('./daemonLogging.mjs', import.meta.url).href)};
import { daemonLogPath } from ${JSON.stringify(new URL('./daemonState.mjs', import.meta.url).href)};
installDaemonLogging(daemonLogPath('p1'), { jsonEvents: true });
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

test('installing the logging does not change what status collects', (t) => {
  const root = temp();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const before = process.env.HOME;
  process.env.HOME = root;
  const saved = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  try {
    const entry = { projectId: 'p-status', name: 'n', repoRoot: '/r', fleetToken: 'tok' };
    writeDaemonState('p-status', { lastPoll: '2026-09-26T00:00:00.000Z', holder: 'serving' });
    const deps = { entries: [entry], runtimes: [], runningFor: () => true, pidFor: () => process.pid };
    const beforeInstall = desktopStatus(deps);
    for (const k of Object.keys(saved)) console[k] = () => {};
    installDaemonLogging(daemonLogPath('p-status'));
    console.error('a line that lands in the log');
    const afterInstall = desktopStatus(deps);
    assert.deepEqual(afterInstall, beforeInstall);
    assert.equal(afterInstall.projects[0].holder, 'serving');
    assert.equal(afterInstall.projects[0].logFile, daemonLogPath('p-status'));
    assert.match(readFileSync(daemonLogPath('p-status'), 'utf8'), /a line that lands in the log/);
    assert.ok(statSync(daemonStatePath('p-status')).size > 0);
  } finally {
    Object.assign(console, saved);
    if (before === undefined) delete process.env.HOME; else process.env.HOME = before;
  }
});

test('the status builder writes no output of its own: desktopContract.mjs redirects nothing', () => {
  const src = readFileSync(new URL('./desktopContract.mjs', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  assert.ok(src.includes('export function desktopStatus('), 'anchor: the status builder lives here');
  for (const banned of ['process.stdout.write', 'console[', 'appendFileSync', 'writeFileSync', 'emitMachineEvent']) {
    assert.ok(!src.includes(banned), `desktopContract.mjs must not own output or state writes (${banned})`);
  }
});
