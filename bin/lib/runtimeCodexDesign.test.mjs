/**
 * THE MOCKUP, 3D-MODEL AND DECK CARDS RUN ON CODEX TOO (0.115.0; 2026-09-29,
 * the owner: "im getting errors using codex as the 3d model builder. its
 * saying 3d models run on claude only but thats not true").
 *
 * MEASURED on 2026-09-29 on this box — codex-cli 0.156.1 (gpt-6-luna, low
 * effort), Claude Code 2.1.284 (haiku), Linux + bubblewrap — each kind's real
 * contract in a scratch git repository, and a fence probe asking the CLI to
 * write outside `.flowviant/artifacts/`:
 *
 *   kind      | Claude                  | Codex                          | Antigravity
 *   ----------+-------------------------+--------------------------------+------------------------
 *   design    | works fenced            | works fenced (0.115.0)         | unmeasured; cannot fence
 *   model     | works fenced            | works fenced (0.115.0)         | unmeasured; cannot fence
 *   deck      | works fenced            | works fenced (0.115.0)         | unmeasured; cannot fence
 *   research  | works fenced            | works only unfenced (unsafe)   | unmeasured; cannot fence
 *   image     | cannot produce it       | works fenced (0.114.0)         | unmeasured; cannot produce
 *
 * The evidence, per column:
 *  · CLAUDE (the design list, `claudePermFor('design')`, through the real
 *    argv): Write of `.flowviant/artifacts/ok.html` landed; Write of
 *    `src/escape-write.txt` was refused by the CLI ("Claude requested
 *    permissions to write to …/src/escape-write.txt, but you haven't granted
 *    it yet"); `echo x > src/escape-bash.txt` was refused by the read guard
 *    ("this turn is read-only, so a redirect (`>`) is refused here"); Read of
 *    `~/.flowviant/credentials.json` and of `.env` were refused; no MCP server
 *    loaded. Research shares the one scoped write. Claude Code has no image
 *    tool (its init lists none), so an image card is not something it makes.
 *  · CODEX under `codexDesignFence` (runtimeCodex.mjs): its `apply_patch` of
 *    `src/escape-patch.txt` was refused by Codex ("patch rejected: writing
 *    outside of the project; rejected by user approval settings"), shell
 *    writes to `src/` and `/tmp` failed "read-only file system", curl could
 *    not resolve a host, no web tool, no MCP. The real mockup, 3D-model and
 *    deck contracts each wrote their one page (the model's with the
 *    `glb-ready`/`export-glb` handshake, the deck's with sections, arrow keys
 *    and print rules) and `git status` stayed clean. A here-document failed
 *    until the fence granted the turn a scratch (`/tmp` is read-only in
 *    there); with it, the daemon-built argv wrote the page, fresh and
 *    resumed. RESEARCH produced its
 *    write-up with `web_search="live"` (`web__run` in its tool list) — but
 *    under that same profile the turn could read `.env` and
 *    `~/.flowviant/credentials.json` (ENV_READABLE, CRED_READABLE), and
 *    Codex 0.156.1 cannot narrow reads: a `"none"` over the home directory
 *    hides its own sandbox helper, and a second masked file fails every
 *    command. A turn that reads secrets and holds the web is what Claude's
 *    research list is fenced against, so research stays Claude's.
 *  · ANTIGRAVITY is not installed here (`agy` not found). From the daemon's
 *    own record of agy 1.1.12 (runtimeAntigravity.mjs): headless auto-denies
 *    every write, `--dangerously-skip-permissions` grants every write, and
 *    `--sandbox` only shuts egress — no flag writes one directory and nothing
 *    else, and its machine-wide `permissions.allow` is inherited with no
 *    equivalent of `--ignore-user-config`. It declares no kind posture.
 *
 * What is pinned here: the argv of the Codex design fence, the registry's
 * declarations, and the real agent lane running a 3D-model card on a fake
 * `codex` to a delivery (and refusing research on Codex and a model on
 * Antigravity in words, before any CLI spawns). A file of its own, because
 * the fake rides PATH for the whole process; HOME is a scratch one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CODEX_RUNTIME, codexDesignFence } from './runtimeCodex.mjs';
import { RUNTIMES, canRun } from './runtimes.mjs';
import { FENCE_TMP_DIR, ensureFenceScratch } from './artifacts.mjs';

const WT = '/home/someone/repo/.flowviant-worktrees/agent-1';
const argvFor = (over = {}) => CODEX_RUNTIME.args({ prompt: 'P', system: 'S', profile: 'design', cwd: WT, ...over });
/** The value after each `-c`. */
const configs = (a) => a.flatMap((x, i) => (a[i - 1] === '-c' ? [x] : []));
const flagged = (a, flag, value) => a.some((x, i) => x === value && a[i - 1] === flag);

test('the design profile on Codex writes only the artifacts directory, with no web, no image tool and nobody’s config', () => {
  const a = argvFor();
  const c = configs(a);
  assert.equal(a[0], 'exec');
  assert.ok(c.includes('permissions.flowviantdesign.extends=":read-only"'));
  // The artifacts directory, and the turn's own scratch beside it — the one
  // place a here-document's temp file can go (`/tmp` is read-only in here).
  assert.ok(
    c.includes(`permissions.flowviantdesign.filesystem={"${WT}/.flowviant/artifacts"="write","${WT}/.flowviant/tmp"="write"}`),
    c.join('\n')
  );
  assert.ok(c.includes(`shell_environment_policy.set={TMPDIR="${WT}/.flowviant/tmp",TMPPREFIX="${WT}/.flowviant/tmp/zsh"}`));
  assert.ok(c.includes('default_permissions="flowviantdesign"'));
  assert.ok(c.includes('approval_policy="never"'));
  // Image generation ships ON in 0.156.1 (measured: `image_gen__imagegen` in
  // the tool list under --ignore-user-config), so it is switched OFF by name.
  assert.ok(flagged(a, '--disable', 'image_generation'));
  assert.ok(!flagged(a, '--enable', 'image_generation'));
  assert.ok(c.includes('tools.web_search=false') && c.includes('web_search="disabled"'));
  assert.ok(c.includes('features.multi_agent=false') && c.includes('features.goals=false'));
  for (const f of ['browser_use', 'browser_use_external', 'in_app_browser', 'computer_use', 'apps']) {
    assert.ok(c.includes(`features.${f}=false`), f);
  }
  assert.ok(a.includes('--ignore-user-config') && a.includes('--ignore-rules'));
  // No MCP of any kind, and never the spellings exec (resume) refuses.
  assert.ok(!c.some((x) => x.startsWith('mcp_servers.')), 'no MCP server');
  assert.ok(!a.includes('-P') && !a.includes('--sandbox'));
  assert.ok(!c.some((x) => x.startsWith('sandbox_mode=')), 'the build posture’s sandbox is not stacked on the fence');
  assert.ok(!a.includes('--dangerously-bypass-approvals-and-sandbox'));
  assert.equal(a.at(-1), 'S\n\n---\n\nP', 'the prompt is the trailing positional');
  assert.deepEqual(a.slice(2, -1), codexDesignFence(WT), 'the branch is the one function');
});

test('a resumed design turn keeps the fence; no absolute worktree is refused loudly', () => {
  const a = argvFor({ resumeThreadId: '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b' });
  assert.deepEqual(a.slice(0, 3), ['exec', 'resume', '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b']);
  assert.ok(configs(a).includes('default_permissions="flowviantdesign"'));
  assert.ok(flagged(a, '--disable', 'image_generation'));
  assert.throws(() => argvFor({ cwd: undefined }), /design turn needs its worktree to fence/);
  assert.throws(() => argvFor({ cwd: 'relative/wt' }), /design turn needs its worktree to fence/);
});

test('the scratch stands empty, as a real directory under a real .flowviant, or not at all', () => {
  const root = mkdtempSync(join(tmpdir(), 'fv-scratch-'));
  try {
    const place = join(root, 'place');
    mkdirSync(join(place, '.flowviant', 'tmp'), { recursive: true });
    writeFileSync(join(place, '.flowviant', 'tmp', 'left-over'), 'x');
    assert.equal(ensureFenceScratch(place), true);
    assert.deepEqual(readdirSync(join(place, FENCE_TMP_DIR)), [], "a previous turn's scratch is nobody's");
    // A committed `.flowviant/tmp -> elsewhere` would aim the grant outside.
    const elsewhere = join(root, 'elsewhere');
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, 'keep'), 'x');
    const linked = join(root, 'linked');
    mkdirSync(join(linked, '.flowviant'), { recursive: true });
    symlinkSync(elsewhere, join(linked, FENCE_TMP_DIR));
    assert.equal(ensureFenceScratch(linked), false);
    assert.deepEqual(readdirSync(elsewhere), ['keep'], 'nothing removed through the link');
    const noParent = join(root, 'bare');
    mkdirSync(noParent);
    assert.equal(ensureFenceScratch(noParent), false, 'the artifacts directory makes .flowviant first');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Codex declares design and image but not research; Antigravity declares none', () => {
  assert.ok(CODEX_RUNTIME.profiles.includes('design'));
  assert.equal(canRun(RUNTIMES.codex, 'design'), true);
  assert.equal(canRun(RUNTIMES.codex, 'research'), false);
  for (const p of ['design', 'research', 'image']) assert.equal(canRun(RUNTIMES.antigravity, p), false, p);
});

test('the mockup, 3D-model and deck contracts are spoken to the CLI that runs them; Claude’s bytes are unchanged', async () => {
  const { SYSTEM_AGENT_FOR, AGENT_CONTRACTS } = await import('./prompts.mjs');
  for (const k of ['design', 'model', 'deck']) {
    const claude = AGENT_CONTRACTS[k];
    assert.ok(claude.startsWith("You are the human's own Claude,"), `canary: ${k} opens on Claude`);
    assert.equal(SYSTEM_AGENT_FOR(k, RUNTIMES.claude.label), claude, `${k}: Claude's contract, byte for byte`);
    assert.equal(SYSTEM_AGENT_FOR(k), claude);
    const codex = SYSTEM_AGENT_FOR(k, RUNTIMES.codex.label);
    assert.ok(codex.startsWith("You are the human's own Codex,"), k);
    assert.equal(codex.slice("You are the human's own Codex,".length), claude.slice("You are the human's own Claude,".length), `${k}: only the opening moves`);
    assert.ok(!codex.includes('Claude'), `${k}: names no Claude anywhere`);
  }
  // The image contract already speaks to Codex, and code to "coding agent".
  assert.equal(SYSTEM_AGENT_FOR('image', RUNTIMES.codex.label), AGENT_CONTRACTS.image);
  assert.equal(SYSTEM_AGENT_FOR('code', RUNTIMES.codex.label), AGENT_CONTRACTS.code);
});

// ── The real agent lane, against a fake `codex` ─────────────────────────────

const scratch = mkdtempSync(join(tmpdir(), 'fv-codex-design-'));
process.on('exit', () => rmSync(scratch, { recursive: true, force: true }));
for (const d of ['bin', 'home', 'personal']) mkdirSync(join(scratch, d), { recursive: true });
process.env.HOME = join(scratch, 'home');
process.env.CODEX_HOME = join(scratch, 'personal');
const spawns = join(scratch, 'spawns');
// A Codex that does what the measured one did: writes its one page into the
// artifacts directory of the worktree it runs in, then ends with the JSON.
writeFileSync(
  join(scratch, 'bin', 'codex'),
  `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const argv = process.argv.slice(2);
const scratch = path.join(process.cwd(), '.flowviant', 'tmp');
fs.appendFileSync(${JSON.stringify(spawns)}, JSON.stringify({ argv, cwd: process.cwd(), scratch: fs.existsSync(scratch) && fs.readdirSync(scratch).length === 0 }) + '\\n');
const dir = path.join(process.cwd(), '.flowviant', 'artifacts', 'red-cube');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>Red cube</title>');
const say = (ev) => process.stdout.write(JSON.stringify(ev) + '\\n');
say({ type: 'thread.started', thread_id: '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b' });
say({ type: 'item.completed', item: { type: 'agent_message', text: '\`\`\`json\\n' + JSON.stringify({ status: 'delivered', summary: 'A red cube in .flowviant/artifacts/red-cube/index.html.', progress: 'Built the cube page.' }) + '\\n\`\`\`' } });
say({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });
`
);
chmodSync(join(scratch, 'bin', 'codex'), 0o755);
process.env.PATH = `${join(scratch, 'bin')}:${process.env.PATH}`;
const { createWorkManager } = await import('./work.mjs');

const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function managerIn(t) {
  const repoRoot = mkdtempSync(join(scratch, 'repo-'));
  git(['init', '-q', '-b', 'main'], repoRoot);
  git(['config', 'user.email', 't@t.t'], repoRoot);
  git(['config', 'user.name', 'T'], repoRoot);
  writeFileSync(join(repoRoot, 'a.txt'), 'one');
  git(['add', '-A'], repoRoot);
  git(['commit', '-qm', 'base'], repoRoot);
  const baseDir = mkdtempSync(join(scratch, 'base-'));
  const m = createWorkManager({
    repoRoot,
    baseDir,
    getBaseRef: () => 'main',
    getMcpUrl: () => 'http://127.0.0.1:0/mcp',
    getLeaseTtl: () => 60,
  });
  t.after(() => {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(baseDir, { recursive: true, force: true });
  });
  return { m, baseDir };
}

function stubFetch(t) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), body: typeof opts.body === 'string' ? JSON.parse(opts.body) : null });
    return { ok: true, status: 200, json: async () => ({ data: { claimed: true } }) };
  };
  t.after(() => {
    globalThis.fetch = real;
  });
  return calls;
}
const until = async (cond, ms = 10_000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
};
const spawned = () =>
  existsSync(spawns) ? readFileSync(spawns, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
const settles = (calls) => calls.filter((c) => c.url.includes('agent-turn-done')).map((c) => c.body);
const card = (taskKind) => ({ id: `card-${taskKind}`, title: 'A red cube', brief: 'One red cube.', taskKind });
const job = (id, agentId, runtime, taskKind) => ({
  id,
  agentId,
  placeId: `a-${agentId}`,
  runtime,
  agentName: 'Ada',
  kind: 'task',
  task: card(taskKind),
  taskKind,
});

test('a 3D-model card on Codex runs under the design fence, spoken to Codex, and delivers its page', async (t) => {
  const { m, baseDir } = managerIn(t);
  const calls = stubFetch(t);
  rmSync(spawns, { force: true });
  m.processAgentTurnJobs([job('at-1', 'ag1', 'codex', 'model')]);
  await until(() => settles(calls).length === 1 && !m.workBusy());
  const [settle] = settles(calls);
  assert.equal(settle.outcome, 'delivered', JSON.stringify(settle));
  assert.match(settle.answer, /red cube/i);
  const [run, ...more] = spawned();
  assert.deepEqual(more, [], 'one CLI');
  const wt = join(baseDir, 'sessions', 'a-ag1');
  assert.equal(run.cwd, wt);
  assert.ok(
    configs(run.argv).includes(`permissions.flowviantdesign.filesystem={"${wt}/.flowviant/artifacts"="write","${wt}/.flowviant/tmp"="write"}`),
    run.argv.join(' ')
  );
  assert.ok(configs(run.argv).includes('default_permissions="flowviantdesign"'));
  assert.ok(flagged(run.argv, '--disable', 'image_generation'));
  assert.ok(!configs(run.argv).some((x) => x.startsWith('mcp_servers.')), 'an agent turn has no MCP');
  const prompt = run.argv.at(-1);
  assert.ok(prompt.startsWith("You are the human's own Codex, working one 3D MODEL card"), prompt.slice(0, 120));
  assert.ok(!prompt.includes("the human's own Claude"), 'the contract never calls Codex Claude');
  assert.ok(existsSync(join(wt, '.flowviant', 'artifacts', 'red-cube', 'index.html')));
  assert.ok(run.scratch, 'the scratch stood, a real directory, before the CLI ran');
});

test('a write-up on Codex and a 3D model on Antigravity are refused in words before any CLI spawns', async (t) => {
  const { m } = managerIn(t);
  const calls = stubFetch(t);
  rmSync(spawns, { force: true });
  m.processAgentTurnJobs([job('at-2', 'ag2', 'codex', 'research')]);
  await until(() => settles(calls).length === 1 && !m.workBusy());
  m.processAgentTurnJobs([job('at-3', 'ag3', 'antigravity', 'model')]);
  await until(() => settles(calls).length === 2 && !m.workBusy());
  const [research, model] = settles(calls);
  assert.equal(research.outcome, 'nothing');
  assert.equal(research.answer, 'write-up cards run on Claude on this machine');
  assert.equal(model.outcome, 'nothing');
  assert.equal(model.answer, 'mockup, 3D model and presentation cards run on Claude or Codex on this machine');
  assert.deepEqual(spawned(), [], 'nothing ran');
});
