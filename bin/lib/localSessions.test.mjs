/**
 * NEVER OFFER SOMEBODY THEIR OWN REFLECTION.
 *
 * The machine OPERATOR's Workbench tabs work in the checkout itself (their
 * place is `'repo'`), so their CLI transcripts land in exactly the directory
 * this scan reads for adoptable TERMINAL sessions. The `excludeDirs` fence
 * cannot help — repoRoot is the scan ROOT, not something under it — so the
 * daemon reported its own tabs as adoptable, and two harms followed:
 *
 *  · the `+` menu offered to adopt a tab you already have open, and accepting
 *    FORKS that conversation and copies the checkout's uncommitted and
 *    untracked files into a new worktree;
 *  · the ended walk keeps only the newest row per directory, and a live tab's
 *    transcript is always the freshest thing in the checkout — so a REAL
 *    terminal session started in the repo root could never be offered at all.
 *
 * The fence is therefore by conversation ID, not by directory: the directory is
 * shared with exactly the sessions we still want to offer. The ids come from
 * the markers the daemon already writes to pin each tab's conversation.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ourConversationIds, SESSION_MARKERS } from './localSessions.mjs';

const withRepo = (fn) => {
  const root = mkdtempSync(join(tmpdir(), 'fv-ls-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: root });
    fn(root, join(root, '.git'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

test('the marker names have one owner', () => {
  // `work.mjs` WRITES these and localSessions READS them; a drift is silent.
  assert.deepEqual(SESSION_MARKERS, [
    'flowviant-claude-session',
    'flowviant-codex-thread',
    'flowviant-agy-conversation',
  ]);
});

test('collects every pinned conversation in the checkout', () => {
  withRepo((root, gitDir) => {
    writeFileSync(join(gitDir, 'flowviant-claude-session-s1'), 'conv-aaa\n');
    writeFileSync(join(gitDir, 'flowviant-codex-thread-s2'), 'thread-bbb');
    writeFileSync(join(gitDir, 'flowviant-agy-conversation-s3'), 'agy-ccc\n');
    const ids = ourConversationIds(root);
    assert.ok(ids.has('conv-aaa'));
    assert.ok(ids.has('thread-bbb'));
    assert.ok(ids.has('agy-ccc'));
  });
});

test('ignores files that are not markers', () => {
  withRepo((root, gitDir) => {
    writeFileSync(join(gitDir, 'HEAD-ish'), 'not-a-conversation');
    writeFileSync(join(gitDir, 'flowviant-turn.lock'), '12345');
    writeFileSync(join(gitDir, 'flowviant-claude-session-s1'), 'conv-aaa');
    const ids = ourConversationIds(root);
    assert.deepEqual([...ids], ['conv-aaa']);
  });
});

test('an empty or unreadable marker fences nothing', () => {
  withRepo((root, gitDir) => {
    writeFileSync(join(gitDir, 'flowviant-claude-session-s1'), '   \n');
    mkdirSync(join(gitDir, 'flowviant-codex-thread-s2')); // a directory, not a file
    assert.equal(ourConversationIds(root).size, 0);
  });
});

test('a path that is not a repo yields an EMPTY fence, never a throw', () => {
  // Presence must never throw into the poll loop, and an empty fence degrades
  // to the old behaviour rather than to hiding everything.
  const dir = mkdtempSync(join(tmpdir(), 'fv-ls-norepo-'));
  try {
    assert.equal(ourConversationIds(dir).size, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
