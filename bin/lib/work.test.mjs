import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

function manager(t) {
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
  return m;
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
