/**
 * `npx flowviant machines` — every project connected on THIS box, and every box
 * that has polled each of them (0.91.0).
 *
 * ── WHY A THIRD COMMAND EXISTS AT ALL ──
 *
 * The terminal surface is `npx flowviant` and `npx flowviant login`, full stop.
 * That is the owner's own ruling and it is what deleted the terminal flag that
 * used to move a project's machine. This amends it BY HIS OWN REQUEST — "the CLI gets a command to list connections" —
 * and it is amended in the narrowest way the ruling can survive: this command
 * is VIEW-ONLY. It starts nothing, stops nothing, moves nothing and takes no
 * lock; the one thing it can change is the local credential file, and only
 * behind an explicit `--forget`. Every decision is still made in the app.
 *
 * The question it answers is the owner's, verbatim: "is there a way to view ALL
 * the connected flowviants? because im not sure if i have any duplicate or
 * redundant daemons running". Measured the day it was asked: four live daemons
 * across two boxes, two credentials last heard three days ago, and two projects
 * both named "BRIF AI" bound to the same checkout — which is why `npx
 * flowviant` there offered two identical picker rows. THE PROJECT ID IS
 * THEREFORE ALWAYS PRINTED: it is the only thing that tells those two apart,
 * and the whole listing is worth less without it.
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

/** The boxes read, derived from the roster URL the way the diffstat post is —
 *  one place configures the API base and everything else is a suffix swap. */
export function boxesUrlFrom(fleetUrl) {
  return String(fleetUrl).replace(/\/agents\/?$/, '/boxes');
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
  const name = box.boxName || 'an unnamed machine';
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
    box.checkoutPath || '(checkout not reported)',
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
    const label = e.name || `project ${e.projectId.slice(0, 8)}…`;
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
  return lines;
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
    if (res.status === 401 || res.status === 403) return { rejected: true };
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
    return `${b.boxName || 'an unnamed machine'} (${role ? `${role} · ` : ''}${heardPhrase(b, now)})`;
  });
  const more = others.length - parts.length;
  return `other machines on this project: ${parts.join(', ')}${more > 0 ? `, and ${more} more` : ''}`;
}
