/**
 * THE `machines` LISTING — pure rendering over the boxes answer and the stored
 * credentials (`machineListing.mjs`, split out of `machines.mjs` by the SOLID
 * audit 2026-09-26, F056; its tests moved with it).
 *
 * WHAT IS WORTH A TEST HERE is what a render cannot show and a running daemon
 * would only reveal on somebody's second computer:
 *
 *  · A STALE BOX IS LISTED, NOT HIDDEN — the owner's own answer to "what about
 *    boxes that stopped" was "last heard". The word LAST is the staleness mark,
 *    and the row keeps its place either way.
 *  · A CREDENTIAL THAT IS REJECTED AND A SERVER THAT IS TOO OLD ARE DIFFERENT
 *    SENTENCES. They call for different next moves, and collapsing them is how
 *    somebody deletes a working credential.
 *  · THE PROJECT ID IS ALWAYS THERE. It is the only thing that tells two
 *    same-named projects apart, which is the case that produced the command.
 *  · TWO PROJECTS ON ONE REPO ARE SAID, at the foot, in one sentence.
 *
 * Run: node --test bin/lib/machineListing.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  agoFrom,
  MACHINES_FLAGS_FOOTER,
  MACHINES_FOOTER,
  otherBoxesLine,
  renderBox,
  renderCollisions,
  renderMachines,
} from './machineListing.mjs';
import { connectedOn } from './credentialDate.mjs';
import { launchCommand } from './launchCommand.mjs';

const box = (o = {}) => ({
  boxId: 'B1',
  boxName: 'vm-dev-1',
  checkoutPath: '/home/dev/northwind-one',
  daemonVersion: '0.91.0',
  pid: 4242,
  processStartedAt: null,
  firstHeardAt: new Date(0).toISOString(),
  lastHeardAt: new Date().toISOString(),
  role: 'serving',
  fresh: true,
  behind: false,
  ...o,
});
const entry = (o = {}) => ({
  projectId: 'f1000003-1111-2222-3333-444455556666',
  fleetToken: 'fva_x',
  name: 'Northwind One',
  repoRoot: '/home/dev/code/northwind-one',
  savedAt: null,
  ...o,
});

// ── the listing ─────────────────────────────────────────────────────────────

test('a stale box is LISTED with "last heard", never hidden', () => {
  const now = Date.now();
  const line = renderBox(
    box({ fresh: false, role: 'inactive', boxName: 'devbox', lastHeardAt: new Date(now - 3 * 86_400_000).toISOString() }),
    {},
    now
  );
  assert.match(line, /devbox/);
  assert.match(line, /last heard 3d ago/);
  // The FRESH one says "heard", without the staleness word — that one word is
  // the whole distinction, so it must not appear on a live box.
  const live = renderBox(box({ lastHeardAt: new Date(now - 12_000).toISOString() }), {}, now);
  assert.match(live, /heard 12s ago/);
  assert.ok(!/last heard/.test(live), 'a live box is not marked stale');
});

test('“← this box” marks only the caller, and “behind” names the published latest', () => {
  const lines = [
    renderBox(box({ boxId: 'MINE' }), { me: 'MINE', latest: '0.91.0' }),
    renderBox(box({ boxId: 'THEIRS', daemonVersion: '0.87.0', behind: true }), {
      me: 'MINE',
      latest: '0.91.0',
    }),
  ];
  assert.match(lines[0], /← this box/);
  assert.ok(!/← this box/.test(lines[1]));
  assert.match(lines[1], /· behind, 0\.91\.0 is latest/);
  // A behind flag with no latest to name says NOTHING rather than inventing a
  // version — an instruction naming something npm does not serve is worse than
  // silence.
  assert.ok(!/behind/.test(renderBox(box({ behind: true }), { latest: null })));
});

/**
 * THE ROLE WORD IS PRINTED AS THE SERVER SENT IT — no mapping, no default.
 *
 * It had ONE special case until 2026-09-21: `'standing-by'` was respelled as
 * `standing by`, because a hyphenated enum value is an identifier and a
 * terminal should not print one. The owner replaced the word itself — asked
 * whether a box should keep saying "standing by", he answered *"no, it can [be]
 * inactive instead"* — so the server sends `serving` and `inactive`, both
 * already words, and the case had nothing left to translate.
 *
 * IT IS NOT KEPT "IN CASE". A mapping table inside a relay is a place for the
 * two ends to disagree, and a stale entry would have this command print one
 * word while the app printed another about the same box — the exact confusion
 * this listing exists to end. Pinned as an ABSENCE, because an absence passes
 * every render test ever written against it.
 */
test('the role word is the SERVER’S, printed, with no table in between', () => {
  assert.match(renderBox(box({ role: 'serving' })), /serving/);
  assert.match(renderBox(box({ role: 'inactive' })), /inactive/);
  // A relay does not second-guess a word it has not heard of.
  assert.match(renderBox(box({ role: 'quarantined' })), /quarantined/);
  // THE DEAD SPELLING IS NOT TRANSLATED ANY MORE. A server still sending the
  // old enum gets it printed raw, which is visibly wrong rather than quietly
  // papered over — and nothing in the module may re-introduce the mapping.
  assert.match(renderBox(box({ role: 'standing-by' })), /standing-by/);
  const code = readFileSync(new URL('./machineListing.mjs', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .join('\n');
  // THE CANARY: the function is really being read. A pin over a file it failed
  // to read passes every doesNotMatch ever written against it.
  assert.match(code, /function roleWord\(role\)/, 'reading the real relay');
  assert.doesNotMatch(code, /'standing by'/, 'no respelling survives');
  assert.doesNotMatch(code, /'standing-by'/, 'and nothing matches the dead enum');
  // …nor a DEFAULT. `?? 'idle'` was a CLAIM — "the server told us this box is
  // doing nothing" — about an answer the server did not give.
  assert.doesNotMatch(code, /\?\? 'idle'/, 'an absent role is not defaulted');
});

/** An unreported role DROPS ITS CELL rather than printing a blank column or a
 *  guess. Every other cell states its own absence because a reader needs to
 *  know nobody measured one; a role is different — the row already carries the
 *  mark, the version and the last-heard. */
test('an absent role says nothing at all, at both doors', () => {
  const line = renderBox(box({ role: null }));
  assert.match(line, /vm-dev-1/);
  assert.ok(!/idle/.test(line), 'nothing is invented');
  assert.ok(!/ {4,}/.test(line.trim()), 'and no empty column is left behind');

  const now = Date.now();
  const other = otherBoxesLine(
    [box({ boxId: 'B2', boxName: 'devbox', role: null, lastHeardAt: new Date(now - 12_000).toISOString() })],
    'B1',
    now
  );
  assert.equal(other, 'other machines on this project: devbox (heard 12s ago)');
});

test('an unreported checkout or version says so — never blank, never guessed', () => {
  const line = renderBox(box({ checkoutPath: null, daemonVersion: null, boxName: null }));
  assert.match(line, /an unnamed machine/);
  assert.match(line, /\(checkout not reported\)/);
  assert.match(line, /version not reported/);
});

// A3 CROSS 8a (the audit): a box's name and checkout path are SERVER-relayed
// (another box's own poll, upserted into a row this box's `machines` just
// read back), so a C1 escape or a bidi override in either reaches this
// terminal exactly the way a hostname or a project name does.
test('a box name or checkout path carrying an escape sequence or a bidi override is scrubbed before it reaches the terminal', () => {
  const line = renderBox(
    box({ boxName: 'evil‮txt.crt⁦', checkoutPath: '/home/x\u009d52;c;ZXZpbA==\u009c' })
  );
  assert.ok(!/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/.test(line));
  assert.match(line, /eviltxt\.crt/);
  assert.match(line, /\/home\/x52;c;ZXZpbA==/);
  // A name that scrubs down to nothing still gets the honest fallback, not a
  // blank cell.
  assert.match(renderBox(box({ boxName: '‮⁦' })), /an unnamed machine/);
});

test('otherBoxesLine scrubs a box name the same way', () => {
  const line = otherBoxesLine(
    [box({ boxId: 'B2', boxName: 'devbox‮', role: 'inactive' })],
    'B1'
  );
  assert.ok(!/‮/.test(line));
  assert.match(line, /devbox/);
});

test('the project id is on EVERY row — it is what tells two same-named projects apart', () => {
  const a = entry({ projectId: 'fa000001-aaaa', name: 'Acme App', savedAt: '2026-08-01T12:00:00.000Z' });
  const b = entry({ projectId: 'fb000002-bbbb', name: 'Acme App', savedAt: '2026-09-16T12:00:00.000Z' });
  const lines = renderMachines([a, b], {
    [a.projectId]: { boxes: [], latest: '0.91.0', me: null },
    [b.projectId]: { boxes: [], latest: '0.91.0', me: null },
  });
  assert.match(lines[0], /id fa000001…/);
  assert.match(lines[2], /id fb000002…/);
  // The date rides the id because it is the fact a person can match against
  // their own memory, where two hex prefixes are two things to compare
  // character by character.
  assert.match(lines[0], /connected Aug 1/);
  assert.match(lines[2], /connected Sep 16/);
});

test('nothing polled, credential rejected, old server and unreachable are FOUR sentences', () => {
  const quiet = entry({ projectId: 'p-quiet', name: 'Quiet' });
  const dead = entry({ projectId: '3f2092aa-dead', name: 'Contoso', repoRoot: null });
  const old = entry({ projectId: 'p-old', name: 'Old' });
  const down = entry({ projectId: 'p-down', name: 'Down' });
  const lines = renderMachines([quiet, dead, old, down], {
    [quiet.projectId]: { boxes: [], latest: null, me: null },
    [dead.projectId]: { rejected: true },
    [old.projectId]: { unsupported: true },
    [down.projectId]: { error: 'fetch failed' },
  }).join('\n');
  // "nothing has polled this" is NOT "this has no machines": a project whose
  // machines have all gone quiet still has rows, wearing their last-heard.
  assert.match(lines, /\(no machine has polled this project\)/);
  assert.match(lines, /credential rejected/);
  assert.match(lines, /flowviant machines --forget 3f2092aa/);
  assert.match(lines, /server does not report machines yet/);
  assert.match(lines, /could not ask the server — fetch failed/);
  // An unbound credential says so rather than printing an empty path.
  assert.match(lines, /not bound to a repo yet/);
});

test('a project with no answer at all reads as unreachable, not as empty', () => {
  const e = entry({ projectId: 'p-missing' });
  const lines = renderMachines([e], {}).join('\n');
  assert.match(lines, /could not ask the server/);
  assert.ok(!/no machine has polled/.test(lines), 'silence is not a measurement');
});

test('the footer states the verbs elsewhere AND this command’s own scope', () => {
  const text = MACHINES_FOOTER.join('\n');
  // There are no verbs here, so it says where they are.
  assert.match(text, /project settings → Machine → Disconnect/);
  assert.match(text, new RegExp(`${launchCommand()}\` on another box takes the project over`));
  // …and the one thing a reader cannot see from the output: this lists what is
  // connected on THIS box, and a daemon on a computer this one has never met is
  // invisible to it.
  assert.match(text, /connected on THIS box/);
  assert.match(text, /Home lists every machine on your account/);
});

// ── the startup line ────────────────────────────────────────────────────────

test('the startup line excludes the calling box and says nothing when alone', () => {
  const me = 'MINE';
  assert.equal(otherBoxesLine([box({ boxId: me })], me), null);
  assert.equal(otherBoxesLine([], me), null);
  assert.equal(otherBoxesLine(null, me), null);
  const line = otherBoxesLine(
    [box({ boxId: me }), box({ boxId: 'X', boxName: 'devbox', role: 'inactive', fresh: false, lastHeardAt: new Date(Date.now() - 3 * 86_400_000).toISOString() })],
    me
  );
  assert.match(line, /^other machines on this project: devbox \(inactive · last heard 3d ago\)$/);
});

// ── the helpers ─────────────────────────────────────────────────────────────

test('an unmeasurable stamp renders NOTHING rather than a duration nobody took', () => {
  assert.equal(agoFrom(null), null);
  assert.equal(agoFrom('not a date'), null);
  assert.equal(connectedOn(null), null);
  assert.equal(connectedOn(''), null);
  // Never "0s" — a box heard a moment ago has not been silent for no time.
  assert.equal(agoFrom(new Date().toISOString()), 'just now');
  // A clock skew must not read as the future on a terminal.
  assert.equal(agoFrom(new Date(Date.now() + 60_000).toISOString()), 'just now');
});

// ── the review caught it, and it shipped green ──────────────────────────────

/**
 * "HEARD JUST NOW AGO" — on the serving box, on the first line anybody looks
 * at.
 *
 * `agoFrom` answers with a DURATION except in the newest case, where it answers
 * with a PHRASE, and both callers appended " ago" to whatever came back. A
 * daemon that polled four hundred milliseconds ago is the most common row in
 * the whole listing, so the one row that was always wrong was the one always
 * read. Composed in one place now (`heardPhrase`), and pinned at BOTH doors
 * because being fixed in one of them is exactly how it got here.
 */
test('a box heard moments ago never reads "just now ago", at either door', async () => {
  const { heardPhrase } = await import('./machineListing.mjs');
  const now = Date.now();
  const justNow = box({ lastHeardAt: new Date(now - 400).toISOString(), fresh: true });

  assert.equal(heardPhrase(justNow, now), 'heard just now');
  assert.match(renderBox(justNow, {}, now), /heard just now(?! ago)/);
  assert.doesNotMatch(renderBox(justNow, {}, now), /just now ago/);

  const other = box({ boxId: 'B2', boxName: 'devbox', role: 'inactive' });
  const line = otherBoxesLine([{ ...other, lastHeardAt: new Date(now - 400).toISOString() }], 'B1', now);
  assert.match(line, /heard just now\)$/);
  assert.doesNotMatch(line, /just now ago/);

  // The DURATION case still takes the suffix — the fix must not have been "drop
  // the word ago", which would have made every other row read as a bare span.
  assert.equal(heardPhrase(box({ lastHeardAt: new Date(now - 12_000).toISOString() }), now), 'heard 12s ago');
  // …and "LAST heard" survives as the staleness mark, in both shapes.
  assert.equal(
    heardPhrase(box({ fresh: false, lastHeardAt: new Date(now - 400).toISOString() }), now),
    'last heard just now'
  );
  assert.equal(
    heardPhrase(box({ fresh: false, lastHeardAt: new Date(now - 3 * 86_400_000).toISOString() }), now),
    'last heard 3d ago'
  );
  // An unmeasurable stamp is never a duration nobody took.
  assert.equal(heardPhrase(box({ lastHeardAt: null }), now), 'never heard');
});

// ── 0.95.0: the collision is SAID, and the command has verbs ────────────────

/**
 * THE OWNER READ TWO SAME-NAMED PROJECTS AS ONE PROJECT CONNECTED TWICE
 * (2026-09-23): "Acme App appears twice meaning I likely have 2 daemon or
 * 'machine profiles' on my machine for the same Acme App project". The id on
 * every row (2026-09-19) said "different" and never said "same repo" — so the
 * listing now ends with a sentence per repo that two projects are bound to,
 * naming each in full. Pure, and absent when nothing collides.
 */
test('two projects bound to one repo are named in one line at the foot of the listing', () => {
  const a = entry({ projectId: 'fa000001-aaaa', name: 'Acme App', repoRoot: '/home/dev/acme-app', savedAt: '2026-08-01T12:00:00Z' });
  const b = entry({ projectId: 'fb000002-bbbb', name: 'Acme App', repoRoot: '/home/dev/acme-app', savedAt: '2026-09-16T12:00:00Z' });
  const other = entry();
  const lines = renderCollisions([other, a, b]);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /2 projects are connected for \/home\/dev\/acme-app/);
  assert.match(lines[0], /Acme App \(fa000001…, connected Aug 1\) and Acme App \(fb000002…, connected Sep 16\)/);
  // The rule, and the remedy in the owner's order: delete the project in
  // Flowviant first, disconnect this box second.
  assert.match(lines[0], new RegExp(`a directory serves one project, and \`${launchCommand()}\` there refuses to start until it does`));
  assert.match(lines[0], /Delete the one you do not mean in Flowviant \(project settings → General → Delete project\), or disconnect this box from it/);
  // A store with no collision says nothing at all: a sentence about an absence
  // is chrome.
  assert.deepEqual(renderCollisions([other, a]), []);
  // …and the whole listing carries it, after the rows and a blank line.
  const results = { [other.projectId]: { boxes: [] }, [a.projectId]: { boxes: [] }, [b.projectId]: { boxes: [] } };
  const all = renderMachines([other, a, b], results);
  assert.equal(all[all.length - 1], lines[0]);
  assert.equal(all[all.length - 2], '');
  // Three on one repo reads as a list, not a pair.
  const c = entry({ projectId: 'fe000000-cccc', name: 'Acme App', repoRoot: '/home/dev/acme-app' });
  assert.match(renderCollisions([a, b, c])[0], /3 projects are connected .*fa000001…[^]*, Acme App \(fb000002…[^]* and Acme App \(fe000000…\)/);
});

test('a machine launched through the Node package runner names that launch in its remedy', () => {
  const previous = process.env.npm_config_user_agent;
  try {
    process.env.npm_config_user_agent = 'npm/11 npx/11';
    const a = entry({ projectId: 'one', repoRoot: '/repo' });
    const b = entry({ projectId: 'two', repoRoot: '/repo' });
    assert.match(renderCollisions([a, b])[0], /`flowviant` there refuses/);
  } finally {
    if (previous === undefined) delete process.env.npm_config_user_agent;
    else process.env.npm_config_user_agent = previous;
  }
});

test('the flags footer names both scripted verbs and what each reaches', () => {
  const text = MACHINES_FLAGS_FOOTER.join('\n');
  assert.match(text, /--remove <id>/);
  assert.match(text, /stops its daemon here/);
  assert.match(text, /removes this box from that project’s machines list in the app/);
  assert.match(text, /--forget <id>` forgets the credential here only/);
});
