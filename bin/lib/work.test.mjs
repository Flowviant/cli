import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkManager } from './work.mjs';

/**
 * The work manager against a REAL repo and a STUBBED wire. The seams under
 * test are the ones whose failure is invisible in production: a place stored
 * without validation surfaces only when a traversal value reaches a tunnel,
 * and a settle POST that fails surfaces only as an agent parked for six hours
 * with a false sentence. Both are cheap to reach here because the paths they
 * ride refuse BEFORE any CLI spawns — no model call, no worktree, no network
 * beyond the stub.
 */
const git = (args, cwd) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'fv-work-'));
  git(['init', '-q', '-b', 'main'], dir);
  git(['config', 'user.email', 't@t.t'], dir);
  git(['config', 'user.name', 'T'], dir);
  writeFileSync(join(dir, 'a.txt'), 'one');
  git(['add', '-A'], dir);
  git(['commit', '-qm', 'base'], dir);
  return dir;
}

/** The manager AND the two directories it is standing in — the begun-guard is
 *  about what is on disk, so its tests have to be able to put things there. */
function managerIn(t) {
  const dir = repo();
  const baseDir = mkdtempSync(join(tmpdir(), 'fv-work-base-'));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(baseDir, { recursive: true, force: true });
  });
  const m = createWorkManager({
    repoRoot: dir,
    baseDir,
    getBaseRef: () => 'main',
    getMcpUrl: () => 'http://127.0.0.1:0/mcp',
    getLeaseTtl: () => 60,
  });
  return { m, repoRoot: dir, baseDir };
}

function manager(t) {
  return managerIn(t).m;
}

/**
 * Every POST the manager makes, recorded; `mode` picks the wire's health.
 * 'down' is a network error (retryable), '404' is the server refusing the
 * body (terminal), 'ok' accepts. The split matters: the held-body contract is
 * retry-on-network, drop-on-refusal, and a stub that cannot say both cannot
 * test the difference.
 */
function stubFetch(t) {
  const real = globalThis.fetch;
  const calls = [];
  const state = { mode: 'ok' };
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({
      url: String(url),
      body: typeof opts.body === 'string' ? JSON.parse(opts.body) : null,
    });
    if (state.mode === 'down') throw new Error('network down');
    if (state.mode === '404') return { ok: false, status: 404, json: async () => ({}) };
    // `claimed: true` because a lease-gated lane is unreachable without it: a
    // plan job whose claim comes back false returns in silence, which is a
    // healthy daemon losing a race and is not what any test here is about.
    return { ok: true, status: 200, json: async () => ({ data: { claimed: true } }) };
  };
  t.after(() => {
    globalThis.fetch = real;
  });
  return { calls, state };
}

const until = async (cond, ms = 3000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
};
const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms));

test('a turn job naming a traversal place is settled out loud, never stored or run', async (t) => {
  const m = manager(t);
  const { calls } = stubFetch(t);
  m.processWorkTurns([
    { id: 'turn-1', body: 'hello', sessionId: 'sess-1', place: '../../outside' },
  ]);
  await until(() => calls.length >= 1);
  const settle = calls.find((c) => c.url.includes('work-turn-done'));
  assert.ok(settle, 'the turn must be settled, not silently dropped');
  assert.equal(settle.body.turnId, 'turn-1');
  assert.equal(settle.body.ok, false);
  assert.match(settle.body.answer, /working directory/);
  // Nothing else moved: no mint, no CLI, and nothing left holding the manager
  // busy — the refusal happened before the place could reach any consumer.
  await tick();
  assert.equal(calls.length, 1);
  assert.equal(m.workBusy(), false);
});

test('a finished agent turn whose settle POST failed re-POSTs the held body on re-offer — never the CLI', async (t) => {
  const m = manager(t);
  const { calls, state } = stubFetch(t);
  state.mode = 'down';
  // kind:'task' with no task is refused before any worktree or CLI — the
  // cheapest path that still produces a FINISHED settle body.
  const job = { id: 'at-1', agentId: 'ag-1', placeId: 'a-1', kind: 'task' };
  m.processAgentTurnJobs([job]);
  await until(() => calls.some((c) => c.url.includes('agent-turn-done')));
  await tick();
  const firstBody = calls.find((c) => c.url.includes('agent-turn-done')).body;
  assert.equal(firstBody.outcome, 'nothing');
  // The held body is undelivered work: a restart here loses it permanently,
  // so it must read as busy to the auto-update gate.
  assert.equal(m.workBusy(), true);

  // The server re-offers the pending turn — now WITH a task attached, so a
  // re-RUN would head for a worktree and a CLI and settle something else
  // entirely. The stored body must win.
  state.mode = 'ok';
  const before = calls.length;
  m.processAgentTurnJobs([{ ...job, task: { id: 'card-1', title: 'x' } }]);
  await until(() => calls.length > before);
  const second = calls[calls.length - 1];
  assert.ok(second.url.includes('agent-turn-done'));
  assert.deepEqual(second.body, firstBody, 'the re-offer must re-POST the stored body');
  await until(() => !m.workBusy());
});

/**
 * A REFUSED SETTLE STAYS HELD (2026-09-24). The server answers an already-
 * settled, expired or unknown turn with 200 `{ settled: false }`; its only 4xx
 * are an unparseable body and auth, and a WAF rule in front of it answers 403.
 * Every one leaves the turn row PENDING, so dropping the body on a 4xx meant
 * the next offer found nothing held and RAN THE CLI AGAIN — every poll, for
 * six hours. The body is the skip-guard: it stays, and only its re-POST backs
 * off.
 */
test('a settle the server refuses (4xx) stays held — the CLI is never re-run, and the re-POST backs off', async (t) => {
  const m = manager(t);
  const { calls, state } = stubFetch(t);
  state.mode = '404';
  const job = { id: 'at-2', agentId: 'ag-2', placeId: 'a-2', kind: 'task' };
  m.processAgentTurnJobs([job]);
  const doneCalls = () => calls.filter((c) => c.url.includes('agent-turn-done'));
  await until(() => doneCalls().length >= 1);
  await tick();
  const heldBody = doneCalls()[0].body;
  assert.equal(m.workBusy(), true, 'a refused body is still undelivered work');
  // The server keeps offering the pending turn — now WITH a task, so a re-RUN
  // would head for a worktree and settle something else. Inside the backoff
  // nothing goes out at all.
  const before = calls.length;
  m.processAgentTurnJobs([{ ...job, task: { id: 'card-1', title: 'x' } }]);
  await tick(120);
  assert.equal(calls.length, before, 'no CLI, no second body, no hammering inside the backoff');
  assert.equal(m.workBusy(), true);
  // The stand-down flush still carries the STORED body, and a 2xx releases it.
  state.mode = 'ok';
  await m.settleAgentTurns('stopping');
  assert.deepEqual(doneCalls()[doneCalls().length - 1].body, heldBody, 'the stored body, never a new one');
  await until(() => !m.workBusy());
});

test('a press the board can no longer serve is settled, and narrates NOTHING', async (t) => {
  const m = manager(t);
  const { calls } = stubFetch(t);
  // No cards left: refused before any CLI, which is the only plan path that
  // reaches a settle on a machine whose runtimes are whatever it happens to
  // have installed.
  m.processAgentPlanJobs([{ id: 'p-1', tasks: [] }]);
  await until(() => calls.some((c) => c.url.includes('agent-plan-done')));
  await tick();
  const at = (part) => calls.findIndex((c) => c.url.includes(part));
  assert.equal(at('agent-plan-claim'), 0, 'the claim comes first — an unleased settle is discarded');
  assert.ok(at('agent-plan-done') > 0);
  assert.match(calls[at('agent-plan-done')].body.error, /no longer on the board/);
  // A press that never ran a turn has nothing to narrate, and silence must
  // read as "this machine has not narrated" rather than as a stage nobody
  // reached. Anything invented here would be Flowviant speaking for a CLI
  // that never started.
  assert.equal(calls.filter((c) => c.url.includes('agent-plan-activity')).length, 0);
  await until(() => !m.workBusy());
});

test('postAgentPlan retries a 429 honouring Retry-After instead of dropping the settle', async (t) => {
  const m = manager(t);
  const real = globalThis.fetch;
  const calls = [];
  let doneAttempts = 0;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    calls.push({ url: u, body: typeof opts.body === 'string' ? JSON.parse(opts.body) : null });
    if (u.includes('agent-plan-claim'))
      return { ok: true, status: 200, json: async () => ({ data: { claimed: true } }) };
    if (u.includes('agent-plan-done')) {
      doneAttempts += 1;
      if (doneAttempts === 1)
        return {
          ok: false,
          status: 429,
          // Retry-After: 0 — a real header would carry a real delay, but the
          // point under test is that the header is HONOURED at all, and a
          // slow test proves nothing a fast one does not.
          headers: { get: (k) => (String(k).toLowerCase() === 'retry-after' ? '0' : null) },
          json: async () => ({}),
        };
      return { ok: true, status: 200, json: async () => ({}) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };
  t.after(() => {
    globalThis.fetch = real;
  });

  m.processAgentPlanJobs([{ id: 'p-1', tasks: [] }]);
  await until(() => calls.filter((c) => c.url.includes('agent-plan-done')).length >= 2);
  assert.equal(
    calls.filter((c) => c.url.includes('agent-plan-done')).length,
    2,
    'a 429 is retried rather than treated as the server having answered'
  );
  await until(() => !m.workBusy());
});

test('postAgentPlan treats any OTHER 4xx as delivered — no retry, no hammering', async (t) => {
  const m = manager(t);
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    calls.push({ url: u });
    if (u.includes('agent-plan-claim'))
      return { ok: true, status: 200, json: async () => ({ data: { claimed: true } }) };
    if (u.includes('agent-plan-done')) return { ok: false, status: 400, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({}) };
  };
  t.after(() => {
    globalThis.fetch = real;
  });

  m.processAgentPlanJobs([{ id: 'p-1', tasks: [] }]);
  await until(() => calls.some((c) => c.url.includes('agent-plan-done')));
  await tick(200);
  assert.equal(
    calls.filter((c) => c.url.includes('agent-plan-done')).length,
    1,
    'a considered refusal is the server’s answer, not something to retry into a hammer'
  );
  await until(() => !m.workBusy());
});

test('safeUploadName keeps the extension through a cut, the server’s safeFileName shape', () => {
  // CODE ONLY: `safeUploadName` has no seam of its own to call through the
  // manager's returned API (it is reached only via a full session turn with
  // a real attachment). The shape under test — stem cut, an 8-hex hash tag,
  // extension preserved — is identical to the behaviourally-tested versions
  // in knowledge.test.mjs and artifacts.test.mjs; this pins that it was not
  // quietly reverted to the old bare `slice(0, 80)`.
  const src = workSource();
  const fn = fnBody(src, 'safeUploadName');
  assert.ok(!/\.slice\(0,\s*80\)/.test(fn), 'no bare 80-char slice — that is what cut extensions off');
  assert.match(fn, /lastIndexOf\('\.'\)/, 'the dot is found so the extension can survive the cut');
  assert.match(fn, /safeUploadFnv1a8\(clean\)/, 'the hash rides the WHOLE sanitised name');
  const hash = fnBody(src, 'safeUploadFnv1a8');
  assert.match(hash, /0x811c9dc5/, 'FNV-1a, the server’s own hash, not a different scheme');
  assert.match(hash, /\.toString\(16\)\.padStart\(8, '0'\)/, '8 hex digits, matching the server’s fnv1a8');
});

test('a preview claim and its attribution refusal both echo the job’s shareId', async (t) => {
  const m = manager(t);
  const { calls } = stubFetch(t);
  // No real listener on this port in this worktree, so the attribution check
  // (originFor) fails honestly — the point under test is the wire shape, not
  // opening a real tunnel.
  m.processPreviewJobs([{ sessionId: 'sess-1', port: 47823, shareId: 'share-abc123' }]);
  await until(() => calls.some((c) => c.url.includes('preview-done')));
  const claim = calls.find((c) => c.url.includes('preview-claim'));
  assert.ok(claim, 'the claim went out');
  assert.equal(claim.body.shareId, 'share-abc123', 'the claim echoes the job’s shareId');
  const done = calls.find((c) => c.url.includes('preview-done'));
  assert.match(done.body.error, /nothing is listening/);
  assert.equal(done.body.shareId, 'share-abc123', 'the refusal echoes it too');
});

/**
 * CODE ONLY. The comments in `work.mjs` quote the shapes they replaced, and
 * matching over raw source fails on its own documentation — a false alarm
 * that trains the next person to weaken the pin.
 */
const workSource = () =>
  [
    'work.mjs',
    'workAgentPlans.mjs',
    'workAgentReview.mjs',
    'workAgentTurns.mjs',
    'workAgentMerges.mjs',
    'workDiffs.mjs',
    'workPreviews.mjs',
    'workProcesses.mjs',
    'workPullRequests.mjs',
    'workShip.mjs',
  ]
    .map((file) => readFileSync(new URL(`./${file}`, import.meta.url), 'utf8'))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .join('\n');
/** The body of a `const <name> = ` binding, up to the next top-level one. */
const fnBody = (src, name) => {
  const i = src.indexOf(`const ${name} = `);
  assert.ok(i > -1, `${name} must exist`);
  const j = src.indexOf('\n  const ', i + 10);
  const end = src.indexOf('\n  return { ', i + 10);
  const stop = j < 0 ? end : end < 0 ? j : Math.min(j, end);
  assert.ok(stop > i, `${name} must have a closing anchor`);
  return src.slice(i, stop);
};

test('the planning turn relays the CLI, and the relay cannot outrun its own throttle', () => {
  const src = workSource();
  // The endpoint is derived exactly as every other agent-lane post derives
  // its own — a hand-written base is how one lane ends up pointing at a
  // different deployment than the rest.
  assert.ok(
    src.includes(
      "const AGENT_PLAN_ACTIVITY_URL = FLEET_URL.replace(/\\/agents\\/?$/, '/agent-plan-activity');"
    )
  );
  const post = fnBody(src, 'postAgentPlanActivity');
  assert.ok(post.includes('AGENT_PLAN_ACTIVITY_URL'));
  assert.ok(post.includes('JSON.stringify({ planId, line: text })'), 'the wire is { planId, line }');
  // Scrubbed and capped before it leaves, in ONE place, so a phase marker
  // added later cannot skip either.
  assert.ok(post.includes("envScrub(String(line ?? '')).slice(0, 400)"));
  assert.ok(/catch\s*\{/.test(post), 'a failed narration POST must never fail the turn');

  const plan = fnBody(src, 'runAgentPlan');
  assert.ok(plan.includes('onActivity:'), 'the plan turn must forward the CLI tail it already parses');
  assert.ok(plan.includes('narrate(String(a.label))'));
  assert.ok(/now - lastPlanBeat < 2_000/.test(plan), 'same >=2s throttle the agent turn keeps');
  // Fire-and-forget: awaited narration would put a spinner in front of a turn.
  assert.ok(/void postAgentPlanActivity\(id, line\)/.test(plan));
});

test('the machine narrates the two moments only it can see, in its own voice', () => {
  const plan = fnBody(workSource(), 'runAgentPlan');
  // The CLI actually spawned — before that, "planning" is a claimed row and
  // nothing more.
  assert.ok(/onSpawn: \(ch\) => \{[\s\S]*?say\(/.test(plan));
  assert.ok(plan.includes("started on this machine"));
  // …and waiting for the checkout, which from a browser is indistinguishable
  // from a CLI that is thinking.
  assert.ok(plan.includes('placeLocks.get(REPO_PLACE)'));
  assert.ok(/busy\.writing \|\| busy\.waiters\.some/.test(plan));
  assert.ok(plan.includes('waiting for the checkout'));
});

test('a wedged planning CLI is stopped inside the server\'s expiry, and the press is settled', () => {
  const src = workSource();
  const m = src.match(/const PLAN_TURN_TIMEOUT_MS = (\d+) \* 60_000;/);
  assert.ok(m, 'the plan turn must have a cap of its own — runTurn has no timer');
  const minutes = Number(m[1]);
  // The server fails a CLAIMED press at thirty minutes, measured from
  // claimedAt. A daemon-side cap at or past that reports into a row the
  // server has already expired, which is the silence this exists to end.
  assert.ok(minutes < 30, `the cap must sit under the server's 30-minute expiry, got ${minutes}`);
  const plan = fnBody(src, 'runAgentPlan');
  assert.ok(plan.includes('PLAN_TURN_TIMEOUT_MS'));
  assert.ok(plan.includes("ch.kill('SIGKILL')"), 'the child is killed — never its group');
  assert.ok(!/kill\(-/.test(plan), 'signalling the group is the rule teardown deliberately breaks');
  // The wait ends HERE rather than on a `close` that may never arrive, and
  // the press is reported: a claimed press this daemon abandons is the wedge
  // the merge lane already wears a belt against.
  assert.ok(plan.includes('stopWaiting('));
  assert.ok(/if \(wedged\) \{[\s\S]*?postAgentPlan\(\{/.test(plan));
  assert.ok(/ran past fifteen minutes on this machine/.test(plan));
});

/**
 * THE AGENT'S RUNNING ACCOUNT RIDES THE ONE SETTLE THAT FOLLOWS A PARSED RESULT
 * (2026-09-22, 0.93.0).
 *
 * WHY THIS IS A SOURCE PIN AND NOT A ROUND TRIP, stated because a source pin is
 * the weaker instrument and this file already prefers the real wire everywhere
 * it can reach it: the body under test is built only AFTER a CLI has run and
 * produced a parseable final object, and this suite deliberately never spawns
 * one — every agent-turn case here reaches the wire through `runtime: 'nope'`,
 * which `canRun` refuses precisely so the tests do not depend on which CLIs
 * happen to be installed on the box running them. Stubbing a `claude` onto PATH
 * to reach this one line would make every case in this file hostage to that
 * stub. The DECISION the pin covers — carried when present, key ABSENT when not
 * — is exercised for real against `parseTurnResult` in `agentPlan.test.mjs`;
 * what is left here is the wiring, which is exactly what a source pin can say.
 *
 * THREE CLAIMS, and each one fails silently if it goes:
 *  · SPREAD, NOT ASSIGNED. `progress: res.progress` would put `undefined` on
 *    the body — which `JSON.stringify` drops, so it would happen to work today
 *    and would break the moment anything normalises the body. The contract is
 *    that an absent key means KEEP, and a spread is what guarantees absence.
 *  · SCRUBBED BEFORE IT IS CUT. `envScrub` replaces EXACT values, so a
 *    paragraph sliced first hands the scrub a credential already cut in half:
 *    it matches nothing and the surviving prefix ships. The check-output lane
 *    learned this the expensive way and the pre-review relearned it in review.
 *  · THE TWO `nothing` SETTLES CARRY NONE. They follow a turn that declared no
 *    outcome at all — a signed-out CLI, a crash, a quota — so there is no
 *    account to relay, and sending one would be the machine speaking for the
 *    agent.
 */
test('an agent turn relays the account the agent wrote, and never invents one (0.93.0)', () => {
  const src = workSource();
  // The whole settle body for a parsed result, bounded at both ends.
  const i = src.indexOf('const reply = await postAgentTurn({');
  assert.ok(i > -1, 'the parsed-result settle must exist');
  const j = src.indexOf('});', i);
  assert.ok(j > i, 'the parsed-result settle must close');
  const body = src.slice(i, j);
  assert.ok(
    body.includes("...(res.progress ? { progress: envScrub(res.progress).slice(0, 1000) } : {})"),
    'the account must be spread conditionally, scrubbed before it is cut'
  );

  /**
   * AND THE `nothing` SETTLES MUST NOT. Asserted over the region BEFORE the
   * parsed-result settle, which is where both of them live — the limit park and
   * the no-result backstop. A slice with both anchors checked, the standing
   * rule: a pin over an empty slice passes over nothing.
   */
  const k = src.indexOf('const res = (lastAnswer && parseTurnResult(lastAnswer)) || parseTurnResult(out);');
  assert.ok(k > -1 && k < i, 'the parse must precede the settle it feeds');
  const backstops = src.slice(k, i);
  assert.ok(backstops.includes("outcome: 'nothing'"), 'both backstop settles live here');
  assert.ok(!backstops.includes('progress'), 'a turn that declared nothing has no account to relay');
});

test('an agent turn re-measures its worktree when its CLI exits', () => {
  const turn = fnBody(workSource(), 'runAgentTurn');
  // Without this the branch diff, head sha and trailered commits an agent
  // just produced wait for the <=60s sweep, so review opens on the branch as
  // it was BEFORE the work. Fire-and-forget, because the check that may run
  // next holds this function for up to ten minutes.
  assert.ok(/void reportSessionWorktree\(place\)\.catch/.test(turn));
});

test('an agent turn carries the container\'s pinned brain into its CLI, on brainFor\'s guards alone (0.85.0)', () => {
  /**
   * `agentTurnJobs[].model/effort` (server, DAEMON_AGENT_KNOBS_MIN) reach the
   * CLI only if this lane spreads them. The failure it guards is the silent
   * substitution every floor in this product exists for: the board asserts a
   * pin, the daemon drops the keys, and the turn runs on the machine default
   * with nothing on either side saying so.
   *
   * A source pin rather than a behavioural one because the only path that
   * reaches `runTurn` spawns a real CLI — every settle this suite can reach
   * (unknown runtime, missing card, the begun-guard) returns strictly BEFORE
   * the call whose arguments are the thing under test.
   */
  const turn = fnBody(workSource(), 'runAgentTurn');
  const brainAt = turn.indexOf('const brain = brainFor(job);');
  // The argument object, not the call: the lane builds it once so the fresh
  // retry after a lost resume wears the same brain.
  const callAt = turn.indexOf('const agentTurnArgs = {');
  assert.ok(brainAt > -1, 'the agent lane must resolve a brain');
  assert.ok(callAt > brainAt, 'a brain resolved after the call is a brain the turn never wore');
  const args = turn.slice(callAt);
  assert.ok(args.includes('...brain,'), 'the pin must reach runTurn');
  // ONE VALIDATOR. brainFor drops a model this machine cannot spell and an
  // effort no CLI accepts, so a copy of either rule here would be a second
  // answer to the same question — and the two would disagree the first time
  // one of them learned a new effort.
  assert.ok(
    !/WORK_MODEL_RE|WORK_EFFORTS/.test(turn),
    'validation lives in brainFor; a second copy is a second answer'
  );
  // Absent stays ABSENT: a null reaching the builders is a value, and Claude's
  // `model || MODEL` is the only one that survives it — which is how an
  // unpinned agent stops running on the machine pin. See brainFor's docblock.
  assert.ok(!/model: job\.model|effort: job\.effort/.test(turn));
});

test('fleet.mjs and its whole import graph resolve — a stale named import fails HERE, not at daemon start', async () => {
  // `node --check` cannot see a named import of an export a sibling module
  // deleted; only linking can. This is the load that a published daemon does
  // first, so it is the one failure a test file must buy before npm does.
  const fleet = await import('./fleet.mjs');
  assert.equal(typeof fleet.runFleetDaemon, 'function');
  assert.equal(typeof fleet.shouldStop, 'function');
});

test('a capture turn runs its own prompt pair and the read-only profile (0.82.0)', async () => {
  // THE CAPTURE CHAT (server 2026-09-13): `job.capture === true` must swap in
  // SYSTEM_CAPTURE, the capture kickoff, AND `planPerm` — the scratch
  // planner's read-only permission list — because "read-only" as prose in a
  // prompt is only an instruction, and instructions are exactly what an
  // injected repo file competes with. A daemon that ran a capture job under
  // SYSTEM_WORK with build permissions would be the silent substitution
  // DAEMON_CAPTURE_MIN exists to keep unreachable.
  const src = workSource();
  assert.ok(src.includes('const captureTab = job.capture === true;'));
  assert.ok(/captureTab\s*\?\s*CAPTURE_TURN_KICKOFF/.test(src));
  assert.ok(/captureTab \? SYSTEM_CAPTURE : SYSTEM_WORK/.test(src));
  assert.ok(src.includes('planPerm: captureTab,'));
  const prompts = await import('./prompts.mjs');
  // The system prompt may only name tools the capture scope actually has —
  // telling the model to file_card/log_work (SYSTEM_WORK's vocabulary) walks
  // it into refusals all turn.
  for (const banned of ['file_card', 'log_work', 'deliver_card', 'update_session', 'ship']) {
    assert.ok(
      !prompts.SYSTEM_CAPTURE.includes(banned),
      `SYSTEM_CAPTURE must not name ${banned}`
    );
  }
  for (const needed of ['stage_card', 'stage_card_edit', 'read_card', 'list_staged', 'list_cards', 'stream_session_turn']) {
    assert.ok(prompts.SYSTEM_CAPTURE.includes(needed), `SYSTEM_CAPTURE must name ${needed}`);
  }
  assert.ok(!prompts.SYSTEM_CAPTURE.toLowerCase().includes('points'));
});

/**
 * THE BEGUN-GUARD (0.84.0) — the whole point is what does NOT happen.
 *
 * Two boxes can hold the same machine credential, and an agent's worktree, its
 * branch and its conversation exist on exactly one of them until somebody
 * approves it. Before this guard, the second box answered a begun agent's turn
 * by cutting a FRESH `session/a-<id>` off base and running a CLI with no memory
 * of the card — so the observable failures were a new branch on disk and a real
 * model turn, and both are asserted as absences here.
 *
 * `runtime: 'nope'` is how the not-firing cases stop short of a CLI: `canRun`
 * refuses an unknown runtime, which settles with a sentence of its own and is
 * reached ONLY past the guard. A test that depended on which CLIs happen to be
 * installed on the machine running the suite would prove nothing.
 */
const GUARD_SENTENCE = "This machine does not hold this agent's worktree or branch";

test('a begun agent turn on a box holding neither its worktree nor its branch is refused before anything is cut', async (t) => {
  const { m, repoRoot, baseDir } = managerIn(t);
  const { calls } = stubFetch(t);
  m.processAgentTurnJobs([
    {
      id: 'at-g1',
      agentId: 'ag-g1',
      placeId: 'a-ag-g1',
      kind: 'task',
      task: { id: 'card-g1', title: 'T' },
      begun: true,
      begunOn: 'mac-mini',
    },
  ]);
  await until(() => calls.some((c) => c.url.includes('agent-turn-done')));
  await tick();
  const settle = calls.find((c) => c.url.includes('agent-turn-done'));
  assert.equal(settle.body.outcome, 'nothing');
  // The box name is a RELAY of what the server measured, so it is quoted
  // exactly and only appears because the job carried one.
  assert.equal(
    settle.body.answer,
    "This machine does not hold this agent's worktree or branch — its work is on mac-mini. Stop the agent to re-plan it here."
  );
  // Nothing was cut and nothing was run: no directory, no branch, no CLI.
  assert.equal(existsSync(join(baseDir, 'sessions', 'a-ag-g1')), false);
  assert.equal(
    git(['branch', '--list', 'session/a-ag-g1'], repoRoot),
    '',
    'a rival branch of the same name is the damage this guard exists to prevent'
  );
  await until(() => !m.workBusy());
});

test('an unattributed begun turn says the two things it measured and guesses at no third', async (t) => {
  const { m } = managerIn(t);
  const { calls } = stubFetch(t);
  // No `begunOn`: the server has no box recorded for this agent (pre-0.84.0
  // data). Naming one anyway would be the daemon inventing where the work is.
  m.processAgentTurnJobs([
    { id: 'at-g2', agentId: 'ag-g2', placeId: 'a-ag-g2', kind: 'task', task: { id: 'c', title: 'T' }, begun: true },
  ]);
  await until(() => calls.some((c) => c.url.includes('agent-turn-done')));
  const settle = calls.find((c) => c.url.includes('agent-turn-done'));
  assert.equal(
    settle.body.answer,
    "This machine does not hold this agent's worktree or branch. Stop the agent to re-plan it here."
  );
  await until(() => !m.workBusy());
});

test('the guard does not fire when the BRANCH survives here — that is same-box recovery', async (t) => {
  const { m, repoRoot } = managerIn(t);
  const { calls } = stubFetch(t);
  // A directory somebody removed, with the committed work still on its branch.
  // `placeWtFor`'s attach fallback re-opens it, which is today's behaviour and
  // must stay reachable.
  git(['branch', 'session/a-ag-g3', 'main'], repoRoot);
  m.processAgentTurnJobs([
    {
      id: 'at-g3',
      agentId: 'ag-g3',
      placeId: 'a-ag-g3',
      kind: 'task',
      task: { id: 'c', title: 'T' },
      begun: true,
      runtime: 'nope',
    },
  ]);
  await until(() => calls.some((c) => c.url.includes('agent-turn-done')));
  const settle = calls.find((c) => c.url.includes('agent-turn-done'));
  assert.match(settle.body.answer, /cannot run nope/, 'the turn ran past the guard');
  assert.ok(!String(settle.body.answer).includes(GUARD_SENTENCE));
  await until(() => !m.workBusy());
});

test('the guard does not fire when the WORKTREE is here, nor when the turn has not begun', async (t) => {
  const { m, baseDir } = managerIn(t);
  const { calls } = stubFetch(t);
  mkdirSync(join(baseDir, 'sessions', 'a-ag-g4'), { recursive: true });
  const job = (id, place, extra) => ({
    id,
    agentId: `ag-${place}`,
    placeId: place,
    kind: 'task',
    task: { id: 'c', title: 'T' },
    runtime: 'nope',
    ...extra,
  });
  m.processAgentTurnJobs([job('at-g4', 'a-ag-g4', { begun: true })]);
  await until(() => calls.filter((c) => c.url.includes('agent-turn-done')).length >= 1);
  // …and a turn the server does NOT call begun is untouched by any of this: a
  // first turn has no worktree and no branch anywhere, which is exactly the
  // shape the guard refuses, so gating on `begun` is what keeps a fresh agent
  // startable.
  m.processAgentTurnJobs([job('at-g5', 'a-ag-g5', {})]);
  await until(() => calls.filter((c) => c.url.includes('agent-turn-done')).length >= 2);
  for (const c of calls.filter((x) => x.url.includes('agent-turn-done'))) {
    assert.match(c.body.answer, /cannot run nope/);
  }
  await until(() => !m.workBusy());
});

test('the guard is read BEFORE the worktree can be cut, and a begun turn is the only thing it reads', () => {
  const turn = fnBody(workSource(), 'runAgentTurn');
  const guardAt = turn.indexOf('if (job.begun)');
  const cutAt = turn.indexOf('const dir = placeWtFor(place);');
  assert.ok(guardAt > -1, 'the begun guard must exist');
  assert.ok(cutAt > guardAt, 'placeWtFor cuts a branch — checking after it is checking too late');
  // The branch it looks for is built from the PLACE, the same string placeWtFor
  // would name, so the two can never drift into checking for one branch and
  // cutting another.
  assert.ok(turn.includes('`refs/heads/session/${place}`'));
  assert.ok(turn.includes('--verify'), 'a missing ref must be an exit code, not a parse');
  /**
   * AN UNREADABLE REPO IS NOT AN ABSENT BRANCH. `--verify --quiet` exits 1 for a
   * ref that is not there, and that exit code IS the measurement. Every other
   * failure — 128 for "not a repository", ENOENT for no git, a momentary index
   * lock — measured nothing, and collapsing it onto "absent" would have the
   * daemon assert "this machine does not hold this agent's branch" off a repo it
   * could not read: the guard inventing the fact it exists to relay.
   */
  assert.ok(turn.includes('e?.status === 1'), 'exit 1 is the ref-absent measurement');
  assert.ok(turn.includes('branchMeasured && !existsSync(wtDir) && !hasBranch'));
});

test('the stand-down settles what is in flight and never overwrites a finished answer', async (t) => {
  const { m } = managerIn(t);
  const { calls, state } = stubFetch(t);
  // A finished turn whose settle POST failed: its real answer is held here and
  // nowhere else, so the stand-down must RETRY it rather than posting `nothing`
  // over work this machine actually did.
  state.mode = 'down';
  m.processAgentTurnJobs([{ id: 'at-s1', agentId: 'ag-s1', placeId: 'a-s1', kind: 'task' }]);
  await until(() => calls.some((c) => c.url.includes('agent-turn-done')));
  await until(() => m.workBusy());
  const held = calls.find((c) => c.url.includes('agent-turn-done')).body;
  state.mode = 'ok';
  const before = calls.length;
  await m.settleAgentTurns('The project\'s machine moved to box-b while this turn was running.');
  const after = calls.slice(before).filter((c) => c.url.includes('agent-turn-done'));
  assert.equal(after.length, 1);
  assert.deepEqual(after[0].body, held, 'a held body outranks the stand-down sentence');
});

test('an agent worktree report names the box that measured it — and a tab report does not', () => {
  const report = fnBody(workSource(), 'sessionWorktreeReport');
  // The server stores this on the agent row so a LATER turn can be checked
  // against the box that actually holds the work. Keyed on `envpub`, the same
  // identity the poll arbitrates on, because it is durable per box; the
  // hostname beside it is a label for a person and nothing else.
  assert.ok(report.includes("sessionId.startsWith('a-') && sessionId.length > 2 ? myPubB64() : null"));
  assert.ok(report.includes('...(pub ? { box: { id: pub, name: MACHINE_HOST } } : {})'));
  // THREE STATES. An unreadable keypair sends no key at all, which the server
  // reads as "nobody said" — never as "not this box", which would refuse a turn
  // on a machine that is exempt from arbitration by construction.
  assert.ok(!report.includes("box: { id: pub ?? ''"));
});

/**
 * PUBLISHING AN AGENT'S BRANCH (0.86.0) — against a REAL remote.
 *
 * Every one of these runs a real `git push` at a real bare repo in a temp dir,
 * because the failures this feature can have are git's, not JavaScript's: a
 * refspec that names the wrong side, a force flag that discards commits, a
 * delete that survives its own guard. A stub for git would test the stub.
 *
 * `runtime: 'nope'` is again how a turn settles without a CLI — `canRun`
 * refuses an unknown runtime — and it is reached PAST the begun guard and past
 * the worktree cut, which is exactly where a branch worth publishing exists.
 */
function originFor(t, repoRoot) {
  const bare = mkdtempSync(join(tmpdir(), 'fv-origin-'));
  git(['init', '-q', '--bare', '-b', 'main'], bare);
  git(['remote', 'add', 'origin', bare], repoRoot);
  git(['push', '-q', 'origin', 'main'], repoRoot);
  t.after(() => rmSync(bare, { recursive: true, force: true }));
  return bare;
}
/** '' for a ref that is not there — the absence IS the assertion in half of
 *  these, so it must not be an exception. */
const refIn = (dir, ref) => {
  try {
    return git(['rev-parse', '--verify', '--quiet', ref], dir);
  } catch {
    return '';
  }
};
const reportsIn = (calls) =>
  calls.filter((c) => c.url.includes('session-worktrees')).flatMap((c) => c.body?.reports ?? []);

test('an agent turn pushes its branch to the name the server gave it, and reports what it pushed', async (t) => {
  const { m, repoRoot } = managerIn(t);
  const bare = originFor(t, repoRoot);
  const { calls } = stubFetch(t);
  m.processAgentTurnJobs([
    {
      id: 'at-p1',
      agentId: 'ag-p1',
      placeId: 'a-ag-p1',
      kind: 'task',
      task: { id: 'c', title: 'T' },
      runtime: 'nope',
      publishTo: 'flowviant/auth-3f9a21',
    },
  ]);
  await until(() => calls.some((c) => c.url.includes('agent-turn-done')));
  await until(() => refIn(bare, 'refs/heads/flowviant/auth-3f9a21') !== '');
  // The remote ref is the LOCAL branch — the same commits, not a new branch cut
  // off base and not the checkout's HEAD.
  assert.equal(
    refIn(bare, 'refs/heads/flowviant/auth-3f9a21'),
    refIn(repoRoot, 'refs/heads/session/a-ag-p1')
  );
  /**
   * AND THE SERVER IS TOLD, because it stores nothing it was not told: it
   * composes the target name and sends it, and until a machine reports a push
   * the agent reads as never published. A push nobody reported is a ref no
   * surface may name and no later job may fetch or delete.
   */
  await until(() => reportsIn(calls).some((r) => r.published));
  const rep = reportsIn(calls).find((r) => r.published);
  assert.equal(rep.sessionId, 'a-ag-p1');
  assert.equal(rep.published.ref, 'flowviant/auth-3f9a21');
  assert.equal(rep.published.sha, refIn(repoRoot, 'refs/heads/session/a-ag-p1'));
  assert.ok(!('publishError' in rep), 'a report carries the push or the failure, never both');
  await until(() => !m.workBusy());
});

test('a push that fails is reported in git\'s own words and settles the turn anyway', async (t) => {
  const { m } = managerIn(t);
  // NO origin at all — the commonest real failure (a box with no push rights
  // is the same shape). The turn must still settle: a push is tail work.
  const { calls } = stubFetch(t);
  m.processAgentTurnJobs([
    {
      id: 'at-p2',
      agentId: 'ag-p2',
      placeId: 'a-ag-p2',
      kind: 'task',
      task: { id: 'c', title: 'T' },
      runtime: 'nope',
      publishTo: 'flowviant/auth-3f9a21',
    },
  ]);
  await until(() => calls.some((c) => c.url.includes('agent-turn-done')));
  const settle = calls.find((c) => c.url.includes('agent-turn-done'));
  assert.match(settle.body.answer, /cannot run nope/, 'the turn settled on its own terms');
  assert.ok(
    !/push|origin|publish/i.test(settle.body.answer),
    'a failed push may not colour the turn\'s own answer'
  );
  await until(() => reportsIn(calls).some((r) => r.publishError));
  const rep = reportsIn(calls).find((r) => r.publishError);
  assert.ok(!('published' in rep));
  assert.match(rep.publishError, /origin/i, 'git\'s own reason, relayed');
  assert.ok(rep.publishError.length <= 300);
  await until(() => !m.workBusy());
});

test('no target means no key — absence keeps its one meaning', async (t) => {
  const { m, repoRoot } = managerIn(t);
  originFor(t, repoRoot);
  const { calls } = stubFetch(t);
  // A project with publishing OFF, or a server older than this daemon: both
  // arrive as an absent `publishTo`, and both must leave the agent reading as
  // never published rather than as a push that failed.
  m.processAgentTurnJobs([
    {
      id: 'at-p3',
      agentId: 'ag-p3',
      placeId: 'a-ag-p3',
      kind: 'task',
      task: { id: 'c', title: 'T' },
      runtime: 'nope',
    },
  ]);
  await until(() => calls.some((c) => c.url.includes('agent-turn-done')));
  await until(() => !m.workBusy());
  assert.equal(refIn(repoRoot, 'refs/heads/flowviant/auth-3f9a21'), '');
  // The sweep is where a report comes from when no push happened, so ask for
  // one directly rather than inferring from silence.
  m.reportWorktrees(['a-ag-p3']);
  await until(() => reportsIn(calls).length > 0);
  const rep = reportsIn(calls).find((r) => r.sessionId === 'a-ag-p3');
  assert.ok(rep, 'the sweep must still measure an unpublished agent');
  assert.ok(!('published' in rep) && !('publishError' in rep));
});

test('a begun agent whose branch was published is CONTINUED here, on the commits it already made', async (t) => {
  const { m, repoRoot, baseDir } = managerIn(t);
  const bare = originFor(t, repoRoot);
  // The work as another box left it: a commit on the remote under the agent's
  // published name, and nothing on this box — no worktree, no local branch.
  git(['checkout', '-q', '-b', 'tmp-published'], repoRoot);
  writeFileSync(join(repoRoot, 'b.txt'), 'the work');
  git(['add', '-A'], repoRoot);
  git(['commit', '-qm', 'work from the other box'], repoRoot);
  const published = git(['rev-parse', 'HEAD'], repoRoot);
  git(['push', '-q', 'origin', 'tmp-published:refs/heads/flowviant/carry-3f9a21'], repoRoot);
  git(['checkout', '-q', 'main'], repoRoot);
  git(['branch', '-qD', 'tmp-published'], repoRoot);

  const { calls } = stubFetch(t);
  m.processAgentTurnJobs([
    {
      id: 'at-f1',
      agentId: 'ag-f1',
      placeId: 'a-ag-f1',
      kind: 'task',
      task: { id: 'c', title: 'T' },
      begun: true,
      begunOn: 'mac-mini',
      publishedRef: 'flowviant/carry-3f9a21',
      runtime: 'nope',
    },
  ]);
  await until(() => calls.some((c) => c.url.includes('agent-turn-done')));
  const settle = calls.find((c) => c.url.includes('agent-turn-done'));
  assert.match(settle.body.answer, /cannot run nope/, 'the turn ran past the guard');
  assert.ok(!String(settle.body.answer).includes(GUARD_SENTENCE));
  // THE COMMITS, not a fresh branch off base. This is the whole difference
  // between continuing the work and redoing it.
  assert.equal(refIn(repoRoot, 'refs/heads/session/a-ag-f1'), published);
  assert.equal(existsSync(join(baseDir, 'sessions', 'a-ag-f1')), true);
  await until(() => !m.workBusy());
});

test('a fetch that cannot land falls through to the refusal, extended with git\'s reason', async (t) => {
  const { m, repoRoot, baseDir } = managerIn(t);
  originFor(t, repoRoot);
  const { calls } = stubFetch(t);
  // The server named a ref this remote does not have — the shape is right, the
  // branch is not there. Continuing on a fetch that materialized nothing is the
  // silent redo the guard exists to prevent, wearing this feature's name.
  m.processAgentTurnJobs([
    {
      id: 'at-f2',
      agentId: 'ag-f2',
      placeId: 'a-ag-f2',
      kind: 'task',
      task: { id: 'c', title: 'T' },
      begun: true,
      begunOn: 'mac-mini',
      publishedRef: 'flowviant/gone-3f9a21',
      runtime: 'nope',
    },
  ]);
  await until(() => calls.some((c) => c.url.includes('agent-turn-done')));
  const settle = calls.find((c) => c.url.includes('agent-turn-done'));
  assert.equal(settle.body.outcome, 'nothing');
  assert.ok(settle.body.answer.startsWith(GUARD_SENTENCE), 'the existing sentence is the fallback');
  assert.match(settle.body.answer, /its work is on mac-mini/);
  assert.match(settle.body.answer, /Its published branch could not be fetched \(.+\)\./);
  // Nothing was cut and nothing was run — the guard's own assertions, which a
  // failed fetch must not weaken.
  assert.equal(refIn(repoRoot, 'refs/heads/session/a-ag-f2'), '');
  assert.equal(existsSync(join(baseDir, 'sessions', 'a-ag-f2')), false);
  await until(() => !m.workBusy());
});

test('a landed merge retires the published ref; a failed one keeps it', async (t) => {
  const { m, repoRoot, baseDir } = managerIn(t);
  const bare = originFor(t, repoRoot);
  git(['push', '-q', 'origin', 'main:refs/heads/flowviant/done-3f9a21'], repoRoot);
  git(['push', '-q', 'origin', 'main:refs/heads/flowviant/kept-3f9a21'], repoRoot);
  const { calls } = stubFetch(t);
  // A branch already on base: `count === 0` is the cheapest success this lane
  // has, and success is the only thing the delete hangs off.
  const wt = join(baseDir, 'sessions', 'a-ag-m1');
  git(['worktree', 'add', '-q', '-b', 'session/a-ag-m1', wt, 'main'], repoRoot);
  m.processAgentMergeJobs([
    {
      agentId: 'ag-m1',
      placeId: 'a-ag-m1',
      agentName: 'auth',
      stale: false,
      publishedRef: 'flowviant/done-3f9a21',
    },
  ]);
  await until(() => calls.some((c) => c.url.includes('agent-merge-done')));
  assert.equal(calls.find((c) => c.url.includes('agent-merge-done')).body.ok, true);
  await until(() => refIn(bare, 'refs/heads/flowviant/done-3f9a21') === '');

  // …and a merge that FAILED keeps its branch, which is the whole point of the
  // branch. No worktree here, so the lane reports a failure without touching
  // git at all.
  m.processAgentMergeJobs([
    {
      agentId: 'ag-m2',
      placeId: 'a-ag-m2',
      agentName: 'billing',
      stale: false,
      publishedRef: 'flowviant/kept-3f9a21',
    },
  ]);
  await until(() => calls.filter((c) => c.url.includes('agent-merge-done')).length >= 2);
  await tick();
  const second = calls.filter((c) => c.url.includes('agent-merge-done'))[1];
  assert.equal(second.body.ok, false);
  assert.notEqual(refIn(bare, 'refs/heads/flowviant/kept-3f9a21'), '');
});

test('the publish is tail work: after the settle, and outside the place lock', () => {
  const turn = fnBody(workSource(), 'runAgentTurn');
  const lockAt = turn.indexOf('await inPlace(place, place.startsWith(\'a-\')');
  /**
   * THE REVIEW-ENTRY BEAT — the project's check AND, since 0.88.0, the AI
   * pre-review, both behind `runReviewEntry`. Re-anchored when the call was
   * wrapped: a pin moves with the code it pins, and this one sliced on a string
   * the file no longer held. BOTH anchors are asserted before they are compared,
   * because `-1` makes every `>` below it silently true.
   */
  const lastAt = turn.indexOf(
    'if (reply?.review === true) await runReviewEntry(agentId, wt, job.agentName);'
  );
  const pubAt = turn.indexOf('await publishAgentBranch(place, job.publishTo)');
  assert.ok(lockAt > -1, 'the turn must still take its place lock');
  assert.ok(lastAt > -1, 'the review-entry beat must still be the last thing in the lock');
  assert.ok(pubAt > -1, 'the publish must still exist');
  assert.ok(lastAt > lockAt, 'the review-entry beat runs inside the lock, as the last thing in it');
  assert.ok(pubAt > lastAt, 'the publish must exist, after the lock block');
  /**
   * A push is a blocking network call that can hang for its whole timeout, and
   * it is worth nothing beside the turn's answer. INSIDE the lock it would hold
   * the next turn behind a remote's bad day; BEFORE the settle it would hold the
   * board behind one. The two slices are what prove both: every settle is above
   * it, and the lock block CLOSES between the last statement in it and this.
   */
  assert.ok(
    turn.slice(lockAt, pubAt).includes('postAgentTurn('),
    'the settle must be inside the lock block above'
  );
  assert.match(
    turn.slice(lastAt, pubAt),
    /\}\);/,
    'the publish sits after the closing of the inPlace block, not inside it'
  );
  // Never able to fail a turn that is already settled.
  assert.ok(/publishAgentBranch\(place, job\.publishTo\)[\s\S]{0,200}catch/.test(turn));
  // …and an ABSENT target is an instruction to forget: the sweep republishes
  // from this process's own memory, so without this a project that turned
  // publishing off went on pushing for the life of the daemon.
  assert.ok(turn.includes('if (!job.publishTo) {'), 'the absent target must be handled, not ignored');
  assert.ok(turn.includes('agentPublished.delete(place);'));
  assert.ok(turn.includes('agentRemoteAt.delete(place);'));
});

/**
 * THE RETIREMENT IS TAIL WORK TOO — the same placement argument the publish
 * above makes, which this half did not make when it shipped.
 *
 * The delete hung off `report`, and every `report` call in `runAgentMerge` is
 * inside `inPlace(place, true, …)` — the place WRITER lock. `gitNet` is
 * `execFileSync`, so a stalling remote held this agent's lock and blocked the
 * event loop for up to a minute AFTER the merge had already settled, with
 * nothing left that the delay served.
 */
test('the published ref is retired after the settle and outside the place lock', () => {
  const fn = fnBody(workSource(), 'runAgentMerge');
  const lockAt = fn.indexOf('await inPlace(place, true, async () => {');
  const finallyAt = fn.indexOf("detail: 'the merge did not complete — check the daemon log',");
  const delAt = fn.indexOf('publishDeleteArgs(landedRef)');
  assert.ok(lockAt > -1, 'the merge must still take the place writer lock');
  assert.ok(finallyAt > lockAt, 'the unreported belt closes the lock block');
  assert.ok(delAt > finallyAt, 'the delete must sit past the lock block, in the tail');
  // In the `finally`, so a throw between the ok settle and the end of the
  // locked block cannot strand a ref no later merge job will ever carry.
  assert.ok(fn.slice(0, delAt).lastIndexOf('} finally {') > lockAt);
  // `report` RECORDS the ref and nothing else — one place, so a fourth success
  // site cannot forget it — and only on a success.
  assert.ok(fn.includes("if (body?.ok === true) landedRef = job.publishedRef ?? null;"));
  // The record goes with the ref, or the next sweep pushes it straight back as
  // an orphan no later merge job can ever carry.
  assert.ok(fn.slice(delAt - 400, delAt).includes('agentPublished.delete(place);'));
});

/**
 * THE PULL REQUEST'S HEAD IS THE PUBLISHED REF (0.86.0).
 *
 * PR mode pushed `session/a-<uuid>` and opened the PR on it, so on the projects
 * this feature is most for — the ones where people read branches in a host UI —
 * the branch under review was the opaque name the feature exists to replace,
 * the readable `flowviant/*` ref was the one the cleanup retired, and the uuid
 * ref outlived every merge. Pinned in the source because `gh` is not runnable
 * here, and pinned as all four call sites because three of four would leave the
 * PR pointing at a head nobody pushed.
 */
test('a PR-mode merge reviews and retires ONE ref — the published one', () => {
  const fn = fnBody(workSource(), 'runAgentMerge');
  const prAt = fn.indexOf('if (job.prMode) {');
  const verifyAt = fn.indexOf('const tipOnBase = () => {');
  assert.ok(prAt > -1 && verifyAt > prAt, 'the PR block must still exist, above the verify');
  const pr = fn.slice(prAt, verifyAt);
  assert.ok(
    pr.includes('ownBranch && isPublishRef(job.publishedRef) ? job.publishedRef : branch'),
    'the head is the published ref, and only for this agent’s own branch'
  );
  assert.ok(pr.includes("const ownBranch = branch === `session/${place}`;"));
  for (const call of [
    "execFileSync('gh', ['pr', 'view', head,",
    "['pr', 'create', '--head', head,",
    "execFileSync('gh', ['pr', 'merge', head,",
  ]) {
    assert.ok(pr.includes(call), `the PR head is not carried into: ${call}`);
  }
  // The push that precedes them carries the same lease the publish lane uses,
  // and is TIMED — it runs inside the writer lock.
  assert.ok(pr.includes('publishPushArgs(place, head, seen?.ref === head ? seen.sha : null)'));
  assert.ok(/gitNet\(\s*publishPushArgs\(place, head/.test(pr));
});

test('a fetch is only a continue once the branch is MEASURED here', () => {
  const fn = fnBody(workSource(), 'fetchPublishedBranch');
  /**
   * A fetch that exits 0 having created nothing is not a failure git reports —
   * and continuing on one walks straight into `placeWtFor` cutting a fresh
   * branch off base, which is the context-free redo the begun guard exists to
   * prevent, wearing this feature's name. So the ref is re-READ before `ok`,
   * and `ok` is the only answer the caller continues on.
   */
  const fetchAt = fn.indexOf('gitNet(args');
  const verifyAt = fn.indexOf('const sha = agentBranchSha(place);');
  const okAt = fn.indexOf('return { ok: true }');
  assert.ok(fetchAt > -1 && verifyAt > fetchAt, 'the ref must be re-read after the fetch');
  assert.ok(okAt > verifyAt, 'ok may only be returned past the measurement');
  // Three answers, because two would lie: nothing to try, a measured failure,
  // and a measured success. `null` must leave the refusal sentence untouched.
  assert.ok(fn.includes('if (!args) return null;'));
  /**
   * AND THE FETCH IS AN OBSERVATION OF THE REMOTE, recorded as one. A box that
   * continues an agent it never started has seen that ref exactly once — here —
   * and without recording it, its own first push would carry no lease.
   */
  const seenAt = fn.indexOf('agentRemoteAt.set(place, { ref, sha })');
  assert.ok(seenAt > verifyAt && seenAt < okAt, 'a measured fetch must record what it saw');
});

/**
 * THE LEASE IS THIS PROCESS'S OWN SIGHTING — proven against a real remote, with
 * this daemon's own `git fetch` in the middle of it.
 *
 * The bare `--force-with-lease` expects the remote-tracking ref, and the
 * worktree sweep refreshes that ref itself. The sequence below is what that
 * costs: a rival box publishes over the same name, OUR fetch learns it, and the
 * next push then overwrites the rival's commits with the lease still nominally
 * held. With the explicit lease the same push is refused and REPORTED, which is
 * the promise `agentPublish.mjs` makes in its own comment.
 */
test('a rival push is refused even after this daemon has fetched the ref', async (t) => {
  const { m, repoRoot, baseDir } = managerIn(t);
  const bare = originFor(t, repoRoot);
  const { calls } = stubFetch(t);
  const job = (id) => ({
    id,
    agentId: 'ag-l1',
    placeId: 'a-ag-l1',
    kind: 'task',
    task: { id: 'c', title: 'T' },
    runtime: 'nope',
    publishTo: 'flowviant/lease-3f9a21',
  });
  m.processAgentTurnJobs([job('at-l1')]);
  await until(() => refIn(bare, 'refs/heads/flowviant/lease-3f9a21') !== '');
  await until(() => !m.workBusy());
  const ours = refIn(repoRoot, 'refs/heads/session/a-ag-l1');

  // ANOTHER BOX publishes over the same name. Its commit is the one this must
  // not discard.
  git(['checkout', '-q', '-b', 'tmp-rival'], repoRoot);
  writeFileSync(join(repoRoot, 'rival.txt'), 'the other box');
  git(['add', '-A'], repoRoot);
  git(['commit', '-qm', 'from the other box'], repoRoot);
  const rival = git(['rev-parse', 'HEAD'], repoRoot);
  git(['push', '-q', '--force', 'origin', 'tmp-rival:refs/heads/flowviant/lease-3f9a21'], repoRoot);
  git(['checkout', '-q', 'main'], repoRoot);
  git(['branch', '-qD', 'tmp-rival'], repoRoot);
  // …AND THIS DAEMON LEARNS OF IT, exactly as the worktree sweep does on its own
  // beat. This one line is what launders a bare lease.
  git(['fetch', 'origin', '--quiet'], repoRoot);
  assert.notEqual(rival, ours);

  // Our branch moves on, and the next turn publishes it.
  const wt = join(baseDir, 'sessions', 'a-ag-l1');
  writeFileSync(join(wt, 'ours.txt'), 'our work');
  git(['add', '-A'], wt);
  git(['commit', '-qm', 'our later work'], wt);
  const before = calls.length;
  m.processAgentTurnJobs([job('at-l2')]);
  await until(() => calls.slice(before).some((c) => c.url.includes('agent-turn-done')));
  await until(() => !m.workBusy());

  // THE RIVAL'S COMMIT IS STILL THERE. A rival writer is a failure we report,
  // never work we silently discard.
  assert.equal(refIn(bare, 'refs/heads/flowviant/lease-3f9a21'), rival);
  await until(() => reportsIn(calls).some((r) => r.publishError));
  assert.match(reportsIn(calls).find((r) => r.publishError).publishError, /stale info|rejected/i);
});

/**
 * TURNING THE SWITCH OFF STOPS THE PUSHING, and the sweep is where it did not.
 *
 * The settle path reads `job.publishTo` and so honours the switch immediately;
 * the SWEEP republishes from this process's own memory, which no toggle ever
 * cleared — so an already-publishing agent went on pushing every commit it made
 * for the life of the daemon, while the settings copy said "publishes nothing
 * further". The absent key is the instruction to forget.
 */
test('an absent target makes the sweep forget the agent, not keep pushing it', async (t) => {
  const { m, repoRoot, baseDir } = managerIn(t);
  const bare = originFor(t, repoRoot);
  const { calls } = stubFetch(t);
  m.processAgentTurnJobs([
    {
      id: 'at-o1',
      agentId: 'ag-o1',
      placeId: 'a-ag-o1',
      kind: 'task',
      task: { id: 'c', title: 'T' },
      runtime: 'nope',
      publishTo: 'flowviant/off-3f9a21',
    },
  ]);
  await until(() => refIn(bare, 'refs/heads/flowviant/off-3f9a21') !== '');
  await until(() => !m.workBusy());
  const published = refIn(bare, 'refs/heads/flowviant/off-3f9a21');

  // The owner turns publishing off; the branch moves on regardless.
  const wt = join(baseDir, 'sessions', 'a-ag-o1');
  writeFileSync(join(wt, 'after.txt'), 'work done after the switch');
  git(['add', '-A'], wt);
  git(['commit', '-qm', 'after the switch'], wt);
  m.processAgentTurnJobs([
    {
      id: 'at-o2',
      agentId: 'ag-o1',
      placeId: 'a-ag-o1',
      kind: 'task',
      task: { id: 'c', title: 'T' },
      runtime: 'nope',
    },
  ]);
  await until(() => calls.filter((c) => c.url.includes('agent-turn-done')).length >= 2);
  await until(() => !m.workBusy());
  // The sweep is the leak's road — ask for one directly rather than waiting a
  // minute for the beat.
  m.reportWorktrees(['a-ag-o1']);
  await until(() => reportsIn(calls).some((r) => r.sessionId === 'a-ag-o1'));
  await tick();
  assert.equal(
    refIn(bare, 'refs/heads/flowviant/off-3f9a21'),
    published,
    'a switched-off project must not keep pushing an agent it already published'
  );
});

// ── THE AI PRE-REVIEW ─────────────────────────────────────────────────────────
//
// A fresh Claude reads the branch before the human does. Everything under pin
// here is a property whose failure is silent: a reviewer spawned on the wrong
// beat spends the operator's quota on every settle; one that resumed the agent's
// own conversation produces self-approval wearing a second reader's name; one
// that posts an unparseable answer puts a paragraph nobody wrote on the surface
// where a merge is decided.

test('the reviewer runs ONLY on the review-entry beat, and only through one door', () => {
  const src = workSource();
  /**
   * ONE CALL SITE, and it is inside `runReviewEntry`. The mutation this exists
   * to catch is the obvious one — spawning the reviewer after EVERY settle
   * rather than after the settles that emptied a queue — which on a busy board
   * is a model call per card instead of one per branch.
   */
  assert.equal(
    (src.match(/await runPrecheck\(/g) ?? []).length,
    1,
    'exactly one caller: the review-entry beat'
  );
  assert.equal(
    (src.match(/await runCheck\(/g) ?? []).length,
    1,
    'the check goes through the same door, so the two cannot drift apart'
  );
  const entry = fnBody(src, 'runReviewEntry');
  assert.ok(entry.includes('await runCheck(agentId, wt)'));
  assert.ok(entry.includes('await runPrecheck(agentId, wt, agentName)'));
  assert.ok(
    entry.indexOf('runCheck(') < entry.indexOf('runPrecheck('),
    'the cheap local command lands on the row before the model call'
  );
  // Neither may throw past the beat: `runAgentMerge` settles a CLAIMED merge
  // after this returns, and an escape there leaves it unreported until its
  // lease lapses.
  assert.equal((entry.match(/catch\s*\{/g) ?? []).length, 2);

  /**
   * EVERY REVIEW-ENTRY BEAT, AND NOTHING ELSE. Three call sites: the settle
   * reply, the held body's re-POST, and the stale-merge re-read after base is
   * folded in. A fourth appearing here without a `review === true` guard (or the
   * merge's own `job.stale` branch) is the mutation this counts.
   */
  // The definition is `const runReviewEntry = async (` and does not match; what
  // this counts is CALLS.
  const beats = src.match(/runReviewEntry\(/g) ?? [];
  assert.equal(beats.length, 3, 'exactly three beats own review entry');
  assert.ok(src.includes('if (reply?.review === true) await runReviewEntry(agentId, wt, job.agentName);'));
  assert.ok(src.includes('runReviewEntry(String(job.agentId || \'\'), wt, job.agentName)'));
  const merge = fnBody(src, 'runAgentMerge');
  assert.ok(merge.includes('await runReviewEntry(agentId, wt, job.agentName);'));
});

test('the reviewer is a STRANGER: fresh conversation, read-only, no MCP', () => {
  const pre = fnBody(workSource(), 'runPrecheck');
  // The whole design in one absence. A resumed turn would be the agent grading
  // its own homework out of the context that produced the work.
  assert.ok(!/\bresume\b\s*[:,]/.test(pre), 'no resume — a second reader has no conversation');
  assert.ok(pre.includes('readOnly: true'), 'consultPermFor: no Write, no Edit, no mkdir, no rm');
  assert.ok(!pre.includes('mcpArgs'), 'no control plane on this turn at all');
  assert.ok(!pre.includes('mcpConfig'));
  assert.ok(pre.includes('system: SYSTEM_PRECHECK'));
  // IN the agent's worktree: it needs the code and the diff.
  assert.ok(pre.includes('cwd: wt'));
  assert.ok(pre.includes("pickRuntimeFor('consult')"));
});

test('the reviewer is bounded: admission, a cap under the check\'s, and a quota skip', () => {
  const src = workSource();
  const pre = fnBody(src, 'runPrecheck');
  // The pressure guard every unattended lane asks. `churn`, never
  // `interactive`: nobody is watching a label.
  assert.ok(pre.includes("const hold = admit('churn');"));
  assert.ok(pre.includes('admit.reserve()'));
  assert.ok(/releaseSlot\(\)/.test(pre));

  const m = src.match(/const PRECHECK_TIMEOUT_MS = (\d+) \* 60_000;/);
  assert.ok(m, 'runTurn has no timer of its own — this turn must carry a cap');
  const minutes = Number(m[1]);
  const check = Number(src.match(/const CHECK_TIMEOUT_MS = (\d+) \* 60_000;/)[1]);
  assert.ok(
    minutes < check,
    `a label must not outlast the check it rides behind (got ${minutes} vs ${check})`
  );
  assert.ok(pre.includes("ch.kill('SIGKILL')"), 'the child is killed — never its group');
  assert.ok(!/kill\(-/.test(pre));
  // A wedged reading posts NOTHING: there is no row to settle, and absence is
  // what a machine that never ran one already leaves.
  assert.ok(/if \(wedged\) \{[\s\S]{0,200}return;/.test(pre));

  /**
   * A QUOTA LIMIT SKIPS, AND NEVER PARKS. `postAgentParked` stops every agent on
   * the project because the CLI login is shared — the right answer for real
   * work, and catastrophic for an optional label.
   */
  assert.ok(pre.includes('if (limitLine(out))'));
  assert.ok(!pre.includes('postAgentParked'), 'a label may never stall the fleet');

  /**
   * …AND A LIMIT IS ONLY A LIMIT WHEN NOTHING PARSED (review, 2026-09-17).
   *
   * `limitLine` matches a literal phrase over the CLI's WHOLE output, and under
   * `answerFromResult` that output is the reviewer's own answer — so a triage of
   * rate-limiting code read as a quota failure and threw a good reading away.
   * The agent-turn lane fixed the identical false positive once; this pins the
   * ORDER rather than the presence, because the broken version contained both
   * lines.
   */
  assert.ok(
    pre.indexOf('parsePrecheck(out') < pre.indexOf('limitLine(out)'),
    'parse first: a pre-review that mentions a rate limit is not a rate limit'
  );
  assert.ok(
    /if \(!result\) \{[\s\S]{0,400}limitLine\(out\)/.test(pre),
    'the limit branch is reached only when the reading produced nothing'
  );
});

test('a malformed answer posts nothing, and everything that does leave is scrubbed BEFORE it is cut', () => {
  const src = workSource();
  const pre = fnBody(src, 'runPrecheck');
  assert.ok(pre.includes('parsePrecheck(out, envScrub)'), 'the scrub rides INTO the parser');
  assert.ok(/if \(!result\) \{[\s\S]{0,400}return;/.test(pre), 'an unparseable triage is not a triage');

  /**
   * THE ORDER, NOT THE PRESENCE (review, 2026-09-17).
   *
   * This lane shipped `envScrub(cd.note).slice(0, 400)` over a note
   * `parsePrecheck` had ALREADY cut to 400 — and `scrub` is an exact full-value
   * replace, so a credential straddling that cut arrived pre-severed, matched
   * nothing, and its prefix was rendered to every member of the project. That is
   * byte-for-byte the bug `runCheck`'s output lane records learning the
   * expensive way. The old pin asserted only that `envScrub(` appeared, which
   * was true of the broken order; this asserts the cut comes after the scrub,
   * inside the one function that holds the whole field.
   */
  // BOTH ANCHORS BEFORE THE SLICE — a pin that slices on a missing anchor
  // asserts over nothing, which this repo has caught itself doing five times.
  const planSrc = readFileSync(new URL('./agentPlan.mjs', import.meta.url), 'utf8');
  const from = planSrc.indexOf('export function parsePrecheck(');
  const to = planSrc.indexOf('\n}', from);
  assert.ok(from > -1 && to > from, 'parsePrecheck must exist to be pinned');
  const parse = planSrc.slice(from, to);
  assert.ok(parse.includes('parsePrecheck(text, scrub'), 'the scrub is a parameter, not an afterthought');
  for (const field of ['scrub(c.note.trim())', 'scrub(parsed.overall.trim())']) {
    const at = parse.indexOf(field);
    assert.ok(at > -1, `${field}: the whole field is redacted first`);
    const cut = parse.indexOf('.slice(0, MAX_PRECHECK', at);
    assert.ok(cut > at, `${field}: and only then capped`);
  }
  // …and nothing downstream re-cuts what the parser already sized, which is how
  // a second cap silently reintroduces the same straddle.
  assert.ok(!/envScrub\((?:cd\.note|result\.overall)\)/.test(pre));
  assert.ok(!/cd\.note\.slice|result\.overall\.slice/.test(pre));

  // The head the reading belongs to — the `checkFingerprint` shape, so a later
  // commit voids it rather than letting an old reading label a new branch.
  assert.ok(pre.includes("git(['rev-parse', 'HEAD'], wt)"));
  assert.ok(pre.includes('...(headSha ? { headSha } : {})'));
});

/**
 * THE READING DELETES ITS OWN TRANSCRIPT, and an absent call is invisible to
 * every other test in this file (review, 2026-09-17).
 *
 * The agent resumes with `--continue`, which is CWD-KEYED, and this is the only
 * thing in the daemon that runs a SECOND `claude -p` in an agent's worktree. Its
 * leftover `~/.claude/projects/<munged-cwd>/<id>.jsonl` is the newest
 * conversation there, so the agent's next turn — a send-back's re-queued card, a
 * merge-resolve, a human's typed answer — resumes the read-only stranger's
 * diff-triage under build permissions.
 */
test('the pre-review leaves no conversation behind for the agent to resume', () => {
  const pre = fnBody(workSource(), 'runPrecheck');
  assert.ok(pre.includes('onInit:'), 'the session id is harvested off the stream, not probed');
  assert.ok(/preSession = i\.sessionId\.trim\(\)/.test(pre));
  assert.ok(
    pre.includes('removeProbeTranscript(wt, preSession)'),
    'the same cleanup the skills probe and the dev-command resolver already use'
  );
  // In the `finally`, so a wedged, killed or thrown turn cleans up too — every
  // one of them leaves the file behind.
  const fin = pre.slice(pre.indexOf('} finally {'));
  assert.ok(fin.includes('removeProbeTranscript(wt, preSession)'), 'on every exit, not just the happy one');
});

test('a permanent refusal is delivered-and-done; a blip is retried once', () => {
  const src = workSource();
  assert.ok(
    src.includes("const AGENT_PRECHECK_URL = FLEET_URL.replace(/\\/agents\\/?$/, '/agent-precheck');")
  );
  const post = fnBody(src, 'postPre');
  /**
   * THE `postAgentTrace` SPLIT, for the same reason: a server with no such route
   * 404s this body and will 404 every retry of it, so re-sending is a wedge
   * wearing a retry's clothes. There is NO version floor here — an older daemon
   * never posts, and an older server simply never learns the pre-review.
   */
  assert.ok(
    post.includes(
      'res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429'
    )
  );
  assert.ok(/catch \{\s*return false;/.test(post), 'a network error stays retryable');
  const pre = fnBody(src, 'runPrecheck');
  assert.ok(
    pre.includes('if (!(await postPre(body))) await postPre(body);'),
    'ONE retry — the body cost a whole model call'
  );
});

test('the card spec is stashed as the agent is given it, from ONE builder', () => {
  const turn = fnBody(workSource(), 'runAgentTurn');
  assert.ok(turn.includes("sessionMetaPath(wt, 'flowviant-agent-cards', agentId)"));
  assert.ok(turn.includes('AGENT_TASK_SPEC(job.task)'));
  // BEFORE the CLI runs, so a turn that crashes still leaves behind the spec
  // its commits were made against.
  const stashAt = turn.indexOf('stashCard(');
  const runAt = turn.indexOf('out = await runTurn(');
  assert.ok(stashAt > -1 && runAt > -1);
  assert.ok(stashAt < runAt, 'the spec is written down before the card is handed over');
  // …and the reviewer reads the same builder's output, so what it judges
  // against is byte-identical to what the agent was given.
  const pre = fnBody(workSource(), 'runPrecheck');
  assert.ok(pre.includes("readStash(sessionMetaPath(wt, 'flowviant-agent-cards', agentId))"));
});

/**
 * MISSING SPECS ARE MEASURED, NEVER INVENTED. A box that adopted this agent
 * mid-run holds only the prompts IT typed; the count is the difference between
 * the `Flowviant-Task:` trailers on the branch and the specs on this disk.
 */
test('a box that holds only half the specs says so, from the branch\'s own trailers', () => {
  const src = workSource();
  const log = fnBody(src, 'branchLog');
  // The trailer scan itself lives in taskIdsFromMessage (worktreeDiff.mjs,
  // pinned against 'Flowviant-Task:' there) — a LINEAR reader, replacing a
  // regex whose `\s*$` was quadratic against a long run of whitespace on one
  // line (audit 2026-09-24). branchLog calls it over the real commit log
  // text rather than fabricating ids.
  assert.ok(log.includes('taskIdsFromMessage(out)'), 'the ids come off the commits, not from a guess');
  assert.ok(/catch \{[\s\S]{0,120}return \{ text: '', taskIds: \[\] \};/.test(log),
    'an unreadable range costs the context, never the beat');
  const pre = fnBody(src, 'runPrecheck');
  assert.ok(pre.includes('const held = new Set(stash.map((s) => s.taskId));'));
  assert.ok(pre.includes('log.taskIds.filter((id) => !held.has(id)).length'));
  assert.ok(pre.includes('missingSpecs,'));
});

test('an ordinary settle runs no pre-review and posts nothing about one', async (t) => {
  const m = manager(t);
  const { calls } = stubFetch(t);
  // The no-task refusal: a real settle on a path that never emptied a queue.
  // The stub answers `{claimed:true}` and NO `review` flag, which is what an
  // ordinary turn's reply looks like.
  m.processAgentTurnJobs([{ id: 'at-9', agentId: 'ag-9', placeId: 'a-9', kind: 'task' }]);
  await until(() => calls.some((c) => c.url.includes('agent-turn-done')));
  await tick(120);
  assert.equal(
    calls.filter((c) => c.url.includes('agent-precheck')).length,
    0,
    'no pre-review without a review-entry beat'
  );
  assert.equal(calls.filter((c) => c.url.includes('agent-check-done')).length, 0);
});

/**
 * WHAT A TURN SPENT REACHES THE SERVER ON EVERY SETTLE A CLI ACTUALLY RAN
 * (2026-09-19), and on none of the ones it did not.
 *
 * This is a source pin because the behaviour it guards lives past a real
 * `claude -p`: the fake wire above reaches the agent lane only through the
 * refusals, which are exactly the settles that must carry NO usage. So the
 * runtime tests here prove the absence and this proves the presence.
 *
 * THE FOUR THAT CARRY IT are the four that follow the turn: the limit park,
 * the no-result backstop, the missing-artifact settle (0.97.0) and the main
 * settle. A turn that hit a limit or
 * produced nothing parseable still spent real tokens, and a counter that only
 * charged the happy path would under-report precisely the runs somebody opens
 * the number to understand.
 *
 * THE ONES THAT MUST NOT are the pre-spawn refusals (a traversal place, a
 * missing card, the begun-guard) and the teardown sweep — nothing ran there.
 * `usage` is null on every one of them by construction, which is what makes the
 * spread its own guard; the pin is on the spread being spelled that way, since
 * an unconditional `usage` key would post `null` and read as a measured zero.
 */
test('every settle that follows a CLI carries what it spent, and no other does', () => {
  const src = workSource();
  const turn = fnBody(src, 'runAgentTurn');
  assert.ok(turn.includes('let usage = null;'), 'held across the turn, for every settle below');
  assert.ok(
    /onUsage: \(u\) => \{\s*usage = \{ \.\.\.u, runtime: rt \};\s*\},/.test(turn),
    'SET, never accumulated — one turn is one result event, and the adding-up is the server\'s'
  );
  const spread = '...(usage ? { usage } : {}),';
  // FOUR since 0.97.0: a design or research turn that delivered without
  // writing its artifact settles `nothing` AFTER the CLI ran, so it spent real
  // tokens and carries them like the other three.
  assert.equal(
    turn.split(spread).length - 1,
    4,
    'the limit park, the no-result backstop, the missing-artifact settle and the main settle — those four and no more'
  );
  // The teardown sweep re-POSTs stored bodies and settles the rest as
  // `nothing`; nothing ran in it, so it may not invent a spend.
  const sweep = fnBody(src, 'settleAgentTurns');
  assert.ok(!sweep.includes('usage'), 'a turn nobody ran charges nothing');

  // …AND THE PRE-REVIEW, which charges the AGENT and never a card link: a
  // reading belongs to no card, which is why the link totals can never sum to
  // the container's.
  const pre = fnBody(src, 'runPrecheck');
  assert.ok(pre.includes('let usage = null;'));
  assert.ok(/onUsage: \(u\) => \{\s*usage = \{ \.\.\.u, runtime: rt \};\s*\},/.test(pre));
  assert.ok(pre.includes(spread), 'on the /fleet/agent-precheck body');
});

/**
 * A REFUSED TURN POSTS NO SPEND — the other half of the pin above, at runtime.
 * The begun-guard settles before anything is cut, so its body is the shape of
 * every pre-spawn refusal: an outcome, a sentence, and no claim about tokens.
 */
test('a settle that refused before spawning claims no tokens', async (t) => {
  const { m } = managerIn(t);
  const { calls } = stubFetch(t);
  m.processAgentTurnJobs([
    { id: 'at-u1', agentId: 'ag-u1', placeId: 'a-ag-u1', kind: 'task', task: { id: 'c', title: 'T' }, begun: true },
  ]);
  await until(() => calls.some((c) => c.url.includes('agent-turn-done')));
  const settle = calls.find((c) => c.url.includes('agent-turn-done'));
  assert.equal(settle.body.outcome, 'nothing');
  assert.equal('usage' in settle.body, false, 'absent, never a zeroed object');
  await until(() => !m.workBusy());
});

/**
 * ITERATION KEEPS THE KIND (2026-09-23). A send-back from the review deck is a
 * `human` turn, and on an agent whose queue has emptied it names NO card — so a
 * posture read off `job.task` alone ran it as a BUILD turn under the code
 * contract, on a design agent. The server now projects the kind onto the JOB;
 * this pins that the lane reads it there first and the card's key second.
 */
test('the agent turn takes its kind from the job before the card', () => {
  const turn = fnBody(workSource(), 'runAgentTurn');
  // Canary: this IS the agent lane.
  assert.ok(turn.includes('AGENT_HUMAN_KICKOFF({'));
  assert.ok(turn.includes('const taskKind = agentTaskKindOf(job.taskKind ?? job.task?.taskKind);'));
  assert.ok(!turn.includes('agentTaskKindOf(job.task?.taskKind)'), 'never the card key alone');
});

/**
 * …AND AT RUNTIME: a card-less human turn carrying `taskKind: 'design'` is
 * judged under the design posture — which only Claude declares, so on another
 * runtime it is refused in the design sentence BEFORE anything spawns. The
 * canary is the same job with no kind on an unknown runtime: that is a build
 * turn, refused in the build sentence — so the words, not the refusal, are what
 * prove the job's key was read.
 */
test('a card-less send-back on a design agent runs under the design posture', async (t) => {
  const { m } = managerIn(t);
  const { calls } = stubFetch(t);
  m.processAgentTurnJobs([
    { id: 'at-k1', agentId: 'ag-k1', placeId: 'a-ag-k1', kind: 'human', body: 'make the hero bigger', runtime: 'codex', taskKind: 'design' },
    { id: 'at-k2', agentId: 'ag-k2', placeId: 'a-ag-k2', kind: 'human', body: 'make the hero bigger', runtime: 'no-such-cli' },
  ]);
  await until(() => calls.filter((c) => c.url.includes('agent-turn-done')).length >= 2);
  const settle = (id) => calls.find((c) => c.url.includes('agent-turn-done') && c.body.turnId === id).body;
  assert.equal(settle('at-k1').outcome, 'nothing');
  assert.equal(settle('at-k1').answer, 'design and research cards run on Claude on this machine');
  assert.equal(settle('at-k2').answer, 'this machine cannot run no-such-cli');
  await until(() => !m.workBusy());
});

/**
 * THREE WIRINGS A ROUND TRIP HERE CANNOT REACH (2026-09-24) — each sits behind
 * a CLI that actually ran, which this suite deliberately never spawns (see the
 * account pin above for why). Each failed silently:
 *  · an agent's process group was recorded under the bare agent id while every
 *    reader asks with its PLACE, so its watcher reported `processes: []` and a
 *    dead entry per turn filled the registry;
 *  · the Deploy-press planner left its transcript in the checkout, where it
 *    became the newest terminal session the operator's `+` menu and their own
 *    `claude --continue` saw;
 *  · raised cards went out unscrubbed beside a scrubbed answer.
 */
test('an agent group is recorded under its place, the planner removes its transcript, raised cards are scrubbed', () => {
  const src = workSource();
  const turn = fnBody(src, 'runAgentTurn');
  assert.ok(turn.includes('noteSessionGroup(place, ch.pid)'));
  assert.ok(!turn.includes('noteSessionGroup(agentId'), 'never the bare agent id');
  const plan = fnBody(src, 'runAgentPlan');
  assert.ok(plan.includes('planSession = i.sessionId.trim()'), 'the planner learns its own conversation');
  assert.ok(plan.includes('removeProbeTranscript(repoRoot, planSession)'), '…and removes it');
  assert.ok(!turn.includes('{ raised: res.raised }'), 'raised cards never ride verbatim');
  assert.ok(turn.includes('title: envScrub(r.title).slice(0, 300)'));
  assert.ok(turn.includes('brief: envScrub(r.brief).slice(0, 2000)'));
});
