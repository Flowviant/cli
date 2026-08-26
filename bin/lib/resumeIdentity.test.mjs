import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RUNTIMES } from './runtimes.mjs';

/**
 * WHAT CONVERSATION IS THIS? — the question `--continue` stopped being able to
 * answer.
 *
 * `--continue` is CWD-KEYED. That was unambiguous while one directory meant one
 * tab. The day tabs moved into their driver's project folder, every tab there
 * said `--continue` and every one resumed whichever conversation had spoken
 * most recently in that directory — so tab B inherited tab A's whole context
 * and every turn afterwards ping-ponged between them. It is the same failure
 * codex's own note warns about for `resume --last`, reaching Claude by a
 * different route.
 */

const argv = (over = {}) =>
  RUNTIMES.claude.args({
    prompt: 'hi',
    system: 'sys',
    model: 'opus',
    perm: [],
    ...over,
  });

const pairOf = (a, flag) => {
  const i = a.indexOf(flag);
  return i < 0 ? null : a[i + 1];
};

test('resumes BY ID when the tab has spoken before', () => {
  const a = argv({ resumeThreadId: 'sess-abc12345', resume: true });
  assert.equal(pairOf(a, '--resume'), 'sess-abc12345');
  // Never alongside: they are one decision answered two ways, and passing both
  // is how a tab resumes an id AND whatever the directory saw last.
  assert.ok(!a.includes('--continue'));
  // A fork would leave the original untouched and start a copy — right for
  // ADOPTION, wrong for a tab continuing its own thread.
  assert.ok(!a.includes('--fork-session'));
});

test('adoption still wins, and still forks', () => {
  const a = argv({ adoptResumeId: 'terminal-1', resumeThreadId: 'sess-abc12345', resume: true });
  assert.equal(pairOf(a, '--resume'), 'terminal-1');
  assert.ok(a.includes('--fork-session'));
  assert.ok(!a.includes('--continue'));
  assert.ok(!a.includes('sess-abc12345'));
});

test('falls back to --continue only when no id is known', () => {
  const a = argv({ resume: true });
  assert.ok(a.includes('--continue'));
  assert.ok(!a.includes('--resume'));
});

test('a fresh turn asks for nothing', () => {
  const a = argv({});
  assert.ok(!a.includes('--continue'));
  assert.ok(!a.includes('--resume'));
});

test('the id is the FIRST thing on the command line', () => {
  // Claude Code expands a slash command only at position 0 and reads flags
  // before the prompt; a resume flag after `-p` is a flag in the wrong place.
  const a = argv({ resumeThreadId: 'sess-abc12345', resume: true });
  assert.ok(a.indexOf('--resume') < a.indexOf('-p'));
});
