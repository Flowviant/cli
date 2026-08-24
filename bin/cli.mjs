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
 * `flowviant stop` stops every daemon on this box — the answer to "is one even
 * running?", which otherwise ends in a pid hunt through `ps`.
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
 * MANY PROJECTS, ONE BOX (0.55.0): `flowviant login` in each repo stores one
 * credential per project (~/.flowviant/credentials.json holds a map), and a
 * bare `npx flowviant` serves the project BOUND to the repo it is started in.
 * Ambiguity is a picker on a TTY and a worded refusal headless — never a
 * guess. `flowviant projects` lists what is stored; `--project <name|id>`
 * picks without a prompt.
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
import { FLEET_TOKEN, CREDENTIAL, adoptStoredCredential } from './lib/config.mjs';
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

// `flowviant stop` — stop every flowviant daemon on this machine.
//
// THE FRICTION IT REMOVES is not knowing whether one is running. So you run
// `flowviant`, get a refusal naming a pid in a directory you do not recognise,
// and go hunting through `ps`. This asks no question and takes no argument: it
// sweeps every credential's lock file, not just the one this checkout keys to,
// because a stop command with a scope is one you have to be sure about before
// you can use it — and being unsure is the whole reason you typed it.
//
// It identifies each holder before signalling it and says so when it cannot
// (see stopAllDaemons); it needs NO credential and NO network — it reads lock
// files under ~/.flowviant and signals pids — so it runs BEFORE the auth gate,
// like `shot`. "I don't know what is running" is not a state in which we should
// also be asking someone to log in.
//
// EXIT 0 when it stopped something AND when it found nothing: "no flowviant
// daemon is running on this machine." is the answer the asker came for, not an
// error. Non-zero only when something was alive and could not be stopped.
if (process.argv[2] === 'stop') {
  const { stopAllDaemons } = await import('./lib/instance.mjs');
  const { failed } = stopAllDaemons({ log: (m) => console.log(m) });
  process.exit(failed > 0 ? 1 : 0);
}

// `flowviant projects` — every project this box has a credential for, which
// repo each is bound to, and which the legacy mirror points at. Needs no
// network: it reads the store, which is the exact thing a confused person is
// trying to see. The remedies are named because this listing IS the moment of
// confusion ("why did it say skadooble?"), not documentation.
if (process.argv[2] === 'projects') {
  const { listStoredProjects, projectLabel } = await import('./lib/credentials.mjs');
  const entries = listStoredProjects();
  if (entries.length === 0) {
    console.log('no projects connected on this machine yet — run `flowviant login` inside a repo.');
    process.exit(0);
  }
  for (const e of entries) {
    console.log(
      `  ${projectLabel(e)}  (${e.projectId.slice(0, 8)}…)` +
        `${e.repoRoot ? `\n      repo · ${e.repoRoot}` : '\n      repo · not bound yet — first start or login in its repo binds it'}` +
        `${e.active ? '\n      what a pre-0.55.0 flowviant on this box would serve (the legacy mirror)' : ''}`
    );
  }
  console.log(
    '\n  `npx flowviant` picks by the repo it is started in; `--project <name|id>` overrides;\n' +
      '  `flowviant login` in a new repo connects another project.'
  );
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

// ── WHICH PROJECT THIS START SERVES — said, asked, or refused; never guessed.
//
// The store holds many projects since 0.55.0 and resolution is BY REPO
// (credentials.mjs). What is left here is the human half: an ambiguous store
// on a TTY becomes a PICKER, a single unbound credential gets ONE confirm that
// binds it, and a headless start with no unambiguous answer refuses in words
// that name every stored project and every way out. The one thing this block
// must never do is serve a project the resolution did not name — "it said
// skadooble in my calendar repo" is the confusion this exists to end.
// A RESTART IS NOT A PERSON. `reexec` (update.mjs) inherits stdio, so an
// auto-updated daemon's child sees two TTYs; without this it would stop on the
// binding confirm below and the machine would stay dark until somebody typed a
// key. Same reasoning as the headless case, and the same answer.
const interactive =
  Boolean(process.stdin.isTTY && process.stdout.isTTY) && process.env.FLOWVIANT_REEXEC !== '1';
const externalToken = process.argv.includes('--fleet') || Boolean(process.env.FLOWVIANT_FLEET);

/** Re-exec a plain `flowviant` after an inline login — the login command's own
 *  pattern: config.mjs read the store at IMPORT time, before the credential
 *  existed, so this process cannot serve; the child can. */
async function reexecAfterLogin() {
  await runLogin({ thenStart: false });
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, [process.argv[1]], { stdio: 'inherit', env: process.env });
  process.exit(await new Promise((resolve) => child.on('exit', (code) => resolve(code ?? 0))));
}

function listLines(entries, { projectLabel }) {
  return entries
    .map(
      (e, i) =>
        `  ${i + 1}. ${projectLabel(e)}` +
        (e.repoRoot ? `  — connected for ${e.repoRoot}` : '  — not tied to a repo yet')
    )
    .join('\n');
}

if (!FLEET_TOKEN) {
  if (CREDENTIAL.error) {
    console.error(`error: ${CREDENTIAL.error}. \`flowviant projects\` lists what is stored.`);
    process.exit(1);
  }
  if (CREDENTIAL.choices?.length && interactive) {
    const creds = await import('./lib/credentials.mjs');
    const { choices, repoRoot } = CREDENTIAL;
    console.log(
      CREDENTIAL.reason === 'outside-repo'
        ? 'flowviant is not inside a git repo, and more than one project is connected here.'
        : CREDENTIAL.reason === 'multiple-bound'
          ? `More than one connected project names this repo (${repoRoot}) — pick which one this daemon serves:`
          : `This repo (${repoRoot}) is not connected to any project yet. Connected on this machine:`
    );
    console.log(listLines(choices, creds));
    console.log(`  ${choices.length + 1}. connect ${repoRoot ? 'this repo' : 'a repo'} to a different project (flowviant login)`);
    const rl = (await import('node:readline/promises')).createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    const raw = (await rl.question(`Which project should this daemon serve? [1-${choices.length + 1}] `)).trim();
    rl.close();
    const n = Number.parseInt(raw, 10);
    if (n === choices.length + 1) await reexecAfterLogin();
    const picked = Number.isInteger(n) ? choices[n - 1] : undefined;
    if (!picked) {
      console.error('nothing chosen — nothing started.');
      process.exit(1);
    }
    // An answered question is consent: adopt it, and BIND it to this repo so
    // the next start needs no prompt. Repointing is legitimate and said aloud.
    if (repoRoot && picked.repoRoot && picked.repoRoot !== repoRoot) {
      console.log(`note: ${creds.projectLabel(picked)} was connected for ${picked.repoRoot} — now serving ${repoRoot} instead.`);
    }
    adoptStoredCredential(picked);
    creds.selectStoredProject(picked.projectId, { bindRepoRoot: repoRoot ?? undefined });
    console.log(`serving ${creds.projectLabel(picked)}${repoRoot ? ` from ${repoRoot}` : ''}.`);
  } else if (CREDENTIAL.choices?.length) {
    const creds = await import('./lib/credentials.mjs');
    console.error(
      'error: more than one project is connected on this machine and this repo is not bound to any of them:\n' +
        listLines(CREDENTIAL.choices, creds) +
        '\nPick one with `--project <name|id>`, bind this repo by running `flowviant` here in a terminal once,\n' +
        'or connect this repo to its own project with `flowviant login`.'
    );
    process.exit(1);
  } else {
    console.error(
      'error: no credential found. Easiest:\n' +
        '  flowviant login      (approve in the app — recommended)\n' +
        'Or set:\n' +
        '  FLOWVIANT_FLEET=fva_…   (machine token, from the app)'
    );
    process.exit(1);
  }
} else if (!externalToken && CREDENTIAL.needsConfirm && interactive) {
  // ONE stored project, never tied to a repo — the pre-0.55.0 world. Ask once;
  // yes binds and every later start is silent. This is the exact question
  // whose absence had a calendar checkout serving skadooble.
  const creds = await import('./lib/credentials.mjs');
  const label = creds.projectLabel(CREDENTIAL.entry);
  const rl = (await import('node:readline/promises')).createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const raw = (
    await rl.question(`This machine's one connected project is ${label}. Serve this repo (${CREDENTIAL.repoRoot}) as ${label}? [Y/n] `)
  ).trim().toLowerCase();
  rl.close();
  if (raw === '' || raw === 'y' || raw === 'yes') {
    creds.bindStoredRepo(CREDENTIAL.entry.projectId, CREDENTIAL.repoRoot);
  } else {
    console.error(
      `nothing started. Connect this repo to its own project with \`flowviant login\`, ` +
        `or see what is stored with \`flowviant projects\`.`
    );
    process.exit(1);
  }
}

await runFleetDaemon();
