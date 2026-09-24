/** Agent plan claims, read-only planning turns, and proposal reports. */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { FLEET_URL, FLEET_TOKEN, USER_AGENT, DAEMON_INSTANCE } from './config.mjs';
import { git, isSafePathSegment } from './git.mjs';
import { parseProposal } from './agentPlan.mjs';
import { c, note } from './ui.mjs';
import { runTurn } from './claude.mjs';
import { SYSTEM_PLAN, AGENT_PLAN_KICKOFF } from './prompts.mjs';
import { scrub as envScrub } from './env.mjs';
import { pickRuntimeFor, removeProbeTranscript, RUNTIMES } from './runtimes.mjs';

export function createWorkAgentPlans({
  postBestEffort,
  baseDir,
  baseRef,
  REPO_PLACE,
  inPlace,
  repoRoot,
  admit,
  state,
}) {
  const AGENT_PLAN_DONE_URL = FLEET_URL.replace(/\/agents\/?$/, '/agent-plan-done');
  const AGENT_PLAN_ACTIVITY_URL = FLEET_URL.replace(/\/agents\/?$/, '/agent-plan-activity');
  const AGENT_PLAN_CLAIM_URL = FLEET_URL.replace(/\/agents\/?$/, '/agent-plan-claim');

  const { placeLocks, workChildren } = state;

  // ── AGENT PLAN JOBS: the Deploy press ──────────────────────────────────────
  //
  // Somebody selected cards and pressed Deploy. This turn works out HOW THE
  // WORK SHOULD BE SPLIT across agents and stops — a person edits what it
  // proposes on the board, and ACCEPTING is what spawns anything. Nothing here
  // creates a worktree, a branch or a card.
  //
  // READ-ONLY IN THE CHECKOUT. `readOnly: true` selects `consultPermFor` (the
  // fenced Read/Glob rules plus a few path-validated `git`/`ls`/`cat` reads —
  // no Write, no Edit, no mkdir, no rm) and NO MCP is passed at all, so this
  // turn has no control plane to reach even if the repository it reads tries
  // to steer it. The proposal comes back as the turn's final message rather
  // than through a tool, which is exactly what lets that permission set be
  // this narrow.
  //
  // It takes the checkout's place lock as a READER, beside the operator's own
  // tabs. It writes nothing, so a writer lock would only starve real work.
  const planning = new Set(); // press ids in flight on this tick

  const postAgentPlan = async (body) => {
    // Bounded retry on 408/429/5xx, an other-4xx counted as delivered — see
    // postBestEffort's own docblock. Previously this swallowed every
    // response including ordinary 5xx and rate limits, so a transient
    // failure looked identical to a hostile refusal: nothing retried, and
    // the proposal sat unsettled until the server's own expiry.
    await postBestEffort(AGENT_PLAN_DONE_URL, { ...body, instance: DAEMON_INSTANCE });
  };

  /**
   * WHAT THE PLANNER IS DOING, RELAYED — the agent turn's narration channel,
   * on a PRESS instead of an agent.
   *
   * This turn was already streaming and the daemon was already reading it:
   * `streamJson` humanizes every read, grep, command and thought and prints
   * it behind `[plan]` on the operator's terminal. Every one of those lines
   * was then thrown away, so a Deploy press said "planning" on the board and
   * nothing else for as long as it took — which on an overnight queue is the
   * whole night. Forwarding the CLI's own tail costs nothing that is not
   * already being computed.
   *
   * IT IS THE CLI'S WORDS, OR THE MACHINE'S — never a stage, a percentage or
   * an estimate of how far along a model is. Flowviant relays.
   *
   * SCRUBBED AND CAPPED HERE rather than at each call site, so a phase marker
   * added later cannot skip either. Fire-and-forget with every failure
   * swallowed: narration is a readout, and it must never fail or delay the
   * turn it describes. A daemon that never calls this is a machine that has
   * not narrated, which is the only thing an absent line can mean.
   */
  const postAgentPlanActivity = async (planId, line) => {
    const text = envScrub(String(line ?? '')).slice(0, 400);
    if (!text) return;
    try {
      await fetch(AGENT_PLAN_ACTIVITY_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${FLEET_TOKEN}`,
          'User-Agent': USER_AGENT,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(15_000),
        body: JSON.stringify({ planId, line: text }),
      });
    } catch {
      /* a readout — losing a line costs nothing */
    }
  };

  /**
   * A WEDGED PLANNING CLI IS STOPPED AT FIFTEEN MINUTES.
   *
   * `runTurn` has no timer of its own. A CLI that hangs — a login prompt
   * nobody is there to answer, a model client stalled on a socket — therefore
   * runs until something else kills it, holding `planning`, which is what
   * blocks every auto-update on this machine, and spending whatever the
   * operator's account is charged for a live session.
   *
   * FIFTEEN because the server fails a claimed press at THIRTY (its
   * `PLAN_JOB_TTL_MS`) past thirty minutes with no renewal: half of that
   * leaves this side — the only side that knows the CLI is still running —
   * time to stop it and have its settle land, instead of the press expiring
   * into a sentence that blames a machine which never spoke. Nothing
   * legitimate is cut off either way: this turn reads a card selection and
   * writes nothing, and the shape of it is minutes.
   *
   * `claimedAt` IS NO LONGER A ONE-SHOT STAMP (2026-09-24): the narration
   * relay below (`postAgentPlanActivity`, `/fleet/agent-plan-activity`)
   * renews it server-side as its own heartbeat, so a genuinely WORKING plan
   * turn keeps its claim alive well past thirty minutes on its own. This
   * timer exists for the one case narration cannot cover — a WEDGED CLI (a
   * login prompt nobody answers, a stalled socket) emits nothing, renews
   * nothing, and is exactly the silence the server's thirty-minute clock was
   * always measuring.
   */
  const PLAN_TURN_TIMEOUT_MS = 15 * 60_000;

  const claimAgentPlan = async (id) => {
    try {
      const res = await fetch(AGENT_PLAN_CLAIM_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${FLEET_TOKEN}`,
          'User-Agent': USER_AGENT,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(15_000),
        body: JSON.stringify({ id, instance: DAEMON_INSTANCE }),
      });
      const j = await res.json().catch(() => null);
      return j?.data?.claimed === true;
    } catch {
      return false; // the peer may hold it; doing nothing is the safe answer
    }
  };

  /**
   * What a live agent has already TOUCHED, measured here rather than sent.
   *
   * The server could have shipped a copy of this, and deliberately does not:
   * these are directories on THIS machine, and a server-side copy would be a
   * second, staler source of truth for a fact the daemon is standing on top of.
   *
   * Uncommitted work AND commits against base, because a planner asking "will
   * these collide" cares about both — a file this agent has already rewritten
   * and merged into its own branch collides exactly as hard as one it is
   * editing now.
   */
  const agentChangedFiles = (placeId) => {
    if (!placeId || !isSafePathSegment(placeId)) return [];
    const wt = join(baseDir, 'sessions', placeId);
    if (!existsSync(wt)) return [];
    const out = new Set();
    for (const args of [
      ['diff', '--name-only', 'HEAD'],
      ['diff', '--name-only', `${baseRef()}...HEAD`],
      ['ls-files', '--others', '--exclude-standard'],
    ]) {
      /**
       * `git()` THROWS; it does not return a non-string.
       *
       * The guard below was `if (typeof r !== 'string') continue`, which is a
       * value `execFileSync` can never produce — so every one of these calls
       * was effectively unguarded. And this runs over the LIVE AGENTS a plan
       * job carries, which include agents still in `planning`: they have no
       * worktree yet, so `git diff` in a directory that does not exist exits
       * non-zero and throws straight out of `runAgentPlan` — after the press
       * has been claimed and before the try/finally below. The press then sat
       * `planning` until its expiry, having spent nothing and explained
       * nothing, on what would be an ordinary second Deploy.
       *
       * An agent whose files cannot be read contributes none. That is the
       * honest answer and it is what the planner should be told.
       */
      let r;
      try {
        r = git(args, wt);
      } catch {
        continue;
      }
      if (typeof r !== 'string') continue;
      for (const line of r.split('\n')) {
        const f = line.trim();
        if (f) out.add(f);
        if (out.size >= 60) return [...out];
      }
    }
    return [...out];
  };

  /** See `runAgentTurn` — the admission reservation, released the moment the
   *  planner's CLI exists. */
  const runAgentPlan = async (job, releaseSlot = () => {}) => {
    const id = String(job.id);
    const tasks = Array.isArray(job.tasks) ? job.tasks : [];
    // CLAIM BEFORE ANYTHING — including before the cheap refusal below.
    //
    // The settle is rejected unless the caller HOLDS the lease, so posting an
    // error first meant the server discarded it and the press sat open forever,
    // holding its cards out of Deploy. That is the opposite of the ordering a
    // kill keeps (refuse cheaply, then claim) and it is because these two
    // lanes settle differently: a kill's settle does not check a lease for the
    // not-found case, and a plan's always does.
    if (!(await claimAgentPlan(id))) return;
    if (tasks.length === 0) {
      // The press named cards the doc no longer has. A real answer, and one the
      // board can explain, rather than a turn that plans nothing.
      await postAgentPlan({ id, error: 'those cards are no longer on the board' });
      return;
    }

    /**
     * WHICH CLI PLANS. `pickRuntimeFor('consult')`, the same picker every other
     * turn nobody @mentioned already uses — Claude when it is here (the prompts
     * were written against it), otherwise whatever can express the profile.
     *
     * Deliberately NOT the project's runtime order: that order is about AGENTS,
     * which hold a conversation across many turns and whose value is that held
     * context. A planner runs once and reads; it takes what the machine has.
     */
    const rt = pickRuntimeFor('consult');
    if (!rt) {
      await postAgentPlan({ id, error: 'no CLI on this machine can run a read-only turn' });
      return;
    }

    /**
     * ONE LINE AT A TIME, AT MOST ONE EVERY TWO SECONDS — the throttle the
     * agent turn's narration keeps, for the same reason: a turn emits hundreds
     * of lines and only the latest is ever rendered. Held per RUN rather than
     * in a map keyed by press, because one press is one turn and there is
     * nothing for the clock to outlive.
     */
    let lastPlanBeat = 0;
    const narrate = (line) => {
      const now = Date.now();
      if (now - lastPlanBeat < 2_000) return;
      lastPlanBeat = now;
      void postAgentPlanActivity(id, line);
    };
    /**
     * THE MACHINE'S OWN VOICE, for the moments only this side can see — the
     * CLI process actually starting, and this press waiting its turn for the
     * checkout. Both are FACTS measured here, not a reading of the model's
     * progress, and both are invisible from a browser: a press held behind a
     * ship's writer lock looks exactly like a press whose CLI is thinking.
     *
     * Never dropped by the throttle above — these are moments, not a stream —
     * and they stamp its clock so the next model line does not overwrite one
     * the instant it lands.
     */
    const say = (line) => {
      lastPlanBeat = Date.now();
      void postAgentPlanActivity(id, line);
    };
    const liveAgents = (Array.isArray(job.liveAgents) ? job.liveAgents : []).map((a) => ({
      id: String(a?.id ?? ''),
      name: String(a?.name ?? ''),
      status: String(a?.status ?? ''),
      // Belt: `agentChangedFiles` is defensive internally, but it resolves a
      // place first and this whole block sits outside the try below.
      changedFiles: (() => {
        try {
          return agentChangedFiles(a?.placeId);
        } catch {
          return [];
        }
      })(),
    }));

    let out = '';
    /** REMOVED IN A `finally`. `workChildren` is what `workBusy()` counts, and
     *  a leaked entry keeps the daemon permanently "busy" — which blocks every
     *  auto-update from that moment on, silently, until a restart. */
    let planChild = null;
    let planTimer = null;
    /**
     * THE PLANNER'S OWN CONVERSATION, so its transcript can be removed.
     *
     * `claude -p` in the CHECKOUT writes `~/.claude/projects/<checkout>/<id>.jsonl`,
     * and the checkout is exactly where the operator runs their own terminal
     * Claude. Left behind, every Deploy press became the newest ENDED session
     * there: it displaced the operator's real conversation from the `+` adopt
     * menu (one row per directory), offered to fork a read-only planner into a
     * build tab, and was what their own `claude --continue` resumed. The
     * pre-review and the skills probe delete theirs for the same reason.
     */
    let planSession = null;
    /** The cap fired: the CLI was still running when this machine stopped it. */
    let wedged = false;
    // Said BEFORE the lock is asked for, because a reader only waits when a
    // writer holds the checkout or is queued ahead of it — which is exactly
    // this condition, read one line before we join the queue.
    const busy = placeLocks.get(REPO_PLACE);
    if (busy && (busy.writing || busy.waiters.some((w) => w.write)))
      say('waiting for the checkout — a ship or another turn on this machine is holding it');
    try {
      await inPlace(REPO_PLACE, false, async () => {
        /**
         * THE CAP RESOLVES THE WAIT ITSELF rather than waiting for `close`
         * after the kill — the shape the project check's timeout already
         * keeps. A SIGKILLed process whose stdio a grandchild still holds can
         * be slow to emit `close`, or never emit it, and this promise is what
         * holds the claimed press open.
         */
        let stopWaiting = () => {};
        const capped = new Promise((r) => {
          stopWaiting = r;
        });
        const turn = runTurn({
          prompt: AGENT_PLAN_KICKOFF({
            tasks,
            liveAgents,
            agentCap: Number.isInteger(job.agentCap) && job.agentCap > 0 ? job.agentCap : 3,
          }),
          system: SYSTEM_PLAN,
          // READ-ONLY, and no MCP: `mcpArgs` is omitted entirely rather than
          // passed empty, so there is no control plane on this turn at all.
          readOnly: true,
          cwd: repoRoot,
          runtime: rt,
          streamJson: true,
          answerFromResult: true,
          label: c.cyan('[plan]'),
          // The CLI's own tail, forwarded to the press. Same rule as an agent
          // turn's: throttled, overwritten rather than appended, and never
          // awaited by the turn.
          onActivity: (a) => {
            if (a?.label) narrate(String(a.label));
          },
          onInit: (i) => {
            if (typeof i.sessionId === 'string' && i.sessionId.trim())
              planSession = i.sessionId.trim();
          },
          onSpawn: (ch) => {
            planChild = ch;
            // No id: a Deploy press is not a task, and the snapshot's per-task
            // rows must not invent one. It still COUNTS against the machine's
            // ceiling — see liveTurnCount.
            workChildren.set(ch, null);
            releaseSlot();
            say(`${RUNTIMES[rt]?.label ?? rt} started on this machine`);
            /**
             * ARMED AT THE SPAWN, not at the claim: time spent waiting for the
             * checkout is not a wedged CLI, and a press that never got to run
             * is what the server's own clock is for.
             *
             * The CHILD, never its group — the rule teardown keeps. A
             * read-only planning turn starts no dev server, so there is
             * nothing behind it worth signalling and everything to lose by
             * signalling somebody else's.
             */
            planTimer = setTimeout(() => {
              wedged = true;
              try {
                ch.kill('SIGKILL');
              } catch {
                /* already gone */
              }
              stopWaiting('');
            }, PLAN_TURN_TIMEOUT_MS);
            planTimer.unref?.();
          },
        });
        out = await Promise.race([turn, capped]);
      });
    } catch (e) {
      await postAgentPlan({ id, error: envScrub(String(e?.message || e)).slice(0, 500) });
      return;
    } finally {
      if (planTimer) clearTimeout(planTimer);
      if (planChild) workChildren.delete(planChild);
      // On EVERY exit, after the kill and on a delay — the transcript is the
      // child's file, and removing it while the child is still dying races a
      // recreate. The pre-review's own shape.
      if (planSession) setTimeout(() => removeProbeTranscript(repoRoot, planSession), 750).unref?.();
    }

    if (wedged) {
      // NEVER LEAVE A CLAIMED PRESS UNREPORTED — the belt the merge lane wears
      // beneath this one. The machine's own words, because the machine is the
      // only side that knows: the server would have expired this press in
      // another fifteen minutes with a sentence blaming a daemon that had in
      // fact answered.
      await postAgentPlan({
        id,
        error: 'the planning turn ran past fifteen minutes on this machine and was stopped',
      });
      return;
    }

    const proposal = parseProposal(out);
    if (!proposal) {
      await postAgentPlan({
        id,
        // The CLI's own words when it has any — a turn that explained why it
        // could not plan is far more use than "planning failed".
        error: out.trim()
          ? `the plan did not come back as JSON: ${envScrub(out).slice(0, 300)}`
          : 'the planning turn produced no output — the CLI may be signed out',
      });
      return;
    }
    await postAgentPlan({ id, proposal, sessionRef: repoRoot });
  };

  const processAgentPlanJobs = (jobs) => {
    if (!Array.isArray(jobs) || jobs.length === 0) return;
    // ONE AT A TIME, and the cap is 1 rather than 5: a planning turn is a real
    // model call, and a machine handed three at once would run three CLIs to
    // answer questions nobody asked in that order.
    for (const job of jobs.slice(0, 1)) {
      const id = String(job?.id || '');
      if (!id || planning.has(id)) continue;
      /**
       * BEFORE THE CLAIM, and that ordering is the whole point: `runAgentPlan`
       * claims the press as its first act, and a claimed press must be settled
       * or it sits open holding its cards out of Deploy. NOT claiming is how
       * this lane declines — the press stays queued, the server offers it
       * again next poll, and nobody is told their Deploy failed.
       */
      const hold = admit('churn');
      if (hold) {
        note(`${c.cyan('plan')} ${c.dim(`— holding off: ${hold.reason}`)}`);
        continue;
      }
      // One press a tick, so this lane cannot burst on its own — but the slot
      // it is about to take has to be visible to the agent-turn lane that runs
      // moments later in the same reconcile. See admission.mjs.
      const releaseSlot = admit.reserve();
      planning.add(id);
      void runAgentPlan(job, releaseSlot).finally(() => {
        releaseSlot();
        planning.delete(id);
      });
    }
  };

  return { processAgentPlanJobs, planning };
}
