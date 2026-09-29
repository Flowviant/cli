import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCommandAudit } from './workCommandAudit.mjs';
import { scanEnvForScrub } from './env.mjs';

/** The tab turn's command audit, driven directly (split out of work.mjs
 *  2026-09-26, SOLID F037) against a recording fetch. */
function recordFetch(t) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), body: JSON.parse(opts.body) });
    return { ok: true, status: 200 };
  };
  t.after(() => {
    globalThis.fetch = real;
  });
  return calls;
}

test('only commands are audited, batched per turn, and flushed at 25 and at settle', (t) => {
  const calls = recordFetch(t);
  const { auditCommand, flushAudit } = createCommandAudit({ sessionId: 's1', turnId: 't1', runtime: 'claude', cwd: '/wt' });
  auditCommand({ kind: 'read', label: 'read a.js' });
  auditCommand({ kind: 'bash' }); // no command — nothing to record
  flushAudit();
  assert.equal(calls.length, 0, 'an empty batch posts nothing');
  for (let i = 0; i < 26; i += 1) auditCommand({ kind: 'bash', command: `echo ${i}` });
  assert.equal(calls.length, 1, 'the 25th command flushes mid-turn');
  assert.ok(calls[0].url.endsWith('/session-commands'));
  const { commands, ...rest } = calls[0].body;
  assert.deepEqual(rest, { sessionId: 's1', turnId: 't1', runtime: 'claude', cwd: '/wt' });
  assert.equal(commands.length, 25);
  assert.equal(commands[0].command, 'echo 0');
  flushAudit();
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].body.commands.map((c) => c.command), ['echo 25']);
});

test('a command line is scrubbed before it leaves the box', (t) => {
  const calls = recordFetch(t);
  const repo = mkdtempSync(join(tmpdir(), 'fv-audit-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  writeFileSync(join(repo, '.env'), 'AUDIT_PROBE_TOKEN=ghp_Aud1tPr0beT0ken99xYz\n');
  scanEnvForScrub(repo, null);
  const { auditCommand, flushAudit } = createCommandAudit({ sessionId: 's', turnId: 't', runtime: 'codex', cwd: repo });
  auditCommand({ kind: 'bash', command: 'curl -H "authorization: ghp_Aud1tPr0beT0ken99xYz" x' });
  flushAudit();
  assert.equal(calls[0].body.commands[0].command, 'curl -H "authorization: [REDACTED:AUDIT_PROBE_TOKEN]" x');
});

test('a failed post drops the batch and never throws into the turn', async (t) => {
  const real = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('down');
  };
  t.after(() => {
    globalThis.fetch = real;
  });
  const { auditCommand, flushAudit } = createCommandAudit({ sessionId: 's', turnId: 't', runtime: 'claude', cwd: '/' });
  auditCommand({ kind: 'bash', command: 'ls' });
  assert.doesNotThrow(() => flushAudit());
  await new Promise((r) => setTimeout(r, 10));
});
