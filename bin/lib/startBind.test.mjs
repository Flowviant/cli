/**
 * A START THAT IS REFUSED MOVES NOTHING.
 *
 * The no-match picker and the single-unbound confirm both BIND the chosen
 * project to this repo. They used to write that binding before the instance
 * lock was asked, so a start refused by the lock (the same project's daemon
 * already live in its own checkout) still moved the binding — and that live
 * daemon's next unattended self-update re-exec'd into a store that no longer
 * bound its repo, found no match headless, and exited with the machine dark.
 *
 * The start path is a top-level script with a TTY menu and a daemon behind it,
 * so this pins the ORDER as source: the binding writes live only inside the
 * deferred `afterLock`, and runFleetDaemon runs it only past the refusal.
 *
 * Run: node --test bin/lib/startBind.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const code = (rel) =>
  readFileSync(new URL(rel, import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l))
    .join('\n');

test('the start path binds a repo only inside the deferred afterLock', () => {
  const cli = code('../cli.mjs');
  const writes = cli.match(/creds\.(selectStoredProject|bindStoredRepo)\(/g) ?? [];
  assert.equal(writes.length, 2, 'the picker and the confirm');
  for (const line of cli.split('\n').filter((l) => /creds\.(selectStoredProject|bindStoredRepo)\(/.test(l))) {
    assert.match(line, /afterLock = \(\) => creds\./, `bound eagerly: ${line.trim()}`);
  }
  assert.ok(cli.includes('await runFleetDaemon({ afterLock });'));
});

test('runFleetDaemon persists the binding only after the lock refused nothing', () => {
  const fleet = code('./fleet.mjs');
  const refuse = fleet.indexOf('if (!instance.ok) {');
  const bind = fleet.indexOf('afterLock?.();');
  assert.ok(refuse > 0, 'the refusal anchor');
  assert.ok(bind > 0, 'the binding anchor');
  assert.ok(bind > refuse, 'the binding runs after the refusal');
});
