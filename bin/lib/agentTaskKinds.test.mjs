import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AGENT_TASK_KINDS, KIND_POSTURES, agentTaskKind, agentTaskKindOf, unknownAgentTaskKind } from './agentTaskKinds.mjs';
import { AGENT_CONTRACTS, AGENT_HANDS_BACK, SYSTEM_AGENT, SYSTEM_AGENT_FOR, AGENT_TASK_KICKOFF } from './prompts.mjs';
import { RUNTIMES, canRun } from './runtimes.mjs';
import { workModuleFiles } from './workModules.test.mjs';

/**
 * ONE ENTRY PER KIND, AND EVERY ENTRY COMPLETE (SOLID F041). A kind added to
 * the table without its contract, its kickoff clause, a posture a runtime can
 * declare or the artifact that proves it delivered fails here, never as a turn
 * run under the wrong posture.
 */
test('every kind has a contract, a posture some runtime declares, and a delivery proof', () => {
  const names = Object.keys(AGENT_TASK_KINDS);
  assert.deepEqual(names, ['code', 'design', 'model', 'image', 'deck', 'research']);
  for (const name of names) {
    const k = AGENT_TASK_KINDS[name];
    assert.equal(typeof AGENT_CONTRACTS[name], 'string', `${name}: a contract`);
    assert.equal(SYSTEM_AGENT_FOR(name), AGENT_CONTRACTS[name]);
    const runners = Object.keys(RUNTIMES).filter((id) => canRun(RUNTIMES[id], k.posture));
    assert.ok(runners.length > 0, `${name}: some runtime declares its posture`);
    assert.equal(typeof k.offRuntime('x'), 'string');
    if (name === 'code') {
      assert.equal(k.posture, 'build');
      assert.equal(k.artifact, null);
    } else {
      assert.ok(k.artifact.match instanceof RegExp, `${name}: an artifact rule`);
      assert.deepEqual(Object.keys(k.artifact).sort(), ['match', 'missing'], `${name}: one file proves it`);
      assert.match(k.artifact.missing, /under \.flowviant\/artifacts\/$/);
      assert.equal(typeof AGENT_HANDS_BACK[name], 'string', `${name}: a kickoff clause`);
      // Each non-code kind runs on exactly ONE CLI, and its off-runtime
      // sentence names that CLI.
      assert.equal(runners.length, 1, `${name}: one CLI runs it`);
      assert.equal(
        k.offRuntime('x'),
        runners[0] === 'claude'
          ? 'mockup, 3D model, presentation and write-up cards run on Claude on this machine'
          : 'image cards run on Codex on this machine',
        name
      );
    }
  }
  // The 3D-model and presentation kinds reuse the design fence; the image
  // kind has its own, and each posture is listed once.
  assert.equal(AGENT_TASK_KINDS.model.posture, 'design');
  assert.equal(AGENT_TASK_KINDS.deck.posture, 'design');
  assert.equal(AGENT_TASK_KINDS.image.posture, 'image');
  assert.deepEqual([...KIND_POSTURES], ['design', 'image', 'research']);
});

/**
 * THE IMAGE KIND IS CODEX'S (0.114.0): the pictures come from Codex's own
 * image tool, so Codex alone declares its posture and Claude — which draws no
 * raster image — is refused before spawn. And Codex declares NEITHER of
 * Claude's kind postures: a mockup on Codex is still refused.
 */
test('the image posture is declared by Codex only, and Claude’s by Claude only', () => {
  assert.equal(canRun(RUNTIMES.codex, 'image'), true);
  assert.equal(canRun(RUNTIMES.claude, 'image'), false);
  assert.equal(canRun(RUNTIMES.antigravity, 'image'), false);
  for (const p of ['design', 'research']) {
    assert.equal(canRun(RUNTIMES.claude, p), true, p);
    assert.equal(canRun(RUNTIMES.codex, p), false, p);
  }
  assert.equal(AGENT_TASK_KINDS.image.offRuntime('claude'), 'image cards run on Codex on this machine');
});

test('table-driven: code, design, model, deck, research and an unknown kind', () => {
  const task = (taskKind) => ({ id: 't1', title: 'T', ...(taskKind === undefined ? {} : { taskKind }) });
  const rows = [
    // value      printed    refused   posture    artifact file that proves it
    [undefined, 'code', null, 'build', null],
    ['code', 'code', null, 'build', null],
    ['design', 'design', null, 'design', 'landing.html'],
    ['model', 'model', null, 'design', 'chair/index.html'],
    ['deck', 'deck', null, 'design', 'pitch.html'],
    ['image', 'image', null, 'image', 'hero-banner.png'],
    ['research', 'research', null, 'research', 'notes.md'],
    ['video', 'code', 'video', 'build', null],
  ];
  for (const [value, printed, refused, posture, proof] of rows) {
    assert.equal(agentTaskKindOf(value), printed, String(value));
    assert.equal(unknownAgentTaskKind(value), refused, String(value));
    const k = agentTaskKind(value);
    assert.equal(k.posture, posture, String(value));
    if (proof) {
      assert.ok(k.artifact.match.test(proof), `${value} accepts ${proof}`);
      // …and not the OTHER kind's artifact: a design turn that wrote only a
      // write-up has not delivered a mockup.
      assert.ok(!k.artifact.match.test(value === 'research' ? 'landing.html' : 'notes.md'));
      // …and no page is a picture, nor a picture a page.
      if (value === 'image') assert.ok(!k.artifact.match.test('hero.html'));
      else assert.ok(!k.artifact.match.test('hero.png'), `${value} is not proven by a png`);
    }
    const kickoff = AGENT_TASK_KICKOFF({ agentName: 'A', task: task(value), position: 1, total: 1 });
    if (printed === 'code') {
      assert.match(kickoff, /Flowviant-Task: t1/, 'a code card is told to commit with the trailer');
      assert.equal(SYSTEM_AGENT_FOR(value), SYSTEM_AGENT);
    } else {
      assert.ok(kickoff.includes(AGENT_HANDS_BACK[printed]));
      assert.ok(!kickoff.includes('Flowviant-Task:'), 'a non-code card is never told to commit');
    }
  }
  // Only a sanitised word is ever relayed back.
  assert.equal(unknownAgentTaskKind('x\ny'), 'xy');
  assert.equal(unknownAgentTaskKind('toString'), 'toString', 'a prototype key is not a kind');
  assert.equal(agentTaskKindOf('toString'), 'code');
  assert.equal(agentTaskKindOf({}), 'code');
});

/**
 * THE 3D-MODEL KIND'S PROOF IS ITS PAGE (0.107.0): the model is built in it,
 * and the person exports it to a .glb in Review. A mesh file alone is not a
 * page anybody can turn around. The presentation kind is one page too.
 */
test('a model and a deck are each proven by their html', () => {
  const proven = (kind, names) => names.some((n) => AGENT_TASK_KINDS[kind].artifact.match.test(n));
  assert.equal(proven('model', ['chair/index.html']), true, 'the page is the model');
  assert.equal(proven('model', ['chair/chair.glb', 'chair/chair.obj']), false, 'a mesh with no page is not a delivery');
  assert.equal(proven('deck', ['pitch.html']), true);
  assert.equal(proven('deck', ['notes.md']), false);
  assert.equal(unknownAgentTaskKind('model'), null);
  assert.equal(unknownAgentTaskKind('deck'), null);
  assert.equal(unknownAgentTaskKind('video'), 'video', 'still refused, never built');
});

/** THE IMAGE KIND'S PROOF IS ONE PNG OR WEBP (0.114.0): the formats its
 *  contract asks for. A drawing in code — an SVG, a page — is not the picture. */
test('an image is proven by a png or a webp, and by nothing drawn in code', () => {
  const proven = (names) => names.some((n) => AGENT_TASK_KINDS.image.artifact.match.test(n));
  assert.equal(proven(['hero-banner.png']), true);
  assert.equal(proven(['icons/app-icon.WEBP']), true);
  assert.equal(proven(['hero.svg', 'hero.html', 'hero.jpg', 'notes.md']), false);
  assert.equal(AGENT_TASK_KINDS.image.artifact.missing, 'the turn ended without writing a PNG or WebP image under .flowviant/artifacts/');
  assert.equal(unknownAgentTaskKind('image'), null, 'known since 0.114.0 — before it, refused into Stuck');
});

/** CODE ONLY. */
const code = (file) =>
  readFileSync(new URL(`./${file}`, import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .join('\n');

test('the kind vocabulary has one home: no reader re-spells it', () => {
  // Every work lane by walk, plus the non-work readers by name. The agent
  // turn's run, wire, begun-guard and settlement (SOLID F036) are lanes too;
  // claude.mjs's posture, stream and turn modules (SOLID F046) are readers.
  const files = [...workModuleFiles(), 'prompts.mjs', 'artifactContracts.mjs', 'claude.mjs', 'claudePosture.mjs', 'claudeStream.mjs', 'runTurn.mjs', 'turnProfile.mjs'];
  assert.ok(files.includes('workAgentTurns.mjs') && files.includes('workRetire.mjs'), 'canary: the walk reaches the lanes');
  for (const f of ['workAgentTurnExecution.mjs', 'workAgentTurnOutcome.mjs', 'workAgentTurnReports.mjs', 'workAgentTurnBegun.mjs'])
    assert.ok(files.includes(f), `canary: the walk reaches ${f}`);
  for (const file of files) {
    const src = code(file);
    assert.ok(!/export const agentTaskKindOf|export const unknownAgentTaskKind/.test(src), `${file} defines the vocabulary`);
    assert.ok(!/=== 'design' \|\| \w+ === 'research'/.test(src), `${file} lists the non-code kinds by hand`);
    assert.ok(!/taskKind === 'design'/.test(src), `${file} branches on a kind name`);
  }
});
