import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TURN_PROFILES, RETIRED_POSTURE_KEYS, resolveTurnProfile } from './turnProfile.mjs';
import { KIND_POSTURES } from './agentTaskKinds.mjs';
import { RUNTIMES } from './runtimes.mjs';
import { workModuleFiles } from './workModules.test.mjs';

/**
 * ONE PROFILE PER TURN (SOLID F047). A caller used to be able to say two
 * postures at once — `planPerm` beside `readOnly`, `posture` beside `wikiPerm`
 * — and the answer was whichever branch came first. Now a caller names one,
 * and anything else fails the turn in words.
 *
 * A fake `claude` on PATH records that it ran, so a refusal is proved by the
 * CLI never spawning — not by a missing binary.
 */
const dir = mkdtempSync(join(tmpdir(), 'fv-turnprofile-'));
const ranMarker = join(dir, 'claude-ran');
writeFileSync(
  join(dir, 'claude'),
  `#!/usr/bin/env node\nrequire('node:fs').appendFileSync(${JSON.stringify(ranMarker)}, 'x');\n` +
    `process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: JSON.stringify(process.argv.slice(2)) }) + '\\n');\n`
);
chmodSync(join(dir, 'claude'), 0o755);
process.env.PATH = `${dir}:${process.env.PATH}`;
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
const { runTurn } = await import('./runTurn.mjs');
const { CLAUDE_PERM_PROFILES, claudePermFor, PLAN_MODE_PERM } = await import('./claudePosture.mjs');

test('absent is build; each name resolves to itself; the adapter sees build under plan mode', () => {
  assert.equal(resolveTurnProfile({}).name, 'build');
  assert.equal(resolveTurnProfile().adapterProfile, 'build');
  for (const name of Object.keys(TURN_PROFILES)) assert.equal(resolveTurnProfile({ profile: name }).name, name);
  const pm = resolveTurnProfile({ profile: 'plan-mode' });
  assert.equal(pm.adapterProfile, 'build');
  assert.equal(pm.strictMcp, true);
  assert.deepEqual(claudePermFor('plan-mode', null), PLAN_MODE_PERM);
});

test('conflicting or retired posture requests are refused, never resolved by branch order', () => {
  for (const opts of [
    { planPerm: true, readOnly: true },
    { readOnly: true },
    { wikiPerm: true },
    { planMode: true },
    { posture: 'design' },
    { profile: 'plan', readOnly: true },
    { profile: 'consult', planMode: false },
  ]) {
    const r = resolveTurnProfile(opts);
    assert.ok(r.error, JSON.stringify(opts));
    assert.match(r.error, /retired posture switch/);
  }
  assert.match(resolveTurnProfile({ profile: 'godmode' }).error, /unknown turn profile 'godmode'/);
  assert.match(resolveTurnProfile({ profile: 'toString' }).error, /unknown turn profile/);
  assert.match(resolveTurnProfile({ profile: 7 }).error, /unknown turn profile/);
  assert.deepEqual([...RETIRED_POSTURE_KEYS], ['wikiPerm', 'readOnly', 'planPerm', 'planMode', 'posture']);
});

test('a retired switch or unknown profile fails the turn before any CLI spawns', async () => {
  for (const opts of [{ readOnly: true }, { planPerm: true, readOnly: true }, { profile: 'godmode' }]) {
    rmSync(ranMarker, { force: true });
    const out = await runTurn({ prompt: 'p', system: 's', cwd: tmpdir(), streamJson: true, answerFromResult: true, ...opts });
    assert.equal(out, '', JSON.stringify(opts));
    assert.ok(!existsSync(ranMarker), `${JSON.stringify(opts)}: never spawned`);
  }
  // Canary: a named profile does spawn the fake.
  rmSync(ranMarker, { force: true });
  const argv = JSON.parse((await runTurn({ prompt: 'p', system: 's', cwd: tmpdir(), streamJson: true, answerFromResult: true, profile: 'consult' })).trim());
  assert.ok(existsSync(ranMarker));
  assert.ok(argv.includes('--allowedTools'), 'consult is a curated list');
});

test('who may run what: plan mode is Claude\'s, the kind postures need a runtime that declares them', () => {
  const claude = RUNTIMES.claude;
  const codex = RUNTIMES.codex;
  assert.equal(resolveTurnProfile({ profile: 'plan-mode' }).onlyOn(claude), null);
  assert.equal(resolveTurnProfile({ profile: 'plan-mode' }).onlyOn(codex), `plan mode runs on Claude Code only — not '${codex.label}'`);
  // RESEARCH IS CLAUDE'S; DESIGN IS CLAUDE'S AND CODEX'S (0.115.0), and the
  // refusal names both.
  assert.equal(resolveTurnProfile({ profile: 'research' }).onlyOn(claude), null);
  assert.equal(resolveTurnProfile({ profile: 'research' }).onlyOn(codex), `a research card runs on Claude Code only — not '${codex.label}'`);
  assert.equal(resolveTurnProfile({ profile: 'design' }).onlyOn(claude), null);
  assert.equal(resolveTurnProfile({ profile: 'design' }).onlyOn(codex), null);
  assert.equal(
    resolveTurnProfile({ profile: 'design' }).onlyOn(RUNTIMES.antigravity),
    "a design card runs on Claude Code or Codex only — not 'Antigravity'"
  );
  // THE IMAGE POSTURE IS CODEX'S (0.114.0), and the sentence names the CLI
  // that declares it rather than assuming Claude.
  assert.equal(resolveTurnProfile({ profile: 'image' }).onlyOn(codex), null);
  assert.equal(resolveTurnProfile({ profile: 'image' }).onlyOn(claude), "an image card runs on Codex only — not 'Claude Code'");
  assert.equal(resolveTurnProfile({ profile: 'image' }).onlyOn(RUNTIMES.antigravity), "an image card runs on Codex only — not 'Antigravity'");
  for (const name of ['build', 'wiki', 'consult', 'plan']) assert.equal(resolveTurnProfile({ profile: name }).onlyOn, null, name);
});

test('the vocabulary and Claude\'s lists are one set, and every kind posture is a profile', () => {
  assert.deepEqual([...CLAUDE_PERM_PROFILES].sort(), Object.keys(TURN_PROFILES).sort());
  for (const p of KIND_POSTURES) assert.ok(Object.hasOwn(TURN_PROFILES, p), p);
  assert.throws(() => claudePermFor('godmode'), /no Claude permission list/);
});

/** CODE ONLY. */
const code = (file) =>
  readFileSync(new URL(`./${file}`, import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .join('\n');

test('no caller passes a retired posture switch to runTurn', () => {
  // Every work lane by walk, plus the non-work spawners by name. The agent
  // turn's CLI is spawned from workAgentTurnExecution.mjs since SOLID F036;
  // runTurn and the postures left claude.mjs in SOLID F046.
  const callers = [...workModuleFiles(), 'fleet.mjs', 'wikiRunner.mjs', 'claude.mjs', 'claudePosture.mjs', 'claudeStream.mjs', 'runTurn.mjs', 'runtimes.mjs', 'runtimeClaude.mjs', 'runtimeCodex.mjs', 'runtimeAntigravity.mjs', 'runtimeEvents.mjs', 'runtimeDetection.mjs', 'runtimeCapabilities.mjs'];
  assert.ok(callers.includes('workAgentPlans.mjs') && callers.includes('workRetire.mjs'), 'canary: the walk reaches the lanes');
  assert.ok(callers.includes('workAgentTurnExecution.mjs'), 'canary: the walk reaches the agent turn\'s run');
  for (const file of callers) {
    const src = code(file);
    for (const k of RETIRED_POSTURE_KEYS) assert.ok(!new RegExp(`\\b${k}:`).test(src), `${file} passes ${k}`);
  }
  // Canary: the callers name their profile.
  assert.equal(code('wikiRunner.mjs').split("profile: 'wiki',").length - 1, 2, 'both wiki lanes');
  assert.ok(code('workAgentPlans.mjs').includes("profile: 'consult',"));
  assert.ok(code('workAgentPrecheck.mjs').includes("profile: 'consult',"));
});
