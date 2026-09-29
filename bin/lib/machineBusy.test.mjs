/**
 * THE DESKTOP APP INSTALLS AN UPDATE ON ITS OWN ONLY OVER A MEASURED IDLE
 * (2026-09-26, SOLID F034).
 *
 * The tray used to infer "nothing is working" from the server's list of
 * working AGENTS, which cannot see a Workbench turn, a ship or a deploy on
 * this box. The daemon now measures itself (`machineBusy`, fleet.mjs — the
 * same predicate its own self-update gate asks) and writes it to its state
 * file each tick; `status --json` reports it per project as `busy`: true,
 * false, or null for unknown — and unknown is never idle.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BUSY_FRESH_MS, busyOf, desktopStatus } from './desktopContract.mjs';

const NOW = Date.parse('2026-09-26T12:00:00.000Z');
const at = (msAgo) => new Date(NOW - msAgo).toISOString();

test('busyOf: a fresh measurement is the answer; absent, malformed or stale is unknown', () => {
  assert.equal(busyOf({ busy: true, busyAt: at(5_000) }, NOW), true);
  assert.equal(busyOf({ busy: false, busyAt: at(5_000) }, NOW), false);
  assert.equal(busyOf(null, NOW), null, 'no live daemon state');
  assert.equal(busyOf({ holder: 'serving' }, NOW), null, 'an older daemon that never wrote the field');
  assert.equal(busyOf({ busy: 'yes', busyAt: at(0) }, NOW), null);
  assert.equal(busyOf({ busy: false }, NOW), null, 'a reading with no time is not a measurement');
  assert.equal(busyOf({ busy: false, busyAt: at(BUSY_FRESH_MS + 1) }, NOW), null, 'a daemon that stopped ticking');
});

test('status --json carries busy only for the LIVE daemon this lock names', () => {
  const entry = { projectId: 'p1', name: null, repoRoot: null, fleetToken: 'secret' };
  const base = { entries: [entry], runtimes: [], nowMs: NOW };
  const working = { pid: 12, busy: true, busyAt: at(3_000) };
  // A Workbench turn, a ship or a deploy in flight all read as `busy: true` —
  // the daemon counts them (see the pin below); the contract relays it.
  assert.equal(desktopStatus({ ...base, runningFor: () => true, pidFor: () => 12, stateFor: () => working }).projects[0].busy, true);
  assert.equal(desktopStatus({ ...base, runningFor: () => true, pidFor: () => 12, stateFor: () => ({ ...working, busy: false }) }).projects[0].busy, false);
  // A state file from a previous process (pid mismatch) says nothing about this one.
  assert.equal(desktopStatus({ ...base, runningFor: () => true, pidFor: () => 99, stateFor: () => ({ ...working, busy: false }) }).projects[0].busy, null);
  assert.equal(desktopStatus({ ...base, runningFor: () => false, stateFor: () => ({ ...working, busy: false }) }).projects[0].busy, null);
});

test('one predicate answers "is this machine working" for the self-update gate and the desktop report', () => {
  const src = readFileSync(new URL('./fleet.mjs', import.meta.url), 'utf8');
  const a = src.indexOf('const machineBusy = () =>');
  assert.ok(a > -1, 'anchor');
  const b = src.indexOf('const reportBusy = () =>', a);
  assert.ok(b > a, 'terminator');
  const body = src.slice(a, b);
  // Session and agent work (turns, plans, merges, SHIPS, undelivered settles)…
  assert.ok(body.includes('workBusy()'));
  // …DEPLOYS, which the server's agent list never showed…
  assert.ok(body.includes('deploysInFlight() > 0'));
  // …and the wiki lane (its runner's own flag, wikiRunner.mjs).
  assert.ok(body.includes('wiki.busy()'));
  const wiki = readFileSync(new URL('./wikiRunner.mjs', import.meta.url), 'utf8');
  assert.ok(wiki.includes('busy: () => wikiBusy,'), 'the runner answers with the flag its drain sets');
  assert.ok(src.includes('const safeToUpdate = !machineBusy();'), 'the self-update gate asks the same question');
  assert.ok(src.includes('writeDaemonState(desktopProjectId, { busy: machineBusy(), busyAt: new Date().toISOString() })'));
  // Written after the tick's intake, so a turn it just started is counted.
  const report = src.lastIndexOf('reportBusy();');
  const intake = src.indexOf('processWorkTurns(roster.workTurnJobs);');
  assert.ok(intake > -1 && report > intake);
});

test('a deploy counts from its claim until its report settles', async (t) => {
  const { deploysInFlight, processDeployJobs } = await import('./deploy.mjs');
  let release;
  const original = globalThis.fetch;
  globalThis.fetch = () => new Promise((resolve) => { release = () => resolve({ ok: true, status: 200, json: async () => ({ data: { claimed: false } }) }); });
  t.after(() => { globalThis.fetch = original; });
  assert.equal(deploysInFlight(), 0);
  processDeployJobs([{ id: 'job-1', kind: 'app', targetId: 'web', env: 'prod' }], { myPubB64: () => 'pub' });
  assert.equal(deploysInFlight(), 1, 'claimed work is work');
  release();
  for (let i = 0; i < 20 && deploysInFlight() > 0; i++) await new Promise((r) => setImmediate(r));
  assert.equal(deploysInFlight(), 0, 'a lost claim releases it');
});
