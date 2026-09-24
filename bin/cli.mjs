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
 * instance, login, mcp-cli; fleet (the roster loop) and work (session turns);
 * claude + runtimes + prompts + stream (spawning a CLI and reading its events);
 * git + worktreeDiff + patch; localSessions, listeners, preview + authproxy;
 * env (the box keypair, the uplink scrubber, the env-comparison scan) + vault
 * (the knowledge wiki, not secrets), resources, deploy, shot.
 */
import { FLEET_TOKEN, CREDENTIAL, VERSION, adoptStoredCredential } from './lib/config.mjs';
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
// `flowviant --version` prints and exits — the first thing a person runs after
// a curl install, and it must never start a daemon.
if (process.argv[2] === '--version' || process.argv[2] === '-v' || process.argv[2] === 'version') {
  console.log(VERSION);
  process.exit(0);
}

if (process.argv[2] === 'login') {
  const noStart = process.argv.includes('--no-start');
  const login = await runLogin({ thenStart: !noStart });
  // A login the person CANCELLED at the second-project question saved nothing,
  // so there is no credential for the child to serve — starting it would end
  // in "no credential found" over a choice they just made on purpose.
  if (!login?.saved) process.exit(1); // refused: the directory already serves another project
  if (noStart) process.exit(0);
  // Re-exec as a plain `flowviant` rather than falling through. config.mjs reads
  // the credential at IMPORT time — which was before the login we just did — so
  // this process still has an empty FLEET_TOKEN and would exit with "no
  // credential found" seconds after saving one. Same shape as the self-update
  // re-exec: stay alive as a thin proxy so the user's shell keeps one foreground
  // process.
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, process.argv[1]?.startsWith('/$bunfs/') ? [] : [process.argv[1]], {
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
  await runUpdateCommand();
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
    // THE DATE RIDES THE ID, always — this listing exists for the moment
    // somebody is asking "why did it say skadooble?", and "which of these two
    // did I set up last month" is the same question one step on. Absent when
    // nothing recorded one (a credential stored before the field existed);
    // nothing is invented.
    const savedOn = e.savedAt ? new Date(e.savedAt) : null;
    const connected =
      savedOn && !Number.isNaN(savedOn.getTime())
        ? `, connected ${savedOn.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
        : '';
    console.log(
      `  ${projectLabel(e)}  (${e.projectId.slice(0, 8)}…${connected})` +
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

// ── `flowviant machines` — every project connected on THIS box, and every box
//    that has polled each of them; and, on a terminal, a menu over them.
//
// A THIRD COMMAND, and the owner's ruling it amends is his own: the terminal
// surface is `npx flowviant` and `npx flowviant login`, full stop — which is
// what deleted the old terminal flag for moving a machine — and he asked for
// this one directly ("the CLI gets a command to list connections"). It shipped
// VIEW-ONLY, and on 2026-09-23 he asked for the rest: "it seems to be only a
// read cmd but I want to be able to interact with it and use arrow keys to
// select the machines or to remove them." So: the listing, then — only where a
// person can drive one — a menu. Its verbs act on THIS BOX'S OWN CONNECTIONS
// (stop the daemon here, leave the project's list in the app, forget the
// credential here) and never on another computer's daemon; machines.mjs
// carries the argument.
//
// The question is the owner's, verbatim: "is there a way to view ALL the
// connected flowviants? because im not sure if i have any duplicate or
// redundant daemons running". It needs the NETWORK, unlike `projects` next
// door, because the boxes are the server's answer — this box cannot see a
// daemon running on somebody else's computer, and guessing would be worse than
// asking.
//
// ONE CALL PER STORED CREDENTIAL, because the CLI has NO PERSON IDENTITY: every
// request it can make is `Bearer <machine token>`, so "all my machines" has to
// be assembled from the credentials this box holds. That is also the limit the
// footer states out loud — the app's Home is where the whole account's answer
// lives.
//
// EXIT 0 whatever it finds, including nothing: the listing is the answer the
// asker came for, and a non-zero code over "you have no projects connected"
// would make this command unusable in anything that checks one. `--remove`
// is the one exit that can be 1, when the daemon it had to stop would not.
if (process.argv[2] === 'machines') {
  const creds = await import('./lib/credentials.mjs');
  const forgetAt = process.argv.indexOf('--forget');
  if (forgetAt >= 0) {
    // THE LOCAL-ONLY WRITE. Named explicitly, matched by full id or a ≥6
    // prefix, and AMBIGUITY REFUSES rather than guessing — this deletes a
    // credential, and two projects that look alike is the case that produced
    // the command.
    const res = creds.forgetStoredProject(process.argv[forgetAt + 1]);
    if (res.error) {
      console.error(`error: ${res.error}`);
      process.exit(1);
    }
    console.log(
      `forgot ${creds.projectLabel(res.entry)} (${res.entry.projectId.slice(0, 8)}…) on this box.\n` +
        '  Nothing was stopped or deleted anywhere else — `flowviant login` connects it again.'
    );
    process.exit(0);
  }
  const { boxesUrlFrom, leaveUrlFrom, fetchBoxesFor, renderMachines, disconnectHere, realDisconnectDeps, MACHINES_FOOTER, MACHINES_FLAGS_FOOTER } =
    await import('./lib/machines.mjs');
  const { FLEET_URL } = await import('./lib/config.mjs');
  const removeAt = process.argv.indexOf('--remove');
  if (removeAt >= 0) {
    // THE SCRIPTED DISCONNECT — the menu's first verb, named by id for a
    // terminal nobody is sitting at. Same matcher and the same refusal of an
    // ambiguous prefix as --forget: a name two projects share is exactly the
    // input this command exists to untangle, and it must not pick one.
    const m = creds.matchStoredProject(process.argv[removeAt + 1]);
    if (m.error) {
      console.error(`error: ${m.error}. \`flowviant machines\` lists what is stored.`);
      process.exit(1);
    }
    const res = await disconnectHere(m.entry, await realDisconnectDeps({ url: leaveUrlFrom(FLEET_URL) }));
    process.exit(res.ok ? 0 : 1);
  }

  let entries = creds.listStoredProjects();
  if (entries.length === 0) {
    console.log('no projects connected on this machine yet — run `flowviant login` inside a repo.');
    process.exit(0);
  }
  // OUR OWN BOX ID, so the listing can mark "← this box".
  //
  // READ, NEVER CREATED. This called `ensureKeypair()` until 2026-09-19, which
  // MINTS a keypair when there is no file — a 0600 write establishing this
  // machine's durable identity, performed by a command whose entire job is to
  // print a list. A view-only command is what let a third terminal command
  // exist at all, and enrolling a box as a side effect of looking at one is not
  // that. `readStoredPubB64` reads or answers null.
  //
  // NULL COSTS ONLY THE MARK, and that is the honest outcome: a box that has
  // never run a daemon has never polled, so it is not in this listing to be
  // marked in the first place.
  let me;
  try {
    const env = await import('./lib/env.mjs');
    me = env.readStoredPubB64() ?? undefined;
  } catch {
    /* unreadable keypair — nothing is marked, and nothing is claimed */
  }
  const url = boxesUrlFrom(FLEET_URL);
  const listing = async () => {
    const results = {};
    // SEQUENTIAL, not a fan-out: this is a handful of credentials on somebody's
    // laptop, and a parallel burst against the API buys nothing a person
    // waiting two seconds can perceive.
    for (const e of entries) {
      results[e.projectId] = await fetchBoxesFor(e, { url, envpub: me });
    }
    console.log('');
    for (const line of renderMachines(entries, results)) console.log(line);
    console.log('');
  };
  await listing();

  // THE MENU, only where a person can drive one. `canPrompt()` is the same
  // gate the start path keeps — a backgrounded job or a pipe gets the listing
  // and the flags, never a prompt that stops the process — and `menuSupported`
  // is whether ↑/↓ can be read at all. Without both this is the command it was.
  const { canPrompt, menuSupported, selectMenu, askWithTimeout } = await import('./lib/tty.mjs');
  if (!(canPrompt() && menuSupported())) {
    for (const line of MACHINES_FOOTER) console.log(line);
    for (const line of MACHINES_FLAGS_FOOTER) console.log(line);
    process.exit(0);
  }
  const deps = await realDisconnectDeps({ url: leaveUrlFrom(FLEET_URL) });
  for (;;) {
    // A ROW PER PROJECT connected on this box — the things this box can act on.
    // The other computers under each project are printed above for the
    // duplicate to be visible, and are not rows here: stopping or removing
    // THEM is the app's verb, and a menu row that answers "not from here" is
    // a control wired to a refusal.
    console.log('  projects connected on this box — enter one for what you can do about it:');
    const rowLabel = (e) => creds.projectRowLabel(e, entries) + (e.repoRoot ? `  — ${e.repoRoot}` : '  — not tied to a repo');
    const pick = await selectMenu({ options: [...entries.map(rowLabel), 'done'] });
    if (pick.cancelled || pick.unsupported || pick.index === entries.length) break;
    const picked = entries[pick.index];
    const who = creds.projectRowLabel(picked, entries);
    // TWO VERBS, each row saying its whole consequence — the app's ⋯ menu on a
    // machine row says the same two things, and a menu whose rows are verbs
    // with the outcome in a manual somewhere is one you have to be sure about
    // before you can use it.
    const action = await selectMenu({
      options: [
        `disconnect this box from ${who} — stops its daemon here, removes this box from its machines list in the app, forgets its credential here`,
        `forget ${who} here only — nothing is stopped; the app keeps listing this box until it goes quiet`,
        'back',
      ],
    });
    if (action.cancelled || action.unsupported || action.index === 2) continue;
    // ONE CONFIRM, in words, because both verbs delete a credential and the
    // arrow keys make a slip cheap. A read that failed (stdin gone) is "no".
    const verb = action.index === 0 ? 'Disconnect this box from' : 'Forget';
    const answer = await askWithTimeout(`  ${verb} ${who}? [y/N] `);
    if (!/^y(es)?$/i.test(answer ?? '')) {
      console.log('  left as it was.\n');
      continue;
    }
    if (action.index === 0) {
      await disconnectHere(picked, deps, { log: (m) => console.log(`  ${m}`) });
    } else {
      const res = creds.forgetStoredProject(picked.projectId);
      console.log(
        res.error
          ? `  ${res.error}`
          : `  forgot ${creds.projectLabel(res.entry)} (${res.entry.projectId.slice(0, 8)}…) on this box. Nothing was stopped or deleted anywhere else — \`flowviant login\` connects it again.`
      );
    }
    entries = creds.listStoredProjects();
    if (entries.length === 0) {
      console.log('\n  no projects are connected on this box now.\n');
      break;
    }
    // THE LISTING AGAIN, re-asked: the server's rows are the only true account
    // of what the leave did, and a menu redrawn over a stale listing would be
    // this command asserting the outcome it hoped for.
    await listing();
  }
  for (const line of MACHINES_FOOTER) console.log(line);
  process.exit(0);
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
if (process.argv[2] === 'mcp') {
  const { runMcpCommand } = await import('./lib/mcp-cli.mjs');
  await runMcpCommand(process.argv.slice(3));
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
// `canPrompt()`, not a bare isTTY pair: a BACKGROUNDED job (`flowviant &`) has
// two TTYs and cannot be asked anything — the first read raises SIGTTIN and the
// kernel STOPS the process, which is why 0.55.2's timeout did not save it (a
// stopped process runs no timers). See tty.mjs.
const { canPrompt, askWithTimeout, selectMenu, menuSupported } = await import('./lib/tty.mjs');
const interactive = canPrompt() && process.env.FLOWVIANT_REEXEC !== '1';

/** NO ANSWER TIME LIMIT on the start path (2026-09-20, the owner: "why is
 *  there an answer time limit, remove that"). The confirm below carried 20s
 *  and the picker 60s, each arguing that a restart nobody is watching must
 *  not sit dark on a prompt — but `interactive` already excludes exactly that
 *  case (no foreground terminal, or a self-update re-exec, and nothing is
 *  asked). What was left was a person reading a list being told "no answer
 *  in 60s — nothing started". A prompt a person can see waits for the
 *  person; tty.mjs's header carries the argument. */
const externalToken =
  process.argv.includes('--fleet') ||
  Boolean(process.env.FLOWVIANT_MACHINE_TOKEN) ||
  Boolean(process.env.FLOWVIANT_FLEET);

/** Re-exec a plain `flowviant` after an inline login — the login command's own
 *  pattern: config.mjs read the store at IMPORT time, before the credential
 *  existed, so this process cannot serve; the child can. */
async function reexecAfterLogin() {
  const login = await runLogin({ thenStart: false });
  if (!login?.saved) process.exit(1); // refused: the directory already serves another project
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, process.argv[1]?.startsWith('/$bunfs/') ? [] : [process.argv[1]], { stdio: 'inherit', env: process.env });
  process.exit(await new Promise((resolve) => child.on('exit', (code) => resolve(code ?? 0))));
}

// TWO ROWS THAT READ ALIKE ARE NOT A CHOICE. `projectRowLabel` adds the id and
// the connected date to the COLLIDING rows only — production held two projects
// both called "BRIF AI", both bound to the same checkout, so this picker
// offered two identical lines and the only way to answer was to guess. See
// credentials.mjs for why the suffix is not on every row. (That exact case is
// a refusal now rather than a picker — a directory serves one project — but
// two same-named projects can still meet in the no-match picker.)
function listLines(entries, { projectRowLabel }) {
  return entries
    .map(
      (e, i) =>
        `  ${i + 1}. ${projectRowLabel(e, entries)}` +
        (e.repoRoot ? `  — connected for ${e.repoRoot}` : '  — not tied to a repo yet')
    )
    .join('\n');
}

/** A repo binding the person just consented to, persisted by runFleetDaemon
 *  only after the instance lock is taken — never before a refusal. */
let afterLock = null;

if (!FLEET_TOKEN) {
  if (CREDENTIAL.error) {
    console.error(`error: ${CREDENTIAL.error}. \`flowviant projects\` lists what is stored.`);
    process.exit(1);
  }
  // A DIRECTORY SERVES ONE PROJECT (2026-09-23, the owner, verbatim: "a
  // directory cannot have more than one project on flowviant. if one already
  // exists, it would warn the user and ask them to delete the project on
  // flowviant first. because 2 projects shouldnt be able to edit a directory
  // at the same time."). This used to be a PICKER — two projects bound to one
  // checkout, choose which this daemon serves — which is a control offering to
  // do the forbidden thing politely. It is a refusal now, on a TTY and
  // headless alike, naming both projects and the remedy. `credentialRefusal`
  // is the same sentence login prints when it declines to bind a second one.
  if (CREDENTIAL.reason === 'multiple-bound') {
    const { directoryTakenRefusal } = await import('./lib/credentials.mjs');
    console.error(directoryTakenRefusal(CREDENTIAL.choices, CREDENTIAL.repoRoot));
    process.exit(1);
  }
  if (CREDENTIAL.choices?.length && interactive) {
    const creds = await import('./lib/credentials.mjs');
    const { originSlug } = await import('./lib/git.mjs');
    const { basename } = await import('node:path');
    const { choices, repoRoot } = CREDENTIAL;
    console.log(
      CREDENTIAL.reason === 'outside-repo'
        ? 'flowviant is not inside a git repo, and more than one project is connected here.'
        : `This repo (${repoRoot}) is not connected to any project yet. Connected on this machine:`
    );

    const loginLabel = `connect ${repoRoot ? 'this repo' : 'a repo'} to a different project (flowviant login)`;
    // WHICH ONE LOOKS RIGHT — a pre-selection, never an auto-serve. The resolver
    // refuses to serve a project the repo PATH did not name (the skadooble law);
    // this only decides which row the cursor starts on, using the repo's folder
    // name and its github repo-name against the stored project names. A unique
    // match becomes ONE keypress; a wrong guess costs nothing, because the human
    // still confirms. (Two projects bound to THIS repo never reach here: that
    // is a refusal above, since 2026-09-23.)
    const slug = repoRoot ? originSlug(repoRoot) : null;
    const likely = creds.likelyChoiceIndex(choices, {
      repoBasename: repoRoot ? basename(repoRoot) : null,
      repoSlugName: slug ? slug.split('/')[1] : null,
    });

    // Bounded like the confirm below, and for the same reason — but silence
    // means something DIFFERENT here and the difference is load-bearing. There
    // is a real ambiguity to resolve; serving a guess is the skadooble bug.
    // So no answer REFUSES, which is exactly what this branch already does
    // headless, and the message says how to answer without being present.
    let chosen = null; // 0-based into [...choices, login]
    if (menuSupported()) {
      const rowLabel = (e) =>
        creds.projectRowLabel(e, choices) +
        (e.repoRoot ? `  — connected for ${e.repoRoot}` : '  — not tied to a repo yet');
      const options = [...choices.map(rowLabel), loginLabel];
      // Say WHY the cursor starts where it does — "intuitive" made visible.
      if (likely >= 0) options[likely] += '   ← looks like this repo';
      const res = await selectMenu({
        options,
        defaultIndex: likely >= 0 ? likely : 0,
      });
      if (res.cancelled) {
        console.error('nothing chosen — nothing started.');
        process.exit(1);
      }
      if (!res.unsupported) chosen = res.index;
    }
    if (chosen === null) {
      // Numeric fallback — a pipe, or a terminal without raw mode. Empty Enter
      // takes the likely default when there is one, so it is one keystroke here
      // too.
      console.log(listLines(choices, creds));
      console.log(`  ${choices.length + 1}. ${loginLabel}`);
      const hint = likely >= 0 ? ` (enter for ${creds.projectLabel(choices[likely])})` : '';
      const raw = await askWithTimeout(
        `Which project should this daemon serve? [1-${choices.length + 1}]${hint} `
      );
      if (raw === null) {
        // The read itself failed — stdin closed, or the terminal went away
        // mid-question. Not a timeout: there is none.
        console.error(
          `\ncould not read an answer — nothing started. ` +
            `Name one with \`--project <name|id>\`, or run \`flowviant\` here in the foreground and pick.`
        );
        process.exit(1);
      }
      const n = raw === '' && likely >= 0 ? likely + 1 : Number.parseInt(raw, 10);
      chosen = Number.isInteger(n) ? n - 1 : -1;
    }

    if (chosen === choices.length) await reexecAfterLogin();
    const picked = chosen >= 0 ? choices[chosen] : undefined;
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
    // BOUND ONLY ONCE THE START HAS THE LOCK. Written here, the answer moved
    // the binding even when the instance lock then refused the start — a live
    // daemon for the same project in its own checkout — and that daemon's next
    // unattended self-update re-exec'd into a store that no longer bound its
    // repo, found no match headless, and exited with the machine dark.
    afterLock = () => creds.selectStoredProject(picked.projectId, { bindRepoRoot: repoRoot ?? undefined });
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
  //
  // AND IT TIMES OUT, because a prompt on a start path is a way for a machine
  // to go dark. `FLOWVIANT_REEXEC` above covers the restart THIS version
  // performs, but it cannot cover the one that matters most: the hop that
  // installs a fixed daemon is spawned by the OLD one, which never sets it.
  // 0.55.0 → 0.55.1 was exactly that — an auto-update landing unattended would
  // stop here with the machine serving nothing. A guard that only works once
  // everyone already has it is not a guard.
  //
  // IF THE READ FAILS WE SERVE, AND WE DO NOT BIND. (This used to say "on
  // timeout"; there is no timeout since 2026-09-20 — a person at the prompt
  // is waited for. `null` now means stdin closed under the question.) Those
  // are two decisions:
  //  · SERVE, because it is what every version before 0.55.0 did with this
  //    exact store, so the silent path is the status quo rather than a new
  //    risk — and a daemon that answers is strictly better than one that does
  //    not, which is the whole reason this product has exactly one refusal.
  //  · DO NOT BIND, because binding is the thing the question was FOR. Nobody
  //    answered, so nothing is cemented; the next human start asks again. That
  //    keeps the skadooble case fixed for the person who is actually looking,
  //    which is the only person it could ever have been fixed for.
  const creds = await import('./lib/credentials.mjs');
  const label = creds.projectLabel(CREDENTIAL.entry);
  const answered = await askWithTimeout(
    `This machine's one connected project is ${label}. Serve this repo (${CREDENTIAL.repoRoot}) as ${label}? [Y/n] `
  );
  const raw = answered === null ? null : answered.toLowerCase(); // null = the read failed
  if (raw === null) {
    console.log(
      `\n  could not read an answer — serving ${label} for this run ` +
        `without tying it to this repo. Run \`flowviant\` here and answer to make it stick.`
    );
  } else if (raw === '' || raw === 'y' || raw === 'yes') {
    // After the lock, for the reason the picker's bind gives above.
    afterLock = () => creds.bindStoredRepo(CREDENTIAL.entry.projectId, CREDENTIAL.repoRoot);
  } else {
    console.error(
      `nothing started. Connect this repo to its own project with \`flowviant login\`, ` +
        `or see what is stored with \`flowviant projects\`.`
    );
    process.exit(1);
  }
}

await runFleetDaemon({ afterLock });
