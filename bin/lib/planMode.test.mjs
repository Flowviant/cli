/**
 * A TAB CAN PLAN (2026-09-23, 0.97.0).
 *
 * `workTurnJobs[].planMode` runs a Claude tab turn under Claude Code's own
 * `--permission-mode plan`. PROBED on 2.1.281 (claude.mjs, PLAN_MODE_PERM):
 * alone it reads, plans and changes nothing; BESIDE
 * `--dangerously-skip-permissions` the bypass silently wins and the edit lands;
 * and every `mcp__flowviant` call is refused in plan mode unless the tool is
 * annotated read-only. So the argv carries one posture or the other — never
 * both — and a plan turn runs plain.
 *
 * The argv is pinned BEHAVIOURALLY: a fake `claude` on PATH echoes the argv it
 * was spawned with as its stream-json result, and `runTurn` is called for real.
 *
 * Run: node --test bin/lib/planMode.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTurn, PLAN_MODE_PERM } from './claude.mjs';

const src = (f) => readFileSync(new URL(`./${f}`, import.meta.url), 'utf8');
const slice = (s, from, to) => {
  const a = s.indexOf(from);
  const b = s.indexOf(to, a + from.length);
  assert.ok(a >= 0, `anchor missing: ${from}`);
  assert.ok(b > a, `anchor missing: ${to}`);
  return s.slice(a, b);
};

/** A `claude` that answers with the argv it was given. */
function fakeClaudeOnPath() {
  const dir = mkdtempSync(join(tmpdir(), 'fv-plan-'));
  const bin = join(dir, 'claude');
  writeFileSync(
    bin,
    `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: JSON.stringify(process.argv.slice(2)) }) + '\\n');\n`
  );
  chmodSync(bin, 0o755);
  process.env.PATH = `${dir}:${process.env.PATH}`;
}
fakeClaudeOnPath();

const argvOf = async (opts) => {
  const out = await runTurn({ prompt: 'p', system: 's', cwd: tmpdir(), streamJson: true, answerFromResult: true, ...opts });
  return JSON.parse(out.trim());
};

test('a plan turn carries --permission-mode plan and NEVER --dangerously-skip-permissions', async () => {
  const argv = await argvOf({ planMode: true });
  const at = argv.indexOf('--permission-mode');
  assert.ok(at >= 0);
  assert.equal(argv[at + 1], 'plan');
  assert.ok(!argv.includes('--dangerously-skip-permissions'), 'beside it, the bypass silently wins (measured)');
  assert.ok(!argv.includes('--allowedTools'), 'plan mode replaces the posture, it does not join a list');
});

test('canary: the same turn without the switch is the build posture, unchanged', async () => {
  const argv = await argvOf({});
  assert.ok(!argv.includes('--permission-mode'));
  // Unattended build: skip-permissions, or FLOWVIANT_SAFE's curated list.
  assert.ok(argv.includes('--dangerously-skip-permissions') || argv.includes('--allowedTools'));
});

test('plan mode on a non-Claude runtime fails the turn — it is never a build turn wearing the word', async () => {
  const out = await runTurn({ prompt: 'p', system: 's', cwd: tmpdir(), runtime: 'codex', planMode: true });
  assert.equal(out, '');
});

test('the posture list is exactly the CLI\'s own flag', () => {
  assert.deepEqual(PLAN_MODE_PERM, ['--permission-mode', 'plan']);
});

test('the tab lane: claude-only refusal in words, plain (no MCP), the sentence appended, no artifacts', () => {
  const w = src('work.mjs');
  const lane = slice(w, 'const planTurn = job.planMode === true', 'streamJson: true,\n              answerFromResult: true,');
  // Canary: this is the tab lane.
  assert.match(lane, /const plainTab = rt\.id === 'antigravity';/);
  assert.match(lane, /if \(planTurn && rt\.id !== 'claude'\) \{\s*await settleWorkTurn\(job\.id, \{\s*ok: false,/);
  assert.match(lane, /plainTab \|\| planTurn\s*\?\s*\{ args: \[\], env: null, dir: null \}/);
  assert.match(lane, /prompt: plainTab \|\| planTurn\s*\?\s*WORK_TURN_KICKOFF_PLAIN/);
  assert.ok(lane.includes('...(planTurn ? { planMode: true } : {}),'));
  assert.ok(
    lane.includes(
      'system: planTurn\n                    ? `${withProjectContext(SYSTEM_WORK_PLAIN, { knowledgeDir, artifacts: false })}\\n\\n${PLAN_TURN_SENTENCE}`'
    ),
    'a plan turn: the plain contract, no artifacts paragraph, the sentence appended'
  );
  // Canary: every other tab's contract is the one it always was.
  assert.ok(lane.includes('{ knowledgeDir, artifacts: !captureTab && getArtifactsAccepted() }'));
});

test('the sentence says plan, change nothing, and do not leave plan mode', async () => {
  const { PLAN_TURN_SENTENCE } = await import('./work.mjs');
  assert.match(PLAN_TURN_SENTENCE, /PLANNING TURN/);
  assert.match(PLAN_TURN_SENTENCE, /answer with the plan/);
  assert.match(PLAN_TURN_SENTENCE, /change nothing/);
  assert.match(PLAN_TURN_SENTENCE, /do not try to leave plan mode/);
});
