/**
 * ONE MACHINE, TWO CLIs (2026-09-24) — Claude plans, Codex executes.
 *
 * A project may send its agents to Codex while Claude plans and captures. Each
 * CLI is its own account, so each keeps its own memory, its own spend and its
 * own limit. These pin the daemon's half of that:
 *
 *  · codex's `turn.completed` usage reaches `onUsage`, in the daemon's one
 *    vocabulary, with the cached share not counted twice;
 *  · codex's `turn.failed` words reach the text the limit matcher reads;
 *  · codex's agent MESSAGE is surfaced alone, so the final JSON is read off the
 *    last thing the agent said rather than the first object anywhere in `out`;
 *  · an agent on codex resumes its own pinned thread, a limit names its CLI,
 *    and the agent prompt names no CLI.
 *
 * Run: node --test bin/lib/runtimeSplit.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { RUNTIMES } from './runtimes.mjs';
import { SYSTEM_AGENT } from './prompts.mjs';

const parse = (ev) => RUNTIMES.codex.parse(JSON.stringify(ev), '/wt');
const workSource = () => readFileSync(new URL('./work.mjs', import.meta.url), 'utf8');
const fnBody = (src, name) => {
  const i = src.indexOf(`const ${name} = `);
  assert.ok(i > -1, `${name} must exist`);
  const j = src.indexOf('\n  const ', i + 10);
  return src.slice(i, j > -1 ? j : src.length);
};

test("codex's turn.completed usage is relayed in the daemon's vocabulary", () => {
  const ev = parse({
    type: 'turn.completed',
    usage: { input_tokens: 1200, cached_input_tokens: 800, output_tokens: 300 },
  });
  // OpenAI's input INCLUDES the cached part; the daemon's four counters do
  // not, so the cached share is subtracted rather than counted twice.
  assert.deepEqual(ev.usage, { input: 400, output: 300, cacheCreate: 0, cacheRead: 800 });
  assert.equal(ev.activity, null);
  assert.equal(ev.text, '');
});

test('a turn.completed with no usage reports nothing, never four zeros', () => {
  assert.equal(parse({ type: 'turn.completed' }), null);
});

test('garbage counts floor to zero and cannot drive input negative', () => {
  const ev = parse({
    type: 'turn.completed',
    usage: { input_tokens: 'x', cached_input_tokens: 50, output_tokens: -3, total_cost_usd: 9 },
  });
  assert.deepEqual(ev.usage, { input: 0, output: 0, cacheCreate: 0, cacheRead: 50 });
  assert.ok(!('costUsd' in ev.usage) && !('total_cost_usd' in ev.usage), 'dollars are never relayed');
});

test("codex's turn.failed words reach the text the limit matcher reads", () => {
  const ev = parse({ type: 'turn.failed', error: { message: "You've reached your usage limit." } });
  assert.equal(ev.text, "You've reached your usage limit.\n");
  // …and an empty message still adds nothing.
  assert.equal(parse({ type: 'turn.failed', error: { message: '' } }).text, '');
});

test('an agent message is surfaced alone as the answer; reasoning is not', () => {
  const msg = parse({ type: 'item.completed', item: { type: 'agent_message', text: '{"status":"delivered"}' } });
  assert.equal(msg.answer, '{"status":"delivered"}');
  const thought = parse({ type: 'item.completed', item: { type: 'reasoning', text: 'maybe {"status":"delivered"}' } });
  assert.equal(thought.answer, undefined);
});

test('an agent on codex resumes its own pinned thread, keyed by the AGENT', () => {
  const turn = fnBody(workSource(), 'runAgentTurn');
  assert.ok(turn.includes("sessionMetaPath(wt, 'flowviant-agent-codex-thread', agentId)"));
  assert.ok(turn.includes('resumeThreadId: codexResumeId || undefined'));
  assert.ok(/CODEX_THREAD_RE\.test\(v\)\) codexResumeId = v/.test(turn), 'shape-checked before it rides argv');
  assert.ok(/CODEX_THREAD_RE\.test\(seenThreadId\)/.test(turn), 'persisted only in a shape argv can carry');
  // Never `resume --last`, which is machine-global: codex resumes only by id.
  assert.ok(turn.includes("rt === 'codex'\n          ? Boolean(codexResumeId)"));
});

test('only a Claude turn writes the marker that sends Claude to --continue', () => {
  const turn = fnBody(workSource(), 'runAgentTurn');
  assert.ok(turn.includes("if (ranMarker && rt === 'claude') {"));
});

test('a lost resume runs once more fresh, in the same worktree', () => {
  const turn = fnBody(workSource(), 'runAgentTurn');
  const at = turn.indexOf('out = await runTurn(agentTurnArgs);');
  assert.ok(at > -1);
  const after = turn.slice(at, at + 1200);
  assert.ok(after.includes("if (resume && (!(out || '').trim() || resumeConversationLost(out))) {"));
  assert.ok(after.includes('runTurn({ ...agentTurnArgs, resume: false, resumeThreadId: undefined })'));
});

test("the outcome is read off the agent's last message first", () => {
  const turn = fnBody(workSource(), 'runAgentTurn');
  assert.ok(turn.includes('const res = (lastAnswer && parseTurnResult(lastAnswer)) || parseTurnResult(out);'));
});

test('a limit parks only the CLI that hit it', () => {
  const src = workSource();
  assert.ok(fnBody(src, 'runAgentTurn').includes('await postAgentParked(limit, rt);'));
  const post = fnBody(src, 'postAgentParked');
  assert.ok(post.includes('JSON.stringify({ reason, ...(runtime ? { runtime } : {}) })'));
});

test('the agent prompt names no CLI and points at both instruction files', () => {
  assert.ok(!/own Claude/.test(SYSTEM_AGENT));
  assert.ok(SYSTEM_AGENT.includes('CLAUDE.md') && SYSTEM_AGENT.includes('AGENTS.md'));
});
