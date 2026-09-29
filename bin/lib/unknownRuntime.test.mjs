/**
 * AN UNKNOWN RUNTIME IS REFUSED, NEVER RUN AS CLAUDE (2026-09-26, SOLID F048).
 *
 * `runtimeById` used to answer Claude for any id it did not declare, so a
 * misspelled id — or one a newer server learned ahead of this daemon — got
 * Claude's MCP config minted for it, or Claude spawned under its name. It now
 * answers null, and both callers refuse before anything is created.
 *
 * Behavioural: a fake `claude` on PATH drops a marker file when it is spawned,
 * and `runTurn` is called for real.
 *
 * Run: node --test bin/lib/unknownRuntime.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeById, RUNTIMES } from './runtimes.mjs';
import { mcpFor } from './claude.mjs';
import { runTurn } from './runTurn.mjs';

const dir = mkdtempSync(join(tmpdir(), 'fv-unknown-rt-'));
const spawned = join(dir, 'spawned');
const bin = join(dir, 'claude');
writeFileSync(
  bin,
  `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(spawned)}, '1');\nprocess.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'ran' }) + '\\n');\n`
);
chmodSync(bin, 0o755);
process.env.PATH = `${dir}:${process.env.PATH}`;

test('runtimeById answers null for an id it does not declare — never Claude', () => {
  for (const id of ['gemini', 'Claude', '', null, undefined, 'toString', '__proto__']) {
    assert.equal(runtimeById(id), null, String(id));
  }
  // Canary: every declared id still resolves to its own adapter.
  for (const id of Object.keys(RUNTIMES)) assert.equal(runtimeById(id), RUNTIMES[id]);
});

test('runTurn with an unknown runtime spawns nothing and fails the turn', async () => {
  rmSync(spawned, { force: true });
  const out = await runTurn({ prompt: 'p', system: 's', cwd: tmpdir(), runtime: 'gemini', streamJson: true, answerFromResult: true });
  assert.equal(out, '');
  assert.equal(existsSync(spawned), false, 'no CLI was started for an unknown runtime');
});

test('canary: omitting the runtime still runs Claude, from runTurn\'s own default', async () => {
  rmSync(spawned, { force: true });
  const out = await runTurn({ prompt: 'p', system: 's', cwd: tmpdir(), streamJson: true, answerFromResult: true });
  assert.equal(out.trim(), 'ran');
  assert.equal(existsSync(spawned), true);
});

test('mcpFor refuses an unknown runtime by the id it was given, minting no config', () => {
  assert.throws(() => mcpFor('gemini', 'tok', 'http://127.0.0.1:1/mcp'), /runtime 'gemini' is not one this daemon knows/);
  // Canary: a known runtime still gets its config.
  const m = mcpFor('claude', 'tok', 'http://127.0.0.1:1/mcp');
  assert.ok(Array.isArray(m.args) && m.args.length > 0);
  if (m.dir) rmSync(m.dir, { recursive: true, force: true });
});
