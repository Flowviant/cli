import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTurnResumingOnce } from './resumeLost.mjs';

/**
 * THE AGENT LANE'S RESUME SEQUENCE, AGAINST A SPAWNED CLI (SOLID F001).
 *
 * resumeLost.test.mjs proves the rule on strings. This proves the part it
 * cannot: that a real `runTurn` delivers Claude's `system.init` through the
 * stream parser BEFORE the sequence classifies `out`, so the evidence the rule
 * reads is measured, not defaulted. A fake `claude` on PATH counts its spawns.
 * The old agent lane (`resumeConversationLost(out)`, no evidence) ran the
 * answering variant twice.
 */
const dir = mkdtempSync(join(tmpdir(), 'fv-resumelost-'));
const spawns = join(dir, 'spawns');
writeFileSync(
  join(dir, 'claude'),
  `#!/usr/bin/env node
const fs = require('node:fs');
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(spawns)}, JSON.stringify(argv) + '\\n');
const say = (ev) => process.stdout.write(JSON.stringify(ev) + '\\n');
const resumed = argv.includes('--continue') || argv.includes('--resume');
if (process.env.FV_FAKE_MODE === 'dead' && resumed) {
  // A dead --continue: Claude fails before a conversation exists — no init.
  say({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['No conversation found with session ID: abc'] });
} else {
  say({ type: 'system', subtype: 'init', session_id: 'sess-1', skills: [] });
  say({ type: 'result', subtype: 'success', result: resumed
    ? 'Fixed it: the session cookie was not found because SameSite dropped it.'
    : 'fresh answer' });
}
`
);
chmodSync(join(dir, 'claude'), 0o755);
process.env.PATH = `${dir}:${process.env.PATH}`;
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
const { runTurn } = await import('./runTurn.mjs');

const spawned = () => (existsSync(spawns) ? readFileSync(spawns, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
const args = () => ({ prompt: 'p', system: 's', cwd: tmpdir(), streamJson: true, answerFromResult: true, profile: 'build', runtime: 'claude' });

test('a resumed answer that MENTIONS a missing session spawns once', async () => {
  rmSync(spawns, { force: true });
  process.env.FV_FAKE_MODE = 'answer';
  const inits = [];
  let fresh = 0;
  const out = await runTurnResumingOnce(runTurn, { ...args(), onInit: (i) => inits.push(i.sessionId) }, {
    resume: true,
    runtime: 'claude',
    beforeFresh: () => fresh++,
  });
  assert.equal(spawned().length, 1, 'one CLI run');
  assert.ok(spawned()[0].includes('--continue'), 'canary: it was a resume');
  assert.match(out, /session cookie was not found/);
  assert.equal(fresh, 0);
  assert.deepEqual(inits, ['sess-1'], "the caller's own onInit still runs");
});

test('a genuinely dead resume retries once, fresh', async () => {
  rmSync(spawns, { force: true });
  process.env.FV_FAKE_MODE = 'dead';
  let fresh = 0;
  const out = await runTurnResumingOnce(runTurn, args(), { resume: true, runtime: 'claude', beforeFresh: () => fresh++ });
  const runs = spawned();
  assert.equal(runs.length, 2, 'the dead resume, then one fresh run');
  assert.ok(runs[0].includes('--continue'));
  assert.ok(!runs[1].includes('--continue') && !runs[1].includes('--resume'), 'the retry is a fresh conversation');
  assert.equal(fresh, 1);
  assert.match(out, /fresh answer/);
});

test('a fresh turn is never retried, whatever it says', async () => {
  rmSync(spawns, { force: true });
  process.env.FV_FAKE_MODE = 'dead';
  await runTurnResumingOnce(runTurn, args(), { resume: false, runtime: 'claude' });
  assert.equal(spawned().length, 1);
});
