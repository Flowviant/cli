import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MACHINE_CREDENTIAL_ENV, withoutMachineCredentials } from './machineEnv.mjs';
import { workModuleFiles } from './workModules.test.mjs';

test('both machine credential names go; the CLI sign-in and everything else survive', () => {
  const input = {
    FLOWVIANT_MACHINE_TOKEN: 'fva_machine',
    FLOWVIANT_FLEET: 'fva_fleet',
    ANTHROPIC_API_KEY: 'sk-ant',
    CLAUDE_CODE_OAUTH_TOKEN: 'oauth',
    HOME: '/home/op',
    PATH: '/usr/bin',
  };
  const out = withoutMachineCredentials(input);
  assert.equal(out.FLOWVIANT_MACHINE_TOKEN, undefined);
  assert.equal(out.FLOWVIANT_FLEET, undefined);
  assert.equal(out.ANTHROPIC_API_KEY, 'sk-ant');
  assert.equal(out.CLAUDE_CODE_OAUTH_TOKEN, 'oauth');
  assert.equal(out.HOME, '/home/op');
  assert.equal(out.PATH, '/usr/bin');
  // The input is the daemon's own environment — never mutated.
  assert.equal(input.FLOWVIANT_MACHINE_TOKEN, 'fva_machine');
  assert.deepEqual(withoutMachineCredentials(undefined), {});
});

/** CODE ONLY — comments quote the names they explain. */
const code = (file) =>
  readFileSync(new URL(`./${file}`, import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .join('\n');

test('the removal rule has one home: no lane keeps its own list', () => {
  assert.deepEqual([...MACHINE_CREDENTIAL_ENV], ['FLOWVIANT_MACHINE_TOKEN', 'FLOWVIANT_FLEET']);
  // Every work lane by walk (a lane split out later is covered the day it
  // lands), plus the non-work spawners by name (claude.mjs's posture, stream
  // and turn modules since SOLID F046).
  const files = [...workModuleFiles(), 'claude.mjs', 'claudePosture.mjs', 'claudeStream.mjs', 'runTurn.mjs', 'runtimes.mjs', 'runtimeClaude.mjs', 'runtimeCodex.mjs', 'runtimeAntigravity.mjs', 'runtimeEvents.mjs', 'runtimeDetection.mjs', 'runtimeCapabilities.mjs', 'childEnv.mjs'];
  assert.ok(files.includes('workAgentCheck.mjs') && files.includes('workRetire.mjs'), 'canary: the walk reaches the lanes');
  for (const file of files) {
    const src = code(file);
    assert.ok(!/\[\s*'FLOWVIANT_MACHINE_TOKEN',\s*'FLOWVIANT_FLEET'\s*\]/.test(src), `${file} holds a second list`);
    // No lane spells a credential name at all: every one reads the list.
    assert.ok(!/'FLOWVIANT_(MACHINE_TOKEN|FLEET)'/.test(src), `${file} spells a machine credential name by hand`);
  }
  assert.ok(code('childEnv.mjs').includes('...MACHINE_CREDENTIAL_ENV'), 'redaction is a superset of removal by construction');
  assert.ok(code('runTurn.mjs').includes('withoutMachineCredentials({ ...process.env, ...(mcpEnv ?? {}) })'));
  assert.ok(code('workAgentCheck.mjs').includes('withoutMachineCredentials(env)'));
});

test('every machine credential removed from a child is also redacted from what leaves the box', async () => {
  const { processEnvSecrets } = await import('./childEnv.mjs');
  const saved = {};
  for (const k of MACHINE_CREDENTIAL_ENV) {
    saved[k] = process.env[k];
    process.env[k] = `fva_value_for_${k.toLowerCase()}`;
  }
  try {
    const secrets = JSON.stringify(processEnvSecrets());
    for (const k of MACHINE_CREDENTIAL_ENV) assert.ok(secrets.includes(`fva_value_for_${k.toLowerCase()}`), `${k} is redacted`);
  } finally {
    for (const k of MACHINE_CREDENTIAL_ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});
