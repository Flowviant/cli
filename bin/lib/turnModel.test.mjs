/**
 * WHICH MODEL A TURN RAN ON (2026-09-29) — read off the CLI's own words and
 * nothing else. Claude's from the stream (the init event, else the first
 * reply), Codex's from the thread's rollout (`turn_context`).
 *
 * Run: node --test bin/lib/turnModel.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TURN_MODEL_MAX, codexTurnModel, turnModelOf } from './turnModel.mjs';
import { handleStreamLine } from './claudeStream.mjs';

/**
 * MEASURED on Claude Code 2.1.284, 2026-09-29 (`claude -p "say hi" --model
 * haiku --output-format stream-json --verbose`): the init line, its lists cut
 * to two entries and its paths anonymised, every key as the CLI sent it.
 */
const MEASURED_INIT = JSON.stringify({
  type: 'system',
  subtype: 'init',
  cwd: '/tmp/probe',
  session_id: 'b93b669c-85ff-4439-a221-fcee652bf9c3',
  tools: ['Task', 'Bash'],
  mcp_servers: [{ name: 'claude.ai Claude Docs', status: 'pending', source: 'claudeai' }],
  model: 'claude-haiku-4-5-20251001',
  permissionMode: 'default',
  slash_commands: ['deep-research', 'design'],
  terminal_slash_commands: ['doctor', 'color'],
  apiKeySource: 'none',
  claude_code_version: '2.1.284',
  output_style: 'default',
  agents: ['claude', 'Explore'],
  skills: ['deep-research', 'design'],
  plugins: [{ name: 'agents-md', path: 'builtin', source: 'agents-md@builtin' }],
  capabilities: ['interrupt_receipt_v1', 'interrupt_cancel_queued_v1'],
  analytics_disabled: false,
  product_feedback_disabled: false,
  uuid: '63c9ad39-d7c7-4e1d-927f-a1e65887a9d0',
  fast_mode_state: 'off',
  fast_mode_disabled_reason: 'sdk_opt_in_required',
  per_turn_effort_active: false,
  view_mode: 'default',
});
/** The same probe's first reply, as the CLI framed it. */
const reply = (model, parent = null) =>
  JSON.stringify({
    type: 'assistant',
    message: {
      id: 'msg_011CfXsMFQYveBzvDStNVenW',
      type: 'message',
      role: 'assistant',
      model,
      content: [{ type: 'text', text: 'Hi!' }],
    },
    parent_tool_use_id: parent,
    session_id: 'b93b669c-85ff-4439-a221-fcee652bf9c3',
  });

const heard = (line) => {
  const models = [];
  handleStreamLine(line, { cwd: '/tmp/x', emit() {}, appendText() {}, onModel: (m) => models.push(m) });
  return models;
};

test('the shape takes the ids the CLIs name and nothing else', () => {
  for (const id of ['claude-opus-5-5', 'claude-haiku-4-5-20251001', 'gpt-6-sol', 'us.anthropic.claude-opus-5-5-v1:0', 'org/model']) {
    assert.equal(turnModelOf(id), id, id);
  }
  assert.equal(turnModelOf('x'.repeat(TURN_MODEL_MAX)), 'x'.repeat(TURN_MODEL_MAX));
  for (const bad of ['<synthetic>', '', 'claude-opus-5-5[1m]', 'two words', 'x'.repeat(TURN_MODEL_MAX + 1), 42, null, undefined, {}]) {
    assert.equal(turnModelOf(bad), null, String(bad));
  }
});

test('the init event names the model the turn resolved', () => {
  assert.deepEqual(heard(MEASURED_INIT), ['claude-haiku-4-5-20251001']);
  // …and still hands its other facts to onInit, as before.
  const inits = [];
  handleStreamLine(MEASURED_INIT, { cwd: '/tmp/x', emit() {}, appendText() {}, onInit: (i) => inits.push(i) });
  assert.equal(inits[0].sessionId, 'b93b669c-85ff-4439-a221-fcee652bf9c3');
});

test("a reply names its model; a subagent's or a synthetic one does not count", () => {
  assert.deepEqual(heard(reply('claude-opus-5-5')), ['claude-opus-5-5']);
  assert.deepEqual(heard(reply('claude-haiku-4-5-20251001', 'toolu_01')), [], "a subagent's model is not the turn's");
  assert.deepEqual(heard(reply('<synthetic>')), [], 'a synthetic error message ran on nothing');
  assert.deepEqual(heard(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's' })), [], 'an init naming none says nothing');
});

/** A rollout in a scratch CODEX_HOME, dated today as the CLI files it. */
function rollout(t, thread, lines) {
  const home = mkdtempSync(join(tmpdir(), 'fv-turnmodel-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const now = new Date();
  const day = join(
    home,
    'sessions',
    String(now.getFullYear()),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0')
  );
  mkdirSync(day, { recursive: true });
  writeFileSync(join(day, `rollout-2026-09-29T01-45-15-${thread}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return { CODEX_HOME: home };
}

/** MEASURED on Codex 0.156.1, 2026-09-29: a turn's context line, its long
 *  policy objects elided — `model` sits beside the effort it ran with. */
const turnContext = (at, model) => ({
  timestamp: new Date(at).toISOString(),
  ordinal: 7,
  type: 'turn_context',
  payload: {
    turn_id: '01a0ebb2-2350-7510-a746-531475472e98',
    cwd: '/work/reviewpager',
    current_date: '2026-09-29',
    approval_policy: 'never',
    sandbox_policy: { type: 'workspace-write', network_access: false },
    model,
    collaboration_mode: { mode: 'default', settings: { model, reasoning_effort: 'xhigh', developer_instructions: null } },
    effort: 'xhigh',
    summary: 'none',
  },
});
const noise = (at, n) =>
  Array.from({ length: n }, (_, i) => ({
    timestamp: new Date(at).toISOString(),
    type: 'event_msg',
    payload: { type: 'agent_message', message: `step ${i} ${'·'.repeat(400)}` },
  }));

test("a Codex turn's model is its rollout's newest turn_context, read back across chunks", async (t) => {
  const thread = '01a0ebb2-228b-7b71-820e-d8bd9c8adb44';
  const t0 = Date.now() - 60_000;
  const env = rollout(t, thread, [
    { timestamp: new Date(t0).toISOString(), type: 'session_meta', payload: { id: thread, cli_version: '0.156.1', model_provider: 'openai' } },
    turnContext(t0, 'gpt-6-astra'),
    ...noise(t0, 50),
    turnContext(t0 + 30_000, 'gpt-6-sol'),
    // Well past one 256 KiB chunk, so the line is found by the backward walk.
    ...noise(t0 + 31_000, 2000),
  ]);
  assert.equal(await codexTurnModel(thread, { env }), 'gpt-6-sol', 'the newest context, not the first');
  assert.equal(await codexTurnModel(thread, { env, since: t0 + 30_000 }), 'gpt-6-sol');
});

test("a context written before the spawn is a previous turn's, and nothing is claimed", async (t) => {
  const thread = '01a0ebb2-22a8-7b62-a630-089826904348';
  const t0 = Date.now() - 60_000;
  const env = rollout(t, thread, [turnContext(t0, 'gpt-6-sol'), ...noise(t0, 3)]);
  assert.equal(await codexTurnModel(thread, { env, since: Date.now() }), null);
});

test('a missing, garbled or model-less rollout says nothing and never throws', async (t) => {
  const thread = '01a0ebb2-0000-7000-8000-000000000001';
  const env = rollout(t, thread, [{ ...turnContext(Date.now(), '<synthetic>') }]);
  assert.equal(await codexTurnModel(thread, { env }), null, 'a model the shape refuses');
  assert.equal(await codexTurnModel('01a0ebb2-0000-7000-8000-00000000dead', { env }), null, 'no such thread');
  assert.equal(await codexTurnModel('../../etc/passwd', { env }), null, 'an id of the wrong shape');
  assert.equal(await codexTurnModel(thread, { env: { CODEX_HOME: '/nonexistent/fv' } }), null);
});
