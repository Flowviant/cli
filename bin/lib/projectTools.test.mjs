import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareAgentTools, readBaseTools, runnerToolCapabilities, toolReadout } from './projectTools.mjs';
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
