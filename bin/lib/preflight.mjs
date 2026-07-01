/**
 * Startup preflight: this tool DRIVES your local CLIs (it never sees their
 * credentials), so it checks they're present + signed in and tells you exactly
 * what's missing, rather than failing cryptically mid-run.
 */

import { execFileSync } from 'node:child_process';
import { ok, warn, info, c } from './ui.mjs';

function present(cmd) {
  try {
    execFileSync(cmd, ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function ghAuthed() {
  try {
    execFileSync('gh', ['auth', 'status'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Prints a checklist. Returns false only if a *fatal* prereq (claude, or git
 *  when worktrees are used) is missing — callers may warn-and-continue. */
export function preflight({ needGit = true } = {}) {
  const claude = present('claude');
  const gh = present('gh');
  const node18 = Number(process.versions.node.split('.')[0]) >= 18;
  const git = needGit ? present('git') : true;

  info('checking your setup (this tool drives these — it never sees their logins):');
  claude
    ? ok(`claude installed ${c.dim('· must be signed in — run `claude` once if you haven’t')}`)
    : warn('claude NOT found — install Claude Code: https://claude.com/claude-code');
  gh && ghAuthed()
    ? ok('gh authenticated')
    : warn(gh ? 'gh not signed in — run: gh auth login' : 'gh NOT found — install it + run: gh auth login (needed to open PRs)');
  if (needGit) (git ? ok('git installed') : warn('git NOT found — install git'));
  node18 ? ok(`node ${process.versions.node}`) : warn(`node ${process.versions.node} — need 18+`);
  console.log('');

  if (!claude) warn('Without `claude` nothing can run — install + sign in, then restart.');
  return claude && git;
}
