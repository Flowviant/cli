/**
 * WHO ACTUALLY GETS THE UPDATE.
 *
 * This file exists because the answer was "nobody who follows the README".
 * `AUTO_UPDATE` is on by default, so the flag was never the blocker — the npx
 * branch was: it refused to install (correctly — `npm i -g` lands where the
 * running process will never look) and then nagged a console nobody reads,
 * while the README told everyone to launch with `npx flowviant@latest` and
 * promised a running daemon self-updates. Measured across one account's five
 * machines on 2026-08-25: 0.48.3, 0.51.1, 0.51.2, 0.54.2, 0.56.0 — each frozen
 * at whatever npx had cached. The clincher was the 0.56.0 one, which polled
 * that morning against LATEST 0.56.1 with auto-update on and did not move.
 *
 * `handleVersionSignal` is tested through its RETURN VALUE — true means "I am
 * restarting, caller must stop" — because the alternative is spawning real
 * processes. What each test pins is the DECISION, which is the part that was
 * wrong.
 *
 * Run: node --test bin/lib/update.test.mjs
 */

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installBinaryUpdate, runningCompiledBinary, updateRestartFailed, versionSignalTarget } from './update.mjs';
import { launchCommand, runningViaNpx, terminalCommand } from './launchCommand.mjs';

test('terminal copy names flowviant while channel detection remains measured', () => {
  assert.equal(launchCommand(), 'flowviant');
  assert.equal(terminalCommand('login'), launchCommand() + ' login');
  const previous = process.env.npm_config_user_agent;
  try {
    process.env.npm_config_user_agent = 'npm/11 npx/11';
    assert.equal(runningViaNpx(), true);
  } finally {
    if (previous === undefined) delete process.env.npm_config_user_agent;
    else process.env.npm_config_user_agent = previous;
  }
});

afterEach(() => {
  delete process.env.FLOWVIANT_UPDATE_TARGET;
});

test('a signal targets its readable version: latest when it parses, else min, else nothing', () => {
  assert.deepEqual(versionSignalTarget('0.50.0', { latest: '0.60.0', min: '0.55.0' }), { target: '0.60.0', belowMin: true });
  assert.deepEqual(versionSignalTarget('0.56.0', { latest: '0.60.0', min: '0.55.0' }), { target: '0.60.0', belowMin: false });
  // An unreadable latest beside a readable min the daemon is below: the min.
  assert.deepEqual(versionSignalTarget('0.50.0', { latest: '0.x.1', min: '0.55.0' }), { target: '0.55.0', belowMin: true });
  assert.deepEqual(versionSignalTarget('0.60.0', { latest: '0.60.0', min: '0.55.0' }), { target: null, belowMin: false });
  assert.deepEqual(versionSignalTarget('0.60.0', { latest: '0.59.0', min: '0.61.0' }), { target: '0.61.0', belowMin: true });
  assert.deepEqual(versionSignalTarget('0.50.0', { latest: '0.x.1', min: 'garbage' }), { target: null, belowMin: false });
  assert.deepEqual(versionSignalTarget('0.50.0', { latest: undefined, min: undefined }), { target: null, belowMin: false });
});

test('compiled binary detection does not mistake an npm or npx launch for a binary', () => {
  assert.equal(runningCompiledBinary(), false);
});

test('binary update verifies bytes before atomically replacing the executable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'flowviant-update-'));
  const executable = join(dir, 'flowviant');
  const bytes = Buffer.from('new binary');
  const file = { name: 'flowviant-0.100.0-linux-x64', sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
  const manifest = { version: '0.100.0', files: { 'linux-x64': file } };
  const fetchImpl = async (url) => url.endsWith('latest.json')
    ? new Response(JSON.stringify(manifest))
    : new Response(bytes);
  try {
    await writeFile(executable, 'old binary');
    assert.equal(await installBinaryUpdate({ executable, target: 'linux-x64', fetchImpl }), '0.100.0');
    assert.deepEqual(await readFile(executable), bytes);
    assert.equal((await readFile(executable)).length, file.bytes);
    await writeFile(executable, 'old binary');
    await assert.rejects(
      installBinaryUpdate({ executable, target: 'linux-x64', fetchImpl: async (url) =>
        url.endsWith('latest.json') ? new Response(JSON.stringify(manifest)) : new Response('tampered') }),
      /SHA-256 or size verification/
    );
    assert.equal(await readFile(executable, 'utf8'), 'old binary');
    await assert.rejects(
      installBinaryUpdate({ executable, target: 'linux-x64', minimumVersion: '0.101.0', fetchImpl }),
      /waiting for 0.101.0/
    );
    assert.equal(await readFile(executable, 'utf8'), 'old binary');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// THE LOOP GUARD, and it matters more on the npx path than the global one. A
// failed `npm i -g` throws and lands in a 15-minute backoff; an npx relaunch has
// no install step to fail, so a registry serving a stale `latest` would restart
// this process every poll — tearing down live turns each time.
test('a plain start has no restart marker, so nothing is treated as a failure', () => {
  assert.equal(updateRestartFailed('0.99.0'), false);
});

test('a restart that came back SHORT of its target is a failure', () => {
  // We are whatever VERSION says; claim we restarted to reach something far
  // ahead of any real release and came back anyway.
  process.env.FLOWVIANT_UPDATE_TARGET = '99.0.0';
  assert.equal(updateRestartFailed('99.0.0'), true);
});

test('a restart that reached its target is not a failure', () => {
  process.env.FLOWVIANT_UPDATE_TARGET = '0.0.1';
  assert.equal(updateRestartFailed('0.0.1'), false);
});

// A NEWER target than the one we failed on is a fresh question, not the same
// failure: the registry moved on, and refusing forever would strand the machine
// exactly the way the npx nag did.
test('a NEWER target than the failed one is retried, not suppressed', () => {
  process.env.FLOWVIANT_UPDATE_TARGET = '99.0.0';
  assert.equal(updateRestartFailed('99.0.1'), false);
});

test('an unreadable version is "nothing to do", never an install, a restart failure or an applied update', async () => {
  // A target the previous process could not have meant is not a failed restart.
  process.env.FLOWVIANT_UPDATE_TARGET = 'not-a-version';
  assert.equal(updateRestartFailed('not-a-version'), false);
  assert.equal(updateRestartFailed('99.0.0'), false);
  delete process.env.FLOWVIANT_UPDATE_TARGET;
  // A server signal naming nothing readable asks for nothing.
  const { handleVersionSignal } = await import('./update.mjs');
  let tornDown = false;
  const acted = await handleVersionSignal({
    latest: '0.x.1',
    min: 'garbage',
    autoUpdate: true,
    safeToUpdate: () => true,
    teardown: () => {
      tornDown = true;
    },
  });
  assert.equal(acted, false);
  assert.equal(tornDown, false);
});
