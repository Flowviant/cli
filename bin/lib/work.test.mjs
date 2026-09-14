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

test('a settle the server refuses (4xx) is dropped rather than retried forever', async (t) => {
  const m = manager(t);
  const { calls, state } = stubFetch(t);
  state.mode = 'down';
  const job = { id: 'at-2', agentId: 'ag-2', placeId: 'a-2', kind: 'task' };
  m.processAgentTurnJobs([job]);
  await until(() => calls.some((c) => c.url.includes('agent-turn-done')));
  await until(() => m.workBusy());
  // The server says this settle will never be accepted (expired, already
  // settled). Holding the body past that is a wedge wearing retry's clothes.
  // Offer until the re-POST has gone out (a single offer can race the first
  // attempt's in-flight guard), then STOP offering — which is what the server
  // does once the row is settled or expired; a turn it kept offering after a
  // drop would honestly be fresh work.
  state.mode = '404';
  const doneCalls = () => calls.filter((c) => c.url.includes('agent-turn-done'));
  const heldBody = doneCalls()[0].body;
  await until(() => {
    if (doneCalls().length < 2) {
      m.processAgentTurnJobs([job]);
      return false;
    }
    return true;
  });
  assert.deepEqual(doneCalls()[1].body, heldBody, 'the retry must be the stored body');
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

/**
 * CODE ONLY. The comments in `work.mjs` quote the shapes they replaced, and
 * matching over raw source fails on its own documentation — a false alarm
 * that trains the next person to weaken the pin.
 */
const workSource = () =>
  readFileSync(new URL('./work.mjs', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .join('\n');
/** The body of a `const <name> = ` binding, up to the next top-level one. */
const fnBody = (src, name) => {
  const i = src.indexOf(`const ${name} = `);
  assert.ok(i > -1, `${name} must exist`);
  const j = src.indexOf('\n  const ', i + 10);
  return src.slice(i, j > -1 ? j : src.length);
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

test('an agent turn re-measures its worktree when its CLI exits', () => {
  const turn = fnBody(workSource(), 'runAgentTurn');
  // Without this the branch diff, head sha and trailered commits an agent
  // just produced wait for the <=60s sweep, so review opens on the branch as
  // it was BEFORE the work. Fire-and-forget, because the check that may run
  // next holds this function for up to ten minutes.
  assert.ok(/void reportSessionWorktree\(place\)\.catch/.test(turn));
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
