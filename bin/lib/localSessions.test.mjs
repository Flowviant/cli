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

// ── Claude Code's own directory rule (audit 2026-09-24) ─────────────────────

import { claudeProjectDir, scanLocalSessions, titleForSession } from './localSessions.mjs';
import { realpathSync } from 'node:fs';

test("the transcript directory is Claude Code's munge, not ours", () => {
  assert.equal(claudeProjectDir('/home/w/code/flowviant'), '-home-w-code-flowviant');
  assert.equal(claudeProjectDir('/h/my_repo'), '-h-my-repo');
  assert.equal(claudeProjectDir('/Users/a/My Projects/x@y+z'), '-Users-a-My-Projects-x-y-z');
  // Past 200 characters: cut, then a base-36 hash of the ORIGINAL path — the
  // CLI's `Math.abs(javaHash(path)).toString(36)`.
  const long = `/${'a'.repeat(250)}`;
  let h = 0;
  for (let i = 0; i < long.length; i++) h = ((h << 5) - h + long.charCodeAt(i)) | 0;
  assert.equal(claudeProjectDir(long), `-${'a'.repeat(199)}-${Math.abs(h).toString(36)}`);
});

test('a repo whose path holds an underscore still offers its ended session and its title', () => {
  const home = mkdtempSync(join(tmpdir(), 'fv-ls-home-'));
  const was = process.env.HOME;
  process.env.HOME = home;
  const base = mkdtempSync(join(tmpdir(), 'fv-ls-'));
  const repo = join(base, 'my_repo');
  mkdirSync(repo);
  try {
    execFileSync('git', ['init', '-q'], { cwd: repo });
    const real = realpathSync(repo);
    const dir = join(home, '.claude', 'projects', real.replace(/[^a-zA-Z0-9]/g, '-'));
    mkdirSync(dir, { recursive: true });
    const id = 'aaaaaaaa-1111-2222-3333-444444444444';
    writeFileSync(
      join(dir, `${id}.jsonl`),
      `${JSON.stringify({ type: 'user', cwd: real, sessionId: id })}\n${JSON.stringify({ type: 'ai-title', aiTitle: 'Fix login bug' })}\n`
    );
    assert.equal(titleForSession(real, id), 'Fix login bug');
    const found = scanLocalSessions({ repoRoot: real });
    const rows = Array.isArray(found) ? found : (found?.sessions ?? []);
    assert.ok(
      rows.some((s) => s.id === id),
      `the ended session is offered: ${JSON.stringify(found)}`
    );
  } finally {
    process.env.HOME = was;
    rmSync(base, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
