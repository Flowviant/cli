import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resumeConversationLost, RESUME_LOST_MAX_CHARS } from './work.mjs';

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
