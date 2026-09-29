/**
 * THE PROJECT ID IS THE TOKEN'S, NOT THE STORE'S.
 *
 * `FLEET_TOKEN` prefers `--fleet` and the environment over the stored
 * credential, and `PROJECT_ID` — the env report's fingerprint salt — used to
 * come from the store regardless. A box holding one unbound project A, started
 * with project B's token in the environment, salted B's report with A's id and
 * made every variable read `differs`. config.mjs resolves at IMPORT, so each
 * case runs in its own process over its own HOME.
 *
 * Run: node --test bin/lib/config.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CREDS = new URL('./credentials.mjs', import.meta.url).href;
const CONFIG = new URL('./config.mjs', import.meta.url).href;

function projectIdWith(env) {
  const home = mkdtempSync(join(tmpdir(), 'fv-config-'));
  mkdirSync(join(home, '.flowviant'), { recursive: true });
  const code =
    `const c = await import(${JSON.stringify(CREDS)});\n` +
    `c.saveLogin({ fleetToken: 'fva_A', projectId: 'proj-A', name: 'A' });\n` +
    `const cfg = await import(${JSON.stringify(CONFIG)});\n` +
    `const before = cfg.PROJECT_ID;\n` +
    `cfg.learnProjectId('proj-B');\n` +
    `process.stdout.write(JSON.stringify({ before, after: cfg.PROJECT_ID, inUse: cfg.storedCredentialInUse() }));\n`;
  const clean = { ...process.env };
  delete clean.FLOWVIANT_MACHINE_TOKEN;
  delete clean.FLOWVIANT_FLEET;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: home,
    env: { ...clean, HOME: home, ...env },
    encoding: 'utf8',
  });
  return JSON.parse(out);
}

test('a token from the environment does not borrow the stored project id', () => {
  const r = projectIdWith({ FLOWVIANT_MACHINE_TOKEN: 'fva_B' });
  assert.equal(r.before, null, 'unknown until the roster names it');
  assert.equal(r.inUse, false, 'the store does not describe this token');
  assert.equal(r.after, 'proj-B', 'the roster settles it');
});

test('the stored credential still names its own project', () => {
  const r = projectIdWith({});
  assert.equal(r.before, 'proj-A');
  assert.equal(r.inUse, true);
});
