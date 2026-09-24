import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
    writeFileSync(join(root, 'AGENTS.md'), 'base instructions');
    git('add', '.'); git('commit', '-qm', 'base');
    const ref = 'HEAD';
    writeFileSync(join(root, '.mcp.json'), JSON.stringify({ mcpServers: { injected: { command: 'node' } } }));
    writeFileSync(join(root, '.claude/skills/review/SKILL.md'), 'worktree skill');
    const snapshot = readBaseTools(root, ref, { PATH: process.env.PATH, SECRET: 'private-value' });
    assert.deepEqual(snapshot.tools.map((t) => t.name), ['local', 'absent', 'remote']);
    assert.equal(snapshot.skills[0].body, 'base skill');
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
