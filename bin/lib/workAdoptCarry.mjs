/**
 * ADOPTION'S DIRTY CARRY — a terminal checkout's uncommitted state copied,
 * read-only, into the fresh worktree a tab adopts it into.
 *
 * Split out of work.mjs (2026-09-26, SOLID F037). It is git plumbing with a
 * promise of its own (the source is never written, a problem becomes one line
 * for the agent to say), reached once, from the session lane's adopt path.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, lstatSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { git, gitRaw, splitNul } from './git.mjs';

export function createAdoptCarry({ sessionMetaPath }) {
  /**
   * Carry a terminal checkout's DIRTY state into a fresh adopt worktree. The
   * source is strictly READ-ONLY — nothing here writes to it, because it is
   * the human's own checkout and adoption promises to leave it exactly as the
   * closed terminal did. Tracked changes travel as one binary patch staged
   * through the worktree's PRIVATE git dir (invisible to status, dies with the
   * tree); untracked files are copied one by one, skipping anything over 5MB.
   *
   * Returns '' or ONE bracketed line for the turn's prompt: a carry problem is
   * the AGENT's to explain to the user, never a reason to fail the adoption —
   * the conversation is the thing being adopted, and it resumes either way.
   */
  const carryDirtyState = (srcCwd, wt, sessionId) => {
    const problems = [];
    try {
      // A Buffer, not utf8: a `--binary` patch (and a hunk from a non-UTF-8
      // text file) must round-trip byte-exact or the apply corrupts what it
      // carries. 64MB of headroom — a dirtier tree than that fails the read
      // here and is SAID, below, rather than half-applied.
      const patch = execFileSync('git', ['diff', 'HEAD', '--binary'], {
        cwd: srcCwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 64 * 1024 * 1024,
      });
      if (patch.length) {
        const patchPath = sessionMetaPath(wt, 'flowviant-adopt.patch', sessionId);
        if (!patchPath) throw new Error('no private git dir to stage the patch in');
        try {
          writeFileSync(patchPath, patch);
          git(['apply', '--whitespace=nowarn', patchPath], wt);
        } finally {
          try {
            rmSync(patchPath, { force: true });
          } catch {
            /* best-effort — the private git dir dies with the worktree anyway */
          }
        }
      }
    } catch {
      problems.push(
        'their uncommitted TRACKED changes did not carry over (they are still in the terminal checkout, untouched)'
      );
    }
    try {
      const skipped = [];
      for (const rel of splitNul(
        gitRaw(['ls-files', '--others', '--exclude-standard', '-z'], srcCwd)
      )) {
        try {
          const from = join(srcCwd, rel);
          // lstat, not stat: a symlink is carried as itself, and its own size
          // is what the 5MB budget judges — never the file it points at.
          if (lstatSync(from).size > 5 * 1024 * 1024) {
            skipped.push(rel);
            continue;
          }
          const to = join(wt, rel);
          mkdirSync(dirname(to), { recursive: true });
          cpSync(from, to);
        } catch {
          skipped.push(rel);
        }
      }
      if (skipped.length) {
        problems.push(
          `${skipped.length} untracked file${skipped.length === 1 ? '' : 's'} did not carry (over 5MB or unreadable): ${skipped.slice(0, 5).join(', ')}${skipped.length > 5 ? ', …' : ''}`
        );
      }
    } catch {
      problems.push(
        'untracked files could not be listed in the terminal checkout, so none were carried'
      );
    }
    return problems.length
      ? `[ADOPTION NOTE from the daemon — tell the user plainly at the start of your reply: ${problems.join('; ')}.]`
      : '';
  };

  return { carryDirtyState };
}
