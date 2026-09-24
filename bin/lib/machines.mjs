/**
 * `npx flowviant machines` — every project connected on THIS box, and every box
 * that has polled each of them (0.91.0).
 *
 * ── WHY A THIRD COMMAND EXISTS AT ALL ──
 *
 * The terminal surface is `npx flowviant` and `npx flowviant login`, full stop.
 * That is the owner's own ruling and it is what deleted the terminal flag that
 * used to move a project's machine. This amends it BY HIS OWN REQUEST — "the CLI gets a command to list connections" —
 * and it shipped in the narrowest way the ruling could survive: VIEW-ONLY,
 * starting nothing, stopping nothing, moving nothing, the one write behind an
 * explicit `--forget`.
 *
 * ── AND IT GREW VERBS, ON HIS SECOND REQUEST (2026-09-23, 0.95.0) ──
 *
 * Verbatim: *"when i run npx flowviant machines, it just exits out of cli, it
 * seems to be only a read cmd but I want to be able to interact with it and
 * use arrow keys to select the machines or to remove them"* — and, of the
 * duplicate it showed him, *"there should be a cli to remove it as well as a
 * ui on flowviant to remove it."* So on a terminal that can draw a menu the
 * listing is followed by one: ↑/↓ over the projects connected on THIS box,
 * enter for a project's two verbs, esc to leave. Piped, or on a terminal with
 * no raw mode, it is exactly the listing it was, and `--remove <id>` /
 * `--forget <id>` are the same two verbs for a script.
 *
 * THE VERBS ACT ON THIS BOX'S OWN CONNECTIONS AND NOTHING ELSE. "Disconnect"
 * stops the daemon serving that project HERE (one credential's lock, never a
 * sweep), tells the app this box has left that project's machines list, and
 * forgets the credential here — three things this box is entitled to do about
 * itself. It does not stop, remove or move a daemon on another computer: those
 * rows are printed under each project so the duplicate is visible, and the
 * footer still says where THOSE verbs live. Decisions about other machines
 * stay in the app, which is the ruling this amends and not the one it breaks.
 *
 * The question it answers is the owner's, verbatim: "is there a way to view ALL
 * the connected flowviants? because im not sure if i have any duplicate or
 * redundant daemons running". Measured the day it was asked: four live daemons
 * across two boxes, two credentials last heard three days ago, and two projects
 * both named "BRIF AI" bound to the same checkout — which is why `npx
 * flowviant` there offered two identical picker rows. THE PROJECT ID IS
 * THEREFORE ALWAYS PRINTED: it is the only thing that tells those two apart,
 * and the whole listing is worth less without it. **And since 0.95.0 the
 * collision is SAID, not left to be noticed**: the id told him the rows were
 * different projects, and he still read them as one project connected twice
 * ("BRIF AI appears twice meaning I likely have 2 daemon or 'machine
 * profiles' on my machine for the same BRIF AI project"). `renderCollisions`
 * prints one line per repo that two projects are bound to, naming both.
 *
 * ── IT IS A RELAY ──
 *
 * The role words are the SERVER'S — `serving` and `inactive` today — computed in
 * one place so this command, project settings and the account's Home block
 * cannot disagree about what a box is doing. They are PRINTED AS SENT: there is
 * no mapping table here and no default word, because either is this command
 * having an opinion about a state it did not measure. Nothing here re-derives a
 * state, and a project the server could not answer for says so rather than
 * rendering as empty.
 *
 * ── RENDERING IS PURE, FETCHING IS NOT ──
 *
 * `renderMachines` takes the entries and the results and returns lines, so
 * every case that matters — rejected, unreachable, an older server, no boxes,
 * behind, this box — is provable without a network, a credential or a daemon.
 * The wiring above it is the thin part on purpose.
 *
 * It deliberately imports NOTHING from fleet.mjs: that module pulls the whole
 * daemon (the CLIs, the worktree machinery, the preview tunnels) and this
 * command runs before the auth gate, like `stop` and `projects`. The small
 * duration formatter below is a second copy of a ten-line function, knowingly,
 * and it says different words anyway — "heard 12s ago" against "last heard 3d
 * ago", where the word LAST is the staleness mark.
 */

import { USER_AGENT } from './config.mjs';
import { projectLabel, repoCollisions, safeName } from './credentials.mjs';
import { credentialRejected } from './authReject.mjs';

/** The boxes read, derived from the roster URL the way the diffstat post is —
 *  one place configures the API base and everything else is a suffix swap. */
export function boxesUrlFrom(fleetUrl) {
  return String(fleetUrl).replace(/\/agents\/?$/, '/boxes');
}

/** Where this box tells the server it has left a project — the boxes read's
 *  own path with a verb on the end, so a server that has the read and not the
 *  verb answers 404 and the caller says "older server" rather than guessing. */
export function leaveUrlFrom(fleetUrl) {
  return `${boxesUrlFrom(fleetUrl)}/leave`;
}

/** The one answer `agoFrom` gives that is a PHRASE rather than a duration, so
 *  it is the one answer that must not take an " ago" after it. Named because
 *  two callers have to agree about it and a bare string literal is how they
 *  stopped agreeing. */
const JUST_NOW = 'just now';

/**
 * A coarse age. Never "0s": a box heard a moment ago reads as "just now",
 * because a daemon that polled four hundred milliseconds ago has not been
 * silent for no time at all — the same rule `agoLabel` keeps in fleet.mjs and
 * `elapsed` keeps in the web.
 *
 * NULL for anything unmeasurable, so the caller DROPS the clause rather than
 * printing a duration nobody took.
 */
export function agoFrom(iso, now = Date.now()) {
  const t = Date.parse(iso ?? '');
  if (Number.isNaN(t)) return null;
  const ms = Math.max(0, now - t);
  const s = Math.round(ms / 1000);
  if (s < 5) return JUST_NOW;
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

/**
 * WHEN THIS BOX WAS LAST HEARD FROM, as a whole phrase — and the phrase is one
 * function because the two callers got it WRONG THE SAME WAY (2026-09-19, the
 * review).
 *
 * `agoFrom` answers with a DURATION for everything except the newest case,
 * where it answers with the words "just now" — and both callers appended
 * " ago", so the most common row in the listing, a daemon that polled four
 * hundred milliseconds ago, read "heard just now ago". On the serving box. On
 * the first line anybody looks at.
 *
 * Stated once here rather than fixed twice: a duration takes the suffix, a
 * phrase does not, and "LAST heard" is the staleness mark the whole listing
 * turns on. An unmeasurable stamp says "never heard" rather than printing a
 * duration nobody took.
 */
export function heardPhrase(box, now = Date.now()) {
  const ago = agoFrom(box?.lastHeardAt, now);
  if (!ago) return 'never heard';
  const lead = box?.fresh ? 'heard' : 'last heard';
  return ago === JUST_NOW ? `${lead} ${ago}` : `${lead} ${ago} ago`;
}

/** `savedAt` as a date somebody can match against their own memory of setting
 *  it up. Absent stays absent — a credential stored before the field existed
 *  has no date, and inventing one would be the listing asserting a day. */
export function connectedOn(iso) {
  const t = Date.parse(iso ?? '');
  if (Number.isNaN(t)) return null;
  return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/**
 * THE SERVER'S OWN ROLE WORD, PRINTED. A pure relay and nothing else.
 *
 * It carried one special case until 2026-09-21: `'standing-by'` was respelled
 * as `standing by`, because the server sent a hyphenated enum value and a
 * terminal should not print an identifier. The owner replaced that word —
 * asked whether a box should keep saying "standing by", he answered *"no, it
 * can [be] inactive instead"* — so the server sends `serving` and `inactive`,
 * both of which are already words, and the special case had nothing left to
 * translate.
 *
 * IT IS NOT KEPT "IN CASE": a mapping table in a relay is a place for the two
 * ends to disagree, and a stale entry would print one thing while the app
 * printed another about the same box — which is precisely the confusion this
 * command exists to end. A role this build has never heard of passes through
 * untouched for the same reason.
 *
 * An ABSENT role prints nothing rather than a guess. It used to default to
 * `idle`, which is a CLAIM — "the server told us this box is doing nothing" —
 * about an answer the server did not give.
 */
function roleWord(role) {
  return typeof role === 'string' && role.trim() ? role.trim() : '';
}

/** One box, as a line under its project. The MARK is the only derived thing on
 *  it — a filled dot for a box the server still calls fresh, hollow for one it
 *  does not — and the words beside it are all the server's or the box's own. */
export function renderBox(box, { me = null, latest = null } = {}, now = Date.now()) {
  const mark = box.fresh ? '●' : '○';
  // SCRUBBED HERE TOO (2026-09-24, the audit) — a belt against the server's
  // own display scrub, in defence of a stale stored row or a server this
  // fix has not reached: the terminal is where an escape sequence in a
  // box's name or its checkout path actually does harm, so this is the one
  // place it must never be trusted to have already been cleaned. See
  // printable.mjs.
  const name = safeName(box.boxName) ?? 'an unnamed machine';
  // "LAST heard" is the staleness mark, and the row is never hidden for it —
  // the owner's answer to "what about a box that stopped" was exactly this.
  const heard = heardPhrase(box, now);
  // An unreported role DROPS ITS CELL. Every other cell on this row states its
  // own absence ("(checkout not reported)") because a reader who cannot see a
  // path needs to know nobody measured one; a role is different — the row is
  // already carrying the mark, the version and the last-heard, and a
  // placeholder there would be four words of nothing in the widest column.
  const cells = [
    `${mark} ${name}`,
    roleWord(box.role),
    safeName(box.checkoutPath) ?? '(checkout not reported)',
    box.daemonVersion ? `v${box.daemonVersion}` : 'version not reported',
    heard,
  ].filter(Boolean);
  let line = `    ${cells.join('   ')}`;
  if (me && box.boxId === me) line += '   ← this box';
  // Said only when the server said it, and it names the version that is
  // actually published rather than a feature floor — a floor may sit above
  // LATEST on purpose, and an instruction to install something npm does not
  // serve is worse than silence.
  if (box.behind && latest) line += `   · behind, ${latest} is latest`;
  return line;
}

/**
 * THE WHOLE LISTING, as lines. Pure over (entries, results, now).
 *
 * `results` is keyed by projectId and each value is one of:
 *   { boxes, latest, me }   the server answered
 *   { rejected: true }      401/403 — the credential is dead here
 *   { unsupported: true }   404 — an older server with no boxes route
 *   { error: '<words>' }    anything else, relayed rather than summarised
 * A project with no entry in `results` is treated as unreachable, because that
 * is the only thing an absent answer can honestly mean.
 */
export function renderMachines(entries, results, { now = Date.now() } = {}) {
  const lines = [];
  // WHICH LABELS COLLIDE. Two projects genuinely called the same thing is the
  // case that produced this command, so the id carries it — and it is printed
  // on EVERY row rather than only the colliding ones, because a reader who has
  // to notice a suffix to know whether it matters has already been asked to do
  // the work this listing is for.
  for (const e of entries) {
    const label = projectLabel(e);
    const connected = connectedOn(e.savedAt);
    const id = `(id ${e.projectId.slice(0, 8)}…${connected ? `, connected ${connected}` : ''})`;
    lines.push(
      `  ${label}  ·  ${e.repoRoot || 'not bound to a repo yet'}   ${id}`
    );
    const r = results?.[e.projectId];
    if (!r || r.error) {
      // The failure is RELAYED, not summarised, and the loop carries on: one
      // unreachable project must not cost you the listing for the others.
      lines.push(`    could not ask the server — ${r?.error ?? 'no answer'}`);
      continue;
    }
    if (r.rejected) {
      lines.push(
        '    credential rejected — this project was disconnected or deleted. ' +
          `\`flowviant machines --forget ${e.projectId.slice(0, 8)}\` removes it here.`
      );
      continue;
    }
    if (r.unsupported) {
      lines.push('    server does not report machines yet');
      continue;
    }
    const boxes = Array.isArray(r.boxes) ? r.boxes : [];
    if (boxes.length === 0) {
      // NOT "no machines". Nothing has polled this credential, which is a
      // different fact from a project whose machines have all gone quiet — and
      // a quiet one still has rows, wearing its last-heard.
      lines.push('    (no machine has polled this project)');
      continue;
    }
    for (const b of boxes) lines.push(renderBox(b, { me: r.me, latest: r.latest }, now));
  }
  const collisions = renderCollisions(entries);
  if (collisions.length) lines.push('', ...collisions);
  return lines;
}

/** A project as ONE phrase for a sentence that names two of them — the name,
 *  the id, and the connected date, which is the fact a person can match
 *  against their own memory ("I set that one up last month"). */
export function projectPhrase(e) {
  const connected = connectedOn(e?.savedAt);
  return `${projectLabel(e)} (${String(e?.projectId ?? '').slice(0, 8)}…${connected ? `, connected ${connected}` : ''})`;
}

/**
 * TWO PROJECTS ON ONE REPO, SAID OUT LOUD (2026-09-23).
 *
 * The owner ran this command, saw "BRIF AI" twice, and concluded he had two
 * daemons for one project. The id on each row said they were different
 * projects; nothing said they were bound to the SAME checkout, which is the
 * fact that makes it a duplicate rather than two rows. So the listing ends
 * with one line per such repo, naming every project on it in full, the rule
 * (a directory serves one project — the owner's 2026-09-23 ruling, which made
 * the start there a refusal), and the remedy in his order: delete the project
 * in Flowviant, or disconnect this box from it (the menu below, or the flags).
 *
 * Pure over the entries. An unbound project collides with nothing.
 */
export function renderCollisions(entries) {
  return repoCollisions(entries).map((g) => {
    const names = g.entries.map(projectPhrase);
    const list = `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
    return (
      `  ! ${g.entries.length} projects are connected for ${g.repoRoot}: ${list} — ` +
      'a directory serves one project, and `npx flowviant` there refuses to start until it does. ' +
      'Delete the one you do not mean in Flowviant (project settings → General → Delete project), or disconnect this box from it.'
    );
  });
}

/**
 * THE FOOTER. Two sentences, both of which exist because this listing is the
 * moment somebody is confused — the same reason `flowviant projects` names its
 * remedies inline rather than in a manual.
 *
 * The first says where the verbs are, because there are none here. The second
 * states this command's own SCOPE, which is the one thing a reader cannot see
 * from the output: it lists what is connected on THIS box, and a daemon running
 * on a computer that has never met this one is invisible to it. The app's Home
 * is where "all of them" lives, and pretending otherwise would be this listing
 * quietly answering a narrower question than the one asked.
 */
export const MACHINES_FOOTER = [
  '  stop a machine from the app: project settings → Machine → Disconnect;',
  '  a new `npx flowviant` on another box takes the project over.',
  '  this lists the projects connected on THIS box; the app’s Home lists every machine on your account.',
];

/** THE SCRIPT'S VERBS, said only when there was no menu to offer them in — a
 *  terminal that could draw the menu was offered the same two things by name,
 *  and repeating the flags under it would be a manual under a control. */
export const MACHINES_FLAGS_FOOTER = [
  '  `flowviant machines --remove <id>` disconnects this box from a project: stops its daemon here,',
  '  removes this box from that project’s machines list in the app, and forgets its credential here.',
  '  `--forget <id>` forgets the credential here only.',
];

/**
 * Ask one credential for its boxes. Never throws: every outcome is a shape the
 * renderer knows, because one dead project must not end the listing.
 *
 * A 404 is an older SERVER rather than a missing project — the route is new —
 * and it is kept apart from a 401, which is a credential this box should
 * probably forget. Two different next moves; collapsing them is how somebody
 * deletes a working credential.
 */
export async function fetchBoxesFor(entry, { url, envpub, fetchImpl = fetch } = {}) {
  const target = new URL(url);
  if (envpub) target.searchParams.set('envpub', envpub);
  try {
    const res = await fetchImpl(target, {
      headers: { Authorization: `Bearer ${entry.fleetToken}`, 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(15_000),
    });
    if (await credentialRejected(res)) return { rejected: true };
    if (res.status === 401 || res.status === 403) return { error: `HTTP ${res.status} from something in front of the app` };
    if (res.status === 404) return { unsupported: true };
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const body = await res.json();
    const data = body?.data;
    if (!data || !Array.isArray(data.boxes)) return { error: 'unexpected answer shape' };
    return { boxes: data.boxes, latest: data.latest ?? null, me: data.me ?? null };
  } catch (e) {
    return { error: String(e?.message ?? e) };
  }
}

/**
 * THE OTHER BOXES ON THIS PROJECT, as ONE line for the daemon's startup — or
 * null when there are none, which is the common case and must print nothing.
 *
 * Said ONCE per process, after the first successful poll, and never per poll:
 * the fact only changes when somebody starts a daemon somewhere else, and a
 * true sentence restated every ten seconds is a scrolling console nobody reads.
 * THE CALLING BOX IS EXCLUDED — it is the one box the person at that terminal
 * does not need to be told about.
 */
export function otherBoxesLine(boxes, me, now = Date.now()) {
  const others = (Array.isArray(boxes) ? boxes : []).filter((b) => b && b.boxId !== me);
  if (others.length === 0) return null;
  const parts = others.slice(0, 6).map((b) => {
    const role = roleWord(b.role);
    return `${safeName(b.boxName) ?? 'an unnamed machine'} (${role ? `${role} · ` : ''}${heardPhrase(b, now)})`;
  });
  const more = others.length - parts.length;
  return `other machines on this project: ${parts.join(', ')}${more > 0 ? `, and ${more} more` : ''}`;
}

/**
 * TELL THE SERVER THIS BOX HAS LEFT ONE PROJECT — `POST /fleet/boxes/leave`
 * (0.95.0). Never throws; every outcome is a shape the caller can say in words.
 *
 * It is THIS box removing ITSELF: the body carries our own `envpub`, the same
 * label every poll carries, and the server deletes our registry row for that
 * credential outright — no stand-down, because the daemon that would take one
 * has just been stopped by the same hand, and a stand-down waits on a poll
 * that is not coming. If we were the box serving the project, the server says
 * so (`wasHolder`) and the project has no machine until another one polls.
 *
 * A 404 is an OLDER SERVER (the read exists, the verb does not) and is kept
 * apart from a 401/403, which is a credential the app has already killed: the
 * first means "the row goes stale on its own, or remove it in the app", the
 * second means "there was nothing to leave". Collapsing them is how a working
 * credential gets described as dead.
 */
export async function leaveBoxFor(entry, { url, envpub, fetchImpl = fetch } = {}) {
  if (!envpub) return { skipped: true };
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${entry.fleetToken}`,
        'User-Agent': USER_AGENT,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ envpub }),
      signal: AbortSignal.timeout(15_000),
    });
    if (await credentialRejected(res)) return { rejected: true };
    if (res.status === 401 || res.status === 403) return { error: `HTTP ${res.status} from something in front of the app` };
    if (res.status === 404) return { unsupported: true };
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const body = await res.json();
    const data = body?.data;
    if (!data || typeof data.removed !== 'boolean') return { error: 'unexpected answer shape' };
    return { removed: data.removed, wasHolder: Boolean(data.wasHolder) };
  } catch (e) {
    return { error: String(e?.message ?? e) };
  }
}

/**
 * DISCONNECT THIS BOX FROM ONE PROJECT — the three steps, in the only order
 * that is safe, with every outcome said as it happens (0.95.0).
 *
 *  1. STOP the daemon serving that credential HERE. One lock, identified
 *     before it is signalled, through the same stand-down `flowviant stop`
 *     uses — never a sweep, because the person named ONE project. A daemon
 *     that is alive and could not be stopped ABORTS the disconnect: forgetting
 *     a credential under a running daemon changes nothing about the daemon
 *     (it holds the token in memory) and telling the server we have left while
 *     it keeps polling is a row that comes back in ten seconds wearing the
 *     name we just said was gone.
 *  2. LEAVE in the app — see `leaveBoxFor`. Skipped, and said, when this box
 *     has no identity file: a box that never ran a daemon never polled, so
 *     the app has no row to remove.
 *  3. FORGET the credential here. Last, so a failure in 1 or 2 leaves the
 *     store able to try again.
 *
 * `deps` is injected so the ORDER and the SENTENCES are provable without a
 * daemon, a socket or a credential file; `realDisconnectDeps` builds the live
 * set. Returns `{ ok }`, false only when step 1 refused.
 */
export async function disconnectHere(entry, deps, { log = (m) => console.log(m) } = {}) {
  const who = projectPhrase(entry);
  const tally = deps.stopDaemon(entry.fleetToken);
  if (tally.failed > 0) {
    log(
      `not disconnected from ${who}: a daemon for it is still running here and was not stopped. ` +
        'Stop it first (the line above says how), then run this again.'
    );
    return { ok: false };
  }
  if (tally.running === 0) log(`no daemon for ${who} was running here.`);

  const left = await deps.leave(entry);
  if (left.skipped) {
    log('this box has never run a daemon, so the app has no row of it to remove.');
  } else if (left.rejected) {
    log(`the app had already disconnected or deleted ${who} — nothing to leave.`);
  } else if (left.unsupported) {
    log(
      'the app does not take a leave from a machine yet (older server) — its row goes quiet on its own, ' +
        'or remove it in project settings → Machines.'
    );
  } else if (left.error) {
    log(
      `could not tell the app this box has left ${who} (${left.error}) — its row goes quiet on its own, ` +
        'or remove it in project settings → Machines.'
    );
  } else if (!left.removed) {
    log(`the app was not listing this box on ${who}.`);
  } else {
    log(
      `removed this box from ${who}’s machines list in the app.` +
        (left.wasHolder ? ' It was the machine serving that project, which has none until another polls.' : '')
    );
  }

  const gone = deps.forget(entry.projectId);
  if (gone.error) {
    log(`could not forget the credential here: ${gone.error}`);
    return { ok: false };
  }
  log(`forgot ${who}’s credential on this box. \`flowviant login\` in its repo connects it again.`);
  return { ok: true };
}

/**
 * THE LIVE DEPENDENCIES for `disconnectHere`, built lazily: `instance.mjs`
 * and `env.mjs` are imported here and not at the top so that rendering the
 * listing — the piped, scripted, most common use — loads nothing that reads a
 * lock directory or a keypair. `readStoredPubB64` READS the key and never
 * mints one, the rule the `machines` branch in cli.mjs is pinned to.
 */
export async function realDisconnectDeps({ url, log = (m) => console.log(m) } = {}) {
  const { stopDaemonFor } = await import('./instance.mjs');
  const { forgetStoredProject } = await import('./credentials.mjs');
  let envpub = null;
  try {
    const env = await import('./env.mjs');
    envpub = env.readStoredPubB64();
  } catch {
    /* unreadable keypair — the leave is skipped and said */
  }
  return {
    stopDaemon: (fleetToken) => stopDaemonFor(fleetToken, { log: (m) => log(`  ${m}`) }),
    leave: (entry) => leaveBoxFor(entry, { url, envpub }),
    forget: (projectId) => forgetStoredProject(projectId),
  };
}
