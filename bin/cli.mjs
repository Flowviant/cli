#!/usr/bin/env node
/**
 * flowviant — run your own coding CLI (Claude Code, Codex, Antigravity) as the
 * machine behind a Flowviant project.
 *
 * ONE mode, one credential:
 *
 *   FLOWVIANT_FLEET=fva_…   npx flowviant@latest  # the machine daemon
 *
 * `FLOWVIANT_TOKEN` (one worker, current checkout) and `FLOWVIANT_TOKENS` (a
 * comma list, one worktree each) stood beside it until 2026-08-19. Both ran the
 * pre-daemon WORKER loop, whose first move was `claim_next_task` — a tool on the
 * `worker` MCP principal, which was deleted with dispatch and now owns nothing.
 * A worker token cannot be minted any more either, so those vars could only
 * ever hold a credential issued before that. They authenticated fine and then
 * sat against an empty tool list, which is a worse failure than not starting.
 *
 * Launch with `@latest` so each start pulls the newest published version (bare
 * `npx flowviant` can reuse a stale cache). A running daemon also self-updates
 * on its own — at startup and when idle — so it stays current without restarts
 * (FLOWVIANT_NO_UPDATE=1 makes it nag-only; `flowviant update` updates now).
 *
 * The daemon: install ONCE with a machine credential, then work entirely from
 * Flowviant. It polls GET /api/v2/fleet/agents, and the roster hands it the
 * project's SESSIONS — the Workbench's tabs. Each session gets one persistent
 * git worktree on its own `session/<id>` branch, held across turns (never reset
 * to base: the branch outlives the tab). A turn spawns the session's CLI with a
 * short-lived per-session MCP token, relays what it prints back to the tab,
 * reports the worktree's branch and diffstat when it settles, and answers the
 * odd side job the roster carries — a commit's patch, a preview share, a wiki
 * regen. When you say ship, the daemon merges that branch into base `--no-ff`.
 *
 * Env:
 *   FLOWVIANT_FLEET     the machine credential (or use `flowviant login`).
 *   FLOWVIANT_API_URL   default https://api.flowviant.com/api/v2
 *   FLOWVIANT_MCP_URL   default <API_URL>/mcp
 *   FLOWVIANT_FLEET_URL default <API_URL>/fleet/agents
 *   RECONCILE_SECONDS   roster poll cadence (default 10)
 *   FLOWVIANT_SAFE=1    restrict the toolset instead of running unattended.
 *
 * Requires one of `claude` / `codex` / `agy` on PATH, plus `git`; run from
 * inside the git repo you want worked. `gh` is optional.
 *
 * Implementation lives in ./lib/: config, ui, preflight, install, update,
 * instance, login, mcp-cli; fleet (the roster loop) and work (session turns);
 * claude + runtimes + prompts + stream (spawning a CLI and reading its events);
 * git + worktreeDiff + patch; localSessions, listeners, preview + authproxy;
 * env + env-cli + vault, resources, deploy, shot.
 */
import { FLEET_TOKEN } from './lib/config.mjs';
import { runFleetDaemon } from './lib/fleet.mjs';
import { runLogin } from './lib/login.mjs';

// `flowviant login` — device auth (recommended): approve a code in the app, the
// credential is stored locally, and then we KEEP GOING into the daemon.
//
// It used to print "Now just run: npx flowviant" and exit. Everything about that
// was technically correct and practically a dead end: the line scrolled past in
// a terminal the user had already stopped reading (they were in the browser,
// typing a code), and the app told them their machine would "come online
// shortly" — which it never did, because nothing was running. The product
// promise is install once; a second command you have to notice is not that.
//
// `--no-start` for scripts and CI, which want the credential and not a
// long-running process.
if (process.argv[2] === 'login') {
  const noStart = process.argv.includes('--no-start');
  await runLogin({ thenStart: !noStart });
  if (noStart) process.exit(0);
  // Re-exec as a plain `flowviant` rather than falling through. config.mjs reads
  // the credential at IMPORT time — which was before the login we just did — so
  // this process still has an empty FLEET_TOKEN and would exit with "no
  // credential found" seconds after saving one. Same shape as the self-update
  // re-exec: stay alive as a thin proxy so the user's shell keeps one foreground
  // process.
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, [process.argv[1]], {
    stdio: 'inherit',
    env: process.env,
  });
  // AWAIT it. Registering an exit handler and falling through would run the rest
  // of this file in the parent — which has no credential — and print "no
  // credential found" over the daemon that just started in the child.
  process.exit(await new Promise((resolve) => child.on('exit', (code) => resolve(code ?? 0))));
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

// `flowviant shot <url>` — capture a headless-browser screenshot of a running
// page. A session's agent shells out to this to SEE the change it just made.
// Self-contained + graceful (no browser → exit 1, and the agent carries on in
// text); needs no credential, so it runs before the auth gate.
if (process.argv[2] === 'shot') {
  const { runShot } = await import('./lib/shot.mjs');
  await runShot(process.argv.slice(3));
  process.exit(0);
}

// `flowviant env <import|set|show>` — the CLI half of team env sync. Values
// are sealed to the project pubkey ON THIS MACHINE (same write-only crypto as
// the browser); `show` decrypts locally — it only works on an ENROLLED machine.
// `flowviant mcp` — connect YOUR Claude to Flowviant so you can file work from
// the terminal. Mints a `cli` credential: a separate principal from the
// per-session tokens, with only the management tools and no way to work or ship
// a card.
if (process.argv[2] === 'mcp') {
  const { runMcpCommand } = await import('./lib/mcp-cli.mjs');
  await runMcpCommand(process.argv.slice(3));
  process.exit(0);
}

if (process.argv[2] === 'env') {
  const { runEnvCommand } = await import('./lib/env-cli.mjs');
  await runEnvCommand(process.argv.slice(3));
  process.exit(0);
}

if (!FLEET_TOKEN) {
  console.error(
    'error: no credential found. Easiest:\n' +
      '  flowviant login      (approve in the app — recommended)\n' +
      'Or set:\n' +
      '  FLOWVIANT_FLEET=fva_…   (machine token, from the app)'
  );
  process.exit(1);
}

await runFleetDaemon();
