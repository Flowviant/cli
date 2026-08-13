/**
 * Startup preflight: this tool DRIVES your local CLIs (it never sees their
 * credentials), so it checks they're present + signed in and tells you exactly
 * what's missing, rather than failing cryptically mid-run.
 */

import { execFileSync } from 'node:child_process';
import { ok, warn, info, c } from './ui.mjs';
import { addLocalBinToPath, promptYesNo, installClaude, installGh } from './install.mjs';
import { RUNTIMES, detectRuntimes } from './runtimes.mjs';

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
 *  prereq (SOME drivable runtime, or git when worktrees are used) is still
 *  missing after. */
export async function preflight({ needGit = true } = {}) {
  addLocalBinToPath(); // find a gh/cloudflared we bundled on a previous run
  let gh = present('gh');
  const node18 = Number(process.versions.node.split('.')[0]) >= 18;
  const git = needGit ? present('git') : true;

  info('checking your setup (this tool drives these — it never sees their logins):');

  // THE RUNTIMES. This used to test one binary — `present('claude')` — and treat
  // its absence as fatal, which stopped being right the moment a second CLI could
  // build a task: a machine with Codex and no Claude Code is a working machine,
  // and it was refused at startup. What is fatal is having NOTHING to build with.
  //
  // Reported per runtime rather than as a single verdict, because the three
  // states a user can be in need three different sentences: not installed
  // (install it), installed but this daemon cannot drive it here (the live-mode
  // note, or the registry's own `blocked` reason), and ready.
  let detected = detectRuntimes({ refresh: true });
  const shown = detected.filter((r) => r.installed || r.id === 'claude');
  for (const r of shown) {
    const rt = RUNTIMES[r.id];
    if (r.dispatchable) {
      ok(
        `${rt.bin} installed ${c.dim(`· ${rt.label} · must be signed in — run \`${rt.login}\` once if you haven’t`)}`
      );
    } else if (r.installed) {
      warn(`${rt.bin} installed but not usable here ${c.dim(`· ${r.blocked ?? 'unsupported'}`)}`);
    } else if (r.id === 'claude') {
      // Only Claude gets an install offer: it is the one whose installer we
      // control and can verify. The others are named, not fetched.
      warn('claude NOT found.');
      if (await promptYesNo('Install Claude Code now?', false)) {
        if (installClaude((m) => info(m))) detected = detectRuntimes({ refresh: true });
      }
      if (!detected.find((d) => d.id === 'claude')?.installed) {
        warn('install Claude Code manually: https://claude.com/claude-code');
      }
    }
  }
  const drivable = detected.filter((r) => r.dispatchable);
  // Name the alternatives once, and only when there is nothing to build with —
  // a working machine does not need a catalogue of the CLIs it is not using.
  if (drivable.length === 0) {
    for (const rt of Object.values(RUNTIMES)) {
      if (!detected.find((d) => d.id === rt.id)?.installed) {
        info(`${c.dim(`or ${rt.label}: ${rt.install}`)}`);
      }
    }
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

  if (drivable.length === 0) {
    warn('No usable coding CLI — install and sign in to one of the above, then restart.');
  }
  return drivable.length > 0 && git;
}
