/**
 * THE READ GUARD (2026-09-23, 0.97.0) — a `PreToolUse` hook on every curated
 * Claude posture, because `Bash(git log:*)` is a prefix and `git log
 * --output=<path>` writes any file (a reviewer landed one under RESEARCH_PERM
 * with no denial). PROBED on Claude Code 2.1.281: the hook fires under
 * `--allowedTools`, exit 2 blocks the call, and its sentence reaches the model
 * (hooks/readGuard.mjs, claude.mjs READ_GUARD).
 *
 * Pinned three ways, none of them a source pin over the decision itself:
 *  · the decision, as a pure function over real command strings;
 *  · the hook PROCESS, spawned through the exact command string the
 *    `--settings` JSON hands the CLI, stdin in, exit code and stderr out;
 *  · the ARGV, behaviourally — a fake `claude` on PATH echoes what `runTurn`
 *    spawned it with — for every posture that must carry the guard and every
 *    one that must not.
 * Plus the runTurn belt that refuses a design or research posture on a
 * runtime that does not declare it (a fake `codex` leaves a mark when it is
 * spawned, so a missing belt fails as a mark rather than as a real CLI run).
 *
 * Run: node --test bin/lib/readGuard.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readGuardRefusal } from './hooks/readGuard.mjs';
import { READ_GUARD_PATH, READ_GUARD_SETTINGS, runTurn } from './claude.mjs';

test('plain reads pass', () => {
  for (const cmd of [
    'git log -1 --oneline',
    'git log --stat -5 -- src/app.ts',
    'git show HEAD~1 --name-only',
    'git diff main...HEAD --stat',
    'git diff --no-ext-diff HEAD',
    'git log --no-textconv -p -1',
    'git rev-parse HEAD',
    'ls -la src',
    'wc -l README.md',
  ]) {
    assert.equal(readGuardRefusal(cmd), null, cmd);
  }
});

test('the writers and executors hiding in the git readers are refused', () => {
  for (const cmd of [
    "git log -1 --format='tformat:x' --output=pwned.txt", // the reviewer's
    'git log -1 --output notes.txt',
    'git show --output-directory=/tmp/x',
    'git diff --ext-diff HEAD',
    'git log -p --textconv',
    'git --exec-path=/tmp log',
    'git --git-dir=/tmp/evil/.git log',
    'git --work-tree=/tmp log',
    'git -c core.fsmonitor=/tmp/x.sh log',
    'git --config-env=core.pager=X log',
    'git diff -O/tmp/order HEAD',
    'git log -c',
  ]) {
    assert.ok(readGuardRefusal(cmd), cmd);
  }
});

test('quote and backslash splicing cannot hide a flag', () => {
  for (const cmd of ["git log --out''put=x", 'git log --out""put=x', 'git log --out\\put=x', "git log '--output=x'"]) {
    assert.match(readGuardRefusal(cmd), /--output/, cmd);
  }
});

test('shell composition is refused — one plain command per call', () => {
  for (const cmd of [
    'git log > out.txt',
    'git log >> out.txt',
    'git log | tee out.txt',
    'ls; rm -rf .',
    'ls && touch x',
    'ls || touch x',
    'ls & touch x',
    'ls `touch x`',
    'ls $(touch x)',
    'ls $HOME',
    'git diff --no-index <(cat /etc/passwd) x',
    'ls\ntouch x',
  ]) {
    assert.ok(readGuardRefusal(cmd), JSON.stringify(cmd));
  }
});

test('environment assignments are refused', () => {
  for (const cmd of ['GIT_DIR=/tmp/evil git log', 'GIT_EXTERNAL_DIFF=/tmp/x git diff', 'PAGER=/tmp/x git log', 'git log GIT_TRACE=1']) {
    assert.match(readGuardRefusal(cmd), /environment assignment/, cmd);
  }
});

/** Run the hook exactly as the CLI would: the settings' command, via a shell. */
const settingsCommand = () => JSON.parse(READ_GUARD_SETTINGS).hooks.PreToolUse[0].hooks[0].command;
const runHook = (stdin) => spawnSync('/bin/sh', ['-c', settingsCommand()], { input: stdin, encoding: 'utf8' });

test('the settings JSON is a Bash PreToolUse hook running THIS node on THIS file', () => {
  const s = JSON.parse(READ_GUARD_SETTINGS);
  const entry = s.hooks.PreToolUse[0];
  assert.equal(entry.matcher, 'Bash');
  assert.equal(entry.hooks[0].type, 'command');
  // The daemon's own node, never a `node` looked up on PATH: a hook that fails
  // to start is a non-blocking error and the command runs anyway.
  assert.ok(entry.hooks[0].command.includes(process.execPath));
  assert.ok(entry.hooks[0].command.includes(READ_GUARD_PATH));
});

test('the hook process: exit 2 with the sentence on a refusal, exit 0 on a read, exit 2 on garbage', () => {
  const bad = runHook(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git log -1 --output=pwned.txt' } }));
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /^flowviant: this turn is read-only, so `--output` is refused here/);
  assert.match(bad.stderr, /use the Read, Grep and Glob tools/);
  const ok = runHook(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git log -1 --oneline' } }));
  assert.equal(ok.status, 0);
  assert.equal(ok.stderr, '');
  // Fails CLOSED: an unreadable payload is a refusal, never a pass.
  assert.equal(runHook('not json').status, 2);
  assert.equal(runHook('').status, 2);
  // Not ours to judge: the matcher is Bash.
  assert.equal(runHook(JSON.stringify({ tool_name: 'Read', tool_input: { file_path: 'x' } })).status, 0);
});

// ── The argv, behaviourally ────────────────────────────────────────────────

/** A `claude` that answers with its argv, and a `codex` that leaves a mark
 *  when it is spawned at all — the belt's claim is that it never is. */
function fakeCliOnPath() {
  const dir = mkdtempSync(join(tmpdir(), 'fv-guard-'));
  const claude = join(dir, 'claude');
  writeFileSync(
    claude,
    `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: JSON.stringify(process.argv.slice(2)) }) + '\\n');\n`
  );
  chmodSync(claude, 0o755);
  const codex = join(dir, 'codex');
  writeFileSync(codex, `#!/usr/bin/env node\nrequire('node:fs').appendFileSync(${JSON.stringify(join(dir, 'codex-ran'))}, 'x');\n`);
  chmodSync(codex, 0o755);
  process.env.PATH = `${dir}:${process.env.PATH}`;
  return join(dir, 'codex-ran');
}
const codexRan = fakeCliOnPath();

const argvOf = async (opts) => {
  const out = await runTurn({ prompt: 'p', system: 's', cwd: tmpdir(), streamJson: true, answerFromResult: true, ...opts });
  return JSON.parse(out.trim());
};

test('every curated posture carries the guard, before its --allowedTools', async () => {
  for (const [name, opts] of [
    ['consult', { readOnly: true }],
    ['plan', { planPerm: true }],
    ['wiki', { wikiPerm: true }],
    ['design', { posture: 'design' }],
    ['research', { posture: 'research' }],
  ]) {
    const argv = await argvOf(opts);
    const at = argv.indexOf('--settings');
    assert.ok(at >= 0, `${name}: --settings present`);
    assert.equal(argv[at + 1], READ_GUARD_SETTINGS, `${name}: the guard, exactly`);
    assert.ok(at < argv.indexOf('--allowedTools'), `${name}: before the variadic list`);
    assert.ok(!argv.includes('--dangerously-skip-permissions'), `${name}: never beside the bypass`);
  }
});

test('the build posture and plan mode do NOT carry it', async () => {
  const build = await argvOf({});
  assert.ok(!build.includes('--settings'), 'build: the operator\'s own choice');
  assert.ok(build.includes('--dangerously-skip-permissions') || build.includes('--allowedTools'), 'canary: this is the build argv');
  const plan = await argvOf({ planMode: true });
  assert.ok(!plan.includes('--settings'), 'plan mode is the CLI\'s own posture');
  assert.ok(plan.includes('--permission-mode'), 'canary: this is the plan-mode argv');
});

test('research is handed the knowledge dir it was spawned with, as a rule beside --add-dir', async () => {
  const kd = '/srv/repo/.flowviant/knowledge';
  const argv = await argvOf({ posture: 'research', knowledgeDir: kd });
  assert.equal(argv[argv.indexOf('--add-dir') + 1], kd);
  assert.ok(argv.includes(`Read(/${kd}/**)`));
  assert.ok(argv.indexOf('--disallowedTools') > argv.indexOf('--allowedTools'));
  assert.deepEqual(argv.slice(argv.indexOf('--disallowedTools') + 1), ['Read(./.env*)', 'Read(./**/.env*)', 'Bash']);
});

test('runTurn refuses a design or research posture on a runtime that does not declare it', async () => {
  for (const posture of ['design', 'research']) {
    const out = await runTurn({ prompt: 'p', system: 's', cwd: tmpdir(), runtime: 'codex', posture });
    assert.equal(out, '', `${posture} on codex: the turn fails`);
    assert.ok(!existsSync(codexRan), `${posture} on codex: never spawned as a codex build`);
  }
  // Canary: the fake codex IS spawned when nothing refuses, so the absence
  // above is the belt and not a missing binary.
  await runTurn({ prompt: 'p', system: 's', cwd: tmpdir(), runtime: 'codex' });
  assert.ok(existsSync(codexRan));
});
