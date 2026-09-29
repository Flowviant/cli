/**
 * EVERY `/fleet/*` ENDPOINT FROM THE ONE ROSTER URL (SOLID audit 2026-09-26,
 * F166): both API prefixes, a trailing slash, an endpoint NAME validated, a
 * roster URL that is not one passed through unchanged — never a throw, because
 * these run while modules load and a throw took down `flowviant help` (the
 * ruling fleetWire.mjs argues; the roster poll is what fails on such a URL) —
 * and a pin that the swap is never spelled again.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fleetEndpoint } from './fleetWire.mjs';

test('the final agents segment is swapped, under /api and the /api/v2 alias alike', () => {
  assert.equal(fleetEndpoint('agent-turn-done', 'https://api.flowviant.com/api/fleet/agents'), 'https://api.flowviant.com/api/fleet/agent-turn-done');
  assert.equal(fleetEndpoint('boxes', 'https://x.test/api/v2/fleet/agents'), 'https://x.test/api/v2/fleet/boxes');
  assert.equal(fleetEndpoint('device/start', 'http://127.0.0.1:8787/api/fleet/agents'), 'http://127.0.0.1:8787/api/fleet/device/start');
});

test('a trailing slash on the roster URL is accepted and not carried over', () => {
  assert.equal(fleetEndpoint('boxes', 'https://x/api/v2/fleet/agents/'), 'https://x/api/v2/fleet/boxes');
});

test('only the FINAL agents segment is the roster; a URL without one is left for the roster poll to fail on', () => {
  assert.equal(fleetEndpoint('boxes', 'https://agents.test/agents/fleet/agents'), 'https://agents.test/agents/fleet/boxes');
  // Never a throw while modules load: that took down `help` and `projects`
  // over a setting only the daemon's lanes read. The answer is the one the
  // forty-nine copies gave, byte for byte.
  for (const other of ['https://x/api/fleet', 'https://x/api/fleet/agentsx', 'https://x/agents/extra']) {
    assert.equal(fleetEndpoint('boxes', other), other.replace(/\/agents\/?$/, '/boxes'));
  }
});

test('an endpoint name is a path, never a URL or a traversal', () => {
  for (const bad of ['', '/boxes', 'boxes/', '../x', 'Boxes', 'a b', 'https://evil', null]) {
    assert.throws(() => fleetEndpoint(bad, 'https://x/api/fleet/agents'), TypeError, String(bad));
  }
});

/** CODE ONLY — comments may quote the shape this replaced. */
const code = (src) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .join('\n');

test('the roster swap has one home; every endpoint is derived through it', () => {
  const dirs = [new URL('./', import.meta.url), new URL('../', import.meta.url)];
  const files = dirs.flatMap((d) =>
    readdirSync(d)
      .filter((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs'))
      .map((f) => ({ f, src: code(readFileSync(new URL(f, d), 'utf8')) }))
  );
  const users = files.filter((x) => x.src.includes('fleetEndpoint(')).map((x) => x.f);
  assert.ok(users.includes('workReportQueue.mjs') && users.includes('fleetReports.mjs'), 'the walk found the callers (canary)');
  // The swap itself, in any spelling: a replace keyed on the agents segment.
  const copies = files.filter((x) => /replace\(\s*\/\\\/agents/.test(x.src)).map((x) => x.f).sort();
  // fleetWire.mjs holds the rule in a constant; config.mjs's push channel is
  // the one derivation kept apart, and its header says why.
  assert.deepEqual(copies, ['config.mjs']);
  const home = files.find((x) => x.f === 'fleetWire.mjs').src;
  assert.ok(home.includes('const ROSTER_TAIL = /\\/agents\\/?$/;'));
});
