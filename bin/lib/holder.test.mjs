/**
 * WHOSE MACHINE THIS IS (0.84.0).
 *
 * A project has ONE machine credential and `device/approve` hands every device
 * the same raw token, so two boxes running `npx flowviant` are two daemons that
 * both believe they are the machine. The server arbitrates — it is the only
 * party that can see both — and this file pins the daemon's half of that
 * contract: what it says, how often, and what it does NOT do.
 *
 * The properties worth a test are all absences or exact words:
 *   · a server that does not arbitrate must produce EXACTLY the 0.83.0 daemon,
 *     with no new code path taken at all;
 *   · a standby says its sentence ONCE per holder and never exits;
 *   · a displaced box settles every turn it is holding BEFORE it goes, and
 *     exits ZERO;
 *   · NOTHING here asks for the machine. The terminal surface is `npx flowviant`
 *     and `npx flowviant login`, full stop — the owner's own ruling — so the
 *     explicit move is a press in the app and the daemon only ever learns the
 *     answer. Pinned as an absence, because an absence passes every test ever
 *     written against it.
 *
 * Run: node --test bin/lib/holder.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import {
  agoLabel,
  createHolderWatch,
  displacedTurnSentence,
  standDownDisplaced,
} from './fleet.mjs';
import { MACHINE_HOST } from './config.mjs';

/** CODE ONLY — the comments in fleet.mjs quote the shapes they replaced, and a
 *  source pin that matches its own documentation trains the next person to
 *  weaken it. */
const fleetSource = () =>
  readFileSync(new URL('./fleet.mjs', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .join('\n');
const configSource = () => readFileSync(new URL('./config.mjs', import.meta.url), 'utf8');
/** Asserts BOTH anchors before slicing: an `indexOf` that missed returns -1 and
 *  an empty slice passes every `includes` you can write against it. */
const between = (src, from, to, what) => {
  const a = src.indexOf(from);
  assert.ok(a >= 0, `${what}: anchor not found — ${from}`);
  const b = src.indexOf(to, a + 1);
  assert.ok(b > a, `${what}: closing anchor not found after it — ${to}`);
  return src.slice(a, b);
};

// ── the box's own name ───────────────────────────────────────────────────────

test('the hostname is a bounded LABEL, and an unnamed box sends nothing at all', () => {
  // A query string is not a log: every string this daemon puts on the wire is
  // capped where it is built.
  assert.ok(
    configSource().includes("String(hostname() || '').trim().slice(0, 64) || null"),
    'mh must be trimmed, capped at 64, and null rather than empty'
  );
  if (MACHINE_HOST !== null) {
    assert.ok(MACHINE_HOST.length > 0 && MACHINE_HOST.length <= 64);
    assert.equal(MACHINE_HOST, MACHINE_HOST.trim());
    assert.equal(MACHINE_HOST, String(hostname()).trim().slice(0, 64));
  }
  // ABSENT, never ''. A box that cannot name itself must look like an older
  // daemon (nobody said) rather than like a box called nothing.
  const src = fleetSource();
  assert.ok(src.includes("if (MACHINE_HOST) url.searchParams.set('mh', MACHINE_HOST);"));
});

// ── how long ago ─────────────────────────────────────────────────────────────

test('an unmeasurable duration renders NOTHING rather than a number nobody measured', () => {
  assert.equal(agoLabel(0), '0s');
  assert.equal(agoLabel(34_000), '34s');
  assert.equal(agoLabel(9 * 60_000), '9m');
  assert.equal(agoLabel(3 * 60 * 60_000), '3h');
  assert.equal(agoLabel(4 * 24 * 60 * 60_000), '4d');
  for (const bad of [undefined, null, 'soon', NaN, -1, Infinity]) assert.equal(agoLabel(bad), null);
});

// ── the watch ────────────────────────────────────────────────────────────────

const watch = () => {
  const said = [];
  return { w: createHolderWatch({ say: (m) => said.push(m) }), said };
};

test('a server that does not arbitrate produces the 0.83.0 daemon — no state, no words', () => {
  const { w, said } = watch();
  for (const holder of [undefined, null, [], 'yes', 3]) {
    assert.equal(w.observe(holder), 'absent');
  }
  assert.deepEqual(said, [], 'silence is what an older server has always produced');
});

test('a standby says its sentence once per DISTINCT holder, and never per poll', () => {
  const { w, said } = watch();
  for (let i = 0; i < 5; i++) {
    assert.equal(w.observe({ mine: false, name: 'mac-mini', heardAgo: 34_000 }), 'standby');
  }
  assert.equal(said.length, 1);
  assert.equal(
    said[0],
    "This project's machine is mac-mini (heard 34s ago). It moves here automatically " +
      "once that machine has been quiet 10 minutes — or move it now from the app's " +
      'project settings.'
  );
  // A DIFFERENT box is news; the same one again is not.
  w.observe({ mine: false, name: 'studio', heardAgo: 60_000 });
  assert.equal(said.length, 2);
  assert.match(said[1], /machine is studio \(heard 1m ago\)/);
  w.observe({ mine: false, name: 'studio', heardAgo: 70_000 });
  assert.equal(said.length, 2);
});

test('an unnamed holder gets the nameless fallback and still announces once', () => {
  const { w, said } = watch();
  w.observe({ mine: false, name: null, heardAgo: null });
  w.observe({ mine: false, name: '   ', heardAgo: undefined });
  assert.equal(said.length, 1);
  assert.equal(
    said[0],
    "This project's machine is another machine. It moves here automatically " +
      "once that machine has been quiet 10 minutes — or move it now from the app's " +
      'project settings.'
  );
  assert.ok(!said[0].includes('heard'), 'an unmeasured duration drops the clause whole');
});

test('the handover is announced only to a box that was standing by', () => {
  const { w, said } = watch();
  // An ordinary daemon that has always been the machine prints nothing new.
  assert.equal(w.observe({ mine: true }), 'mine');
  assert.deepEqual(said, []);
  w.observe({ mine: false, name: 'mac-mini', heardAgo: 1_000 });
  assert.equal(said.length, 1);
  assert.equal(w.observe({ mine: true }), 'mine');
  assert.equal(said.length, 2);
  assert.match(said[1], /now serves the project/);
  // …and the same holder announces again if it takes the machine back, because
  // by then it IS news.
  w.observe({ mine: false, name: 'mac-mini', heardAgo: 1_000 });
  assert.equal(said.length, 3);
});

// ── the stand-down ───────────────────────────────────────────────────────────

test('a displaced box settles every turn it is holding BEFORE it goes, and exits 0', async () => {
  const order = [];
  let code = 'never';
  let sentence = null;
  await standDownDisplaced({
    by: 'mac-mini',
    settleAgentTurns: async (s) => {
      sentence = s;
      order.push('settle');
    },
    flushReports: async () => order.push('flush'),
    teardown: () => order.push('teardown'),
    exit: (c) => {
      order.push('exit');
      code = c;
    },
  });
  // The settle is the one thing here that no later poll from anybody can fix:
  // this process holds the only copy of the fact that those turns were running.
  assert.deepEqual(order, ['settle', 'flush', 'teardown', 'exit']);
  // EXIT ZERO. Under `Restart=on-failure` a nonzero code relaunches this daemon
  // straight into being told again that it is not the machine — a restart loop
  // fighting a decision somebody made on purpose. Both existing terminal paths
  // (the commanded stop, the revoked credential) document the same thing.
  assert.equal(code, 0);
  assert.equal(
    sentence,
    "The project's machine moved to mac-mini while this turn was running."
  );
});

test('the stand-down runs to the end even when the wire is dead', async () => {
  const order = [];
  let code = 'never';
  await standDownDisplaced({
    by: null,
    settleAgentTurns: async () => {
      order.push('settle');
      throw new Error('network down');
    },
    flushReports: async () => {
      order.push('flush');
      throw new Error('network down');
    },
    teardown: () => order.push('teardown'),
    exit: (c) => {
      code = c;
    },
  });
  // Teardown is NOT optional on this path: detached preview tunnels survive
  // this process by design, so skipping it strands a public hostname pointed
  // into a worktree on a box that no longer serves the project.
  assert.deepEqual(order, ['settle', 'flush', 'teardown']);
  assert.equal(code, 0);
  // An unnamed displacer is said as one, never guessed at.
  assert.equal(
    displacedTurnSentence(undefined),
    "The project's machine moved to another machine while this turn was running."
  );
});

// ── where it sits in the loop ────────────────────────────────────────────────

test('the displacement is read before the version signal, and after the commanded stop', () => {
  const src = fleetSource();
  const stopAt = src.indexOf('const stopSignal = shouldStop(roster.daemon);');
  const displacedAt = src.indexOf('if (roster.displaced &&');
  const updateAt = src.indexOf('const updating = handleVersionSignal({');
  assert.ok(stopAt > -1 && displacedAt > -1 && updateAt > -1, 'all three anchors must exist');
  // A stop was ASKED FOR by a person and outranks everything. A displacement
  // outranks the UPDATE for the reason the stop does: handleVersionSignal can
  // re-exec this process, and a box that has just been displaced coming back up
  // wearing a newer version is the one outcome nobody asked for.
  assert.ok(stopAt < displacedAt, 'a commanded stop outranks a displacement');
  assert.ok(displacedAt < updateAt, 'standing down outranks re-execing into a new version');
});

test('holdership is read in exactly one place, and gates nothing else in the loop', () => {
  const src = fleetSource();
  const reads = src.split('roster.holder').length - 1;
  // One reader. `toBe(1)` rather than "at most one": a count that can pass at
  // zero cannot tell "one reader" from "the pattern stopped matching".
  assert.equal(reads, 1, 'one read of the holder — a second would be a second definition');
  assert.ok(src.includes('holderState = holderWatch.observe(roster.holder);'));
  // A STANDBY KEEPS POLLING AND KEEPS SWEEPING. Its `activeWorkSessions` is
  // credential-scoped and correct, so skipping the loop body below would leave
  // a standby retiring worktrees whose tabs it can no longer see — and a
  // `continue` here is how that would arrive.
  const after = between(
    src,
    'holderState = holderWatch.observe(roster.holder);',
    'const updating = handleVersionSignal({',
    'the holder observation'
  );
  assert.ok(!after.includes('continue;'));
  assert.ok(!after.includes('return;'));
  assert.ok(!after.includes('process.exit'));
});

test('the standby never exits, and standing by gates nothing but copy', () => {
  const src = fleetSource();
  /**
   * A box that quits is a box somebody has to go and restart by hand, which is
   * the opposite of what an auto-handover is for — so standing by must not have
   * grown an exit of its own.
   *
   * SCOPED, not counted over the whole file. A raw total ("there are six
   * `process.exit`s") answers neither direction: an exit added on the standby
   * path while an unrelated one was refactored away keeps the total at six and
   * passes, and any unrelated new terminal path fails a test about standing by.
   * The property is positional — every exit in this file is upstream of the
   * holder observation, and the stand-down's is injected rather than called.
   */
  const fromObservation = src.slice(src.indexOf('holderState = holderWatch.observe(roster.holder);'));
  assert.ok(fromObservation.length > 0, 'the holder observation must exist');
  assert.ok(
    !fromObservation.includes('process.exit'),
    'nothing downstream of the holder observation may exit — a standby polls on'
  );
  assert.ok(
    src.includes('exit: (code) => process.exit(code),'),
    'the stand-down exits through an injected function, never by calling it itself'
  );
  /**
   * COUNTED WITH `equal`, never "at most" — the 2026-09-13 sweep's standing
   * rule, which the paragraph directly above already states and which the two
   * `<=` assertions that used to stand here broke. `<=` cannot tell a held rule
   * from a pattern that stopped matching, and one of them was matching NOTHING:
   * `holderState === 'absent'` occurs zero times in fleet.mjs, so `0 <= 1`
   * passed over an assertion about nothing.
   *
   * Standby has exactly TWO readers and both are lines of COPY — the "machine
   * online" greeting it must not print, and the idle heartbeat it rewords. A
   * third would be a standby that behaves differently rather than one that
   * speaks differently, which is the thing this design refuses: a standby polls,
   * sweeps and keeps its keep-list exactly as the holder does.
   */
  assert.equal(src.split("holderState === 'standby'").length - 1, 1);
  assert.equal(src.split("holderState !== 'standby'").length - 1, 1);
  // 'absent' is ASSIGNED as the initial value and never branched on: the
  // absence of a holder field is "this server does not arbitrate", which must
  // take zero new paths. Asserted as zero rather than dropped, because a branch
  // appearing on it is exactly the regression that would be silent.
  assert.equal(src.split("holderState === 'absent'").length - 1, 0);
  assert.equal(src.split("holderState = 'absent'").length - 1, 1);
});

test('NOTHING in the terminal asks for the machine — the gesture is the app\'s', () => {
  /**
   * THE OWNER'S RULING, verbatim: "i dont intend to run or do anything in the
   * terminal besides npx flowviant or npx flowviant login." So a daemon flag
   * that moves the project's machine is not a smaller version of the right
   * answer, it is the wrong surface — the move is a press in project settings,
   * the server performs it (it is the only party that can see both boxes), and
   * every daemon learns the outcome on its next poll, exactly like every other
   * holder fact.
   *
   * PINNED AS AN ABSENCE, because an absence passes every test ever written
   * against it: the only thing that stops a flag like this being re-added is
   * somebody remembering. Keyed on the BANNED STRINGS over a walk of the whole
   * daemon — never on an import (deleting the import is what a regression does)
   * and never on the list of files that happened to carry it, since the next
   * one will be a file not on that list.
   */
  const files = [
    ...readdirSync(new URL('../', import.meta.url))
      .filter((n) => n.endsWith('.mjs'))
      .map((n) => ({ name: `bin/${n}`, url: new URL(`../${n}`, import.meta.url) })),
    ...readdirSync(new URL('./', import.meta.url))
      .filter((n) => n.endsWith('.mjs'))
      .map((n) => ({ name: `bin/lib/${n}`, url: new URL(`./${n}`, import.meta.url) })),
  ];
  // THE CANARY: a walk that silently found nothing would pass this test over an
  // empty set forever, which is the inert-pin shape this repo has been bitten by
  // three times. Both halves — that there are files, and that the daemon itself
  // is among them.
  assert.ok(files.length > 40, `the walk must actually read the daemon — saw ${files.length}`);
  let sawCanary = false;
  /**
   * PATTERNS, not exact spellings — deliberately BROADER than the flag that was
   * deleted, so `claimMachine`, `--claim machine` or a re-spelled env var is
   * caught too. A ban keyed on one literal only catches a copy-paste of it.
   */
  const banned = [
    [/claim[-_ ]?machine/i, 'a flag or env var that moves the project machine'],
    [/searchParams\.set\(\s*['"]take['"]/, "a poll param asking for the machine"],
  ];
  for (const f of files) {
    const text = readFileSync(f.url, 'utf8');
    if (text.includes('acquireInstanceLock')) sawCanary = true;
    if (f.name === 'bin/lib/holder.test.mjs') continue; // this file IS the ban
    for (const [pattern, what] of banned) {
      assert.ok(!pattern.test(text), `${f.name} must not carry ${what} (${pattern})`);
    }
  }
  assert.ok(sawCanary, 'the walk must reach the daemon it is asserting about');
  // …and the local lock's flags are untouched: `--takeover` arbitrates PROCESSES
  // on this box and was never the thing that moved the project's machine, so
  // deleting the claim must not have taken it with it.
  const lock = readFileSync(new URL('./instance.mjs', import.meta.url), 'utf8');
  assert.ok(lock.includes('--no-takeover'), 'the local single-instance flags stand');
  assert.ok(
    !/claim[-_ ]?machine/i.test(configSource()),
    'config.mjs parses no flag that moves the project machine'
  );
});
