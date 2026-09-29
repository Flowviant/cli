/**
 * ONE TURN'S PROCESS LIFETIME, AFTER THE SPLIT (SOLID 2026-09-26, F046) —
 * runTurn.mjs owns the spawn and the supervision of a CLI child, and these
 * pin the two exits every turn takes, through a fake `claude` on PATH:
 *
 *  · CLOSE resolves with everything the child said — on the line-parsed path
 *    the last line is flushed even when it carries no newline, and on the raw
 *    path stdout and stderr both land in the haystack the sentinels read.
 *  · ERROR fails the TURN, never the daemon: a CLI missing from PATH resolves
 *    '' on both paths (it used to `process.exit(1)`), and any other spawn
 *    error resolves what was captured so far.
 *
 * And the split itself, pinned as source: each rule claude.mjs used to hold
 * has exactly one home now, and a copy coming back fails here.
 *
 * Run: node --test bin/lib/runTurn.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTurn } from './runTurn.mjs';
import { handleStreamLine } from './claudeStream.mjs';
import { resetRuntimeLimitsForTest, runtimeLimitsReport } from './runtimeLimits.mjs';

const dir = mkdtempSync(join(tmpdir(), 'fv-runturn-'));
writeFileSync(
  join(dir, 'claude'),
  `#!/usr/bin/env node
const mode = process.env.FAKE_MODE;
if (mode === 'tail') {
  // A result event with NO trailing newline: only the close-time flush reads it.
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'the tail' }));
} else if (mode === 'raw') {
  process.stdout.write('said on stdout\\nWIKI_DONE\\n');
  process.stderr.write('warned on stderr\\n');
} else if (mode === 'fail') {
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['No conversation found'] }) + '\\n');
  process.exit(1);
} else if (mode === 'model') {
  // The init names the model; the replies name it again, and a subagent's names another.
  const say = (ev) => process.stdout.write(JSON.stringify(ev) + '\\n');
  say({ type: 'system', subtype: 'init', session_id: 's-1', skills: [], model: 'claude-opus-5-5' });
  say({ type: 'assistant', parent_tool_use_id: 'toolu_1', message: { model: 'claude-haiku-4-5-20251001', content: [] } });
  say({ type: 'assistant', parent_tool_use_id: null, message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: 'hi' }] } });
  say({ type: 'result', subtype: 'success', result: 'hi' });
} else if (mode === 'model-reply') {
  // An init whose model the shape refuses: the turn's first reply is the answer.
  const say = (ev) => process.stdout.write(JSON.stringify(ev) + '\\n');
  say({ type: 'system', subtype: 'init', session_id: 's-1', model: 'claude-opus-5-5[1m]' });
  say({ type: 'assistant', parent_tool_use_id: null, message: { model: 'claude-opus-5-5', content: [] } });
  say({ type: 'result', subtype: 'success', result: 'hi' });
} else if (mode === 'limits') {
  // The MEASURED line, verbatim, before the result — as the CLI orders them.
  process.stdout.write(process.env.FAKE_RATE_LINE + '\\n');
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'hi' }) + '\\n');
}
`
);
chmodSync(join(dir, 'claude'), 0o755);
// A fake `codex`: it announces its thread and answers; its limits live in the
// rollout the test writes, as the real CLI's do.
writeFileSync(
  join(dir, 'codex'),
  `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: process.env.FAKE_THREAD }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'done' } }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } }) + '\\n');
`
);
chmodSync(join(dir, 'codex'), 0o755);
const ORIGINAL_PATH = process.env.PATH;
process.env.PATH = `${dir}:${ORIGINAL_PATH}`;

const turn = (mode, opts = {}) => {
  process.env.FAKE_MODE = mode;
  return runTurn({ prompt: 'p', system: 's', cwd: tmpdir(), ...opts });
};

/** Run `fn` with PATH pointing only at `path`, restoring it however fn ends. */
async function withPath(path, fn) {
  const saved = process.env.PATH;
  process.env.PATH = path;
  try {
    return await fn();
  } finally {
    process.env.PATH = saved;
  }
}

test('close on the line-parsed path flushes a last line that has no newline', async () => {
  const out = await turn('tail', { streamJson: true, answerFromResult: true });
  assert.equal(out, 'the tail\n');
});

test('close on the raw path resolves stdout and stderr together, sentinels intact', async () => {
  const out = await turn('raw');
  assert.ok(out.includes('said on stdout\n'));
  assert.ok(out.includes('WIKI_DONE\n'), 'the sentinel reaches the haystack');
  assert.ok(out.includes('warned on stderr\n'), 'stderr is kept for the sentinels too');
});

test('a child that exits non-zero still resolves what it explained', async () => {
  const out = await turn('fail', { streamJson: true, answerFromResult: true });
  assert.equal(out, 'No conversation found\n');
});

test('a CLI missing from PATH fails the turn with nothing — on both paths — and the daemon lives', async () => {
  const empty = mkdtempSync(join(tmpdir(), 'fv-runturn-empty-'));
  await withPath(empty, async () => {
    assert.equal(await turn('tail', { streamJson: true, answerFromResult: true }), '');
    assert.equal(await turn('raw'), '');
  });
  // Canary: the same fake still runs once PATH finds it again.
  assert.equal(await turn('tail', { streamJson: true, answerFromResult: true }), 'the tail\n');
});

test('any other spawn error resolves the turn rather than hanging or throwing', async () => {
  // A `claude` that exists but cannot be executed: the spawn errors with
  // something other than ENOENT, and the turn still settles.
  const noexec = mkdtempSync(join(tmpdir(), 'fv-runturn-noexec-'));
  writeFileSync(join(noexec, 'claude'), '#!/bin/sh\necho never\n');
  chmodSync(join(noexec, 'claude'), 0o644);
  await withPath(noexec, async () => {
    assert.equal(await turn('raw'), '');
    assert.equal(await turn('tail', { streamJson: true }), '');
  });
});

// ── the split, pinned as source ──────────────────────────────────────────────

const code = (f) =>
  readFileSync(new URL(`./${f}`, import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .join('\n');
const daemonFiles = readdirSync(new URL('.', import.meta.url)).filter((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs'));

test('each rule claude.mjs held has exactly one home', () => {
  // Canary: the walk sees the daemon, not an empty directory.
  for (const f of ['claude.mjs', 'claudePosture.mjs', 'claudeStream.mjs', 'runTurn.mjs', 'runtimes.mjs']) {
    assert.ok(daemonFiles.includes(f), f);
  }
  const homes = [
    ['export function runTurn(', 'runTurn.mjs'],
    ['export function cliEnv(', 'runTurn.mjs'],
    ['spawn(rt.bin, args,', 'runTurn.mjs'],
    ['export function handleStreamLine(', 'claudeStream.mjs'],
    ['export function usageFromResult(', 'claudeStream.mjs'],
    ['export function claudePermFor(', 'claudePosture.mjs'],
    ['export const READ_GUARD_SETTINGS', 'claudePosture.mjs'],
    ['const WIKI_PERM = [', 'claudePosture.mjs'],
    ['function fencedReads(', 'claudePosture.mjs'],
    ['export const sawSentinel', 'claude.mjs'],
    ['export function mcpFor(', 'claude.mjs'],
  ];
  for (const [needle, home] of homes) {
    const holders = daemonFiles.filter((f) => code(f).includes(needle));
    assert.deepEqual(holders, [home], `${needle} lives in ${home} alone`);
  }
});

test('claude.mjs keeps no posture, stream or process of its own, and re-exports none', () => {
  const c = code('claude.mjs');
  assert.ok(c.includes('export const blockedId'), 'canary: this is claude.mjs');
  for (const banned of ['node:child_process', "from './claudePosture.mjs'", "from './claudeStream.mjs'", "from './runTurn.mjs'", "export * from", '--allowedTools']) {
    assert.ok(!c.includes(banned), `claude.mjs holds ${banned}`);
  }
});

// ── the plan's windows, learned off the turn (0.109.0) ───────────────────────

// MEASURED on Claude Code 2.1.283, 2026-09-28 — verbatim (runtimeLimits.test.mjs).
const MEASURED_CLAUDE_LINE =
  '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1790619000,"rateLimitType":"five_hour","overageStatus":"rejected","overageDisabledReason":"out_of_credits","isUsingOverage":false,"unifiedWindows":{"five_hour":{"utilization":0.03,"resetsAt":1790619000},"seven_day":{"utilization":0.48,"resetsAt":1791028800}}},"uuid":"9c1e60ee-7c8d-491d-871f-b161560b90a9","session_id":"0fce9895-c1d7-462d-99ba-afdbe08fab1a"}';

test('a rate_limit_event reaches onRateLimit whole, and adds no text and no activity', () => {
  const seen = { limits: [], text: '', emitted: [], activity: [], usage: [] };
  handleStreamLine(MEASURED_CLAUDE_LINE, {
    cwd: '/tmp/x',
    emit: (a) => seen.emitted.push(a),
    onActivity: (a) => seen.activity.push(a),
    appendText: (t) => {
      seen.text += t;
    },
    onUsage: (u) => seen.usage.push(u),
    onRateLimit: (i) => seen.limits.push(i),
  });
  assert.deepEqual(seen.limits, [JSON.parse(MEASURED_CLAUDE_LINE).rate_limit_info]);
  assert.equal(seen.text, '');
  assert.deepEqual(seen.emitted, []);
  assert.deepEqual(seen.activity, []);
  assert.deepEqual(seen.usage, []);
  // A caller that asked for none is unaffected.
  handleStreamLine(MEASURED_CLAUDE_LINE, { cwd: '/tmp/x', emit() {}, appendText() {} });
});

test("a Claude turn's rate_limit_event feeds the machine's limits report, and the caller's own handler", async () => {
  resetRuntimeLimitsForTest();
  process.env.FAKE_RATE_LINE = MEASURED_CLAUDE_LINE;
  const heard = [];
  const out = await turn('limits', { streamJson: true, answerFromResult: true, onRateLimit: (i) => heard.push(i.status) });
  assert.equal(out, 'hi\n', 'the answer is untouched');
  assert.deepEqual(heard, ['allowed']);
  const r = runtimeLimitsReport({ detected: [{ id: 'claude', installed: true }], plan: null });
  assert.deepEqual(
    r.claude.windows.map((w) => [w.id, w.usedPct]),
    [['five_hour', 3], ['seven_day', 48]]
  );
});

test("a Codex turn's rollout is read after the child closes, never before the answer", async () => {
  resetRuntimeLimitsForTest();
  const home = mkdtempSync(join(tmpdir(), 'fv-runturn-codex-'));
  const now = new Date();
  const day = join(
    home,
    'sessions',
    String(now.getFullYear()),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0')
  );
  mkdirSync(day, { recursive: true });
  const thread = '01a0e0e1-f12a-7363-9eff-8b81940366fc';
  // MEASURED on Codex 0.156.1, 2026-09-28: the rollout's token_count envelope.
  writeFileSync(
    join(day, `rollout-2026-09-28T10-00-00-${thread}.jsonl`),
    JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        rate_limits: JSON.parse(
          '{"limit_id":"codex","limit_name":null,"primary":{"used_percent":4.0,"window_minutes":10080,"resets_at":1791084105},"secondary":null,"credits":{"has_credits":false,"unlimited":false,"balance":"0"},"individual_limit":null,"spend_control_reached":null,"plan_type":"prolite","rate_limit_reached_type":null}'
        ),
      },
    }) + '\n'
  );
  const saved = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  process.env.FAKE_THREAD = thread;
  try {
    const threads = [];
    await runTurn({ prompt: 'p', system: 's', cwd: tmpdir(), runtime: 'codex', onThreadId: (id) => threads.push(id) });
    assert.deepEqual(threads, [thread], "the caller's onThreadId still hears it");
    assert.equal(runtimeLimitsReport({ detected: [], plan: null }), null, 'not learned before the answer is handed back');
    let r = null;
    for (let i = 0; i < 100 && !r; i++) {
      await new Promise((res) => setTimeout(res, 10));
      r = runtimeLimitsReport({ detected: [], plan: null });
    }
    assert.equal(r?.codex?.plan, 'prolite');
    assert.deepEqual(r.codex.windows.map((w) => [w.id, w.minutes, w.usedPct]), [['seven_day', 10080, 4]]);
  } finally {
    if (saved === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = saved;
  }
});

test('a Claude turn names its model once — the init, else its first reply — and never a subagent\'s', async () => {
  const heard = [];
  assert.equal(await turn('model', { streamJson: true, answerFromResult: true, onModel: (m) => heard.push(m) }), 'hi\n');
  assert.deepEqual(heard, ['claude-opus-5-5'], 'once per spawn, the init first');
  const fallback = [];
  await turn('model-reply', { streamJson: true, answerFromResult: true, onModel: (m) => fallback.push(m) });
  assert.deepEqual(fallback, ['claude-opus-5-5'], 'an init the shape refuses falls back to the first reply');
  const none = [];
  await turn('tail', { streamJson: true, answerFromResult: true, onModel: (m) => none.push(m) });
  assert.deepEqual(none, [], 'a stream that named no model reports none');
});

test("a Codex turn's model is read from its rollout BEFORE the answer is handed back", async () => {
  const home = mkdtempSync(join(tmpdir(), 'fv-runturn-codex-model-'));
  const now = new Date();
  const day = join(
    home,
    'sessions',
    String(now.getFullYear()),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0')
  );
  mkdirSync(day, { recursive: true });
  const thread = '01a0ebb2-228b-7b71-820e-d8bd9c8adb44';
  // The CLI writes its turn_context once the turn has begun — after the spawn.
  const file = join(day, `rollout-2026-09-29T01-45-15-${thread}.jsonl`);
  const saved = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  process.env.FAKE_THREAD = thread;
  try {
    const heard = [];
    let answered = false;
    const out = runTurn({
      prompt: 'p',
      system: 's',
      cwd: tmpdir(),
      runtime: 'codex',
      onSpawn: () => {
        // MEASURED on Codex 0.156.1, 2026-09-29: the turn's context line, trimmed.
        writeFileSync(
          file,
          JSON.stringify({
            timestamp: new Date(Date.now() + 5).toISOString(),
            type: 'turn_context',
            payload: { cwd: '/w', model: 'gpt-6-sol', collaboration_mode: { mode: 'default', settings: { model: 'gpt-6-sol', reasoning_effort: 'xhigh' } }, effort: 'xhigh' },
          }) + '\n'
        );
      },
      onModel: (m) => {
        assert.equal(answered, false, 'heard before the answer is handed back');
        heard.push(m);
      },
    }).then((v) => {
      answered = true;
      return v;
    });
    assert.equal(await out, 'done\n');
    assert.deepEqual(heard, ['gpt-6-sol']);
    // A caller that asks for no model is handed its answer without the read.
    assert.equal(await runTurn({ prompt: 'p', system: 's', cwd: tmpdir(), runtime: 'codex' }), 'done\n');
  } finally {
    if (saved === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = saved;
  }
});
