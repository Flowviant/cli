#!/usr/bin/env node
/**
 * flowviant — run your own Claude Code as headless Flowviant build agents.
 *
 * Three modes, picked by which env var is set:
 *
 *   FLOWVIANT_TOKEN=fva_…   npx flowviant        # 1 worker, current checkout
 *   FLOWVIANT_TOKENS=a,b,c  npx flowviant        # static fleet, 1 worktree each
 *   FLOWVIANT_FLEET=fft_…   npx flowviant        # FLEET DAEMON (recommended)
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
  preflight({ needGit: tokens.length > 1 });
  if (tokens.length === 1) {
    console.log(`» flowviant → ${MCP_URL}  (1 worker · token fva_…${tokens[0].slice(-4)})`);
    await runWorker({ token: tokens[0], cwd: process.cwd(), label: '' });
    return;
  }
  await runStaticFleet();
}

await main();
