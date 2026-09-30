/**
 * THE IMAGE CARD'S FENCE ON CODEX (0.114.0) — the argv `CODEX_RUNTIME.args`
 * builds for the `image` profile, the directory the agent lane makes stand
 * before it spawns, and `runTurn` handing the adapter the turn's own cwd.
 *
 * What was MEASURED on codex-cli 0.156.1 and is pinned here as argv (no model
 * turn was spent; the probes are recorded in runtimeCodex.mjs):
 *  · `codex exec` and `exec resume` refuse `-P` — the profile is selected with
 *    `-c default_permissions="<name>"`, which `codex debug prompt-input`
 *    renders as a managed profile writing only the artifacts directory;
 *  · `exec resume` refuses `--sandbox`, so the image branch passes none;
 *  · a writable root that does not exist cannot be made from inside the fence,
 *    so the lane creates it first — and only as a real directory.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CODEX_RUNTIME } from './runtimeCodex.mjs';
import { ARTIFACT_DIR, ensureArtifactDir } from './artifacts.mjs';

const WT = '/home/someone/repo/.flowviant-worktrees/agent-1';
const argvFor = (over = {}) =>
  CODEX_RUNTIME.args({ prompt: 'P', system: 'S', profile: 'image', cwd: WT, ...over });
/** The value after each `-c`. */
const configs = (a) => a.flatMap((x, i) => (a[i - 1] === '-c' ? [x] : []));

test('the image profile fences writes to the worktree’s artifacts directory, by default_permissions', () => {
  const a = argvFor();
  const c = configs(a);
  assert.equal(a[0], 'exec');
  assert.ok(a.includes('--json'));
  assert.ok(c.includes('permissions.flowviantimage.extends=":read-only"'));
  assert.ok(c.includes(`permissions.flowviantimage.filesystem={"${WT}/.flowviant/artifacts"="write","${WT}/.flowviant/tmp"="write"}`), c.join('\n'));
  assert.ok(c.includes('default_permissions="flowviantimage"'));
  assert.ok(c.includes('approval_policy="never"'));
  // Never the spellings codex exec (or exec resume) refuses on 0.156.1.
  assert.ok(!a.includes('-P'), 'no -P: codex exec refuses it');
  assert.ok(!a.includes('--sandbox'), 'no --sandbox: exec resume refuses it, and it conflicts with default_permissions');
  assert.ok(!a.includes('--dangerously-bypass-approvals-and-sandbox'));
  // No web, no sub-agents, nobody's config widening the fence.
  assert.ok(c.includes('tools.web_search=false') && c.includes('web_search="disabled"'));
  assert.ok(c.includes('features.multi_agent=false') && c.includes('features.goals=false'));
  assert.ok(a.includes('--ignore-user-config') && a.includes('--ignore-rules'));
  // The prompt is the trailing positional, after every flag.
  assert.equal(a.at(-1), 'S\n\n---\n\nP');
});

test('image generation is switched on for the image profile, and for no other', () => {
  const on = (a) => a.some((x, i) => x === 'image_generation' && a[i - 1] === '--enable');
  assert.equal(on(argvFor()), true);
  for (const profile of ['build', 'consult', 'plan']) {
    assert.equal(on(CODEX_RUNTIME.args({ prompt: 'P', system: 'S', profile, cwd: WT })), false, profile);
  }
  assert.equal(on(CODEX_RUNTIME.args({ prompt: 'P', system: 'S', profile: 'wiki', vaultDir: '/v', cwd: WT })), false);
  assert.ok(CODEX_RUNTIME.profiles.includes('image'));
});

test('a resumed image turn keeps the fence, and a path is quoted as a TOML string', () => {
  const a = argvFor({ resumeThreadId: '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b' });
  assert.deepEqual(a.slice(0, 3), ['exec', 'resume', '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b']);
  assert.ok(configs(a).includes('default_permissions="flowviantimage"'));
  const odd = argvFor({ cwd: '/tmp/a "quoted" dir' });
  assert.ok(configs(odd).includes('permissions.flowviantimage.filesystem={"/tmp/a \\"quoted\\" dir/.flowviant/artifacts"="write","/tmp/a \\"quoted\\" dir/.flowviant/tmp"="write"}'));
});

test('an image turn with no absolute worktree is refused loudly, never run unfenced', () => {
  assert.throws(() => argvFor({ cwd: undefined }), /image turn needs its worktree to fence/);
  assert.throws(() => argvFor({ cwd: 'relative/wt' }), /image turn needs its worktree to fence/);
});

test('ensureArtifactDir makes the directory under a real .flowviant, and refuses a symlink at either level', () => {
  const root = mkdtempSync(join(tmpdir(), 'fv-artdir-'));
  try {
    const fresh = join(root, 'fresh');
    mkdirSync(fresh);
    assert.equal(ensureArtifactDir(fresh), true);
    assert.ok(existsSync(join(fresh, ARTIFACT_DIR)));
    assert.equal(ensureArtifactDir(fresh), true, 'idempotent');

    // A committed `.flowviant -> elsewhere` would aim the fence's one write
    // grant outside the worktree: refused, and nothing is made there.
    const elsewhere = join(root, 'elsewhere');
    mkdirSync(elsewhere);
    const linked = join(root, 'linked');
    mkdirSync(linked);
    symlinkSync(elsewhere, join(linked, '.flowviant'));
    assert.equal(ensureArtifactDir(linked), false);
    assert.ok(!existsSync(join(elsewhere, 'artifacts')), 'nothing written through the link');

    const inner = join(root, 'inner');
    mkdirSync(join(inner, '.flowviant'), { recursive: true });
    symlinkSync(elsewhere, join(inner, ARTIFACT_DIR));
    assert.equal(ensureArtifactDir(inner), false);

    const file = join(root, 'file');
    mkdirSync(file);
    writeFileSync(join(file, '.flowviant'), 'x');
    assert.equal(ensureArtifactDir(file), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * END TO END THROUGH runTurn, with a fake `codex` on PATH that answers with
 * its own argv: the turn's cwd reaches the adapter, and Claude's list — looked
 * up by name for every runtime — does not throw on a profile Claude does not
 * declare.
 */
test('runTurn hands the codex adapter the turn’s cwd, and an image turn on Claude never spawns', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fv-fakecodex-'));
  const ran = join(dir, 'ran');
  try {
    for (const bin of ['codex', 'claude']) {
      writeFileSync(
        join(dir, bin),
        `#!/usr/bin/env node\nrequire('node:fs').appendFileSync(${JSON.stringify(ran)}, ${JSON.stringify(bin)});\n` +
          `process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(process.argv.slice(2)) } }) + '\\n');\n`
      );
      chmodSync(join(dir, bin), 0o755);
    }
    const path = process.env.PATH;
    process.env.PATH = `${dir}:${path}`;
    try {
      const { runTurn } = await import('./runTurn.mjs');
      const wt = join(dir, 'wt');
      mkdirSync(join(wt, ARTIFACT_DIR), { recursive: true });
      const out = await runTurn({ prompt: 'p', system: 's', cwd: wt, runtime: 'codex', profile: 'image' });
      const argv = JSON.parse(out.trim().split('\n').at(-1));
      assert.ok(argv.includes(`permissions.flowviantimage.filesystem={"${wt}/.flowviant/artifacts"="write","${wt}/.flowviant/tmp"="write"}`), argv.join(' '));
      assert.ok(argv.includes('image_generation'));
      rmSync(ran, { force: true });
      const refused = await runTurn({ prompt: 'p', system: 's', cwd: wt, runtime: 'claude', profile: 'image', streamJson: true, answerFromResult: true });
      assert.equal(refused, '');
      assert.ok(!existsSync(ran), 'Claude is never spawned under the image posture');
    } finally {
      process.env.PATH = path;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
