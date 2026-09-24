/**
 * THE CURATED POSTURES' READ FENCE, THE TURN'S ENVIRONMENT, AND ITS DECODING
 * (2026-09-24, the audit) — each pinned against the ARGV and ENV `runTurn`
 * actually spawns, through a fake `claude` on PATH, never as source text.
 *
 *  · Design, consult and plan (the capture chat) allowed bare Read/Grep/Glob,
 *    which reach the whole box (measured on 2.1.281) — so a turn steered by a
 *    card could read `~/.flowviant/credentials.json`, every project's machine
 *    credential, and carry it out in an artifact, a plan note or a transcript.
 *  · A headless daemon's `FLOWVIANT_MACHINE_TOKEN` rode into every turn's env.
 *  · stdout was decoded chunk by chunk, so a multi-byte character split across
 *    two pipe reads came out as U+FFFD in the answer.
 *
 * Run: node --test bin/lib/claudePosture.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTurn, cliEnv, designPermFor, planPermFor, consultPermFor } from './claude.mjs';

/** A `claude` whose behaviour the test picks through FAKE_MODE:
 *  `argv` answers with its argv, `env` with the machine-credential variables it
 *  can see, `split` writes a result event cut in the middle of an em dash. */
function fakeClaude() {
  const dir = mkdtempSync(join(tmpdir(), 'fv-posture-'));
  const bin = join(dir, 'claude');
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const mode = process.env.FAKE_MODE;
const result = (r) => JSON.stringify({ type: 'result', subtype: 'success', result: r }) + '\\n';
if (mode === 'env') {
  process.stdout.write(result(JSON.stringify({
    machine: process.env.FLOWVIANT_MACHINE_TOKEN ?? null,
    fleet: process.env.FLOWVIANT_FLEET ?? null,
    mcp: process.env.FLOWVIANT_MCP_TOKEN ?? null,
    other: process.env.FAKE_KEEP ?? null,
  })));
} else if (mode === 'split') {
  const bytes = Buffer.from(result('done — shipped'), 'utf8');
  const cut = bytes.indexOf(0xe2) + 1; // inside the three-byte em dash
  process.stdout.write(bytes.subarray(0, cut));
  setTimeout(() => process.stdout.write(bytes.subarray(cut)), 80);
} else {
  process.stdout.write(result(JSON.stringify(process.argv.slice(2))));
}
`
  );
  chmodSync(bin, 0o755);
  process.env.PATH = `${dir}:${process.env.PATH}`;
}
fakeClaude();

const turn = (opts) => runTurn({ prompt: 'p', system: 's', cwd: tmpdir(), streamJson: true, answerFromResult: true, ...opts });
const argvOf = async (opts) => {
  process.env.FAKE_MODE = 'argv';
  return JSON.parse((await turn(opts)).trim());
};

const KD = '/srv/repo/.flowviant/knowledge';

test('design, plan and consult read through the fence — never a bare Read, Grep or Glob', async () => {
  for (const [name, opts] of [
    ['design', { posture: 'design', knowledgeDir: KD }],
    ['plan', { planPerm: true, knowledgeDir: KD }],
    ['consult', { readOnly: true, knowledgeDir: KD }],
  ]) {
    const argv = await argvOf(opts);
    const at = argv.indexOf('--allowedTools');
    assert.ok(at > 0, `${name}: canary — a curated list`);
    for (const bare of ['Read', 'Grep', 'Glob']) assert.ok(!argv.includes(bare), `${name}: no bare ${bare}`);
    assert.ok(argv.includes('Read(./**)'), `${name}: the worktree`);
    assert.ok(argv.includes('Glob(./**)'), `${name}: names in the worktree`);
    assert.ok(argv.includes(`Read(/${KD}/**)`), `${name}: the knowledge library, by its absolute path`);
    assert.equal(argv[argv.indexOf('--add-dir') + 1], KD, `${name}: and the directory is admitted`);
    assert.ok(!argv.includes('--dangerously-skip-permissions'), `${name}: never the bypass`);
  }
});

test('design denies the checkout secrets by name; plan keeps its control plane', async () => {
  const design = await argvOf({ posture: 'design' });
  assert.deepEqual(design.slice(design.indexOf('--disallowedTools') + 1), ['Read(./.env*)', 'Read(./**/.env*)']);
  const plan = await argvOf({ planPerm: true });
  assert.ok(plan.includes('mcp__flowviant'));
  // The builders agree with what runTurn spawned.
  assert.deepEqual(design.slice(design.indexOf('--settings')), designPermFor(null));
  assert.deepEqual(plan.slice(plan.indexOf('--settings')), planPermFor(null));
  const consult = await argvOf({ readOnly: true });
  assert.deepEqual(consult.slice(consult.indexOf('--settings')), consultPermFor(null));
});

test('the build posture is untouched', async () => {
  const build = await argvOf({});
  assert.ok(build.includes('--dangerously-skip-permissions') || build.includes('--allowedTools'));
  assert.ok(!build.includes('Read(./**)'));
});

test("a turn never sees the daemon's machine credential, and keeps everything else", async () => {
  process.env.FLOWVIANT_MACHINE_TOKEN = 'fva_machine';
  process.env.FLOWVIANT_FLEET = 'fva_fleet';
  process.env.FAKE_KEEP = 'kept';
  process.env.FAKE_MODE = 'env';
  try {
    const seen = JSON.parse((await turn({ mcpEnv: { FLOWVIANT_MCP_TOKEN: 'fva_turn' } })).trim());
    assert.deepEqual(seen, { machine: null, fleet: null, mcp: 'fva_turn', other: 'kept' });
    // …and without an mcpEnv too: that branch used to inherit process.env whole.
    const bare = JSON.parse((await turn({})).trim());
    assert.equal(bare.machine, null);
    assert.equal(bare.fleet, null);
    assert.equal(bare.other, 'kept');
    assert.equal(cliEnv().FLOWVIANT_MACHINE_TOKEN, undefined);
  } finally {
    delete process.env.FLOWVIANT_MACHINE_TOKEN;
    delete process.env.FLOWVIANT_FLEET;
    delete process.env.FAKE_KEEP;
  }
});

test('a multi-byte character split across two pipe reads survives', async () => {
  process.env.FAKE_MODE = 'split';
  const out = await turn({});
  assert.equal(out.trim(), 'done — shipped');
  assert.ok(!out.includes('�'));
});
