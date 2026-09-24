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
