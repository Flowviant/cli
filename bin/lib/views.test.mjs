import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browserCommand, renderStatus, tailLines } from './views.mjs';

const NOW = Date.parse('2026-09-25T12:00:00Z');
const project = (over = {}) => ({
  id: 'abcdef1234567890', name: 'checkout-service', dir: '/home/maya/checkout-service',
  running: true, holder: 'serving', lastPoll: '2026-09-25T11:59:50Z', logFile: '', runtimes: [], ...over,
});
const status = (projects) => ({ schema: 1, version: '0.101.2', installChannel: 'binary', projects, runtimes: [{ id: 'claude', installed: true, version: '2.1.0' }] });

test('status names each project, where it runs and its live agents', () => {
  const text = renderStatus(status([project({ remote: {
    role: 'serving', servingBoxName: 'studio-pc', daemonVersion: '0.101.2', latest: '0.101.2', pressure: null,
    agents: [
      { id: 'a', name: 'onboarding-copy', status: 'stuck', runtime: 'claude', delivered: 0, total: 1, asks: true, parked: false, since: null },
      { id: 'b', name: 'billing-webhooks', status: 'working', runtime: 'claude', delivered: 2, total: 3, asks: false, parked: false, since: '2026-09-25T11:46:00Z' },
    ],
  } })]), { now: NOW });
  assert.match(text, /checkout-service {2}abcdef12…/);
  assert.match(text, /here +running · serving/);
  assert.match(text, /onboarding-copy · asks you a question/);
  assert.match(text, /billing-webhooks · working 14m · 2 of 3 cards delivered/);
  assert.match(text, /CLIs +claude 2\.1\.0/);
  assert.doesNotMatch(text, /update/);
});

test('status says nothing it did not measure', () => {
  const text = renderStatus(status([project({ running: null, holder: null, lastPoll: null, remote: null })]), { now: NOW });
  assert.doesNotMatch(text, /here|agents|update|polled/);
});

test('status offers the fix for a stopped daemon, and the update only when behind', () => {
  const stopped = renderStatus(status([project({ running: false })]), { now: NOW });
  assert.match(stopped, /not running — run flowviant in that repo/);
  const behind = renderStatus(status([project({ remote: { role: 'inactive', servingBoxName: 'studio-pc', daemonVersion: '0.100.0', latest: '0.101.2', agents: [], pressure: null } })]), { now: NOW });
  assert.match(behind, /running · inactive — studio-pc serves this project/);
  assert.match(behind, /flowviant 0\.101\.2 is out; this computer runs 0\.100\.0/);
});

test('status with nothing connected is an offer', () => {
  assert.match(renderStatus(status([])), /No project is connected on this computer yet\.\nRun flowviant login inside your repository\./);
});

test('logs shows the last lines of the file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fv-logs-'));
  try {
    const path = join(dir, 'daemon.log');
    writeFileSync(path, Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n') + '\n');
    assert.equal(tailLines(path, 3).text, 'line 197\nline 198\nline 199');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('open uses the browser this computer has — Windows’ own from inside WSL', () => {
  assert.deepEqual(browserCommand('https://x', { platform: 'linux', env: { WSL_DISTRO_NAME: 'Ubuntu' } }), ['explorer.exe', ['https://x']]);
  assert.deepEqual(browserCommand('https://x', { platform: 'linux', env: {} }), ['xdg-open', ['https://x']]);
  assert.deepEqual(browserCommand('https://x', { platform: 'darwin', env: {} }), ['open', ['https://x']]);
});
