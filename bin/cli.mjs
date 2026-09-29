#!/usr/bin/env node
/**
 * flowviant — run your own coding CLI (Claude Code, Codex, Antigravity) as the
 * machine behind a Flowviant project.
 *
 * ONE mode, one credential:
 *
 *   FLOWVIANT_MACHINE_TOKEN=fva_…   npx flowviant@latest  # the machine daemon, headless
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
 * `npx flowviant` can reuse a stale cache). A running daemon also keeps itself
 * current — at startup and when idle, never mid-turn. Since 0.58.0 that is true
 * under NPX too, by relaunching through `npx flowviant@latest`; before it, the
 * npx branch refused to install and only nagged, so npx launches — the way this
 * README tells everyone to start — silently stayed on whatever was cached
 * (FLOWVIANT_NO_UPDATE=1 makes it nag-only; `flowviant update` updates now).
 * `flowviant stop` stops every daemon on this box — the answer to "is one even
 * running?", which otherwise ends in a pid hunt through `ps`.
 *
 * The daemon: install ONCE with a machine credential, then work entirely from
 * Flowviant. It polls GET /api/fleet/agents, and the roster hands it the
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
 * picks without a prompt. `flowviant machines` (0.91.0) asks the server which
 * BOXES have polled each of those credentials — the answer to "am I running
 * duplicate or redundant daemons?", which the store alone cannot give because
 * a daemon on another computer is invisible from here; since 0.95.0 it says
 * out loud when two projects are bound to one repo, and on a terminal it is a
 * menu (↑/↓, enter) whose verbs disconnect THIS box from a project or forget
 * a credential here — `--remove <id>` / `--forget <id>` for a script. A
 * DIRECTORY SERVES ONE PROJECT: login refuses to bind a second project to a
 * repo, and a store that already holds two for one repo refuses to start
 * until one is deleted in the app or disconnected here.
 *
 * Env:
 *   FLOWVIANT_MACHINE_TOKEN  the machine credential (or use `flowviant login`);
 *                        `FLOWVIANT_FLEET` is the old name and still works.
 *   FLOWVIANT_API_URL   default https://api.flowviant.com/api
 *   FLOWVIANT_MCP_URL   default <API_URL>/mcp
 *   FLOWVIANT_FLEET_URL default <API_URL>/fleet/agents
 *   RECONCILE_SECONDS   roster poll cadence (default 10)
 *   FLOWVIANT_SAFE=1    restrict the toolset instead of running unattended.
 *
 * Requires one of `claude` / `codex` / `agy` on PATH, plus `git`; run from
 * inside the git repo you want worked. `gh` is optional.
 *
 * Implementation lives in ./lib/: config, ui, preflight, install, update,
 * instance, login, mcp-cli; startProject (which project a start serves) and
 * machinesCommand (the `machines` listing and menu); fleet (the roster loop)
 * and work (session turns);
 * claude + runtimes + prompts + stream (spawning a CLI and reading its events);
 * git + worktreeDiff + patch; localSessions (+ claudeSessions, agySessions), listeners, preview + authproxy
 * (+ previewGatePolicy, previewFramePolicy);
 * env (the box keypair, the uplink scrubber, the env-comparison scan) + vault
 * (the knowledge wiki, not secrets), resources, deploy, shot.
 */
// The tray app reads `login --json` through a pipe (wsl.exe). A line written
// just before process.exit() can be dropped there, and then all the tray knows
// is that the login ended; wait for stdout to drain before exiting.
const flushStdout = () => new Promise((resolve) => process.stdout.write('', resolve));

// `flowviant start` is the spelled-out form of a bare `flowviant`; everything
// below reads the start path from argv, so the word is simply dropped.
if (process.argv[2] === 'start' && !process.argv.slice(3).some((arg) => arg === '--help' || arg === '-h')) process.argv.splice(2, 1);

// Resolve --dir before config reads the project bound to cwd. A tray process
// starts outside the checkout; its explicit folder is the daemon's checkout.
// Which words work on the checkout is the command table's (commandSpecs.mjs,
// import-free, so it is safe to read before config.mjs loads).
const { commandUsesCheckout, findCommand } = await import('./lib/commandSpecs.mjs');
const dirAt = process.argv.indexOf('--dir');
if (dirAt >= 0 && commandUsesCheckout(process.argv[2])) {
  const dir = process.argv[dirAt + 1];
  try {
    if (!dir || dir.startsWith('--')) throw new Error('missing directory');
    process.chdir(dir);
  } catch (e) {
    if (process.argv.includes('--json') && process.argv[2] === 'login')
      process.stdout.write(`${JSON.stringify({ event: 'error', message: `Cannot use directory ${dir ?? ''}: ${e.message}` })}\n`);
    else console.error(`error: cannot use directory ${dir ?? ''}: ${e.message}`);
    await flushStdout();
    process.exit(1);
  }
}
const { CREDENTIAL, VERSION } = await import('./lib/config.mjs');
const { runFleetDaemon } = await import('./lib/fleet.mjs');
const { runLogin } = await import('./lib/login.mjs');
const { launchCommand, terminalCommand } = await import('./lib/launchCommand.mjs');

if (process.argv.includes('--remote') && !(process.argv[2] === 'status' && process.argv.includes('--json'))) {
  console.error('error: --remote requires status --json');
  process.exit(1);
}

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
// `flowviant --version` prints and exits — the first thing a person runs after
// a curl install, and it must never start a daemon.
if (findCommand(process.argv[2])?.name === 'version') {
  console.log(VERSION);
  process.exit(0);
}

// `flowviant help`, `--help`/`-h`, and `<command> --help`. Before any command
// runs, so asking about one never runs it (bin/lib/commandSpecs.mjs has the table).
{
  const asksHelp = (arg) => arg === '--help' || arg === '-h';
  const first = process.argv[2];
  if (first === 'help' || asksHelp(first) || process.argv.slice(3).some(asksHelp)) {
    const { renderCommandHelp, renderHelp, unknownCommandMessage } = await import('./lib/help.mjs');
    const topic = first === 'help' ? process.argv[3] : asksHelp(first) ? undefined : first?.startsWith('-') ? 'start' : first;
    if (!topic) { console.log(renderHelp(VERSION)); process.exit(0); }
    const cmd = findCommand(topic);
    if (!cmd) { console.error(unknownCommandMessage(topic)); process.exit(1); }
    console.log(renderCommandHelp(cmd));
    process.exit(0);
  }
}

async function loginCommand() {
  const noStart = process.argv.includes('--no-start');
  const json = process.argv.includes('--json');
  const login = await runLogin({ thenStart: !noStart, json, dir: process.cwd() });
  // A login the person CANCELLED at the second-project question saved nothing,
  // so there is no credential for the child to serve — starting it would end
  // in "no credential found" over a choice they just made on purpose.
  if (json) await flushStdout();
  if (!login?.saved) process.exit(1); // refused: the directory already serves another project
  if (noStart) process.exit(0);
  // Re-exec as a plain `flowviant` rather than falling through. config.mjs reads
  // the credential at IMPORT time — which was before the login we just did — so
  // this process still has an empty FLEET_TOKEN and would exit with "no
  // credential found" seconds after saving one. Same shape as the self-update
  // re-exec: stay alive as a thin proxy so the user's shell keeps one foreground
  // process.
  const { spawn } = await import('node:child_process');
  const startArgs = process.argv[1]?.startsWith('/$bunfs/') ? [] : [process.argv[1]];
  const child = spawn(process.execPath, [...startArgs, ...(json ? ['--json-events'] : [])], {
    stdio: 'inherit',
    env: process.env,
  });
  // AWAIT it. Registering an exit handler and falling through would run the rest
  // of this file in the parent — which has no credential — and print "no
  // credential found" over the daemon that just started in the child.
  process.exit(await new Promise((resolve) => child.on('exit', (code) => resolve(code ?? 0))));
}

// `flowviant status` — each project connected here. `--json` is the tray's
// form (and `--remote` adds the server's answer); plain is the same facts, for
// a person.
async function statusCommand() {
  if (process.argv.includes('--json')) {
    // The tray polls this every 30 s: the fixed per-user bin dirs only, no shell.
    await (await import('./lib/loginPath.mjs')).adoptLoginPathForProcess({ shell: false });
    const { desktopStatus, desktopStatusRemote } = await import('./lib/desktopContract.mjs');
    const refreshAuth = process.argv.includes('--refresh-auth');
    const status = process.argv.includes('--remote') ? await desktopStatusRemote({ refreshAuth }) : desktopStatus({ refreshAuth });
    process.stdout.write(`${JSON.stringify(status)}\n`);
    process.exit(0);
  }
  await (await import('./lib/loginPath.mjs')).adoptLoginPathForProcess();
  const { runStatus } = await import('./lib/views.mjs');
  await runStatus();
  process.exit(0);
}

// `flowviant logs [-f]` — this repo's daemon log.
async function logsCommand() {
  const { runLogs } = await import('./lib/views.mjs');
  await runLogs(process.argv);
  process.exit(0);
}

// `flowviant open` — this repo's board, in the browser.
async function openCommand() {
  const { runOpen } = await import('./lib/views.mjs');
  runOpen(process.argv);
  process.exit(0);
}

// `flowviant doctor` — what this computer needs, checked.
async function doctorCommand() {
  await (await import('./lib/loginPath.mjs')).adoptLoginPathForProcess();
  const { runDoctor } = await import('./lib/views.mjs');
  process.exit((await runDoctor()) > 0 ? 1 : 0);
}

// `flowviant update` — install the latest published version now. The daemon also
// self-updates on its own (at startup + when idle); this is the manual path.
async function updateCommand() {
  const { runUpdateCommand } = await import('./lib/update.mjs');
  await runUpdateCommand();
  process.exit(0);
}

// `flowviant gh-auth` — sign in the gh CLI (incl. a copy we bundled into
// ~/.flowviant/bin), so the isolated install doesn't need gh on your global PATH.
async function ghAuthCommand() {
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
async function cleanCommand() {
  const { rmSync, existsSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { homedir } = await import('node:os');
  const { execFileSync } = await import('node:child_process');
  // Also reap any preview dev-server/tunnel groups a crashed daemon left running.
  const { reapOrphanPreviews } = await import('./lib/previewRegistry.mjs');
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
async function shotCommand() {
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
async function stopCommand() {
  const { stopAllDaemons, stopDaemonFor } = await import('./lib/instance.mjs');
  let result;
  if (process.argv.includes('--project')) {
    const { matchStoredProject } = await import('./lib/credentials.mjs');
    const at = process.argv.indexOf('--project');
    const match = matchStoredProject(process.argv[at + 1]);
    if (match.error) { console.error(`error: ${match.error}`); process.exit(1); }
    result = stopDaemonFor(match.entry.fleetToken, { log: (m) => console.log(m) });
  } else result = stopAllDaemons({ log: (m) => console.log(m) });
  const { failed } = result;
  process.exit(failed > 0 ? 1 : 0);
}

async function uninstallCommand() {
  const { runUninstall } = await import('./lib/uninstall.mjs');
  const { askWithTimeout } = await import('./lib/tty.mjs');
  const result = await runUninstall({
    others: process.argv.includes('--others'),
    purge: process.argv.includes('--purge'),
    yes: process.argv.includes('--yes'),
    json: process.argv.includes('--json'),
    prompt: (query) => askWithTimeout(query, undefined, process.stderr),
  });
  process.exit(result.ok ? 0 : 1);
}

// `flowviant projects` — every project this box has a credential for, which
// repo each is bound to, and which the legacy mirror points at. Needs no
// network: it reads the store, which is the exact thing a confused person is
// trying to see. The remedies are named because this listing IS the moment of
// confusion ("why did it say contoso?"), not documentation.
async function projectsCommand() {
  const { listStoredProjects, projectLabel } = await import('./lib/credentials.mjs');
  const { connectedOn } = await import('./lib/credentialDate.mjs');
  const entries = listStoredProjects();
  if (entries.length === 0) {
    console.log(`no projects connected on this machine yet — run \`${terminalCommand('login')}\` inside a repo.`);
    process.exit(0);
  }
  for (const e of entries) {
    // THE DATE RIDES THE ID, always — this listing exists for the moment
    // somebody is asking "why did it say contoso?", and "which of these two
    // did I set up last month" is the same question one step on. Absent when
    // nothing recorded one (a credential stored before the field existed);
    // nothing is invented.
    const on = connectedOn(e.savedAt);
    const connected = on ? `, connected ${on}` : '';
    console.log(
      `  ${projectLabel(e)}  (${e.projectId.slice(0, 8)}…${connected})` +
        `${e.repoRoot ? `\n      repo · ${e.repoRoot}` : '\n      repo · not bound yet — first start or login in its repo binds it'}` +
        `${e.active ? '\n      what a pre-0.55.0 flowviant on this box would serve (the legacy mirror)' : ''}`
    );
  }
  console.log(
    `\n  \`${launchCommand()}\` picks by the repo it is started in; \`--project <name|id>\` overrides;\n` +
      `  \`${terminalCommand('login')}\` in a new repo connects another project.`
  );
  process.exit(0);
}

// `flowviant machines` — every project connected on THIS box, every box that
// has polled each of them, and on a terminal a menu over them. The command's
// body and its argument live in machinesCommand.mjs.
async function machinesCommand() {
  const { runMachinesCommand } = await import('./lib/machinesCommand.mjs');
  await runMachinesCommand();
}

// `flowviant env <import|set|show>` IS DELETED (2026-09-21), with the
// end-to-end-encrypted secrets vault it was the terminal half of. The owner:
// "no i dont want it. unless its needed where i want to show the env of each
// of the machines (for comparison)." So the terminal surface is back to the
// three commands it is allowed: `npx flowviant`, `npx flowviant login`, and
// the view-only `npx flowviant machines`. The comparison readout that ruling
// carves out is a daemon REPORT, not a command — see `scanEnvFiles` in env.mjs.
//
// `flowviant mcp` — connect YOUR Claude to Flowviant so you can file work from
// the terminal. Mints a `cli` credential: a separate principal from the
// per-session tokens, with only the management tools and no way to work or ship
// a card.
async function mcpCommand() {
  const { runMcpCommand } = await import('./lib/mcp-cli.mjs');
  await runMcpCommand(process.argv.slice(3));
  process.exit(0);
}

// ── DISPATCH: one handler per row of the command table (commandSpecs.mjs).
// `version` and `help` were answered above and `start` is everything below;
// help.test.mjs pins that every other row has exactly one handler here.
const HANDLERS = {
  login: loginCommand,
  status: statusCommand,
  logs: logsCommand,
  open: openCommand,
  doctor: doctorCommand,
  update: updateCommand,
  'gh-auth': ghAuthCommand,
  clean: cleanCommand,
  shot: shotCommand,
  stop: stopCommand,
  uninstall: uninstallCommand,
  projects: projectsCommand,
  machines: machinesCommand,
  mcp: mcpCommand,
};
{
  const handler = HANDLERS[findCommand(process.argv[2])?.name];
  if (handler) {
    await handler();
    // Every handler exits on its own; a command never falls through into
    // starting the daemon.
    process.exit(0);
  }
}

// A WORD THAT IS NOT A COMMAND IS REFUSED, not served. Every word used to fall
// through to here, so `flowviant hlep` started the daemon. Flags still reach
// the start path (`--project`, `--dir`, `--json-events`, …).
if (process.argv[2] && !process.argv[2].startsWith('-')) {
  const { unknownCommandMessage } = await import('./lib/help.mjs');
  console.error(unknownCommandMessage(process.argv[2]));
  process.exit(1);
}

// Find the CLIs where the person's own terminal would: the Windows tray starts
// this through `wsl.exe --`, which reads no shell startup file (loginPath.mjs).
await (await import('./lib/loginPath.mjs')).adoptLoginPathForProcess();

// WHICH PROJECT THIS START SERVES — said, asked, or refused; never guessed.
// startProject.mjs owns the picker, the one binding confirm and the refusals;
// what it hands back is the binding the person consented to, deferred until
// runFleetDaemon holds the instance lock (a refused start moves nothing).
const { resolveStartProject } = await import('./lib/startProject.mjs');
const afterLock = await resolveStartProject({ dirGiven: dirAt >= 0 });

const { installDaemonLogging } = await import('./lib/daemonLogging.mjs');
const { daemonLogPath } = await import('./lib/daemonState.mjs');
const logProjectId = CREDENTIAL?.entry?.projectId;
installDaemonLogging(logProjectId ? daemonLogPath(logProjectId) : null, { jsonEvents: process.argv.includes('--json-events') });
await runFleetDaemon({ afterLock });
