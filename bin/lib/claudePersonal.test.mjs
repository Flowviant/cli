import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A FENCED CLAUDE TURN TAKES ITS PERMISSIONS AND HOOKS FROM FLOWVIANT ALONE
 * (2026-09-29, the owner: "yes, the agent's fence can ignore") — see
 * claudePersonal.mjs and runtimeClaude.mjs for the rule.
 *
 * MEASURED on Claude Code 2.1.284 (2026-09-29), `claude -p … --model haiku
 * --output-format stream-json --verbose` in a scratch git repo, with
 * CLAUDE_CONFIG_DIR a scratch directory holding a LINK to the person's
 * credentials file and the settings.json under test (~/.claude untouched),
 * the design shape's `--allowedTools 'Bash(ls:*)'`, asked to run `node -p 40+2`:
 *
 *  · `--setting-sources user` (every agent turn before this) with a personal
 *    `permissions.allow: ["Bash(node:*)"]`: node RAN ("42"), and personal
 *    UserPromptSubmit and PreToolUse hooks fired. The same argv with no rule:
 *    refused, "This command requires approval". (`echo` is no probe: the CLI's
 *    own read-only classifier ran it with no rule at all.)
 *  · a personal `permissions.defaultMode: "bypassPermissions"`: the init event
 *    read `permissionMode: "bypassPermissions"` and node ran — the fence gone.
 *  · NO `--setting-sources` (the pre-review, planner, intake, wiki and capture
 *    chat before this): a hook in the cwd's `.claude/settings.json` FIRED
 *    although the workspace was untrusted (its allow rule alone was ignored:
 *    "this workspace has not been trusted").
 *  · `--setting-sources ''`: the allow rule, the bypass and every hook,
 *    personal and project, did not load — node refused, `permissionMode:
 *    "default"`, no hook — and the turn answered on the same OAuth login
 *    (`apiKeySource: "none"`). `~/.claude/CLAUDE.md`, a personal skill and a
 *    personal subagent were gone too, and so was a settings `env` variable.
 *  · `--settings` still applies under it: a flag hook fired, a flag allow
 *    admitted node, a flag `env` reached `printenv`; `--plugin-dir` still
 *    loaded its skill. Given TWO `--settings`, only the last one's hook fired.
 *  · a personal deny `Bash(node:*)` DID hold a `--dangerously-skip-permissions`
 *    turn under `--setting-sources user` ("has been denied") — so the build
 *    posture keeps the person's file (see runtimeClaude.mjs).
 *  · neither a personal skill's `allowed-tools: Bash(node:*)` nor a personal
 *    subagent's `permissionMode: bypassPermissions` admitted node under the
 *    list (each refused, "This command requires approval").
 *
 * The last test here re-measures the load-bearing half on the REAL CLI with no
 * credentials and no model call: the init event, which the CLI prints before
 * it asks anything of the API, carries the permission mode, and a SessionStart
 * hook reports itself before it (`hook_started`). It is skipped where no
 * `claude` is installed.
 */

// The real CLI, found before the fake below shadows it.
let realClaude = null;
try {
  realClaude = execFileSync('sh', ['-c', 'command -v claude'], { encoding: 'utf8' }).trim() || null;
} catch {
  realClaude = null;
}

const root = mkdtempSync(join(tmpdir(), 'fv-personal-'));
process.on('exit', () => rmSync(root, { recursive: true, force: true }));
for (const d of ['bin', 'home', 'personal']) mkdirSync(join(root, d), { recursive: true });
process.env.HOME = join(root, 'home');
process.env.CLAUDE_CONFIG_DIR = join(root, 'personal');

/** What a person might well have in `~/.claude/settings.json`: rules and hooks
 *  that would widen or act on a fenced turn, beside the login and defaults. */
const HOOK_MARK = join(root, 'personal-hook-ran');
const PERSONAL = {
  permissions: {
    allow: ['Bash(node:*)', 'Bash(google-chrome:*)'],
    deny: ['WebFetch'],
    ask: ['Bash(git push:*)'],
    defaultMode: 'bypassPermissions',
    additionalDirectories: ['/etc'],
  },
  hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `touch '${HOOK_MARK}'` }] }] },
  disableAllHooks: false,
  enabledPlugins: { 'browser@market': true },
  sandbox: { enabled: true, autoAllowBashIfSandboxed: true },
  statusLine: { type: 'command', command: 'true' },
  model: 'opus[1m]',
  language: 'japanese',
  apiKeyHelper: '/usr/local/bin/key-helper',
  env: {
    ANTHROPIC_BASE_URL: 'https://proxy.example',
    DISPLAY: ':0',
    BROWSER: 'wslview',
    FLOWVIANT_MACHINE_TOKEN: 'fvm_secret',
    NOT_A_STRING: 7,
  },
  modelSettings: { 'claude-opus-5-5': { effortLevel: 'high' } },
  alwaysThinkingEnabled: true,
  cleanupPeriodDays: 400,
};
/** What a fenced turn keeps of it — the login, the model defaults, the store. */
const KEPT = {
  apiKeyHelper: '/usr/local/bin/key-helper',
  env: { ANTHROPIC_BASE_URL: 'https://proxy.example' },
  modelSettings: { 'claude-opus-5-5': { effortLevel: 'high' } },
  alwaysThinkingEnabled: true,
  cleanupPeriodDays: 400,
};
writeFileSync(join(root, 'personal', 'settings.json'), JSON.stringify(PERSONAL));

// A fake `claude` that writes down every argv it was spawned with, then
// answers as a delivered turn — writing the mockup a design card must hand
// back, so the fenced agent lane settles as it would for real.
const spawns = join(root, 'spawns');
writeFileSync(
  join(root, 'bin', 'claude'),
  `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(spawns)}, JSON.stringify(process.argv.slice(2)) + '\\n');
try { fs.mkdirSync('.flowviant/artifacts', { recursive: true }); fs.writeFileSync('.flowviant/artifacts/page.html', '<p>x</p>'); } catch {}
const say = (ev) => process.stdout.write(JSON.stringify(ev) + '\\n');
say({ type: 'system', subtype: 'init', session_id: 'sess-' + Date.now(), skills: [], model: 'claude-opus-5-5' });
say({ type: 'result', subtype: 'success', usage: { input_tokens: 1, output_tokens: 1 },
  result: JSON.stringify({ status: 'delivered', summary: 'done' }) });
`
);
chmodSync(join(root, 'bin', 'claude'), 0o755);
process.env.PATH = `${join(root, 'bin')}:${process.env.PATH}`;

const { personalClaudeSettings, withPersonalSettings, PERSONAL_KEPT, NO_SETTING_SOURCES } = await import('./claudePersonal.mjs');
const { READ_GUARD_SETTINGS, claudePermFor, designPermFor } = await import('./claudePosture.mjs');
const { runTurn } = await import('./runTurn.mjs');
const { TURN_PROFILES } = await import('./turnProfile.mjs');
const { RUNTIMES } = await import('./runtimes.mjs');
const { createWorkManager } = await import('./work.mjs');

const GUARD = JSON.parse(READ_GUARD_SETTINGS);
const spawned = () => (existsSync(spawns) ? readFileSync(spawns, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const sourcesOf = (argv) => {
  const at = argv.indexOf('--setting-sources');
  return at < 0 ? null : argv[at + 1];
};
const settingsOf = (argv) => {
  const at = argv.indexOf('--settings');
  return at < 0 ? null : JSON.parse(argv[at + 1]);
};
/** The fenced shape: no settings file at all, the posture's guard exactly,
 *  and of the person's file only what is kept. */
function assertFenced(argv, name) {
  assert.equal(argv.filter((x) => x === '--setting-sources').length, 1, `${name}: one source flag`);
  assert.equal(sourcesOf(argv), '', `${name}: no settings file — user, project or local`);
  assert.equal(argv.filter((x) => x === '--settings').length, 1, `${name}: one --settings (the CLI reads the last)`);
  const s = settingsOf(argv);
  assert.deepEqual(s.hooks, GUARD.hooks, `${name}: the read guard, and no hook of the person's`);
  assert.equal(s.permissions, undefined, `${name}: no personal rule, mode or directory`);
  const { hooks, ...personal } = s;
  assert.deepEqual(personal, KEPT, `${name}: the login and the defaults, nothing else`);
  assert.ok(!argv.includes('--dangerously-skip-permissions'), `${name}: canary — a curated posture`);
}

test('the person\'s file is read down to the login, the model defaults and the store', () => {
  assert.deepEqual(personalClaudeSettings(process.env), KEPT);
  for (const key of ['permissions', 'hooks', 'disableAllHooks', 'enabledPlugins', 'sandbox', 'statusLine', 'model', 'language'])
    assert.ok(!PERSONAL_KEPT.includes(key), `${key} is the posture's, never the person's`);
  // Where the CLI looks: CLAUDE_CONFIG_DIR, else ~/.claude.
  const home = mkdtempSync(join(root, 'h-'));
  mkdirSync(join(home, '.claude'));
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ effortLevel: 'low', permissions: { allow: ['Bash'] } }));
  assert.deepEqual(personalClaudeSettings({ HOME: home }), { effortLevel: 'low' });
  // Absent, garbled or not an object: nothing kept, and nothing thrown.
  assert.deepEqual(personalClaudeSettings({ CLAUDE_CONFIG_DIR: join(root, 'nowhere') }), {});
  writeFileSync(join(home, '.claude', 'settings.json'), '{ "env": ');
  assert.deepEqual(personalClaudeSettings({ HOME: home }), {});
  writeFileSync(join(home, '.claude', 'settings.json'), '["apiKeyHelper"]');
  assert.deepEqual(personalClaudeSettings({ HOME: home }), {});
  // An env with nothing kept in it rides as no env at all.
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ env: { DISPLAY: ':1', WAYLAND_DISPLAY: 'w', CHROME_USER_DATA_DIR: '/p' } }));
  assert.deepEqual(personalClaudeSettings({ HOME: home }), {});
});

test('what is kept rides inside the posture\'s one --settings, and the posture wins', () => {
  const design = designPermFor(null);
  assert.deepEqual(withPersonalSettings(design, {}), design, 'nothing kept: the posture as it was');
  const merged = withPersonalSettings(design, { ...KEPT, hooks: { Stop: [] } });
  assert.equal(merged.filter((x) => x === '--settings').length, 1);
  assert.equal(merged.indexOf('--settings'), design.indexOf('--settings'), 'still before the variadic list');
  assert.deepEqual(merged.slice(2), design.slice(2), 'the lists untouched');
  const s = JSON.parse(merged[1]);
  assert.deepEqual(s.hooks, GUARD.hooks, "the posture's key wins");
  assert.equal(s.apiKeyHelper, KEPT.apiKeyHelper);
  // A posture with no --settings of its own gets one ahead of its lists.
  assert.deepEqual(withPersonalSettings(['--allowedTools', 'Read'], { effortLevel: 'low' }), ['--settings', '{"effortLevel":"low"}', '--allowedTools', 'Read']);
  assert.deepEqual(NO_SETTING_SOURCES, ['--setting-sources', '']);
});

const turn = (opts) => runTurn({ prompt: 'p', system: 's', cwd: root, streamJson: true, answerFromResult: true, ...opts });
const argvOfTurn = async (opts) => {
  rmSync(spawns, { force: true });
  await turn(opts);
  const all = spawned();
  assert.equal(all.length, 1, 'canary: one spawn');
  return all[0];
};

test('every Claude posture but the build reads no settings file — a posture added later included', async () => {
  const fenced = [];
  for (const name of Object.keys(TURN_PROFILES)) {
    // A posture Claude does not declare is refused before any argv (image).
    const profile = TURN_PROFILES[name].adapterProfile;
    if (profile !== 'build' && !RUNTIMES.claude.profiles.includes(profile)) continue;
    const argv = await argvOfTurn({ profile: name });
    if (profile === 'build') {
      // A Terminal tab — its build or its plan mode — is the person's own
      // Claude Code: every settings file, no settings flag of ours.
      assert.equal(sourcesOf(argv), null, `${name}: the person's own Claude Code`);
      assert.equal(argv.indexOf('--settings'), -1, `${name}: nothing folded in`);
    } else {
      assertFenced(argv, name);
      fenced.push(name);
    }
  }
  assert.deepEqual(fenced.sort(), ['consult', 'design', 'plan', 'research', 'wiki'], 'canary: every fenced Claude posture was asked');
});

test('an agent\'s fenced card reads no settings file; its code card keeps the person\'s own, never the worktree\'s', async () => {
  const agentTools = { instructions: 'BASE', pluginDir: join(root, 'plugin') };
  for (const profile of ['design', 'research']) {
    const argv = await argvOfTurn({ profile, agentTools });
    assertFenced(argv, `${profile} agent`);
    assert.ok(!argv.includes('user'), `${profile} agent: never the user source`);
    assert.equal(argv[argv.indexOf('--plugin-dir') + 1], agentTools.pluginDir, `${profile} agent: the base skills still ride`);
  }
  const code = await argvOfTurn({ profile: 'build', agentTools });
  assert.equal(sourcesOf(code), 'user', 'a code agent: the person\'s file, not the worktree\'s');
  assert.equal(code.indexOf('--settings'), -1);
  assert.ok(code.includes('--dangerously-skip-permissions') || code.includes('--allowedTools'), 'canary: the build argv');
});

/**
 * THE LANES, run for real against the fake: a 3D-model card's agent turn (the
 * case that ran Chrome), a code card's, a Terminal tab and a capture chat.
 */
const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function managerIn(t) {
  const repoRoot = mkdtempSync(join(root, 'repo-'));
  git(['init', '-q', '-b', 'main'], repoRoot);
  git(['config', 'user.email', 't@t.t'], repoRoot);
  git(['config', 'user.name', 'T'], repoRoot);
  writeFileSync(join(repoRoot, 'a.txt'), 'one');
  git(['add', '-A'], repoRoot);
  git(['commit', '-qm', 'base'], repoRoot);
  const baseDir = mkdtempSync(join(root, 'base-'));
  const m = createWorkManager({ repoRoot, baseDir, getBaseRef: () => 'main', getMcpUrl: () => 'http://127.0.0.1:0/mcp', getLeaseTtl: () => 60 });
  t.after(() => {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(baseDir, { recursive: true, force: true });
  });
  return m;
}
function stubFetch(t) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url) });
    return { ok: true, status: 200, json: async () => ({ data: { claimed: true, token: 'fva_tab' } }) };
  };
  t.after(() => {
    globalThis.fetch = real;
  });
  return calls;
}
const until = async (cond, ms = 15_000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
};
/** The spawn whose prompt carries `words` — an agent's own turn (it alone
 *  renders the base snapshot afresh) or a tab's. */
const promptOf = (argv) => argv[argv.indexOf('-p') + 1] ?? '';
const spawnFor = (words, { agent = false } = {}) =>
  spawned().find((a) => promptOf(a).includes(words) && a.includes('--system-prompt-snapshot') === agent);

test('the lanes: a 3D-model card and a capture chat are fenced; a code card and a Terminal tab keep the person\'s own', async (t) => {
  const m = managerIn(t);
  const calls = stubFetch(t);
  const agentDone = () => calls.filter((c) => c.url.includes('agent-turn-done')).length;
  const tabDone = () => calls.filter((c) => c.url.includes('work-turn-done')).length;
  rmSync(spawns, { force: true });

  m.processAgentTurnJobs([{ id: 'at-1', agentId: 'ag1', placeId: 'a-ag1', runtime: 'claude', agentName: 'Ada', kind: 'task', task: { id: 'c1', title: 'the moon rocket', taskKind: 'model' } }]);
  await until(() => agentDone() === 1 && !m.workBusy());
  m.processAgentTurnJobs([{ id: 'at-2', agentId: 'ag2', placeId: 'a-ag2', runtime: 'claude', agentName: 'Bo', kind: 'task', task: { id: 'c2', title: 'the login fix' } }]);
  await until(() => agentDone() === 2 && !m.workBusy());
  m.processWorkTurns([{ id: 'turn-1', body: 'hello there', sessionId: 'sess-tab', runtime: 'claude' }]);
  await until(() => tabDone() === 1 && !m.workBusy());
  m.processWorkTurns([{ id: 'turn-2', body: 'a card for the login bug', sessionId: 'sess-cap', runtime: 'claude', capture: true }]);
  await until(() => tabDone() === 2 && !m.workBusy());

  const model = spawnFor('the moon rocket', { agent: true });
  assert.ok(model, 'canary: the 3D-model agent ran');
  assertFenced(model, '3D-model agent');

  const code = spawnFor('the login fix', { agent: true });
  assert.ok(code, 'canary: the code agent ran');
  assert.equal(sourcesOf(code), 'user', 'code agent: the person\'s file, never the worktree\'s');
  assert.equal(code.indexOf('--settings'), -1, 'code agent');

  const tab = spawnFor('hello there');
  assert.ok(tab, 'canary: the Terminal tab ran');
  assert.equal(sourcesOf(tab), null, 'Terminal tab: the person\'s own Claude Code');
  assert.equal(tab.indexOf('--settings'), -1, 'Terminal tab');

  const capture = spawnFor('a card for the login bug');
  assert.ok(capture, 'canary: the capture chat ran');
  assertFenced(capture, 'capture chat');
  assert.ok(capture.includes('mcp__flowviant'), 'canary: the capture posture');
});

/**
 * THE REAL CLI, with no credentials and no model call. A scratch config dir
 * holds a personal file that bypasses every permission and runs a
 * SessionStart hook; each fenced posture's argv, as the adapter builds it, is
 * spawned against it until the init event, then killed. With no credentials
 * the CLI could not reach the model even if the kill came late ("Not logged
 * in", `duration_api_ms: 0`, measured), and the environment is built from
 * nothing but PATH, so no key of the developer's can stand in for one.
 */
function initOf(argv, { cfg, cwd, home }) {
  return new Promise((resolve) => {
    const env = { PATH: process.env.PATH, HOME: home, CLAUDE_CONFIG_DIR: cfg, TMPDIR: tmpdir(), DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
    const child = spawn(realClaude, argv, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const hooks = [];
    let buf = '';
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { child.kill('SIGKILL'); } catch { /* gone */ }
      resolve(v);
    };
    const timer = setTimeout(() => finish({ error: 'no init within 30s' }), 30_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }
        if (ev.subtype === 'hook_started') hooks.push(ev.hook_name);
        if (ev.type === 'system' && ev.subtype === 'init') finish({ permissionMode: ev.permissionMode, hooks });
      }
    });
    child.on('error', (e) => finish({ error: String(e) }));
    child.on('close', () => finish({ error: 'closed before init' }));
  });
}

test('on the real CLI, a personal bypass and hook reach no fenced posture (offline)', async (t) => {
  if (!realClaude) return t.skip('Claude Code is not installed');
  const base = mkdtempSync(join(root, 'real-'));
  const cfg = join(base, 'cfg');
  const home = join(base, 'home');
  const cwd = join(base, 'repo');
  for (const d of [cfg, home, cwd]) mkdirSync(d);
  git(['init', '-q'], cwd);
  const mark = join(base, 'hook-ran');
  writeFileSync(join(cfg, 'settings.json'), JSON.stringify({
    permissions: { defaultMode: 'bypassPermissions', allow: ['Bash(node:*)'] },
    hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `touch '${mark}'` }] }] },
    // Kept keys, so the real CLI is handed the merged --settings too.
    env: { FV_KEPT: '1' },
    alwaysThinkingEnabled: true,
    modelSettings: { 'claude-opus-5-5': { effortLevel: 'high' } },
  }));
  const saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = cfg; // the adapter reads the person's file where the CLI will
  t.after(() => {
    process.env.CLAUDE_CONFIG_DIR = saved;
  });
  const argvFor = (profile, extra = {}) =>
    RUNTIMES.claude.args({ prompt: 'x', system: 's', profile, perm: claudePermFor(profile, null), model: 'haiku', streamJson: true, ...extra });
  const fenced = ['consult', 'plan', 'wiki', 'design', 'research'];
  const ctx = { cfg, cwd, home };
  const [results, agentDesign, oldConsult, codeAgent] = await Promise.all([
    Promise.all(fenced.map((p) => initOf(argvFor(p), ctx))),
    initOf(argvFor('design', { agentTools: { instructions: 'BASE' } }), ctx),
    // CONTROLS. The consult argv as it was spawned before this change — no
    // source flag at all — must see the fixture, or this test proves nothing.
    initOf(argvFor('consult').filter((x, i, a) => !(x === '--setting-sources' || (i > 0 && a[i - 1] === '--setting-sources'))), ctx),
    // A code agent keeps the person's file, and its hook with it.
    initOf(argvFor('build', { agentTools: { instructions: 'BASE' } }), ctx),
  ]);
  assert.equal(oldConsult.permissionMode, 'bypassPermissions', `control: the fixture widens a turn that reads it — ${JSON.stringify(oldConsult)}`);
  assert.ok(oldConsult.hooks.includes('SessionStart:startup'), 'control: …and runs its hook');
  assert.ok(codeAgent.hooks.includes('SessionStart:startup'), 'control: a code agent keeps the person\'s own');
  for (const [name, r] of [...fenced.map((p, i) => [p, results[i]]), ['design agent', agentDesign]]) {
    assert.equal(r.error, undefined, `${name}: ${r.error}`);
    assert.equal(r.permissionMode, 'default', `${name}: the posture's own mode, never the person's bypass`);
    assert.deepEqual(r.hooks, [], `${name}: no hook of the person's`);
  }
});
