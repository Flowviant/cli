import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resumeConversationLost, resumeRetriesFresh, RESUME_LOST_MAX_CHARS } from './resumeLost.mjs';
import { workModuleFiles } from './workModules.test.mjs';

/**
 * A LOST CONVERSATION IS SOMETHING THE CLI SAYS, NOT SOMETHING A REPLY
 * MENTIONS. The retry this gates re-runs the whole message in a fresh,
 * context-free conversation and re-pins the tab to it, so a false positive
 * repeats every edit and commit the first run made and throws away the tab's
 * history. The false positives are ordinary web-debugging sentences.
 */
const REPLIES = [
  'Fixed the login bug: the session cookie was not found because SameSite=Strict dropped it on the redirect. Added a test.',
  'the thread id was not found in the DB, so I added a migration',
  'a request whose session is not found redirects to /login',
];

test('a successful Claude reply that mentions a missing session is never read as a lost conversation', () => {
  for (const r of REPLIES) {
    // Claude reached a conversation — its init event was seen.
    assert.equal(resumeConversationLost(r, { runtime: 'claude', sawInit: true }), false, r);
  }
});

test("Claude's own dead-resume error, with no init event, is a lost conversation", () => {
  const err = 'No conversation found with session ID: 0f3c2a1b-aaaa-bbbb-cccc-1234567890ab';
  assert.equal(resumeConversationLost(err, { runtime: 'claude', sawInit: false }), true);
  // The same words after an init event are not: the CLI found a conversation.
  assert.equal(resumeConversationLost(err, { runtime: 'claude', sawInit: true }), false);
});

test('codex and agy: the phrase must BE the reply, never a paragraph that contains it', () => {
  assert.equal(resumeConversationLost('thread 0199abc not found', { runtime: 'codex' }), true);
  assert.equal(resumeConversationLost('trajectory not found', { runtime: 'antigravity' }), true);
  const long = `${REPLIES[0]} ${'More detail about the fix. '.repeat(20)}`;
  assert.ok(long.length > RESUME_LOST_MAX_CHARS);
  assert.equal(resumeConversationLost(long, { runtime: 'codex' }), false);
});

test('empty text and ordinary answers are not lost conversations', () => {
  assert.equal(resumeConversationLost('', { runtime: 'claude' }), false);
  assert.equal(resumeConversationLost('Rate limit reached', { runtime: 'claude' }), false);
  assert.equal(resumeConversationLost('All done.', { runtime: 'codex' }), false);
});

test('a Claude caller that measured no init event never reads the phrase as a lost conversation', () => {
  const err = 'No conversation found with session ID: 0f3c2a1b-aaaa-bbbb-cccc-1234567890ab';
  // The agent lane's old call: no evidence at all. Unmeasured authorises nothing.
  assert.equal(resumeConversationLost(err, { runtime: 'claude' }), false);
  assert.equal(resumeConversationLost(err), false);
});

test('a resumed agent turn whose successful answer mentions a missing session spawns once', () => {
  // The CLI reached a conversation (init seen) and answered; the reply talks
  // about a session cookie that was not found. No second run.
  for (const out of REPLIES) {
    assert.equal(resumeRetriesFresh({ resume: true, out, runtime: 'claude', sawInit: true }), false, out);
  }
});

test('a genuinely dead resume retries once fresh; an empty resume too; a fresh turn never', () => {
  const err = 'No conversation found with session ID: 0f3c2a1b-aaaa-bbbb-cccc-1234567890ab';
  assert.equal(resumeRetriesFresh({ resume: true, out: err, runtime: 'claude', sawInit: false }), true);
  assert.equal(resumeRetriesFresh({ resume: true, out: '  ', runtime: 'claude', sawInit: true }), true);
  assert.equal(resumeRetriesFresh({ resume: true, out: 'thread 0199abc not found', runtime: 'codex' }), true);
  assert.equal(resumeRetriesFresh({ resume: false, out: err, runtime: 'claude', sawInit: false }), false);
  assert.equal(resumeRetriesFresh({ resume: false, out: '', runtime: 'claude', sawInit: false }), false);
});

/** CODE ONLY — comments quote the shapes they replaced. */
const code = (file) =>
  readFileSync(new URL(`./${file}`, import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .join('\n');

test('the resume-lost rule has one home and both lanes pass it their init evidence', () => {
  const home = code('resumeLost.mjs');
  assert.ok(home.includes('export const resumeConversationLost'));
  assert.ok(home.includes('export const resumeRetriesFresh'));
  // Every work lane by walk (workSessionRuntime.mjs holds the resume ids; the
  // agent turn's run is workAgentTurnExecution.mjs since SOLID F036), plus the
  // non-work spawners by name (claude.mjs's stream and turn modules since
  // SOLID F046).
  const files = [...workModuleFiles(), 'claude.mjs', 'claudePosture.mjs', 'claudeStream.mjs', 'runTurn.mjs', 'runtimes.mjs', 'runtimeClaude.mjs', 'runtimeCodex.mjs', 'runtimeAntigravity.mjs', 'runtimeEvents.mjs', 'runtimeDetection.mjs', 'runtimeCapabilities.mjs'];
  assert.ok(files.includes('workSessionRuntime.mjs') && files.includes('workRetire.mjs'), 'canary: the walk reaches the lanes');
  assert.ok(files.includes('workAgentTurnExecution.mjs'), 'canary: the walk reaches the agent turn\'s run');
  for (const file of files) {
    const src = code(file);
    assert.ok(!/RESUME_LOST\s*=/.test(src), `${file} holds a second copy of the phrases`);
    assert.ok(!/resumeConversationLost\(/.test(src), `${file} classifies without the retry rule's evidence`);
  }
  assert.ok(code('workSessionTurns.mjs').includes('resumeRetriesFresh({ resume, out, runtime: rt.id, sawInit: Boolean(seenClaudeSession) })'));
  // The agent turn's run (split out of workAgentTurns.mjs by SOLID F036).
  const turns = code('workAgentTurnExecution.mjs');
  // The agent lane measures its evidence through the one sequence, never a
  // flag of its own (resumeLostSpawn.test.mjs proves the sequence spawned).
  assert.ok(turns.includes('out = await runTurnResumingOnce(runTurn, agentTurnArgs, {'));
  assert.ok(!/sawInit/.test(turns), 'the agent lane keeps no init flag of its own');
  assert.ok(!/resumeRetriesFresh\(/.test(turns), 'the agent lane asks the rule only through the sequence');
  assert.ok(home.includes('export async function runTurnResumingOnce'));
});
