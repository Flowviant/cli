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
import { runTurn, cliEnv } from './runTurn.mjs';
import { designPermFor, planPermFor, consultPermFor } from './claudePosture.mjs';
import { AGENT_TASK_KINDS } from './agentTaskKinds.mjs';
import { RUNTIMES } from './runtimes.mjs';
import { safeFileName } from './safeFileName.mjs';
import { readGuardRefusal } from './hooks/readGuard.mjs';

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
// NOT THE DEVELOPER'S OWN SETTINGS: a fenced turn folds the person's kept
// Claude settings into its posture's `--settings` (claudePersonal.mjs), so the
// pins below read an empty config dir, where the posture stands alone.
process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'fv-claude-config-'));

const turn = (opts) => runTurn({ prompt: 'p', system: 's', cwd: tmpdir(), streamJson: true, answerFromResult: true, ...opts });
const argvOf = async (opts) => {
  process.env.FAKE_MODE = 'argv';
  return JSON.parse((await turn(opts)).trim());
};

const KD = '/srv/repo/.flowviant/knowledge';

test('design, plan and consult read through the fence — never a bare Read, Grep or Glob', async () => {
  for (const [name, opts] of [
    ['design', { profile: 'design', knowledgeDir: KD }],
    ['plan', { profile: 'plan', knowledgeDir: KD }],
    ['consult', { profile: 'consult', knowledgeDir: KD }],
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
  const design = await argvOf({ profile: 'design' });
  assert.deepEqual(design.slice(design.indexOf('--disallowedTools') + 1), ['Read(./.env*)', 'Read(./**/.env*)']);
  const plan = await argvOf({ profile: 'plan' });
  assert.ok(plan.includes('mcp__flowviant'));
  // The builders agree with what runTurn spawned.
  assert.deepEqual(design.slice(design.indexOf('--settings')), designPermFor(null));
  assert.deepEqual(plan.slice(plan.indexOf('--settings')), planPermFor(null));
  const consult = await argvOf({ profile: 'consult' });
  assert.deepEqual(consult.slice(consult.indexOf('--settings')), consultPermFor(null));
});

/**
 * AN AGENT READS THE FILES IT IS HANDED (0.112.0). A turn's files land in
 * `.flowviant/uploads/` inside its worktree, and every posture an agent turn
 * (build; design for mockups, 3D models and decks; research) or its
 * pre-review (consult) runs under must read them. PROBED on Claude Code
 * 2.1.284 (2026-09-28) with the exact design, research and consult lists in a
 * scratch repo: `.flowviant/uploads/note.txt` and a PNG there were both read
 * (the picture described correctly), no denials, while `/etc/hostname` was
 * refused under the same list. So nothing needed opening; this pins that
 * nothing closes it — no posture denies a path under `.flowviant/`, the one
 * deny they share (`.env*`) cannot match a safe upload name (no leading dot),
 * and the read guard passes a plain look at the directory.
 */
test('every posture an agent runs under reads .flowviant/uploads/ — nothing denies it', async () => {
  for (const kind of Object.keys(AGENT_TASK_KINDS)) {
    const profile = AGENT_TASK_KINDS[kind].posture;
    // THE IMAGE POSTURE IS CODEX'S (0.114.0): Claude never runs it, and on
    // Codex the fence reads the whole disk (`:read-only`) — uploads included —
    // and writes only the artifacts directory; nothing is denied by name.
    if (!RUNTIMES.claude.profiles.includes(profile)) {
      const codex = RUNTIMES.codex.args({ prompt: 'p', system: 's', profile, cwd: '/wt' });
      assert.ok(codex.includes('permissions.flowviantimage.extends=":read-only"'), `${kind}: reads everything on Codex`);
      assert.ok(!codex.some((x) => /uploads/.test(x)), `${kind}: nothing names the uploads`);
      continue;
    }
    const argv = await argvOf({ profile });
    const denied = argv.includes('--disallowedTools') ? argv.slice(argv.indexOf('--disallowedTools') + 1) : [];
    for (const rule of denied) assert.doesNotMatch(rule, /flowviant|uploads/, `${kind}: ${rule}`);
    if (profile !== 'build') assert.ok(argv.includes('Read(./**)'), `${kind}: the worktree, uploads included`);
    else assert.ok(argv.includes('--dangerously-skip-permissions') || argv.includes('Read'), `${kind}: reads everything`);
  }
  const consult = await argvOf({ profile: 'consult' });
  assert.ok(consult.includes('Read(./**)') && !consult.includes('--disallowedTools'), 'the pre-review reads them too');
  for (const raw of ['.env', '.env.png', '.envrc', '..env.local']) {
    assert.ok(!safeFileName(raw, 'attachment').startsWith('.'), `${raw}: an upload is never a dotfile the .env* deny could match`);
  }
  for (const cmd of ['ls .flowviant/uploads', 'ls -la .flowviant/uploads/', 'cat .flowviant/uploads/notes.txt']) {
    assert.equal(readGuardRefusal(cmd), null, cmd);
  }
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
