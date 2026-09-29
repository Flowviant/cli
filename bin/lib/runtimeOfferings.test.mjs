import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localCodexOfferings } from './runtimeOfferings.mjs';

test('local Codex reports are bounded, private, and do not start a turn', () => {
  const calls = [];
  const report = localCodexOfferings({
    env: { CODEX_HOME: '/codex' },
    read: () => JSON.stringify({ models: [
      { slug: 'listed', display_name: 'Listed', visibility: 'list', supported_reasoning_levels: [{ effort: 'high' }] },
      { slug: 'hidden', visibility: 'hide' },
    ] }),
    list: () => [{ name: 'review', isDirectory: () => true }],
    runCodex: (args) => {
      calls.push(args.join(' '));
      return args[0] === 'features' ? 'image_generation stable true\nunknown stable true\n' : JSON.stringify([
        { name: 'connected', auth_status: 'connected' },
        { name: 'uncertain', auth_status: 'unknown' },
        { name: 'login', auth_status: 'needs_auth' },
      ]);
    },
  });
  assert.deepEqual(calls, ['features list', 'mcp list --json']);
  assert.deepEqual(report.models, [{ slug: 'listed', displayName: 'Listed', efforts: ['high'] }]);
  assert.deepEqual(report.capabilities, ['image']);
  assert.deepEqual(report.skills, ['review']);
  assert.deepEqual(report.mcp, [{ n: 'login', s: 'needs-auth' }]);
});

test('failed local probes remain unknown', () => {
  const report = localCodexOfferings({ env: { CODEX_HOME: '/absent' }, read: () => { throw Error(); }, list: () => { throw Error(); }, runCodex: () => { throw Error(); } });
  assert.deepEqual(report, {});
});

test("the repo's MCP servers Codex refuses are reported as failed, by the one table's answer", async () => {
  const { execFileSync } = await import('node:child_process');
  const { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { runtimeOfferings } = await import('./runtimeOfferings.mjs');
  const { mcpRefusal } = await import('./projectToolRuntimes.mjs');
  const root = mkdtempSync(join(tmpdir(), 'flowviant-offerings-'));
  const bin = join(root, 'bin');
  const repo = join(root, 'repo');
  const saved = { PATH: process.env.PATH, CODEX_HOME: process.env.CODEX_HOME };
  try {
    mkdirSync(bin);
    mkdirSync(repo);
    // A fake codex: no features, no personal MCP servers.
    writeFileSync(join(bin, 'codex'), '#!/bin/sh\nif [ "$1" = mcp ]; then echo "[]"; fi\n');
    chmodSync(join(bin, 'codex'), 0o755);
    const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'test');
    const servers = {
      stdio: { command: 'node' },
      http: { type: 'http', url: 'https://example.com/mcp' },
      old: { type: 'sse', url: 'https://example.com/sse' },
      absent: { command: 'no-such-flowviant-command' },
    };
    writeFileSync(join(repo, '.mcp.json'), JSON.stringify({ mcpServers: servers }));
    git('add', '.');
    git('commit', '-qm', 'base');
    process.env.PATH = `${bin}:${saved.PATH}`;
    process.env.CODEX_HOME = join(root, 'codex-home');
    const out = runtimeOfferings(repo, 'HEAD', { refresh: true });
    assert.deepEqual(out.rtp.codex, [{ n: 'old', s: 'failed' }, { n: 'absent', s: 'failed' }]);
    // The SSE row is there because the table refuses it, not by a rule of its own.
    assert.equal(mcpRefusal('codex', servers.old) != null, true);
    assert.equal(mcpRefusal('codex', servers.http), null);
  } finally {
    process.env.PATH = saved.PATH;
    if (saved.CODEX_HOME === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = saved.CODEX_HOME;
    rmSync(root, { recursive: true, force: true });
  }
});
