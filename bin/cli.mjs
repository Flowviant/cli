#!/usr/bin/env node
/**
 * flowviant — run your own Claude Code as headless Flowviant build agents.
 *
 * Three modes, picked by which env var is set:
 *
 *   FLOWVIANT_TOKEN=fva_…   npx flowviant@latest  # 1 worker, current checkout
 *   FLOWVIANT_TOKENS=a,b,c  npx flowviant@latest  # static fleet, 1 worktree each
 *   FLOWVIANT_FLEET=fft_…   npx flowviant@latest  # FLEET DAEMON (recommended)
 *
 * Launch with `@latest` so each start pulls the newest published version (bare
 * `npx flowviant` can reuse a stale cache). A running daemon also self-updates
 * on its own — at startup and when idle — so it stays current without restarts
 * (FLOWVIANT_NO_UPDATE=1 makes it nag-only; `flowviant update` updates now).
 *
 * Fleet daemon: install ONCE with a fleet credential, then manage everything
 * from Flowviant. The daemon polls GET /api/v2/fleet/agents, reconciles one
 * persistent git worktree + worker loop per roster agent, rotates each worker's
 * short-lived MCP token, and only spawns Claude when an agent has work. Add/remove
 * agents in the app — the daemon picks up the change on its next poll. Each worker
 * claims its work, resets its worktree to base per task (fresh Claude conversation),
 * opens one PR per intent, and routes questions back as blockers.
 *
 * Env:
 *   FLOWVIANT_TOKEN / FLOWVIANT_TOKENS / FLOWVIANT_FLEET  (one of) credentials.
 *   FLOWVIANT_API_URL   default https://api.flowviant.com/api/v2
 *   FLOWVIANT_MCP_URL   default <API_URL>/mcp
 *   FLOWVIANT_FLEET_URL default <API_URL>/fleet/agents
 *   POLL_SECONDS        gap between turns while waiting on a blocker (default 20)
 *   IDLE_SECONDS        gap between work checks when idle (default 30)
 *   RECONCILE_SECONDS   fleet roster poll cadence (default 10)
 *   FLOWVIANT_SAFE=1    restrict the toolset instead of running unattended.
 *
 * Requires the `claude` CLI (and `gh` for PRs) on PATH; run from inside the git
 * repo you want worked. Fleet & static-fleet modes also require `git`.
 *
 * Implementation lives in ./lib/: config, ui, claude, git, fleet, single.
 */
import { FLEET_TOKEN, tokens, SAFE, MCP_URL } from './lib/config.mjs';
import { runFleetDaemon } from './lib/fleet.mjs';
import { runWorker, runStaticFleet } from './lib/single.mjs';
import { runLogin } from './lib/login.mjs';
import { preflight } from './lib/preflight.mjs';

// `flowviant login` — device auth (recommended): approve a code in the
// app, the credential is stored locally, then plain `flowviant` just runs.
if (process.argv[2] === 'login') {
  await runLogin();
  process.exit(0);
}

// `flowviant update` — install the latest published version now. The daemon also
// self-updates on its own (at startup + when idle); this is the manual path.
if (process.argv[2] === 'update') {
  const { runUpdateCommand } = await import('./lib/update.mjs');
  runUpdateCommand();
  process.exit(0);
}

// `flowviant gh-auth` — sign in the gh CLI (incl. a copy we bundled into
// ~/.flowviant/bin), so the isolated install doesn't need gh on your global PATH.
if (process.argv[2] === 'gh-auth') {
  const { addLocalBinToPath } = await import('./lib/install.mjs');
  const { execFileSync } = await import('node:child_process');
  addLocalBinToPath();
  try {
    execFileSync('gh', ['auth', 'login'], { stdio: 'inherit' });
  } catch {
    console.error('gh not found — run `flowviant` once to install it, or see https://cli.github.com');
  }
  process.exit(0);
}

// `flowviant clean` — reclaim the persistent worktrees (~/.flowviant/worktrees).
// They're kept across runs so in-flight work survives Ctrl+C; this is the drain.
// Repos self-heal: the daemon runs `git worktree prune` if a stale registration
// blocks re-adding a path.
if (process.argv[2] === 'clean') {
  const { rmSync, existsSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { homedir } = await import('node:os');
  const { execFileSync } = await import('node:child_process');
  // Also reap any preview dev-server/tunnel groups a crashed daemon left running.
  const { reapOrphanPreviews } = await import('./lib/preview.mjs');
  reapOrphanPreviews((m) => console.log(m));
  const dir = join(homedir(), '.flowviant', 'worktrees');
  if (!existsSync(dir)) {
    console.log('nothing to clean — no worktrees at ~/.flowviant/worktrees.');
    process.exit(0);
  }
  let size = '';
  try {
    const kb = Number(execFileSync('du', ['-sk', dir], { encoding: 'utf8' }).split('\t')[0]);
    size = ` (${(kb / 1024).toFixed(0)} MB reclaimed)`;
  } catch {
    /* du unavailable — skip the size */
  }
  console.log('note: stop any running flowviant daemon first — in-flight local work is discarded.');
  rmSync(dir, { recursive: true, force: true });
  console.log(`cleaned ~/.flowviant/worktrees${size}.`);
  process.exit(0);
}

// `flowviant env <import|set|show>` — the CLI half of team env sync. Values
// are sealed to the project pubkey ON THIS MACHINE (same write-only crypto as
// the browser); `show` decrypts locally — it only works on an ENROLLED machine.
if (process.argv[2] === 'env') {
  const { runEnvCommand } = await import('./lib/env-cli.mjs');
  await runEnvCommand(process.argv.slice(3));
  process.exit(0);
}

if (!FLEET_TOKEN && tokens.length === 0) {
  console.error(
    'error: no credential found. Easiest:\n' +
      '  flowviant login      (approve in the app — recommended)\n' +
      'Or set one of:\n' +
      '  FLOWVIANT_FLEET=fva_…   (fleet token, manage agents in Flowviant)\n' +
      '  FLOWVIANT_TOKEN=fva_…   (one agent, current checkout)\n' +
      '  FLOWVIANT_TOKENS=a,b,…  (static fleet)'
  );
  process.exit(1);
}

async function main() {
  if (FLEET_TOKEN) {
    await runFleetDaemon();
    return;
  }
  console.log(
    SAFE
      ? '» safe mode: restricted toolset (unset FLOWVIANT_SAFE for full autonomy).'
      : '» unattended mode: permission prompts skipped so the agent runs hands-off.'
  );
  await preflight({ needGit: tokens.length > 1 });
  if (tokens.length === 1) {
    console.log(`» flowviant → ${MCP_URL}  (1 worker · token fva_…${tokens[0].slice(-4)})`);
    await runWorker({ token: tokens[0], cwd: process.cwd(), label: '' });
    return;
  }
  await runStaticFleet();
}

await main();
