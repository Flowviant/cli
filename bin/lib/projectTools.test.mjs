import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { prepareAgentTools, readBaseTools, toolReadout } from './projectTools.mjs';
import { mcpRefusal, runnerToolCapabilities, skillsRefusal } from './projectToolRuntimes.mjs';
import { RUNTIMES } from './runtimes.mjs';

test('base ref wins over worktree edits; readiness never includes env values', () => {
  const root = mkdtempSync(join(tmpdir(), 'flowviant-tool-test-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  try {
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'test');
    mkdirSync(join(root, '.claude/skills/review'), { recursive: true });
    writeFileSync(join(root, '.mcp.json'), JSON.stringify({ mcpServers: {
      local: { command: 'node', args: ['server.mjs'], env: { KEY: '${SECRET}' } },
      absent: { command: 'no-such-flowviant-command' },
      remote: { type: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer ${SECRET}' } },
    } }));
    writeFileSync(join(root, '.claude/skills/review/SKILL.md'), 'base skill');
    writeFileSync(join(root, '.claude/skills/review/example.txt'), 'supporting file');
    writeFileSync(join(root, 'CLAUDE.md'), 'base Claude instructions');
    writeFileSync(join(root, 'AGENTS.md'), 'base instructions');
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src/AGENTS.md'), 'base nested instructions');
    git('add', '.'); git('commit', '-qm', 'base');
    const ref = 'HEAD';
    writeFileSync(join(root, '.mcp.json'), JSON.stringify({ mcpServers: { injected: { command: 'node' } } }));
    writeFileSync(join(root, '.claude/skills/review/SKILL.md'), 'worktree skill');
    writeFileSync(join(root, 'CLAUDE.md'), 'worktree Claude instructions');
    writeFileSync(join(root, 'AGENTS.md'), 'worktree instructions');
    writeFileSync(join(root, 'src/AGENTS.md'), 'worktree nested instructions');
    const snapshot = readBaseTools(root, ref, { PATH: process.env.PATH, SECRET: 'private-value' });
    assert.deepEqual(snapshot.tools.map((t) => t.name), ['local', 'absent', 'remote']);
    assert.equal(snapshot.skills[0].body, 'base skill');
    assert.deepEqual(snapshot.instructions.map((i) => i.body), ['base instructions', 'base Claude instructions', 'base nested instructions']);
    assert.deepEqual(toolReadout(snapshot, 'claude'), [
      { name: 'local', kind: 'mcp', state: 'ready', reason: null },
      { name: 'absent', kind: 'mcp', state: 'missing', reason: 'command no-such-flowviant-command not on PATH' },
      { name: 'remote', kind: 'mcp', state: 'ready', reason: null },
      { name: 'review', kind: 'instruction', state: 'ready', reason: null },
    ]);
    assert.doesNotMatch(JSON.stringify(toolReadout(snapshot, 'claude')), /private-value/);
    const prepared = prepareAgentTools(snapshot, 'codex', { SECRET: 'private-value' });
    try {
      assert.match(prepared.instructions, /AGENTS\.md/);
      assert.match(prepared.instructions, /SKILL\.md/);
      assert.equal(readFileSync(prepared.mcpPath, 'utf8').includes('injected'), false);
      assert.equal(readFileSync(join(prepared.mcpPath, '../.claude/skills/review/example.txt'), 'utf8'), 'supporting file');
      assert.ok(prepared.codexArgs.some((a) => a.includes('mcp_servers.local.command')));
      assert.ok(prepared.codexArgs.some((a) => a.includes('mcp_servers.remote.http_headers')));
      assert.match(prepared.instructions, /base Claude instructions/);
      assert.match(prepared.instructions, /base nested instructions/);
      assert.doesNotMatch(prepared.instructions, /worktree/);
    } finally { prepared.cleanup(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('runner capability mapping is explicit and rejects unknown runners', () => {
  assert.deepEqual(runnerToolCapabilities('claude'), { mcp: true, skills: true });
  assert.deepEqual(runnerToolCapabilities('codex'), { mcp: true, skills: true });
  assert.deepEqual(runnerToolCapabilities('antigravity'), { mcp: false, skills: false });
  assert.deepEqual(runnerToolCapabilities('future'), { mcp: false, skills: false });
  assert.deepEqual(toolReadout({ tools: [{ name: 'old', config: { type: 'sse', url: 'https://example.com' }, state: 'ready', reason: null }], skills: [] }, 'codex'), [
    { name: 'old', kind: 'mcp', state: 'missing', reason: 'Codex cannot take SSE MCP' },
  ]);
});

test('fenced Claude turns load no project MCP; build takes its explicit snapshot', () => {
  const args = (profile, mcp = []) => RUNTIMES.claude.args({
    prompt: 'work', system: 'system', profile, perm: [], mcp,
  });
  for (const profile of ['consult', 'wiki', 'design', 'research']) {
    assert.ok(args(profile).includes('--strict-mcp-config'), profile);
  }
  assert.deepEqual(args('build', ['--strict-mcp-config', '--mcp-config', '/tmp/reviewed.json'])
    .filter((arg) => arg === '--strict-mcp-config' || arg === '--mcp-config' || arg === '/tmp/reviewed.json'),
  ['--strict-mcp-config', '--mcp-config', '/tmp/reviewed.json']);
  assert.equal(args('build').includes('--strict-mcp-config'), false);
});

test('Codex MCP overrides stay before its positional prompt', () => {
  const args = RUNTIMES.codex.args({
    prompt: 'work', system: 'system', profile: 'build',
    mcp: ['-c', 'mcp_servers.search.command="node"'],
  });
  assert.ok(args.indexOf('mcp_servers.search.command="node"') < args.length - 1);
  assert.match(args.at(-1), /work/);
});

test('agent argv pins base content and disables project discovery without changing workbench argv', () => {
  const agentTools = { instructions: 'BASE_ONLY', pluginDir: '/tmp/base-plugin' };
  const claude = RUNTIMES.claude.args({ prompt: 'work', system: 'BASE_ONLY', profile: 'build', perm: [], agentTools });
  assert.deepEqual(claude.slice(claude.indexOf('--setting-sources'), claude.indexOf('--setting-sources') + 2), ['--setting-sources', 'user']);
  assert.ok(claude.includes('--system-prompt-snapshot') && claude.includes('off'));
  assert.ok(claude.includes('--plugin-dir') && claude.includes('/tmp/base-plugin'));
  const codex = RUNTIMES.codex.args({ prompt: 'work', system: 'BASE_ONLY', agentTools });
  assert.ok(codex.includes('project_doc_max_bytes=0'));
  assert.ok(codex.some((a) => a.includes('developer_instructions=') && a.includes('BASE_ONLY')));
  assert.ok(codex.indexOf('project_doc_max_bytes=0') < codex.length - 1);
  const personal = RUNTIMES.codex.args({ prompt: 'work', system: 'BASE_ONLY', agentTools: { ...agentTools, personalDeveloperInstructions: true } });
  assert.ok(!personal.some((a) => a.startsWith('developer_instructions=')));
  assert.match(personal.at(-1), /BASE_ONLY/);
  assert.ok(!RUNTIMES.claude.args({ prompt: 'work', system: 'system', perm: [] }).includes('--setting-sources'));
  assert.ok(!RUNTIMES.codex.args({ prompt: 'work', system: 'system' }).includes('project_doc_max_bytes=0'));
});

test('Codex offline prompt input ignores trusted worktree docs and project config', (t) => {
  if (spawnSync('codex', ['--version'], { encoding: 'utf8' }).status !== 0) return t.skip('Codex is not installed');
  const root = mkdtempSync(join(tmpdir(), 'flowviant-codex-discovery-'));
  const personal = join(root, 'personal');
  const repo = join(root, 'repo');
  mkdirSync(personal);
  mkdirSync(join(repo, '.codex'), { recursive: true });
  try {
    assert.equal(spawnSync('git', ['init', '-q'], { cwd: repo }).status, 0);
    writeFileSync(join(repo, 'AGENTS.md'), 'WORKTREE_DOC_SENTINEL');
    writeFileSync(join(repo, '.codex/config.toml'), 'developer_instructions = "WORKTREE_CONFIG_SENTINEL"\n');
    mkdirSync(join(repo, '.agents/skills/evil'), { recursive: true });
    mkdirSync(join(repo, '.codex/skills/evil'), { recursive: true });
    mkdirSync(join(personal, 'skills/personal'), { recursive: true });
    writeFileSync(join(repo, '.agents/skills/evil/SKILL.md'), '---\nname: evil\ndescription: WORKTREE_SKILL_SENTINEL\n---\nbody');
    writeFileSync(join(repo, '.codex/skills/evil/SKILL.md'), '---\nname: evil2\ndescription: WORKTREE_CODEX_SKILL_SENTINEL\n---\nbody');
    writeFileSync(join(personal, 'skills/personal/SKILL.md'), '---\nname: personal\ndescription: PERSONAL_SKILL_SENTINEL\n---\nbody');
    writeFileSync(join(personal, 'config.toml'), `model_reasoning_effort = "low"\n[projects."${repo}"]\ntrust_level = "trusted"\n`);
    const snapshot = { tools: [], skills: [], skillFiles: [], instructions: [{ path: 'AGENTS.md', body: 'BASE_DOC_SENTINEL' }] };
    const prepared = prepareAgentTools(snapshot, 'codex', { CODEX_HOME: personal }, repo);
    try {
      const probe = (home, args = []) => spawnSync('codex', ['debug', 'prompt-input', ...args, 'probe'], {
        cwd: repo, env: { ...process.env, CODEX_HOME: home }, encoding: 'utf8', timeout: 10000,
      }).stdout;
      assert.match(probe(personal), /WORKTREE_DOC_SENTINEL/);
      assert.match(probe(personal), /WORKTREE_CONFIG_SENTINEL/);
      assert.match(probe(personal), /WORKTREE_SKILL_SENTINEL/);
      const args = RUNTIMES.codex.args({ prompt: 'probe', system: prepared.instructions, agentTools: prepared });
      const configArgs = args.flatMap((a, i) => a === '-c' ? ['-c', args[i + 1]] : []);
      const scoped = probe(prepared.codexHome, configArgs);
      assert.match(scoped, /BASE_DOC_SENTINEL/);
      assert.match(scoped, /PERSONAL_SKILL_SENTINEL/);
      assert.doesNotMatch(scoped, /WORKTREE_DOC_SENTINEL|WORKTREE_CONFIG_SENTINEL|WORKTREE_SKILL_SENTINEL|WORKTREE_CODEX_SKILL_SENTINEL/);
      assert.ok(existsSync(join(prepared.codexHome, 'config.toml')));
      assert.match(readFileSync(join(prepared.codexHome, 'config.toml'), 'utf8'), /model_reasoning_effort = "low"/);
    } finally { prepared.cleanup(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Claude accepts the reviewed temporary skill plugin and setting source flag offline', (t) => {
  if (spawnSync('claude', ['--version'], { encoding: 'utf8' }).status !== 0) return t.skip('Claude Code is not installed');
  const snapshot = {
    tools: [], skills: [], instructions: [],
    skillFiles: [{ path: '.claude/skills/review/SKILL.md', body: Buffer.from('---\nname: review\ndescription: Base skill\n---\nBASE_SKILL_SENTINEL') }],
  };
  const prepared = prepareAgentTools(snapshot, 'claude');
  try {
    assert.match(readFileSync(join(prepared.pluginDir, 'skills/review/SKILL.md'), 'utf8'), /BASE_SKILL_SENTINEL/);
    const out = spawnSync('claude', ['--setting-sources', 'user', '--plugin-dir', prepared.pluginDir, 'plugin', 'validate', '--json', prepared.pluginDir], {
      encoding: 'utf8', timeout: 10000,
    });
    assert.equal(out.status, 0, out.stderr);
    assert.equal(JSON.parse(out.stdout).success, true);
  } finally { prepared.cleanup(); }
});

test('an unmergeable personal skill list fails closed when the worktree has skills', () => {
  const root = mkdtempSync(join(tmpdir(), 'flowviant-skill-config-'));
  const personal = join(root, 'personal');
  const worktree = join(root, 'worktree');
  mkdirSync(personal);
  mkdirSync(join(worktree, '.agents/skills/evil'), { recursive: true });
  try {
    writeFileSync(join(personal, 'config.toml'), 'skills.config = []\n');
    writeFileSync(join(worktree, '.agents/skills/evil/SKILL.md'), 'unreviewed');
    const snapshot = { tools: [], skills: [], skillFiles: [], instructions: [] };
    assert.throws(() => prepareAgentTools(snapshot, 'codex', { CODEX_HOME: personal }, worktree), /Cannot isolate Codex project skills/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

/**
 * AN AGENT'S CODEX HOME OUTLIVES ITS TURN (2026-09-29). Codex files each
 * thread in its shared index under the CODEX_HOME the turn ran with, as that
 * path; a home that died with its turn sent the agent's next `resume <id>` to
 * "no rollout found" and the agent to Stuck. So the kept home is the SAME
 * place every turn, not under the temp dir, untouched by the turn's cleanup,
 * and refreshed in place: config rewritten (the worktree's skills and the
 * person's settings move), new personal entries linked, a link pointing
 * elsewhere or a real file where a personal entry belongs mended, a link to
 * an entry the person no longer has dropped, and what Codex made itself kept.
 * The old per-turn home fails the first assertion.
 */
test("an agent's Codex home is one kept place, refreshed in place by every turn and never removed by a turn's cleanup", () => {
  const root = mkdtempSync(join(tmpdir(), 'flowviant-kept-home-'));
  const savedTmp = process.env.TMPDIR;
  const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  try {
    const personal = join(root, 'personal');
    mkdirSync(join(personal, 'sessions'), { recursive: true });
    writeFileSync(join(personal, 'auth.json'), 'PERSONAL_LOGIN');
    const personalConfig = `model_reasoning_effort = "low"\n[projects."${root}"]\ntrust_level = "trusted"\n`;
    writeFileSync(join(personal, 'config.toml'), personalConfig);
    const repo = join(root, 'repo');
    mkdirSync(repo);
    git(['init', '-q', '-b', 'main'], repo);
    git(['-c', 'user.email=t@t.t', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'base'], repo);
    const wt = join(root, 'a-ag1');
    git(['worktree', 'add', '-q', '-b', 'session/a-ag1', wt, 'main'], repo);
    // Where the agent lane keeps it: the worktree's private git dir.
    const kept = join(git(['rev-parse', '--absolute-git-dir'], wt), 'flowviant-agent-codex-home-ag1');
    // The per-turn files go to a temp dir of their own, so "not under the
    // temp dir" is a claim about the home and not about where the repo is.
    process.env.TMPDIR = join(root, 'turn-tmp');
    mkdirSync(process.env.TMPDIR);
    const snapshot = { tools: [], skills: [], skillFiles: [], instructions: [] };
    const env = { CODEX_HOME: personal };

    const first = prepareAgentTools(snapshot, 'codex', env, wt, { codexHome: kept });
    assert.equal(first.codexHome, kept, 'the home is the one the agent keeps');
    assert.ok(!first.codexHome.startsWith(tmpdir() + sep), 'never under the temp dir');
    assert.equal(statSync(kept).mode & 0o777, 0o700);
    assert.equal(statSync(join(kept, 'config.toml')).mode & 0o777, 0o600);
    assert.doesNotMatch(readFileSync(join(kept, 'config.toml'), 'utf8'), /projects|trust_level/);
    assert.equal(readlinkSync(join(kept, 'sessions')), join(personal, 'sessions'));
    // What Codex files through the link lands in the person's store, under
    // the path the index will hand back to the next resume.
    writeFileSync(join(kept, 'sessions', 'rollout-t1.jsonl'), '{}');
    first.cleanup();
    assert.ok(!existsSync(first.mcpPath), "the turn's own files go");
    assert.ok(existsSync(join(kept, 'config.toml')), 'the home stays');

    // Between turns: the person's home and the worktree move, and the home
    // is found in every state a refresh has to mend.
    writeFileSync(join(personal, 'new-entry.json'), '{}');
    writeFileSync(join(personal, 'config.toml'), personalConfig.replace('"low"', '"high"'));
    mkdirSync(join(wt, '.agents/skills/late'), { recursive: true });
    writeFileSync(join(wt, '.agents/skills/late/SKILL.md'), 'unreviewed');
    rmSync(join(kept, 'auth.json'));
    writeFileSync(join(kept, 'auth.json'), 'A STALE COPY'); // a link Codex replaced by rename
    mkdirSync(join(root, 'elsewhere'));
    writeFileSync(join(root, 'elsewhere', 'keep.txt'), 'not ours');
    rmSync(join(kept, 'sessions'));
    symlinkSync(join(root, 'elsewhere'), join(kept, 'sessions')); // a link pointing elsewhere
    symlinkSync(join(personal, 'gone'), join(kept, 'gone')); // an entry the person no longer has
    mkdirSync(join(kept, 'generated_images'));
    writeFileSync(join(kept, 'generated_images', 'a.png'), 'png'); // Codex's own
    rmSync(join(kept, 'config.toml'));
    symlinkSync(join(personal, 'config.toml'), join(kept, 'config.toml')); // must never be written through

    const second = prepareAgentTools(snapshot, 'codex', env, wt, { codexHome: kept });
    try {
      assert.equal(second.codexHome, first.codexHome, 'the same place, turn after turn');
      const config = readFileSync(join(kept, 'config.toml'), 'utf8');
      assert.ok(lstatSync(join(kept, 'config.toml')).isFile(), 'config.toml is a file of its own');
      assert.equal(statSync(join(kept, 'config.toml')).mode & 0o777, 0o600);
      assert.match(config, /model_reasoning_effort = "high"/, 'rewritten from the person\'s current config');
      assert.doesNotMatch(config, /projects|trust_level/, 'still without their trust grants');
      assert.ok(config.includes(`path = ${JSON.stringify(join(wt, '.agents/skills/late/SKILL.md'))}\nenabled = false`), "the worktree's new skill is disabled");
      assert.equal(readFileSync(join(personal, 'config.toml'), 'utf8'), personalConfig.replace('"low"', '"high"'), 'the personal config is untouched');
      assert.equal(readlinkSync(join(kept, 'new-entry.json')), join(personal, 'new-entry.json'), 'a new personal entry is linked');
      assert.equal(readlinkSync(join(kept, 'auth.json')), join(personal, 'auth.json'), 'the one login, not a stale copy');
      assert.equal(readlinkSync(join(kept, 'sessions')), join(personal, 'sessions'), 'a link elsewhere is re-pointed');
      assert.equal(readFileSync(join(root, 'elsewhere', 'keep.txt'), 'utf8'), 'not ours', 're-pointing never follows the old link');
      assert.ok(!existsSync(join(kept, 'gone')) && !readdirSync(kept).includes('gone'), 'a link to nothing the person has is dropped');
      assert.ok(existsSync(join(kept, 'generated_images', 'a.png')), "Codex's own entry is kept");
      assert.equal(readFileSync(join(kept, 'sessions', 'rollout-t1.jsonl'), 'utf8'), '{}', 'the first turn\'s rollout is where the index says');
      assert.deepEqual(readdirSync(kept).filter((n) => n.startsWith('.config.toml.')), [], 'no staged config left behind');
    } finally { second.cleanup(); }
    assert.ok(existsSync(join(kept, 'config.toml')));

    // Claude turns are unchanged: no Codex home, kept or otherwise.
    const claudeKept = join(root, 'claude-kept');
    const claude = prepareAgentTools(snapshot, 'claude', env, wt, { codexHome: claudeKept });
    try {
      assert.equal(claude.codexHome, null);
      assert.ok(!existsSync(claudeKept));
    } finally { claude.cleanup(); }
  } finally {
    if (savedTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = savedTmp;
    rmSync(root, { recursive: true, force: true });
  }
});

test('a refused preparation leaves the kept home as the last turn left it', () => {
  const root = mkdtempSync(join(tmpdir(), 'flowviant-kept-refused-'));
  try {
    const personal = join(root, 'personal');
    const worktree = join(root, 'worktree');
    const kept = join(root, 'kept');
    mkdirSync(personal);
    mkdirSync(worktree);
    writeFileSync(join(personal, 'config.toml'), 'skills.config = []\n');
    const snapshot = { tools: [], skills: [], skillFiles: [], instructions: [] };
    prepareAgentTools(snapshot, 'codex', { CODEX_HOME: personal }, worktree, { codexHome: kept }).cleanup();
    const before = readFileSync(join(kept, 'config.toml'), 'utf8');
    // The next turn cannot be isolated: an inline skills list beside a
    // worktree skill. It is refused before the home is touched.
    mkdirSync(join(worktree, '.agents/skills/evil'), { recursive: true });
    writeFileSync(join(worktree, '.agents/skills/evil/SKILL.md'), 'unreviewed');
    writeFileSync(join(personal, 'auth.json'), '{}');
    assert.throws(() => prepareAgentTools(snapshot, 'codex', { CODEX_HOME: personal }, worktree, { codexHome: kept }), /Cannot isolate Codex project skills/);
    assert.equal(readFileSync(join(kept, 'config.toml'), 'utf8'), before);
    assert.ok(!readdirSync(kept).includes('auth.json'), 'nothing was linked for a turn that cannot run');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a kept home refreshed after the worktree grows a skill still hides it from Codex', (t) => {
  if (spawnSync('codex', ['--version'], { encoding: 'utf8' }).status !== 0) return t.skip('Codex is not installed');
  const root = mkdtempSync(join(tmpdir(), 'flowviant-kept-discovery-'));
  const personal = join(root, 'personal');
  const repo = join(root, 'repo');
  const kept = join(root, 'kept');
  mkdirSync(join(personal, 'skills/personal'), { recursive: true });
  mkdirSync(repo);
  try {
    assert.equal(spawnSync('git', ['init', '-q'], { cwd: repo }).status, 0);
    writeFileSync(join(personal, 'skills/personal/SKILL.md'), '---\nname: personal\ndescription: PERSONAL_SKILL_SENTINEL\n---\nbody');
    writeFileSync(join(personal, 'config.toml'), `[projects."${repo}"]\ntrust_level = "trusted"\n`);
    const snapshot = { tools: [], skills: [], skillFiles: [], instructions: [{ path: 'AGENTS.md', body: 'BASE_DOC_SENTINEL' }] };
    prepareAgentTools(snapshot, 'codex', { CODEX_HOME: personal }, repo, { codexHome: kept }).cleanup();
    // The second turn's worktree has a skill the first turn's did not.
    mkdirSync(join(repo, '.agents/skills/late'), { recursive: true });
    writeFileSync(join(repo, '.agents/skills/late/SKILL.md'), '---\nname: late\ndescription: LATE_WORKTREE_SKILL_SENTINEL\n---\nbody');
    writeFileSync(join(repo, 'AGENTS.md'), 'WORKTREE_DOC_SENTINEL');
    const prepared = prepareAgentTools(snapshot, 'codex', { CODEX_HOME: personal }, repo, { codexHome: kept });
    try {
      assert.equal(prepared.codexHome, kept, 'canary: this is the refreshed kept home');
      const args = RUNTIMES.codex.args({ prompt: 'probe', system: prepared.instructions, agentTools: prepared });
      const configArgs = args.flatMap((a, i) => a === '-c' ? ['-c', args[i + 1]] : []);
      const scoped = spawnSync('codex', ['debug', 'prompt-input', ...configArgs, 'probe'], {
        cwd: repo, env: { ...process.env, CODEX_HOME: prepared.codexHome }, encoding: 'utf8', timeout: 10000,
      }).stdout;
      assert.match(scoped, /BASE_DOC_SENTINEL/);
      assert.match(scoped, /PERSONAL_SKILL_SENTINEL/);
      assert.doesNotMatch(scoped, /LATE_WORKTREE_SKILL_SENTINEL|WORKTREE_DOC_SENTINEL/);
    } finally { prepared.cleanup(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('every runtime gives the same MCP and skill answer in preparation and readout (one table)', () => {
  const tools = [
    { name: 'stdio', config: { command: 'node' }, state: 'ready', reason: null },
    { name: 'http', config: { type: 'http', url: 'https://example.com/mcp' }, state: 'ready', reason: null },
    { name: 'sse', config: { type: 'sse', url: 'https://example.com/sse' }, state: 'ready', reason: null },
  ];
  const snapshot = {
    tools,
    skills: [{ path: '.claude/skills/review/SKILL.md', body: 'skill' }],
    skillFiles: [{ path: '.claude/skills/review/SKILL.md', body: Buffer.from('skill') }],
    instructions: [],
  };
  const home = mkdtempSync(join(tmpdir(), 'flowviant-tool-table-'));
  try {
    for (const runner of ['claude', 'codex', 'antigravity', 'none', 'future']) {
      const readout = toolReadout(snapshot, runner);
      const prepared = prepareAgentTools(snapshot, runner, { CODEX_HOME: home });
      try {
        const written = Object.keys(JSON.parse(readFileSync(prepared.mcpPath, 'utf8')).mcpServers);
        for (const t of tools) {
          const refused = mcpRefusal(runner, t.config);
          const row = readout.find((r) => r.kind === 'mcp' && r.name === t.name);
          assert.equal(row.state === 'ready', refused == null, `${runner}/${t.name}: readout agrees with the table`);
          assert.equal(row.reason, refused, `${runner}/${t.name}: readout says the table's words`);
          assert.equal(written.includes(t.name), refused == null, `${runner}/${t.name}: preparation agrees with the table`);
        }
        const skill = readout.find((r) => r.kind === 'instruction');
        assert.equal(skill.state === 'ready', skillsRefusal(runner) == null, `${runner}: skill readout`);
        assert.equal(existsSync(join(prepared.mcpPath, '../.claude/skills/review/SKILL.md')), skillsRefusal(runner) == null, `${runner}: skill copies`);
        assert.equal(prepared.pluginDir != null, runner === 'claude', `${runner}: only Claude gets the reviewed plugin`);
        assert.equal(prepared.codexHome != null, runner === 'codex', `${runner}: only Codex gets an isolated home`);
        assert.equal(runnerToolCapabilities(runner).mcp, !['antigravity', 'none', 'future'].includes(runner));
      } finally { prepared.cleanup(); }
    }
  } finally { rmSync(home, { recursive: true, force: true }); }
  assert.equal(mcpRefusal('codex', { type: 'sse' }), 'Codex cannot take SSE MCP');
  assert.equal(mcpRefusal('none', {}), 'no installed CLI can take MCP');
  assert.equal(skillsRefusal('antigravity'), 'antigravity cannot take instructions');
});

test('the runtime rules have one home: projectTools.mjs branches on no runner id', () => {
  const src = readFileSync(new URL('./projectTools.mjs', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  assert.ok(src.includes('mcpRefusal(runner'), 'anchor: projectTools asks the table');
  for (const banned of ["runner === 'codex'", "runner === 'claude'", "'sse'", 'isolatedCodexHome']) {
    assert.ok(!src.includes(banned), `projectTools.mjs must not carry a runtime rule of its own (${banned})`);
  }
});

test('the MCP transport refusals live in projectToolRuntimes.mjs alone, anywhere in bin/', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith('.mjs') && !e.name.endsWith('.test.mjs') ? [join(d, e.name)] : []);
  const holders = walk(root).filter((f) => /['"`]sse['"`]/.test(strip(readFileSync(f, 'utf8'))));
  // Canary: the walk finds the one home.
  assert.deepEqual(holders.map((f) => f.slice(root.length).replace(/^\//, '')), ['lib/projectToolRuntimes.mjs']);
});
