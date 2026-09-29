/**
 * THE SPELLINGS CODEX ACCEPTS ON BOTH VERBS (0.114.0). `codex exec resume`
 * (codex-cli 0.156.1) takes no `--sandbox`, and `codex exec` takes no `-P`:
 * a build turn that resumed its thread (an agent's second card, an answer)
 * and every Codex wiki turn were refused before they started. Both are now
 * config (`-c sandbox_mode=…`, `-c default_permissions=…`), which both verbs
 * accept.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CODEX_RUNTIME } from './runtimeCodex.mjs';

const base = { prompt: 'p', system: 's', cwd: '/tmp/wt' };

test('a resumed build turn carries its sandbox as config, never --sandbox', () => {
  const a = CODEX_RUNTIME.args({ ...base, resumeThreadId: '0199aaaa-bbbb-7ccc-8ddd-eeeeffff0000' });
  assert.deepEqual(a.slice(0, 3), ['exec', 'resume', '0199aaaa-bbbb-7ccc-8ddd-eeeeffff0000']);
  assert.ok(!a.includes('--sandbox'), a.join(' '));
  assert.ok(a.some((x) => /^sandbox_mode="(workspace-write|danger-full-access)"$/.test(x)), a.join(' '));
});

test('a fresh build turn says the same thing the same way', () => {
  const a = CODEX_RUNTIME.args(base);
  assert.ok(!a.includes('--sandbox'));
  assert.ok(a.some((x) => x.startsWith('sandbox_mode="')));
});

test('a wiki turn selects its permission profile by config, never -P', () => {
  const a = CODEX_RUNTIME.args({ ...base, profile: 'wiki', vaultDir: '/tmp/vault' });
  assert.ok(!a.includes('-P'), a.join(' '));
  assert.ok(a.includes('default_permissions="flowviantwiki"'), a.join(' '));
});

test('the read-only lanes are read-only by config', () => {
  const a = CODEX_RUNTIME.args({ ...base, profile: 'consult' });
  assert.ok(!a.includes('--sandbox'));
  assert.ok(a.includes('sandbox_mode="read-only"'), a.join(' '));
});

test('a fenced turn switches off the browser, the desktop and apps; a build turn does not touch them', () => {
  for (const profile of ['consult', 'wiki']) {
    const a = CODEX_RUNTIME.args({ ...base, profile, vaultDir: '/tmp/vault' });
    for (const f of ['browser_use', 'computer_use', 'apps', 'in_app_browser']) assert.ok(a.includes(`features.${f}=false`), `${profile}: ${f}`);
  }
  const build = CODEX_RUNTIME.args(base);
  assert.ok(!build.some((x) => x.startsWith('features.computer_use')));
});
