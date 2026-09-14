/**
 * THE MACHINE MUST NOT FREEZE THE BOX.
 *
 * This file exists because it did. `MAX_CONCURRENT` was computed from the real
 * hardware, sent to the server on every poll, and enforced NOWHERE — its local
 * enforcement died with the dispatch lane on 2026-08-19 and config.mjs went on
 * claiming otherwise for a month. Beside it, `processWorkTurns` had no slice at
 * all, agent turns started four a tick forever, and nothing anywhere looked at
 * memory before spawning a process that routinely holds gigabytes.
 *
 * EVERY MEASUREMENT HERE IS INJECTED. A guard that only passes on the machine
 * that happens to run the suite is not pinned — and the failure this covers is
 * a threshold comparison, which is exactly the thing a real /proc read would
 * make untestable.
 *
 * The admission points themselves are pinned as SOURCE, because the property
 * that matters is an absence: a deferred job must not be SETTLED. A settle is
 * invisible to any render test and would tell somebody their message failed
 * over a turn this machine never ran.
 *
 * Run: node --test bin/lib/pressure.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { platform } from 'node:os';
import { memAvailableBytes, pressureVerdict, pressureGuardOff } from './resources.mjs';
import { createAdmission } from './admission.mjs';

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

/** A box with room to spare: 16 GB total, 8 GB available, 8 cores, quiet. */
const easy = (over = {}) => ({
  memAvailable: 8 * GiB,
  memTotal: 16 * GiB,
  load1: 1.2,
  cores: 8,
  ...over,
});

/** Restore whatever the suite's environment actually had — these tests run in
 *  the same process as every other file. */
const withEnv = (vars, fn) => {
  const had = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(had)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
};

// ── the verdict ──────────────────────────────────────────────────────────────

test('a healthy box says nothing at either level', () => {
  assert.equal(pressureVerdict('churn', easy()), null);
  assert.equal(pressureVerdict('interactive', easy()), null);
});

test('churn yields on low memory, and the reason is the measurement', () => {
  const v = pressureVerdict('churn', easy({ memAvailable: 612 * MiB }));
  assert.equal(v.reason, 'low memory — 612 MB of 16.0 GB available');
  // No adjectives, no advice, no prediction — the number that fired and the
  // number it fired against, which is all this side actually knows.
  assert.ok(!/try|soon|please|later/i.test(v.reason));
});

test('the floor is the LARGER of the fixed reserve and six per cent', () => {
  // 1 GB is the right reserve on a laptop and nothing on a 256 GB box, where
  // six per cent (15.36 GB) is where the page cache is already being squeezed.
  const big = { memAvailable: 4 * GiB, memTotal: 256 * GiB, load1: 1, cores: 64 };
  assert.ok(pressureVerdict('churn', big));
  // …and on a small box the proportion is the smaller of the two, so the fixed
  // reserve is what holds.
  const small = { memAvailable: 900 * MiB, memTotal: 8 * GiB, load1: 1, cores: 4 };
  assert.ok(pressureVerdict('churn', small));
  assert.equal(pressureVerdict('churn', { ...small, memAvailable: 2 * GiB }), null);
});

test('churn yields on load, per core', () => {
  // 8 cores × 4 = 32 is the line.
  const v = pressureVerdict('churn', easy({ load1: 36.4 }));
  assert.equal(v.reason, 'cpu overloaded — load 36.4 on 8 cores');
  assert.equal(pressureVerdict('churn', easy({ load1: 32 })), null, 'AT the line is not over it');
  assert.ok(pressureVerdict('churn', easy({ load1: 32.1 })));
  // The count is the CGROUP's where there is one (config.mjs), so a two-core
  // container on a big box is judged against two.
  assert.ok(pressureVerdict('churn', easy({ load1: 9, cores: 2 })));
});

test('interactive holds out far longer — a person is watching the composer', () => {
  // Low enough to defer an agent turn, nowhere near enough to stall a tab.
  const squeezed = easy({ memAvailable: 700 * MiB });
  assert.ok(pressureVerdict('churn', squeezed));
  assert.equal(pressureVerdict('interactive', squeezed), null);
  const dying = easy({ memAvailable: 312 * MiB });
  assert.equal(
    pressureVerdict('interactive', dying).reason,
    'nearly out of memory — 312 MB available'
  );
});

test('a session turn is never deferred for LOAD — only for memory', () => {
  // Cores oversubscribe gracefully: everything gets slower. Memory does not —
  // something dies, and not necessarily the offender. Making somebody's message
  // wait because the box is busy would be a refusal with nothing behind it.
  assert.equal(pressureVerdict('interactive', easy({ load1: 500 })), null);
});

test('IGNORANCE NEVER WITHHOLDS: an unreadable measurement refuses nothing', () => {
  // A platform with no MemAvailable and no load average must not be treated as
  // a box that is out of both.
  assert.equal(
    pressureVerdict('churn', { memAvailable: null, memTotal: 0, load1: null, cores: 8 }),
    null
  );
  assert.equal(
    pressureVerdict('interactive', { memAvailable: null, memTotal: 0, load1: null, cores: 8 }),
    null
  );
  // Memory unreadable but load pathological: the half that CAN be read still
  // speaks.
  assert.ok(pressureVerdict('churn', { memAvailable: null, memTotal: 0, load1: 99, cores: 2 }));
});

/**
 * …AND THE PRODUCER CAN ACTUALLY REACH THAT STATE, which for one release it
 * could not. The case above injects `memAvailable: null` straight into the
 * verdict, so it passed over a value `memAvailableBytes` never returned: every
 * branch of it ended in `freemem()` — the figure resources.mjs rejects by name,
 * because a box with 12 GB of reclaimable page cache reads as nearly full on it.
 * An unreadable `/proc` therefore did not mean ignorance, it meant a small
 * number, and the guard deferred every agent turn, Deploy press and wiki sweep
 * indefinitely while relaying "low memory — …" as a measurement.
 */
test('a machine that cannot READ memory says null, never freemem()', {
  skip: platform() !== 'linux' ? 'the Linux reader is the one with an injectable source' : false,
}, () => {
  // Nothing readable at all: no MemAvailable, no cgroup limit.
  assert.equal(memAvailableBytes(() => null), null);
  // A /proc that answers but publishes no MemAvailable line (a masked or
  // restricted container) is the same ignorance.
  assert.equal(memAvailableBytes(() => 'MemTotal:  16384000 kB\nMemFree:  204800 kB'), null);
  // And a real reading still reads.
  assert.equal(
    memAvailableBytes((p) => (p === '/proc/meminfo' ? 'MemAvailable:    2048 kB' : null)),
    2048 * 1024
  );
});

test('the ignorance is not swallowed on the way to the verdict', {
  skip: platform() !== 'linux' ? 'the Linux reader is the one with an injectable source' : false,
}, () => {
  // The whole point of the null: it must travel from the producer into a
  // verdict that refuses nothing, on a quiet box that simply cannot be read.
  const m = { memAvailable: memAvailableBytes(() => null), memTotal: 16 * GiB, load1: 1, cores: 8 };
  assert.equal(m.memAvailable, null);
  assert.equal(pressureVerdict('churn', m), null);
  assert.equal(pressureVerdict('interactive', m), null);
});

// ── the operator's overrides ────────────────────────────────────────────────

test('the thresholds are tunable, and read per call', () => {
  withEnv({ FLOWVIANT_MIN_FREE_MB: '4096' }, () => {
    assert.ok(pressureVerdict('churn', easy({ memAvailable: 2 * GiB })));
  });
  // …and back to the default the moment the variable is gone.
  assert.equal(pressureVerdict('churn', easy({ memAvailable: 2 * GiB })), null);
  withEnv({ FLOWVIANT_MAX_LOAD_PER_CORE: '1' }, () => {
    assert.ok(pressureVerdict('churn', easy({ load1: 9 })));
  });
  withEnv({ FLOWVIANT_CRITICAL_FREE_MB: '2048' }, () => {
    assert.ok(pressureVerdict('interactive', easy({ memAvailable: 1 * GiB })));
  });
});

test('a garbled override falls back to the default instead of disabling the guard', () => {
  // `Number('lots')` is NaN and every comparison against it is false — which
  // would silently turn the guard OFF for whoever was trying to tune it.
  withEnv({ FLOWVIANT_MIN_FREE_MB: 'lots' }, () => {
    assert.ok(pressureVerdict('churn', easy({ memAvailable: 100 * MiB })));
  });
  withEnv({ FLOWVIANT_MIN_FREE_MB: '-1' }, () => {
    assert.ok(pressureVerdict('churn', easy({ memAvailable: 100 * MiB })));
  });
});

test('the escape hatch turns the whole guard off', () => {
  withEnv({ FLOWVIANT_NO_PRESSURE_GUARD: '1' }, () => {
    assert.equal(pressureGuardOff(), true);
    assert.equal(pressureVerdict('churn', easy({ memAvailable: 1, load1: 999 })), null);
    assert.equal(pressureVerdict('interactive', easy({ memAvailable: 1 })), null);
  });
  assert.equal(pressureGuardOff(), false);
  // '0' is not '1' — only the exact opt-out disables it.
  withEnv({ FLOWVIANT_NO_PRESSURE_GUARD: '0' }, () => {
    assert.equal(pressureGuardOff(), false);
  });
});

// ── admission ────────────────────────────────────────────────────────────────

test('the concurrency ceiling refuses at the limit, not past it', () => {
  const admit = createAdmission({
    liveTurnCount: () => 4,
    maxConcurrent: 4,
    verdict: () => null,
  });
  assert.ok(admit('churn'));
  const under = createAdmission({
    liveTurnCount: () => 3,
    maxConcurrent: 4,
    verdict: () => null,
  });
  assert.equal(under('churn'), null);
});

test('capacity is answered before pressure — the exact number beats the sampled one', () => {
  const admit = createAdmission({
    liveTurnCount: () => 9,
    maxConcurrent: 4,
    verdict: () => ({ reason: 'low memory — 1 MB of 1.0 GB available' }),
  });
  assert.match(admit('churn').reason, /already running 9 CLI turns/);
});

test('the capacity reason states ACTIVITY, never the ceiling', () => {
  // "Show activity, never capacity": the moment it fires, the machine says what
  // it is doing. It must not publish the limit beside it — that is the capacity
  // dial wearing a lab coat.
  const admit = createAdmission({
    liveTurnCount: () => 1,
    maxConcurrent: 1,
    verdict: () => null,
  });
  const { reason } = admit('churn');
  assert.equal(reason, 'the machine is already running 1 CLI turn');
  assert.ok(!/limit|ceiling|max|of \d/.test(reason));
});

/**
 * THE BURST, WHICH IS WHAT ACTUALLY FROZE THE BOX.
 *
 * Every lane loop is synchronous and every spawn under it is not: `inPlace`
 * resolves its callback in a later microtask, so the child registry cannot grow
 * while the loop is still running and `liveTurnCount()` returned the same number
 * on every iteration. A roster offering eight session turns admitted all eight
 * against a ceiling of one, then four agent turns, then the planner and the wiki
 * sweep — fourteen CLIs in one tick, with the guard biting only on the NEXT
 * tick, after the box was already loaded.
 */
test('a reserved slot is counted by the very next admission in the same tick', () => {
  let children = 0; // the registry the loop cannot grow until later
  const admit = createAdmission({
    liveTurnCount: () => children,
    maxConcurrent: 3,
    verdict: () => null,
  });
  const admitted = [];
  for (let i = 0; i < 8; i += 1) {
    if (admit('interactive')) continue;
    admitted.push(admit.reserve());
  }
  assert.equal(admitted.length, 3, 'the ceiling must bind inside one tick, not on the next one');
  assert.match(admit('interactive').reason, /already running 3 CLI turns/);
  // The processes then appear, and the reservations are handed back.
  children = 3;
  for (const release of admitted) release();
  assert.equal(admit.reserved(), 0);
  assert.match(admit('interactive').reason, /already running 3 CLI turns/);
});

test('the reservation crosses lanes — one tick has one budget', () => {
  const admit = createAdmission({ liveTurnCount: () => 0, maxConcurrent: 2, verdict: () => null });
  assert.equal(admit('interactive'), null);
  admit.reserve(); // a session turn
  assert.equal(admit('churn'), null);
  admit.reserve(); // an agent turn, moments later in the same reconcile
  // …and the planner behind it is the one that would have been the third CLI.
  assert.ok(admit('churn'));
});

test('releasing twice costs nothing — every caller releases at the spawn AND in a finally', () => {
  const admit = createAdmission({ liveTurnCount: () => 0, maxConcurrent: 2, verdict: () => null });
  const release = admit.reserve();
  release();
  release();
  assert.equal(admit.reserved(), 0);
  // A double release that decremented a counter would hand out a slot nobody
  // is holding, which is how a ceiling quietly stops being one.
  admit.reserve();
  admit.reserve();
  assert.ok(admit('churn'));
});

test('the level is passed through to the verdict — the two lanes differ', () => {
  const seen = [];
  const admit = createAdmission({
    liveTurnCount: () => 0,
    maxConcurrent: 8,
    verdict: (level) => {
      seen.push(level);
      return null;
    },
  });
  admit('churn');
  admit('interactive');
  assert.deepEqual(seen, ['churn', 'interactive']);
});

// ── the admission points, pinned as source ──────────────────────────────────
//
// A slice asserts BOTH of its anchors before slicing: an `indexOf` that misses
// returns −1, and a slice from −1 quietly asserts over the wrong region — or
// over nothing at all, which passes every `toContain` ever written against it.

const here = dirname(fileURLToPath(import.meta.url));
const workSrc = readFileSync(join(here, 'work.mjs'), 'utf8');
const fleetSrc = readFileSync(join(here, 'fleet.mjs'), 'utf8');

const between = (src, from, to, what) => {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a + 1);
  assert.ok(a >= 0, `${what}: anchor not found — ${from}`);
  assert.ok(b > a, `${what}: closing anchor not found after it — ${to}`);
  return src.slice(a, b);
};

test('a deferred SESSION turn is not settled — it is left pending for the next poll', () => {
  const region = between(
    workSrc,
    "const hold = admit('interactive');",
    'workAnswering.add(job.id);',
    'processWorkTurns deferral'
  );
  assert.ok(region.includes('continue;'), 'the deferral must skip the job');
  assert.ok(
    !region.includes('settleWorkTurn'),
    'settling a deferred turn tells the human their message failed over a turn nothing ran'
  );
  // …and it RELAYS, or the tab shows a spinner with no explanation.
  assert.ok(region.includes('sayTurnDeferred('));
  assert.ok(workSrc.includes('The machine retries on its next poll.'));
});

/**
 * EVERY LANE THAT SPAWNS RESERVES, and the pin is here because the failure is
 * invisible: a lane that admits without reserving works perfectly until two jobs
 * arrive in one tick, at which point it starts both.
 */
test('every admitted lane takes the slot before the next job is judged', () => {
  const session = between(
    workSrc,
    "const hold = admit('interactive');",
    'const place = job.place',
    'processWorkTurns reservation'
  );
  assert.ok(session.includes('admit.reserve()'));
  const agentLane = between(
    workSrc,
    'const processAgentTurnJobs = (jobs) => {',
    "// ── THE PROJECT'S OWN CHECK",
    'processAgentTurnJobs'
  );
  assert.ok(agentLane.includes('admit.reserve()'));
  assert.ok(agentLane.includes('runAgentTurn(job, releaseSlot)'));
  const planLane = between(
    workSrc,
    'const processAgentPlanJobs = (jobs) => {',
    '// ── AGENT TURNS: one task per prompt',
    'processAgentPlanJobs'
  );
  assert.ok(planLane.includes('admit.reserve()'));
  // Released where the process actually starts — holding it for the turn's
  // whole life would count one CLI twice and halve the ceiling.
  for (const anchor of ['workChildren.set(ch, job.sessionId);', 'workChildren.set(ch, agentId);'])
    assert.ok(
      between(workSrc, anchor, '\n\n', 'release at the spawn').includes('releaseSlot()'),
      `the reservation must be released where the child registers — ${anchor}`
    );
  // The wiki lane has no child for most of its life and counts the FLAG, which
  // is the same idea one file over.
  assert.ok(fleetSrc.includes('extraLiveTurns: () => (wikiBusy || wikiChild ? 1 : 0)'));
});

test('a deferred AGENT turn is not settled either', () => {
  const lane = between(
    workSrc,
    'const processAgentTurnJobs = (jobs) => {',
    "// ── THE PROJECT'S OWN CHECK",
    'processAgentTurnJobs'
  );
  const region = between(
    lane,
    "const hold = admit('churn');",
    'agentTurns.add(id);',
    'agent turn deferral'
  );
  assert.ok(region.includes('continue;'));
  assert.ok(
    !region.includes('postAgentTurn'),
    'settling here would send the agent to Stuck over a turn this machine never ran'
  );
});

test('a Deploy press is declined by NOT CLAIMING it', () => {
  const lane = between(
    workSrc,
    'const processAgentPlanJobs = (jobs) => {',
    '// ── AGENT TURNS: one task per prompt',
    'processAgentPlanJobs'
  );
  const admitAt = lane.indexOf("admit('churn')");
  const claimAt = lane.indexOf('planning.add(id);');
  assert.ok(admitAt >= 0 && claimAt >= 0);
  // A claimed press must be settled or it holds its cards out of Deploy, so
  // the only safe way to decline one is to never claim it.
  assert.ok(admitAt < claimAt, 'the check must come before the claim');
  assert.ok(!lane.slice(admitAt, claimAt).includes('postAgentPlan'));
});

test('the wiki drain yields without consuming its queue', () => {
  const region = between(
    fleetSrc,
    'async function drainWiki() {',
    'wikiBusy = true;',
    'drainWiki admission'
  );
  assert.ok(region.includes("admit('churn')"));
  assert.ok(region.includes('return;'));
  // Setting the busy flag and returning would strand the drain until a restart.
  assert.ok(!region.includes('wikiQueue.shift'));
});

test('a merge is NOT gated — it ends work and frees the box', () => {
  const lane = between(
    workSrc,
    'const processAgentMergeJobs =',
    'const workBusy = ',
    'processAgentMergeJobs'
  );
  assert.ok(!lane.includes('admit('));
});

test('the machine snapshot is built from the LIVE children, not the dead workers map', () => {
  const region = between(
    fleetSrc,
    'machineSnapshot({',
    'Deploy: a deploy-authorized daemon',
    'machineSnapshot call'
  );
  assert.ok(region.includes('liveTurns()'));
  // `workers` has had no `.set()` since dispatch was deleted; reading it is how
  // this column stayed empty on every machine that has ever run.
  assert.ok(!region.includes('[...workers]'));
});

/**
 * IT RELAYS THE WHOLE ADMISSION, NOT THE PRESSURE HALF.
 *
 * Narrowing it to pressure was the intuitive call and the effect was the
 * opposite of what it protected: a machine refusing every agent turn at its
 * CEILING sent `pr=-`, which says MEASURED AND FINE, so the server cleared any
 * stored reason and the board fell through to "nothing has polled this turn for
 * 12m" over a daemon polling every ten seconds and declining on purpose. The
 * machine asserted health at the exact moment it was refusing.
 */
test('the roster relays the churn ADMISSION, and says so positively when fine', () => {
  const region = between(fleetSrc, "url.searchParams.set('pr'", '});', 'the pr param');
  assert.ok(region.includes('churnHold'), 'the param carries the admission verdict');
  assert.ok(region.includes("'-'"), 'nothing-holding is a fact the server can clear a stale reason with');
  // The one caller asks the SAME `admit` the unattended lanes ask, so what the
  // board is told and what the machine then does cannot disagree.
  // Asserted over the CALL, not over one exact line: the poll grew a `take`
  // argument beside this one, and a pin keyed on the closing paren would have
  // failed on an addition that changes nothing about which `admit` is asked.
  assert.ok(
    between(fleetSrc, 'roster = await fetchRoster(', '\n      );', 'the roster call').includes(
      "admit('churn')"
    )
  );
  // And it no longer reaches round the admission to the raw reading — a poll
  // that measured pressure but not its own ceiling is the bug above.
  assert.ok(!fleetSrc.includes('pressureVerdict('), 'the poll asks the admission, never the verdict');
});
