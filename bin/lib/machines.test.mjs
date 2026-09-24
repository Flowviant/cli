/**
 * HOW MANY DAEMONS DO I HAVE RUNNING — the box registry's daemon half (0.91.0).
 *
 * The owner, verbatim: "we need to design a solution for when users lose track
 * of how many daemons are connected in their device… is there a way to view ALL
 * the connected flowviants? because im not sure if i have any duplicate or
 * redundant daemons running". Production the same day held four daemons on two
 * boxes and two projects with the SAME NAME bound to the same checkout, which
 * is why the picker there offered two identical rows.
 *
 * WHAT IS WORTH A TEST HERE is what a render cannot show and a running daemon
 * would only reveal on somebody's second computer:
 *
 *  · THE ASK IS SPENT ONCE, AND ONLY ON A DELIVERED POLL. One ask per process
 *    is the entire reason `claim=1` cannot make two boxes trade a machine back
 *    and forth; spending it on an ATTEMPTED poll would silently lose the claim
 *    of a daemon that started while the wire was down.
 *  · A STALE BOX IS LISTED, NOT HIDDEN — the owner's own answer to "what about
 *    boxes that stopped" was "last heard". The word LAST is the staleness mark,
 *    and the row keeps its place either way.
 *  · A CREDENTIAL THAT IS REJECTED AND A SERVER THAT IS TOO OLD ARE DIFFERENT
 *    SENTENCES. They call for different next moves, and collapsing them is how
 *    somebody deletes a working credential.
 *  · THE PROJECT ID IS ALWAYS THERE. It is the only thing that tells two
 *    same-named projects apart, which is the case that produced the command.
 *
 * Run: node --test bin/lib/machines.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  agoFrom,
  boxesUrlFrom,
  connectedOn,
  disconnectHere,
  fetchBoxesFor,
  leaveBoxFor,
  leaveUrlFrom,
  MACHINES_FLAGS_FOOTER,
  MACHINES_FOOTER,
  otherBoxesLine,
  renderBox,
  renderCollisions,
  renderMachines,
} from './machines.mjs';
import { machineAskPending, spendMachineAsk } from './fleet.mjs';
import { projectRowLabel } from './credentials.mjs';

/** CODE ONLY — the comments quote the shapes they replaced, and a source pin
 *  that matches its own documentation trains the next person to weaken it. */
const fleetSource = () =>
  readFileSync(new URL('./fleet.mjs', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .join('\n');

/** BOTH anchors asserted before the cut: an `indexOf` that missed returns -1,
 *  and an empty slice passes every `includes` you can write against it. */
const between = (src, from, to, what) => {
  const a = src.indexOf(from);
  assert.ok(a >= 0, `${what}: anchor not found — ${from}`);
  const b = src.indexOf(to, a + 1);
  assert.ok(b > a, `${what}: closing anchor not found after it — ${to}`);
  return src.slice(a, b);
};

const box = (o = {}) => ({
  boxId: 'B1',
  boxName: 'vm-whuang-1',
  checkoutPath: '/home/whuang/merriam-one',
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
  projectId: 'f5f7db90-1111-2222-3333-444455556666',
  fleetToken: 'fva_x',
  name: 'Merriam One',
  repoRoot: '/home/w/code/merriam-one',
  savedAt: null,
  ...o,
});

// ── the ask ─────────────────────────────────────────────────────────────────

test('the machine ask is pending until a DELIVERED poll spends it, then never again', () => {
  // The default: a process that has not polled yet is asking. This is what puts
  // `claim=1` on the first poll and what the owner's "it should kill the first
  // one and take over" reduces to on the wire.
  assert.equal(machineAskPending(), true);
  // Asking does not consume — a poll that never reached the server must keep
  // the claim, or the box somebody walked over to and started never takes the
  // machine and nothing anywhere says why.
  assert.equal(machineAskPending(), true);
  spendMachineAsk();
  assert.equal(machineAskPending(), false);
  // Idempotent: a second delivered poll cannot un-spend it.
  spendMachineAsk();
  assert.equal(machineAskPending(), false);
});

test('the poll sets claim from the PENDING read and spends it only after res.ok', () => {
  const src = fleetSource();
  // The param is gated on the non-consuming read…
  assert.ok(
    src.includes("if (machineAskPending()) url.searchParams.set('claim', '1');"),
    'the claim param is set from the pending read'
  );
  // …and the spend happens after the response was accepted, never where the
  // param is built. Both anchors asserted; the region is the delivery check.
  const region = between(
    src,
    'if (!res.ok) throw new Error(`fleet poll failed',
    'const body = await res.json();',
    'the ask is spent on a delivered poll'
  );
  assert.ok(region.includes('spendMachineAsk();'), 'spent after the poll was answered');
  // A single spend site: two would mean one of them is on a path that did not
  // deliver, which is the bug this ordering exists to prevent. `toBe`-shaped,
  // never "at most one" — `<=` cannot tell one writer from a pattern that
  // stopped matching.
  // The semicolon is what separates the CALL from the `export function
  // spendMachineAsk() {` declaration two hundred lines up.
  assert.equal(src.split('spendMachineAsk();').length - 1, 1);
});

test('the poll reports the checkout, the pid and the process start', () => {
  const src = fleetSource();
  const region = between(
    src,
    "url.searchParams.set('mh', MACHINE_HOST)",
    "url.searchParams.set('claim', '1')",
    'the box-identity params'
  );
  // `cp` is what makes two daemons on ONE box legible — the owner runs a daemon
  // per project directory on purpose — and it is BOUNDED, because a query
  // string is not a log.
  assert.ok(region.includes("url.searchParams.set('cp', String(repoRoot).slice(0, 256))"));
  assert.ok(region.includes("url.searchParams.set('pid', String(process.pid))"));
  assert.ok(region.includes("url.searchParams.set('st', PROCESS_STARTED_AT)"));
  // The checkout is PASSED IN, never re-derived: running git on every poll to
  // re-learn a value resolved once at startup would be a syscall for a readout.
  assert.ok(/repoRoot = null\s*\n\s*\) \{/.test(src), 'repoRoot is a fetchRoster parameter');
  assert.ok(src.includes('admit(\'churn\'),\n        repoRoot\n      );'), 'the loop passes it');
});

// ── the listing ─────────────────────────────────────────────────────────────

test('a stale box is LISTED with "last heard", never hidden', () => {
  const now = Date.now();
  const line = renderBox(
    box({ fresh: false, role: 'inactive', boxName: 'wayleempc', lastHeardAt: new Date(now - 3 * 86_400_000).toISOString() }),
    {},
    now
  );
  assert.match(line, /wayleempc/);
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
  const code = readFileSync(new URL('./machines.mjs', import.meta.url), 'utf8')
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
  assert.match(line, /vm-whuang-1/);
  assert.ok(!/idle/.test(line), 'nothing is invented');
  assert.ok(!/ {4,}/.test(line.trim()), 'and no empty column is left behind');

  const now = Date.now();
  const other = otherBoxesLine(
    [box({ boxId: 'B2', boxName: 'wayleempc', role: null, lastHeardAt: new Date(now - 12_000).toISOString() })],
    'B1',
    now
  );
  assert.equal(other, 'other machines on this project: wayleempc (heard 12s ago)');
});

test('an unreported checkout or version says so — never blank, never guessed', () => {
  const line = renderBox(box({ checkoutPath: null, daemonVersion: null, boxName: null }));
  assert.match(line, /an unnamed machine/);
  assert.match(line, /\(checkout not reported\)/);
  assert.match(line, /version not reported/);
});

test('the project id is on EVERY row — it is what tells two same-named projects apart', () => {
  const a = entry({ projectId: 'fd716bf3-aaaa', name: 'BRIF AI', savedAt: '2026-08-01T12:00:00.000Z' });
  const b = entry({ projectId: 'fdcec6a0-bbbb', name: 'BRIF AI', savedAt: '2026-09-16T12:00:00.000Z' });
  const lines = renderMachines([a, b], {
    [a.projectId]: { boxes: [], latest: '0.91.0', me: null },
    [b.projectId]: { boxes: [], latest: '0.91.0', me: null },
  });
  assert.match(lines[0], /id fd716bf3…/);
  assert.match(lines[2], /id fdcec6a0…/);
  // The date rides the id because it is the fact a person can match against
  // their own memory, where two hex prefixes are two things to compare
  // character by character.
  assert.match(lines[0], /connected Aug 1/);
  assert.match(lines[2], /connected Sep 16/);
});

test('nothing polled, credential rejected, old server and unreachable are FOUR sentences', () => {
  const quiet = entry({ projectId: 'p-quiet', name: 'Quiet' });
  const dead = entry({ projectId: '3f2092aa-dead', name: 'Skadooble', repoRoot: null });
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
  assert.match(text, /npx flowviant` on another box takes the project over/);
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
    [box({ boxId: me }), box({ boxId: 'X', boxName: 'wayleempc', role: 'inactive', fresh: false, lastHeardAt: new Date(Date.now() - 3 * 86_400_000).toISOString() })],
    me
  );
  assert.match(line, /^other machines on this project: wayleempc \(inactive · last heard 3d ago\)$/);
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

test('the boxes URL is the roster URL with its last segment swapped', () => {
  assert.equal(boxesUrlFrom('https://api.flowviant.com/api/fleet/agents'), 'https://api.flowviant.com/api/fleet/boxes');
  assert.equal(boxesUrlFrom('https://x/api/v2/fleet/agents/'), 'https://x/api/v2/fleet/boxes');
});

test('a fetch failure is a SHAPE, never a throw — one dead project keeps the listing', async () => {
  const seen = [];
  const fake = (status, body) => async (url) => {
    seen.push(String(url));
    return {
      status,
      ok: status >= 200 && status < 300,
      headers: { get: () => 'application/json' },
      json: async () => body,
    };
  };
  assert.deepEqual(
    await fetchBoxesFor(entry(), { url: 'https://x/fleet/boxes', fetchImpl: fake(401, { success: false, error: {} }) }),
    { rejected: true }
  );
  assert.deepEqual(await fetchBoxesFor(entry(), { url: 'https://x/fleet/boxes', fetchImpl: fake(404) }), {
    unsupported: true,
  });
  assert.deepEqual(await fetchBoxesFor(entry(), { url: 'https://x/fleet/boxes', fetchImpl: fake(500) }), {
    error: 'HTTP 500',
  });
  // A 200 with the wrong shape is not boxes — the roster poll's own rule.
  assert.deepEqual(
    await fetchBoxesFor(entry(), { url: 'https://x/fleet/boxes', fetchImpl: fake(200, { data: {} }) }),
    { error: 'unexpected answer shape' }
  );
  const ok = await fetchBoxesFor(entry(), {
    url: 'https://x/fleet/boxes',
    envpub: 'PUB',
    fetchImpl: fake(200, { data: { boxes: [box()], latest: '0.91.0', me: 'PUB' } }),
  });
  assert.equal(ok.boxes.length, 1);
  assert.equal(ok.me, 'PUB');
  // The caller's own box id rides the query, so the server can echo it back and
  // the listing can mark "← this box" without matching base64 by hand.
  assert.ok(seen.some((u) => u.includes('envpub=PUB')));
  // And a thrown fetch is caught into the same shape.
  const boom = await fetchBoxesFor(entry(), {
    url: 'https://x/fleet/boxes',
    fetchImpl: async () => {
      throw new Error('ENOTFOUND');
    },
  });
  assert.match(boom.error, /ENOTFOUND/);
});

// ── the picker ──────────────────────────────────────────────────────────────

test('only COLLIDING picker rows gain the id — an ordinary store stays clean', () => {
  const a = entry({ projectId: 'fd716bf3-aaaa', name: 'BRIF AI', savedAt: '2026-08-01T12:00:00.000Z' });
  const b = entry({ projectId: 'fdcec6a0-bbbb', name: 'BRIF AI', savedAt: '2026-09-16T12:00:00.000Z' });
  const c = entry({ projectId: 'c0ffee00-cccc', name: 'Merriam One' });
  const all = [a, b, c];
  assert.match(projectRowLabel(a, all), /^BRIF AI \(id fd716bf3…, connected Aug 1\)$/);
  assert.match(projectRowLabel(b, all), /^BRIF AI \(id fdcec6a0…, connected Sep 16\)$/);
  // The row nothing collides with is untouched: an id on every row is noise on
  // the ordinary case, and noise is what makes the one row that matters
  // unfindable.
  assert.equal(projectRowLabel(c, all), 'Merriam One');
  assert.equal(projectRowLabel(c, [c]), 'Merriam One');
  // A collision with no stored date still gets the id — the id is the
  // disambiguator, the date is only the human-friendly half.
  const d = entry({ projectId: 'dddddddd-dddd', name: 'BRIF AI', savedAt: null });
  assert.equal(projectRowLabel(d, [d, a]), 'BRIF AI (id dddddddd…)');
});

// ── forgetting a credential ─────────────────────────────────────────────────

test('--forget removes one entry, clears the legacy mirror, and refuses ambiguity', async () => {
  // A fake HOME so the real credential store is never touched. `homedir()` on
  // this platform reads $HOME, and node:test gives each file its own process —
  // so this import is the first read credentials.mjs does.
  const home = mkdtempSync(join(tmpdir(), 'fv-machines-'));
  process.env.HOME = home;
  mkdirSync(join(home, '.flowviant'), { recursive: true });
  const file = join(home, '.flowviant', 'credentials.json');
  writeFileSync(
    file,
    JSON.stringify({
      fleetToken: 'fva_dead',
      projectId: '3f2092aa-dead',
      mcpUrl: 'https://x/mcp',
      projects: {
        '3f2092aa-dead': { fleetToken: 'fva_dead', name: 'Skadooble' },
        '3f2092bb-live': { fleetToken: 'fva_live', name: 'Merriam One' },
      },
    })
  );
  const creds = await import(`./credentials.mjs?forget=${Date.now()}`);

  // AMBIGUITY REFUSES rather than guessing — this deletes a credential, and two
  // projects that look alike is the case that produced the whole command.
  assert.match(creds.forgetStoredProject('3f209').error ?? '', /no stored project matches/);
  assert.match(creds.forgetStoredProject('3f2092').error ?? '', /matches 2 stored projects/);
  assert.match(creds.forgetStoredProject('nope').error ?? '', /no stored project matches/);
  assert.match(creds.forgetStoredProject('').error ?? '', /empty/);

  const res = creds.forgetStoredProject('3f2092aa-dead');
  assert.equal(res.entry.projectId, '3f2092aa-dead');
  const after = JSON.parse(readFileSync(file, 'utf8'));
  assert.ok(!after.projects['3f2092aa-dead'], 'the entry is gone');
  assert.ok(after.projects['3f2092bb-live'], 'the other one is untouched');
  // THE LEGACY MIRROR GOES WITH IT. Left behind, `listStoredProjects` surfaces
  // the top-level trio as an entry again and the forget silently did not
  // happen — the worst outcome available here.
  assert.equal(after.projectId, undefined);
  assert.equal(after.fleetToken, undefined);
  assert.equal(creds.listStoredProjects().some((e) => e.projectId === '3f2092aa-dead'), false);
});

// ── the two things the review caught, each of which shipped green ───────────

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
  const { heardPhrase } = await import('./machines.mjs');
  const now = Date.now();
  const justNow = box({ lastHeardAt: new Date(now - 400).toISOString(), fresh: true });

  assert.equal(heardPhrase(justNow, now), 'heard just now');
  assert.match(renderBox(justNow, {}, now), /heard just now(?! ago)/);
  assert.doesNotMatch(renderBox(justNow, {}, now), /just now ago/);

  const other = box({ boxId: 'B2', boxName: 'wayleempc', role: 'inactive' });
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

/**
 * A RESTART IS NOT A PERSON — the auto-update that stole a machine.
 *
 * `update.mjs` re-execs with `FLOWVIANT_REEXEC='1'` after an UNATTENDED update,
 * which is on by default. Born asking, the new process would have taken the
 * project's machine off a live holder in the middle of the night and settled
 * its running turns as moved, because npm published a patch. The ask belongs to
 * a person typing `npx flowviant`; a re-exec is that same start continuing.
 */
test('a re-executed daemon is born with the machine ask already spent', async () => {
  const before = process.env.FLOWVIANT_REEXEC;
  try {
    // A distinct module URL is a distinct module instance — the only way to
    // watch a module-level `let` being initialised twice in one process.
    process.env.FLOWVIANT_REEXEC = '1';
    const reexeced = await import('./fleet.mjs?fv-reexec=1');
    assert.equal(reexeced.machineAskPending(), false, 'a re-exec asks for nothing');

    delete process.env.FLOWVIANT_REEXEC;
    const started = await import('./fleet.mjs?fv-reexec=0');
    assert.equal(started.machineAskPending(), true, 'a person starting it still asks');

    // Anything other than the literal '1' is not a re-exec: the env var is
    // written by us, and a truthiness read here would let a stray value in
    // somebody's shell silently disarm the claim.
    process.env.FLOWVIANT_REEXEC = 'yes';
    const odd = await import('./fleet.mjs?fv-reexec=odd');
    assert.equal(odd.machineAskPending(), true);
  } finally {
    if (before === undefined) delete process.env.FLOWVIANT_REEXEC;
    else process.env.FLOWVIANT_REEXEC = before;
  }
});

test('the updater is what sets the variable the ask reads', () => {
  // THE COUPLING, pinned at the other end: this fix is worth nothing if the
  // re-exec ever stops carrying the flag, and that is one line in a file
  // nobody editing fleet.mjs is looking at.
  const update = readFileSync(new URL('./update.mjs', import.meta.url), 'utf8');
  assert.ok(update.includes("FLOWVIANT_REEXEC: '1'"), 'the re-exec still marks itself');
});

/**
 * LISTING MUST NOT ENROL. `flowviant machines` called `ensureKeypair()`, which
 * on a box with no keypair MINTS one — a 0600 write establishing that machine's
 * durable identity — from a command whose entire job is to print a list. The
 * view-only narrowness is what allowed a third terminal command to exist at
 * all.
 */
test('reading this box’s public key creates nothing', async () => {
  const before = process.env.HOME;
  const home = mkdtempSync(join(tmpdir(), 'fv-pubread-'));
  try {
    process.env.HOME = home;
    const env = await import(`./env.mjs?fv-pub=${Date.now()}`);
    // No file, no directory: null, and nothing on disk.
    assert.equal(env.readStoredPubB64(), null);
    assert.equal(existsSync(join(home, '.flowviant', 'env-keypair.json')), false);

    mkdirSync(join(home, '.flowviant'), { recursive: true });
    writeFileSync(
      join(home, '.flowviant', 'env-keypair.json'),
      JSON.stringify({ pub: 'PUBKEY_B64', priv: 'PRIVKEY_B64' })
    );
    assert.equal(env.readStoredPubB64(), 'PUBKEY_B64');

    // Malformed is NULL, never a throw and never a rewrite: the only cost of
    // not knowing is that no row wears "← this box".
    writeFileSync(join(home, '.flowviant', 'env-keypair.json'), '{not json');
    assert.equal(env.readStoredPubB64(), null);
    assert.equal(readFileSync(join(home, '.flowviant', 'env-keypair.json'), 'utf8'), '{not json');
  } finally {
    if (before === undefined) delete process.env.HOME;
    else process.env.HOME = before;
  }
});

test('the `machines` command never reaches for a keypair it would have to create', () => {
  const cli = readFileSync(new URL('../cli.mjs', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l))
    .join('\n');
  const branch = between(
    cli,
    "if (process.argv[2] === 'machines') {",
    "if (process.argv[2] === 'mcp') {",
    'the machines subcommand'
  );
  assert.ok(branch.includes('readStoredPubB64()'), 'it reads the stored key');
  assert.ok(!branch.includes('ensureKeypair'), 'and never mints one');
});

// ── 0.95.0: the collision is SAID, and the command has verbs ────────────────

/**
 * THE OWNER READ TWO SAME-NAMED PROJECTS AS ONE PROJECT CONNECTED TWICE
 * (2026-09-23): "BRIF AI appears twice meaning I likely have 2 daemon or
 * 'machine profiles' on my machine for the same BRIF AI project". The id on
 * every row (2026-09-19) said "different" and never said "same repo" — so the
 * listing now ends with a sentence per repo that two projects are bound to,
 * naming each in full. Pure, and absent when nothing collides.
 */
test('two projects bound to one repo are named in one line at the foot of the listing', () => {
  const a = entry({ projectId: 'fd716bf3-aaaa', name: 'BRIF AI', repoRoot: '/home/whuang/brif-ai', savedAt: '2026-08-01T12:00:00Z' });
  const b = entry({ projectId: 'fdcec6a0-bbbb', name: 'BRIF AI', repoRoot: '/home/whuang/brif-ai', savedAt: '2026-09-16T12:00:00Z' });
  const other = entry();
  const lines = renderCollisions([other, a, b]);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /2 projects are connected for \/home\/whuang\/brif-ai/);
  assert.match(lines[0], /BRIF AI \(fd716bf3…, connected Aug 1\) and BRIF AI \(fdcec6a0…, connected Sep 16\)/);
  // The rule, and the remedy in the owner's order: delete the project in
  // Flowviant first, disconnect this box second.
  assert.match(lines[0], /a directory serves one project, and `npx flowviant` there refuses to start until it does/);
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
  const c = entry({ projectId: 'fe000000-cccc', name: 'BRIF AI', repoRoot: '/home/whuang/brif-ai' });
  assert.match(renderCollisions([a, b, c])[0], /3 projects are connected .*fd716bf3…[^]*, BRIF AI \(fdcec6a0…[^]* and BRIF AI \(fe000000…\)/);
});

test('the leave URL is the boxes URL with the verb on the end', () => {
  assert.equal(leaveUrlFrom('https://api.flowviant.com/api/fleet/agents'), 'https://api.flowviant.com/api/fleet/boxes/leave');
});

/**
 * FOUR ANSWERS FROM THE SERVER, FOUR SHAPES — and the two that matter most are
 * the ones a lazy collapse would merge: a 404 is an OLDER SERVER that has the
 * read and not the verb (the row goes quiet on its own), a 401 is a credential
 * the app already killed (nothing to leave). Never a throw: one failed leave
 * must not abort the forget that follows it.
 */
test('leaving a project posts our own box id and answers in shapes, never throws', async () => {
  const calls = [];
  const fetchImpl = (status, body) => async (url, init) => {
    calls.push({ url: String(url), init });
    return {
      status,
      ok: status >= 200 && status < 300,
      headers: { get: (h) => (h.toLowerCase() === 'content-type' ? 'application/json' : null) },
      json: async () => body,
    };
  };
  const e = entry();
  const ok = await leaveBoxFor(e, { url: 'https://x/fleet/boxes/leave', envpub: 'ME', fetchImpl: fetchImpl(200, { data: { removed: true, wasHolder: true } }) });
  assert.deepEqual(ok, { removed: true, wasHolder: true });
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(JSON.parse(calls[0].init.body).envpub, 'ME');
  assert.match(calls[0].init.headers.Authorization, /^Bearer fva_x$/);
  assert.deepEqual(await leaveBoxFor(e, { url: 'https://x', envpub: 'ME', fetchImpl: fetchImpl(401, { success: false, error: { message: 'Token revoked' } }) }), { rejected: true });
  // An edge 403 (an HTML challenge page) is not the app rejecting the
  // credential, and must not read as "already disconnected".
  const edge = async () => ({ status: 403, ok: false, headers: { get: () => 'text/html' }, json: async () => { throw new Error('html'); } });
  assert.deepEqual(await leaveBoxFor(e, { url: 'https://x', envpub: 'ME', fetchImpl: edge }), { error: 'HTTP 403 from something in front of the app' });
  assert.deepEqual(await leaveBoxFor(e, { url: 'https://x', envpub: 'ME', fetchImpl: fetchImpl(404, {}) }), { unsupported: true });
  assert.deepEqual(await leaveBoxFor(e, { url: 'https://x', envpub: 'ME', fetchImpl: fetchImpl(500, {}) }), { error: 'HTTP 500' });
  assert.deepEqual(await leaveBoxFor(e, { url: 'https://x', envpub: 'ME', fetchImpl: fetchImpl(200, { data: {} }) }), { error: 'unexpected answer shape' });
  assert.deepEqual(await leaveBoxFor(e, { url: 'https://x', envpub: 'ME', fetchImpl: async () => { throw new Error('ECONNRESET'); } }), { error: 'ECONNRESET' });
  // NO IDENTITY, NO CALL: a box that never ran a daemon never polled, so there
  // is no row to remove and nothing to send.
  assert.deepEqual(await leaveBoxFor(e, { url: 'https://x', envpub: null, fetchImpl: async () => { throw new Error('must not be called'); } }), { skipped: true });
});

/**
 * THE DISCONNECT IS THREE STEPS IN ONE ORDER — stop, leave, forget — and a
 * daemon that would not stop ABORTS before either of the others. Forgetting a
 * credential under a running daemon changes nothing about the daemon, and a
 * leave under a still-polling box is a row that comes back in ten seconds.
 * Injected deps: the order is the contract, and it is provable without a lock
 * directory, a socket or a credential file.
 */
test('disconnect stops, then leaves, then forgets — and a daemon that would not stop aborts it', async () => {
  const order = [];
  const lines = [];
  const e = entry({ name: 'BRIF AI', savedAt: '2026-09-16T12:00:00Z' });
  const deps = (stopTally, leaveShape) => ({
    stopDaemon: (token) => { order.push(`stop:${token}`); return stopTally; },
    leave: async (en) => { order.push(`leave:${en.projectId}`); return leaveShape; },
    forget: (id) => { order.push(`forget:${id}`); return { entry: e }; },
  });
  const log = (m) => lines.push(m);

  // The ordinary case: a daemon was running, it stopped, the app removed the row.
  let res = await disconnectHere(e, deps({ stopped: 1, unconfirmed: 0, failed: 0, running: 1 }, { removed: true, wasHolder: true }), { log });
  assert.equal(res.ok, true);
  assert.deepEqual(order, ['stop:fva_x', `leave:${e.projectId}`, `forget:${e.projectId}`]);
  assert.match(lines.join('\n'), /removed this box from BRIF AI \(f5f7db90…, connected Sep 16\)’s machines list in the app/);
  assert.match(lines.join('\n'), /has none until another polls/);
  assert.match(lines.join('\n'), /forgot BRIF AI .* credential on this box/);
  assert.ok(!lines.some((l) => /no daemon .* was running/.test(l)), 'a running daemon is not described as absent');

  // Nothing running here is the ORDINARY disconnect, and says so.
  order.length = 0; lines.length = 0;
  res = await disconnectHere(e, deps({ stopped: 0, unconfirmed: 0, failed: 0, running: 0 }, { removed: false }), { log });
  assert.equal(res.ok, true);
  assert.match(lines[0], /no daemon for BRIF AI .* was running here/);
  assert.match(lines[1], /the app was not listing this box/);

  // A daemon alive and NOT stopped: abort, nothing left, nothing forgotten.
  order.length = 0; lines.length = 0;
  res = await disconnectHere(e, deps({ stopped: 0, unconfirmed: 1, failed: 1, running: 1 }, { removed: true }), { log });
  assert.equal(res.ok, false);
  assert.deepEqual(order, ['stop:fva_x']);
  assert.match(lines[0], /not disconnected .* still running here and was not stopped/);

  // The four server shapes each get their own sentence, and the forget still
  // happens under every one of them — the daemon is stopped, so the store is
  // the last thing left to clean.
  for (const [shape, words] of [
    [{ skipped: true }, /never run a daemon, so the app has no row/],
    [{ rejected: true }, /already disconnected or deleted .* nothing to leave/],
    [{ unsupported: true }, /older server.*project settings → Machines/],
    [{ error: 'HTTP 500' }, /could not tell the app .*HTTP 500/],
  ]) {
    order.length = 0; lines.length = 0;
    res = await disconnectHere(e, deps({ stopped: 0, unconfirmed: 0, failed: 0, running: 0 }, shape), { log });
    assert.equal(res.ok, true, JSON.stringify(shape));
    assert.match(lines.join('\n'), words);
    assert.equal(order[order.length - 1], `forget:${e.projectId}`, JSON.stringify(shape));
  }
});

/**
 * THE CLI'S WIRING: the menu is gated on BOTH `canPrompt()` and
 * `menuSupported()` (a pipe gets the listing and the flags, a backgrounded
 * job is never asked), `--remove` runs the same `disconnectHere` the menu
 * does, and the listing is RE-ASKED of the server after a verb rather than
 * redrawn from what this process hoped happened.
 */
test('the `machines` menu exists only where a person can drive it, and re-asks the server after a verb', () => {
  const cli = readFileSync(new URL('../cli.mjs', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l))
    .join('\n');
  const branch = between(cli, "if (process.argv[2] === 'machines') {", "if (process.argv[2] === 'mcp') {", 'the machines subcommand');
  assert.ok(branch.includes('if (!(canPrompt() && menuSupported())) {'), 'both gates, together');
  // The non-menu exit prints the flags, so a script's reader learns the verbs.
  const noMenu = between(branch, 'if (!(canPrompt() && menuSupported())) {', 'process.exit(0);', 'the no-menu exit');
  assert.ok(noMenu.includes('MACHINES_FLAGS_FOOTER'));
  // One disconnect implementation for the flag and the menu.
  assert.equal(branch.split('disconnectHere(').length - 1, 2, '--remove and the menu, nothing else');
  // After a verb, the server is asked again.
  const loop = between(branch, 'for (;;) {', 'for (const line of MACHINES_FOOTER) console.log(line);', 'the menu loop');
  assert.ok(loop.includes('await listing();'), 're-fetched, never redrawn from hope');
  assert.ok(loop.includes('entries = creds.listStoredProjects();'), 're-read the store too');
  // Two verbs and a way back, in that order — the destructive one first is what
  // the person came for, and "back" is never the default row.
  assert.ok(/disconnect this box from \$\{who\}[\s\S]*forget \$\{who\} here only[\s\S]*'back',/.test(loop));
  // --remove refuses ambiguity through the same matcher --project uses.
  assert.ok(branch.includes("creds.matchStoredProject(process.argv[removeAt + 1])"));
});

test('the flags footer names both scripted verbs and what each reaches', () => {
  const text = MACHINES_FLAGS_FOOTER.join('\n');
  assert.match(text, /--remove <id>/);
  assert.match(text, /stops its daemon here/);
  assert.match(text, /removes this box from that project’s machines list in the app/);
  assert.match(text, /--forget <id>` forgets the credential here only/);
});
