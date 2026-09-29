/**
 * THE RUNTIMES REPORT KEEPS MEASURED-EMPTY APART FROM UNKNOWN (2026-09-26,
 * SOLID F015). The server's half is pinned behaviourally in the app repo
 * (apps/api/src/lib/agent-runner/machineRuntimesReport.test.ts): `?runtimes=`
 * clears the stored list, an absent param leaves it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runtimesReport } from './runtimeDetection.mjs';

test('the drivable CLIs, comma-joined — and the empty string when none are', () => {
  assert.equal(
    runtimesReport([
      { id: 'claude', dispatchable: true },
      { id: 'codex', dispatchable: false },
      { id: 'antigravity', dispatchable: true },
    ]),
    'claude,antigravity'
  );
  assert.equal(runtimesReport([{ id: 'claude', dispatchable: false }]), '');
  assert.equal(runtimesReport([]), '');
});

test('the poll sends it even when empty — only a detection that threw leaves it absent', () => {
  const src = readFileSync(new URL('./fleetRoster.mjs', import.meta.url), 'utf8');
  assert.ok(src.includes("url.searchParams.set('runtimes', runtimesReport(detectRuntimes()));"));
  assert.ok(!/if \(drivable\.length\)/.test(src), 'no truthiness gate that turns measured-empty into silence');
  // The poll URL a server parses: '' survives serialization as `runtimes=`.
  const url = new URL('https://x.test/api/fleet/agents');
  url.searchParams.set('runtimes', runtimesReport([]));
  assert.equal(url.search, '?runtimes=');
  assert.equal(new URL(url.href).searchParams.get('runtimes'), '');
});
