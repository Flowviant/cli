/**
 * THE START PATH'S PROJECT: which stored credential a bare `flowviant` serves
 * here, said, asked, or refused — never guessed — and the repo binding the
 * person consented to, handed back DEFERRED.
 *
 * SPLIT OUT OF cli.mjs (SOLID audit 2026-09-26, F053): the entrypoint changed
 * for terminal dispatch, for the `machines` menu, and for this policy. The
 * picker, the single-unbound confirm, every refusal and the tray folder check
 * are one decision with one reason to change, so they live here and cli.mjs
 * asks `resolveStartProject` once and passes its answer to runFleetDaemon.
 * Moved verbatim; the refusals still end the process in the same words.
 *
 * THE BINDING IS NEVER WRITTEN HERE. What this returns is `afterLock` — the
 * store write, or null — and runFleetDaemon runs it only once the instance
 * lock refused nothing (startBind.test.mjs pins the order and that this is
 * the one home of both writes).
 */
import { FLEET_TOKEN, CREDENTIAL, adoptStoredCredential } from './config.mjs';
import { runLogin } from './login.mjs';
import { terminalCommand } from './launchCommand.mjs';
import { canPrompt, askWithTimeout, selectMenu, menuSupported } from './tty.mjs';

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
// with one name, both bound to the same checkout, so this picker
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

/**
 * Resolve the project this start serves. Returns the deferred binding (or
 * null); every refusal exits the process in words, as the entrypoint did.
 * `dirGiven`: the start named its checkout with `--dir` (the tray's form).
 */
export async function resolveStartProject({ dirGiven }) {
  // ── WHICH PROJECT THIS START SERVES — said, asked, or refused; never guessed.
  //
  // The store holds many projects since 0.55.0 and resolution is BY REPO
  // (credentials.mjs). What is left here is the human half: an ambiguous store
  // on a TTY becomes a PICKER, a single unbound credential gets ONE confirm that
  // binds it, and a headless start with no unambiguous answer refuses in words
  // that name every stored project and every way out. The one thing this block
  // must never do is serve a project the resolution did not name — "it said
  // contoso in my calendar repo" is the confusion this exists to end.
  // A RESTART IS NOT A PERSON. `reexec` (update.mjs) inherits stdio, so an
  // auto-updated daemon's child sees two TTYs; without this it would stop on the
  // binding confirm below and the machine would stay dark until somebody typed a
  // key. Same reasoning as the headless case, and the same answer.
  // `canPrompt()`, not a bare isTTY pair: a BACKGROUNDED job (`flowviant &`) has
  // two TTYs and cannot be asked anything — the first read raises SIGTTIN and the
  // kernel STOPS the process, which is why 0.55.2's timeout did not save it (a
  // stopped process runs no timers). See tty.mjs.
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

  /** A repo binding the person just consented to, persisted by runFleetDaemon
   *  only after the instance lock is taken — never before a refusal. */
  let afterLock = null;

  if (!FLEET_TOKEN) {
    if (CREDENTIAL.error) {
      console.error(`error: ${CREDENTIAL.error}. \`${terminalCommand('projects')}\` lists what is stored.`);
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
      const { directoryTakenRefusal } = await import('./credentials.mjs');
      console.error(directoryTakenRefusal(CREDENTIAL.choices, CREDENTIAL.repoRoot));
      process.exit(1);
    }
    if (CREDENTIAL.choices?.length && interactive) {
      const creds = await import('./credentials.mjs');
      const { originSlug } = await import('./git.mjs');
      const { basename } = await import('node:path');
      const { choices, repoRoot } = CREDENTIAL;
      console.log(
        CREDENTIAL.reason === 'outside-repo'
          ? 'flowviant is not inside a git repo, and more than one project is connected here.'
          : `This repo (${repoRoot}) is not connected to any project yet. Connected on this machine:`
      );

      const loginLabel = `connect ${repoRoot ? 'this repo' : 'a repo'} to a different project (${terminalCommand('login')})`;
      // WHICH ONE LOOKS RIGHT — a pre-selection, never an auto-serve. The resolver
      // refuses to serve a project the repo PATH did not name (the contoso law);
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
      // is a real ambiguity to resolve; serving a guess is the contoso bug.
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
      const creds = await import('./credentials.mjs');
      console.error(
        'error: more than one project is connected on this machine and this repo is not bound to any of them:\n' +
          listLines(CREDENTIAL.choices, creds) +
          `\nPick one with \`--project <name|id>\`, bind this repo by running \`${terminalCommand()}\` here in a terminal once,\n` +
          `or connect this repo to its own project with \`${terminalCommand('login')}\`.`
      );
      process.exit(1);
    } else {
      console.error(
        'error: no credential found. Easiest:\n' +
          `  ${terminalCommand('login')}      (approve in the app — recommended)\n` +
          'Or set:\n' +
          '  FLOWVIANT_FLEET=fva_…   (machine token, from the app)'
      );
      process.exit(1);
    }
  } else if (!externalToken && CREDENTIAL.needsConfirm && interactive) {
    // ONE stored project, never tied to a repo — the pre-0.55.0 world. Ask once;
    // yes binds and every later start is silent. This is the exact question
    // whose absence had a calendar checkout serving contoso.
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
    //    keeps the contoso case fixed for the person who is actually looking,
    //    which is the only person it could ever have been fixed for.
    const creds = await import('./credentials.mjs');
    const label = creds.projectLabel(CREDENTIAL.entry);
    const answered = await askWithTimeout(
      `This machine's one connected project is ${label}. Serve this repo (${CREDENTIAL.repoRoot}) as ${label}? [Y/n] `
    );
    const raw = answered === null ? null : answered.toLowerCase(); // null = the read failed
    if (raw === null) {
      console.log(
        `\n  could not read an answer — serving ${label} for this run ` +
          `without tying it to this repo. Run \`${terminalCommand()}\` here and answer to make it stick.`
      );
    } else if (raw === '' || raw === 'y' || raw === 'yes') {
      // After the lock, for the reason the picker's bind gives above.
      afterLock = () => creds.bindStoredRepo(CREDENTIAL.entry.projectId, CREDENTIAL.repoRoot);
    } else {
      console.error(
        `nothing started. Connect this repo to its own project with \`${terminalCommand('login')}\`, ` +
          `or see what is stored with \`${terminalCommand('projects')}\`.`
      );
      process.exit(1);
    }
  }

  if (process.argv.includes('--json-events') && dirGiven && CREDENTIAL?.entry) {
    const { detectRepoRoot, listStoredProjects, boundElsewhere } = await import('./credentials.mjs');
    const repo = detectRepoRoot();
    const entry = CREDENTIAL.entry;
    if (!repo || entry.repoRoot !== repo || boundElsewhere(listStoredProjects(), repo, entry.projectId).length) {
      console.error('error: this project is not connected to this repository. Run `flowviant login` for the selected folder.');
      process.exit(1);
    }
  }

  return afterLock;
}
