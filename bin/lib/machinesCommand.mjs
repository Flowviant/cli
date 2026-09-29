/**
 * `flowviant machines` — the command's whole body: the scripted verbs
 * (`--forget`, `--remove`), the listing assembled from each stored
 * credential's boxes, and, on a terminal, the ↑/↓ menu over this box's own
 * connections.
 *
 * SPLIT OUT OF cli.mjs (SOLID audit 2026-09-26, F053): the entrypoint changed
 * for terminal dispatch, for this menu, and for the start path's project
 * binding. The menu is a stateful interaction with its own confirm and its own
 * re-ask loop, so it lives here and cli.mjs keeps one line that dispatches to
 * it. Moved verbatim; the imports stay lazy, as they were, so `--forget` still
 * never loads config.mjs or reaches the network.
 *
 * The rules this body is pinned to (machines.test.mjs, tty.test.mjs): the menu
 * is gated on BOTH `canPrompt()` and `menuSupported()`, `--remove` and the
 * menu share one `disconnectHere`, the listing is re-asked after a verb, the
 * keypair is read and never minted, and no prompt carries a time budget.
 */
import { terminalCommand } from './launchCommand.mjs';

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
// credential here) and never on another computer's daemon; machineListing.mjs
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
export async function runMachinesCommand() {
  const creds = await import('./credentials.mjs');
  const machineJson = process.argv.includes('--json');
  const forgetAt = process.argv.indexOf('--forget');
  if (forgetAt >= 0) {
    if (machineJson && !process.argv.includes('--yes')) {
      process.stdout.write(`${JSON.stringify({ ok: false, error: '--yes is required with --json' })}\n`);
      process.exit(1);
    }
    // THE LOCAL-ONLY WRITE. Named explicitly, matched by full id or a ≥6
    // prefix, and AMBIGUITY REFUSES rather than guessing — this deletes a
    // credential, and two projects that look alike is the case that produced
    // the command.
    const res = creds.forgetStoredProject(process.argv[forgetAt + 1]);
    if (res.error) {
      if (machineJson) { process.stdout.write(`${JSON.stringify({ ok: false, error: res.error })}\n`); process.exit(1); }
      console.error(`error: ${res.error}`);
      process.exit(1);
    }
    if (machineJson) { process.stdout.write(`${JSON.stringify({ ok: true, action: 'forget', projectId: res.entry.projectId })}\n`); process.exit(0); }
    console.log(
      `forgot ${creds.projectLabel(res.entry)} (${res.entry.projectId.slice(0, 8)}…) on this box.\n` +
        `  Nothing was stopped or deleted anywhere else — \`${terminalCommand('login')}\` connects it again.`
    );
    process.exit(0);
  }
  const { boxesUrlFrom, leaveUrlFrom, fetchBoxesFor } = await import('./machines.mjs');
  const { renderMachines, MACHINES_FOOTER, MACHINES_FLAGS_FOOTER } = await import('./machineListing.mjs');
  const { disconnectHere, disconnectShortfall, realDisconnectDeps } = await import('./machineDisconnect.mjs');
  const { FLEET_URL } = await import('./config.mjs');
  const removeAt = process.argv.indexOf('--remove');
  if (removeAt >= 0) {
    if (machineJson && !process.argv.includes('--yes')) {
      process.stdout.write(`${JSON.stringify({ ok: false, error: '--yes is required with --json' })}\n`);
      process.exit(1);
    }
    // THE SCRIPTED DISCONNECT — the menu's first verb, named by id for a
    // terminal nobody is sitting at. Same matcher and the same refusal of an
    // ambiguous prefix as --forget: a name two projects share is exactly the
    // input this command exists to untangle, and it must not pick one.
    const m = creds.matchStoredProject(process.argv[removeAt + 1]);
    if (m.error) {
      if (machineJson) { process.stdout.write(`${JSON.stringify({ ok: false, error: m.error })}\n`); process.exit(1); }
      console.error(`error: ${m.error}. \`${terminalCommand('machines')}\` lists what is stored.`);
      process.exit(1);
    }
    const res = await disconnectHere(m.entry, await realDisconnectDeps({ url: leaveUrlFrom(FLEET_URL), log: machineJson ? () => {} : undefined }), { log: machineJson ? () => {} : undefined });
    if (machineJson) {
      // A refusal keeps its words for the caller (the tray reads stderr when
      // the exit is nonzero): a daemon finishing a deploy is said, not "failed".
      const why = res.ok ? null : (disconnectShortfall(res)?.reason ?? 'failed');
      process.stdout.write(`${JSON.stringify({ ok: res.ok, action: 'disconnect', projectId: m.entry.projectId, ...(why ? { error: why } : {}) })}\n`);
      if (why) process.stderr.write(`${why}\n`);
    }
    process.exit(res.ok ? 0 : 1);
  }

  let entries = creds.listStoredProjects();
  if (entries.length === 0) {
    console.log(`no projects connected on this machine yet — run \`${terminalCommand('login')}\` inside a repo.`);
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
    const env = await import('./boxIdentity.mjs');
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
  const { canPrompt, menuSupported, selectMenu, askWithTimeout } = await import('./tty.mjs');
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
          : `  forgot ${creds.projectLabel(res.entry)} (${res.entry.projectId.slice(0, 8)}…) on this box. Nothing was stopped or deleted anywhere else — \`${terminalCommand('login')}\` connects it again.`
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
