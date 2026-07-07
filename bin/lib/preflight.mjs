/**
 * Startup preflight: this tool DRIVES your local CLIs (it never sees their
 * credentials), so it checks they're present + signed in and tells you exactly
 * what's missing, rather than failing cryptically mid-run.
 */

import { execFileSync } from 'node:child_process';
import { ok, warn, info, c } from './ui.mjs';
import { addLocalBinToPath, promptYesNo, installClaude, installGh } from './install.mjs';

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

/** Prints a checklist and, when a missing prereq is auto-installable, OFFERS to
 *  install it (consent-based, never silent). Returns false only if a *fatal*
 *  prereq (claude, or git when worktrees are used) is still missing after. */
export async function preflight({ needGit = true } = {}) {
  addLocalBinToPath(); // find a gh/cloudflared we bundled on a previous run
  let claude = present('claude');
  let gh = present('gh');
  const node18 = Number(process.versions.node.split('.')[0]) >= 18;
  const git = needGit ? present('git') : true;

  info('checking your setup (this tool drives these — it never sees their logins):');

  // claude — fatal. Offer the official npm install (no-default: it's bigger and
  // account-coupled, so we don't push it).
  if (claude) {
    ok(`claude installed ${c.dim('· must be signed in — run `claude` once if you haven’t')}`);
  } else {
    warn('claude NOT found — Claude Code is required.');
    if (await promptYesNo('Install Claude Code now?', false)) {
      if (installClaude((m) => info(m))) claude = present('claude');
    }
    claude
      ? ok('claude installed — run `claude` once to sign in')
      : warn('install Claude Code manually: https://claude.com/claude-code');
  }

  // gh — needed to open PRs. Offer to fetch the isolated binary (yes-default:
  // low-risk, no login carried by the install itself).
  if (gh && ghAuthed()) {
    ok('gh authenticated');
  } else if (gh) {
    warn('gh not signed in — run: gh auth login');
  } else {
    warn('gh NOT found — needed to open PRs.');
    if (await promptYesNo('Install GitHub CLI (gh) now?', true)) {
      if (await installGh((m) => info(m))) gh = present('gh');
    }
    gh
      ? ok('gh installed to ~/.flowviant/bin — authenticate with: flowviant gh-auth')
      : warn('install gh manually: https://cli.github.com, then run: gh auth login');
  }

  if (needGit) (git ? ok('git installed') : warn('git NOT found — install git'));
  node18 ? ok(`node ${process.versions.node}`) : warn(`node ${process.versions.node} — need 18+`);
  console.log('');

  if (!claude) warn('Without `claude` nothing can run — install + sign in, then restart.');
  return claude && git;
}
