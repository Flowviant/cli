/**
 * HOW MANY TURNS AT ONCE — the derivation, the precedence, and the report.
 *
 * The owner's box computed a ceiling of ONE (16GB was not the problem; two
 * cores were: `cores − 1`), so every agent he deployed serialized at the
 * admission gate with nothing but a per-agent pulse line to explain it. Two
 * things came out of that, and this file pins both:
 *
 *  · THE DERIVATION WAS WRONG IN A WAY A COMMENT ALREADY SAID IT WAS. config.mjs
 *    argues at length that cores oversubscribe gracefully and memory is what
 *    does not — directly above a formula in which cores were the binding half on
 *    any small box. The cases below are the retune, stated as arithmetic rather
 *    than as prose that can drift from it again.
 *  · THE APP MAY NAME A NUMBER NOW, and the ORDER is the whole safety property:
 *    an env var somebody typed at the box is that operator's last word and must
 *    not be silently overruled by a control they cannot see.
 *
 * EVERY INPUT IS INJECTED. `MAX_CONCURRENT` is computed at import from the
 * machine running the suite, so a test that read it would pass or fail by
 * hardware — which is exactly the class of untestable threshold
 * `pressure.test.mjs` was written to avoid.
 *
 * Run: node --test bin/lib/turns.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveMaxConcurrent } from './config.mjs';
import {
  createAdmission,
  effectiveMaxTurns,
  pickMaxTurns,
  setServerMaxTurns,
} from './admission.mjs';

const GiB = 1024 * 1024 * 1024;

// ── the derivation ──────────────────────────────────────────────────────────

test('the ceiling is memory at 1GB a turn, with 2GB held back', () => {
  // 16GB, 8 cores: memory allows 14, cores allow 16, so memory binds — which is
  // the sentence config.mjs has always argued and now actually implements.
  assert.equal(deriveMaxConcurrent(16 * GiB, 8), 14);
  // A small VM: 4GB allows 2, two cores allow 4. Memory binds again, and the
  // answer is 2 rather than the 1 that produced the incident.
  assert.equal(deriveMaxConcurrent(4 * GiB, 2), 2);
});

test('cores cap it only when they are genuinely the scarcer thing', () => {
  // 64GB on one core: memory would allow 62. One core times two is 2.
  assert.equal(deriveMaxConcurrent(64 * GiB, 1), 2);
});

test('the old formulas are gone, and each one is a case', () => {
  // `floor((memGB − 2) / 2)` would say 7 on a 16GB box, not 14.
  assert.notEqual(deriveMaxConcurrent(16 * GiB, 8), 7);
  // `cores − 1` would say 1 on the owner's two-core box — the whole incident.
  assert.notEqual(deriveMaxConcurrent(4 * GiB, 2), 1);
});

test('it never answers zero, and never more than 32', () => {
  // A 1GB container: `1 − 2` is negative, and a ceiling of 0 or −1 refuses
  // every spawn forever, which is a machine that has silently stopped working.
  assert.equal(deriveMaxConcurrent(1 * GiB, 4), 1);
  assert.equal(deriveMaxConcurrent(512 * 1024 * 1024, 4), 1);
  // A very large box is still bounded: this is a runaway guard, not an
  // invitation to start a hundred CLIs.
  assert.equal(deriveMaxConcurrent(512 * GiB, 64), 32);
});

// ── the precedence ──────────────────────────────────────────────────────────

test('env beats the server, and the server beats the derivation', () => {
  assert.equal(pickMaxTurns({ env: 2, server: 8, derived: 14 }), 2);
  assert.equal(pickMaxTurns({ env: null, server: 8, derived: 14 }), 8);
  assert.equal(pickMaxTurns({ env: null, server: null, derived: 14 }), 14);
});

test('the dial NEVER overrules a number somebody typed at the box', () => {
  // The safety half of the order, stated on its own: the operator set this at
  // the machine, and a control in a browser they may not even be looking at
  // must not quietly raise it.
  assert.equal(pickMaxTurns({ env: 1, server: 32, derived: 14 }), 1);
});

test('a malformed value is not a ceiling — it falls through', () => {
  // `Number('')` is 0 and `Number('lots')` is NaN. A ceiling of 0 refuses every
  // spawn forever; NaN is no ceiling at all, since `live >= NaN` is false every
  // time. Both fall through to the next author rather than being honoured.
  assert.equal(pickMaxTurns({ env: null, server: 0, derived: 14 }), 14);
  assert.equal(pickMaxTurns({ env: null, server: NaN, derived: 14 }), 14);
  assert.equal(pickMaxTurns({ env: null, server: 'lots', derived: 14 }), 14);
  assert.equal(pickMaxTurns({ env: -3, server: null, derived: 14 }), 14);
  // …and the clamp holds wherever the number came from.
  assert.equal(pickMaxTurns({ env: null, server: 99, derived: 14 }), 32);
  assert.equal(pickMaxTurns({ env: null, server: 2.9, derived: 14 }), 2);
});

test('the server holder starts null and is cleared by anything unusable', () => {
  assert.equal(setServerMaxTurns(4), 4);
  assert.equal(setServerMaxTurns(undefined), null, 'absent is how Auto is spelled');
  assert.equal(setServerMaxTurns(6), 6);
  assert.equal(setServerMaxTurns(0), null);
  assert.equal(setServerMaxTurns(3), 3);
  assert.equal(setServerMaxTurns('garbage'), null);
  // Leave the holder clear — this module is shared with every other file in the
  // suite's single process.
  assert.equal(effectiveMaxTurns() >= 1, true);
});

// ── the admission reads it PER ADMIT ────────────────────────────────────────

test('a function-form ceiling is read at every admission, not captured once', () => {
  // The dial can move between two polls, so a value captured when the work
  // manager was built would be whatever the dial said at daemon start for the
  // rest of the process.
  let ceiling = 1;
  const admit = createAdmission({
    liveTurnCount: () => 1,
    maxConcurrent: () => ceiling,
    verdict: () => null,
  });
  assert.ok(admit('churn'), 'one turn against a ceiling of one refuses');
  ceiling = 4;
  assert.equal(admit('churn'), null, 'the raised dial takes effect on the next admission');
  ceiling = 1;
  assert.ok(admit('churn'), '…and so does a lowered one');
});

test('a ceiling that reads as garbage is not an ABSENT ceiling', () => {
  // `live >= NaN` is false every time, which is the unguarded spawn loop that
  // froze somebody's computer. A broken reader falls back to the local
  // derivation — the one number in the process that cannot be garbage.
  const admit = createAdmission({
    liveTurnCount: () => 9_999,
    maxConcurrent: () => NaN,
    verdict: () => null,
  });
  assert.ok(admit('churn'), 'a machine already running 9,999 turns must still refuse');
});

test('a plain number still works — every other test here passes one', () => {
  const admit = createAdmission({
    liveTurnCount: () => 2,
    maxConcurrent: 2,
    verdict: () => null,
  });
  assert.match(admit('churn').reason, /already running 2 CLI turns/);
});

// ── the report, pinned as source ────────────────────────────────────────────

const here = dirname(fileURLToPath(import.meta.url));
const fleetSrc = readFileSync(join(here, 'fleet.mjs'), 'utf8');

const between = (src, from, to, what) => {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a + 1);
  assert.ok(a >= 0, `${what}: anchor not found — ${from}`);
  assert.ok(b > a, `${what}: closing anchor not found after it — ${to}`);
  return src.slice(a, b);
};

test('the poll reports the EFFECTIVE ceiling, beside the reason it refused', () => {
  const region = between(fleetSrc, "url.searchParams.set('pr'", '} catch {', 'the mt param');
  assert.ok(region.includes("url.searchParams.set('mt'"));
  // The EFFECTIVE number, not the derivation: `capacity` a few lines up is the
  // dispatch-era fossil and reporting that instead would tell the app a bound
  // the machine is not actually enforcing.
  assert.ok(region.includes('effectiveMaxTurns()'));
  assert.ok(
    !region.includes('MAX_CONCURRENT'),
    'the derived number is not what the admission measured against'
  );
  // Inside the `pr` gate: a poll with no admission to ask has no effective
  // ceiling to report either, and absence must keep meaning "an older daemon".
  assert.ok(region.indexOf('churnHold !== undefined') < region.indexOf("set('mt'"));
});

test('the dial is re-read on EVERY poll, so Auto can be gone back to', () => {
  // Set unconditionally from the roster, including when the key is absent. A
  // learn-only store would leave the last dial standing forever and make
  // turning it back to Auto unspellable — the exact bug `listSessionPlaces`
  // paid for once already.
  assert.ok(fleetSrc.includes('setServerMaxTurns(roster.maxTurns);'));
  // The call stands on its own statement: no `if`, no `??`, no truthiness
  // wrapper. Each of those is a different spelling of the same learn-only store.
  for (const guard of [
    'if (roster.maxTurns',
    'roster.maxTurns &&',
    'roster.maxTurns ??',
    'roster.maxTurns !=',
  ])
    assert.ok(!fleetSrc.includes(guard), `the dial must not be guarded — found ${guard}`);
});
