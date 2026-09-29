/**
 * Cloudflare DevOps — the daemon runs the user's own `wrangler`. Broker-not-
 * host: no cloud credential ever reaches Flowviant. A daemon on a project with
 * deploy allowed claims deploy jobs off the roster, runs build → deploy →
 * verify, and reports the outcome. It also reports its parsed
 * .flowviant/deploy.json so the app can list targets, and (basic) observes
 * out-of-band deployments.
 *
 * THIS FILE IS THE JOB LEASE (SOLID F060, split from one 811-line module):
 * claim → heartbeat → run → report, single-flight per job id and never twice
 * in one process. The rest of the lane sits beside it, one reason to change
 * each:
 *   - deployConfig.mjs    what `.flowviant/deploy.json` on base declares, and
 *                         the report of it to the server
 *   - deployCheckout.mjs  the throwaway detached worktree at the base tip
 *   - deployRunner.mjs    the commands, their environment and log scrubbing,
 *                         the health check (and why a deploy's secrets are
 *                         the machine's own environment)
 *   - deployWire.mjs      the one `/fleet/deploy-*` POST
 */

import { DAEMON_INSTANCE } from './config.mjs';
import { c, note, ok, warn } from './ui.mjs';
import { scrub } from './uplinkScrub.mjs';
import { post } from './deployWire.mjs';
import { runDeploy } from './deployRunner.mjs';
import { workLanesStopped } from './standDownGate.mjs';

/** In-flight guard (single-flight per daemon process): job id → what it is
 *  deploying, in words (`web → prod`, for the stand-down's sentence), and —
 *  once the server has granted the claim — the job and its context, which is
 *  what `reportDeploysAbandoned` needs to settle it. */
const claiming = new Map();
/** How many deploys this process is running (claim through report) — a
 *  deploy is work the machine must not be restarted under (fleet.mjs,
 *  `machineBusy`). */
export const deploysInFlight = () => claiming.size;
/** What the in-flight deploys are deploying, `target → env` each. */
export const deploysInFlightLabels = () => [...claiming.values()].map((c) => c.label);

/**
 * RESOLVES ONCE EVERY DEPLOY THIS PROCESS HAS CLAIMED HAS REPORTED (or given
 * up reporting) — immediately when none is in flight.
 *
 * The stand-down waits on this before it exits (standDownExit.mjs), because a
 * STAND-DOWN LETS A DEPLOY FINISH AND REPORT (ruling 2026-09-26): the process
 * that holds the claim is the only thing that can post its outcome, and an
 * outcome that never lands has the server hand the same irreversible job out
 * again three minutes later.
 */
const settleWaiters = [];
export function whenDeploysSettle() {
  if (claiming.size === 0) return Promise.resolve();
  return new Promise((resolve) => settleWaiters.push(resolve));
}
/** The job's real outcome is on its way (`report` has started): a second
 *  Ctrl+C must not race it with `unknown` (`reportDeploysAbandoned`). */
function markReporting(jobId) {
  const entry = claiming.get(jobId);
  if (entry) entry.reporting = true;
}
function releaseClaim(jobId) {
  claiming.delete(jobId);
  if (claiming.size === 0) for (const resolve of settleWaiters.splice(0)) resolve();
}
/**
 * JOBS THIS PROCESS HAS ALREADY RUN, whatever the server thinks.
 *
 * A deploy is IRREVERSIBLE and the report is not: a transient 5xx, a DNS blip
 * or the 30s timeout meant the outcome never landed, the heartbeat stopped,
 * and three minutes later the server requeued the job and this same daemon ran
 * `wrangler rollback` — or a full prod deploy — a SECOND time, leaving
 * production two versions behind the intended one with nothing recording that
 * it happened twice.
 *
 * So the process remembers. Not a substitute for the report (see the retry
 * below, which is the real fix); a floor under it, for the case where the
 * report never lands at all. It does not survive a restart — nothing local
 * could be trusted to — which is why the retry has to keep the heartbeat alive
 * while it runs.
 */
const ran = new Set();

/**
 * Process queued deploy jobs from the roster. `ctx` = { repoRoot, baseRef,
 * myPubB64 }. Each job: claim → build → deploy → verify → report. Runs
 * concurrently but one-per-jobId.
 */
export function processDeployJobs(jobs, ctx) {
  if (!Array.isArray(jobs) || !jobs.length) return;
  for (const job of jobs) {
    // Defend against a malformed roster element — `job.id` on a null would throw
    // synchronously here (outside the per-job try below) and wedge the whole
    // reconcile loop, since this runs unguarded from the fleet tick.
    if (!job || typeof job.id !== 'string') continue;
    if (claiming.has(job.id)) continue;
    if (ran.has(job.id)) continue; // already executed here — never twice
    claiming.set(job.id, { label: `${job.targetId} → ${job.env}`, held: null, reporting: false });
    void (async () => {
      let beat = null;
      try {
        // `instance` names THIS PROCESS. The pubkey cannot: it is the env
        // keypair read from one file per home directory, so two daemons on one
        // box share it and a pubkey-only read-back let both "win" the claim
        // and run the same deploy twice concurrently.
        const claimed = await post('deploy-claim', {
          jobId: job.id,
          pubkey: ctx.myPubB64(),
          instance: DAEMON_INSTANCE,
        }).catch(() => null);
        if (!claimed?.claimed) return; // another daemon won the claim
        /**
         * A CLAIM THAT COMES BACK AFTER THE STAND-DOWN BEGAN IS NOT RUN. The
         * loop gate cannot see it (the claim was already on the wire), and the
         * command is irreversible: starting it now would start work under a
         * daemon that is leaving. Nothing has run, so the server's stale sweep
         * handing the job out again in three minutes is the right outcome.
         */
        if (workLanesStopped()) {
          note(`${c.cyan('deploy')} ${c.dim(`— ${job.targetId} → ${job.env} was claimed as this daemon began stopping; not run, the app hands it out again.`)}`);
          return;
        }
        const entry = claiming.get(job.id);
        if (entry) entry.held = { job, ctx };
        // Keep the claim fresh while we run — a long deploy must never be
        // re-queued out from under us (that would double-deploy). The async
        // run() in deployRunner.mjs keeps the event loop free so this fires.
        /**
         * …AND IT CAN DIE, which is what makes the `stillBeating` predicate
         * below mean anything.
         *
         * `report` is handed `() => beat != null` so it stops retrying once the
         * claim is certainly stale — but `beat` only ever held a timer handle
         * and was never nulled, so that predicate could not return false and
         * `report` retried into a job another daemon may already own.
         *
         * The server re-queues a deploy whose heartbeat is older than three
         * minutes, and this fires every sixty seconds — so three consecutive
         * failures is exactly the point past which the claim cannot be assumed.
         * A single blip does not count: only an unbroken run does.
         */
        let missed = 0;
        beat = setInterval(() => {
          void post('deploy-heartbeat', {
            jobId: job.id,
            pubkey: ctx.myPubB64(),
            // Instance rides the heartbeat too, or a same-box sibling's beat
            // could keep a dead claimer's job "running" past the stale sweep.
            instance: DAEMON_INSTANCE,
          })
            .then(() => {
              missed = 0;
            })
            .catch(() => {
              missed += 1;
              if (missed >= 3 && beat) {
                clearInterval(beat);
                beat = null;
              }
            });
        }, 60_000);
        note(`${c.cyan('deploy')} ${c.dim(`— ${job.kind} ${job.targetId} → ${job.env}…`)}`);
        const outcome = await runDeploy(job, ctx);
        // From here the work is DONE. Whatever the report does, this job must
        // never run again in this process.
        ran.add(job.id);
        if (abandoned.has(job.id)) return; // its outcome was already said: `unknown`
        markReporting(job.id);
        await report(job, ctx, outcome, () => beat != null);
        if (outcome.ok) ok(`${c.cyan('deploy')} ${c.dim(`— ${job.targetId} → ${job.env} done${outcome.healthOk === false ? ' (health failed)' : ''}`)}`);
        else warn(`deploy: ${job.targetId} → ${job.env} failed — ${outcome.message}`);
      } catch (e) {
        warn(`deploy job ${job.id} errored: ${e.message}`);
        if (abandoned.has(job.id)) return;
        markReporting(job.id);
        await report(job, ctx, { ok: false, message: e.message }).catch(() => {});
      } finally {
        // Stopped only AFTER the report has landed or given up — the requeue is
        // gated on heartbeat staleness, so beating through the retries is what
        // stops the server handing this job out again mid-retry.
        if (beat) clearInterval(beat);
        releaseClaim(job.id);
      }
    })();
  }
}

/**
 * THE OUTCOME IS RETRIED, because losing it re-runs the deploy.
 *
 * One `post` with a `.catch(warn)` was the whole of this: a transient 5xx, a
 * DNS blip or the 30s timeout dropped the outcome, the `finally` stopped the
 * heartbeat, and the server — which requeues a running job after three minutes
 * without one — handed the SAME job back to the SAME daemon, which ran it
 * again. For a rollback that is production two versions behind the intended
 * one; for a prod deploy it is the whole deploy run twice. Nothing recorded
 * that it had happened at all.
 *
 * The heartbeat keeps running throughout (the caller's `finally` is what stops
 * it), so the requeue window stays shut for as long as we are still trying.
 * Bounded: six attempts over roughly a minute, then a warning and the local
 * `ran` guard as the floor.
 */
async function report(job, ctx, outcome, stillBeating = () => true) {
  const body = reportBody(job, ctx, outcome);
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      await post('deploy-report', body);
      return;
    } catch (e) {
      /**
       * A REFUSED CREDENTIAL IS SAID, NEVER THROWN (ruling 2026-09-26). A
       * stand-down lets the deploy finish and report — and the stand-down may
       * be a Disconnect, which rotates the credential while the command is
       * still running. Retrying the API's own refusal changes nothing, and
       * throwing would leave the outcome in nobody's hands; one line names
       * what happened and where the result is.
       *
       * ONLY THE API'S OWN REFUSAL (`credentialRejected`, authReject.mjs's
       * rule, set by deployWire.mjs). An edge 401/403 — Cloudflare's bot
       * checks answer this client class with their own — is a blip like any
       * other and keeps the retries below: dropping the outcome over one
       * would have the server hand the irreversible job out again.
       */
      if (e?.credentialRejected) {
        warn(
          `deploy: ${job.targetId} → ${job.env} ${outcome.ok ? 'finished' : 'failed'}, but its outcome ` +
            `could not be reported — the app refused this machine's credential (HTTP ${e.status}). ` +
            'The result is only in this log.'
        );
        return;
      }
      // The last attempt says so; the ones before it are noise on a path that
      // usually recovers.
      if (attempt === 5) {
        warn(`deploy: could not report outcome after 6 tries — ${e.message}`);
        return;
      }
      // If the heartbeat is already gone the requeue window is open and
      // retrying buys nothing — the job may have been handed to somebody else.
      if (!stillBeating()) {
        warn(`deploy: could not report outcome — ${e.message}`);
        return;
      }
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
}

/** The one shape of `/fleet/deploy-report`, for a real outcome and for an
 *  abandoned one alike. */
function reportBody(job, ctx, outcome) {
  return {
    jobId: job.id,
    pubkey: ctx.myPubB64(),
    // The same term the claim carries, for the same reason: the pubkey is one
    // keypair per home directory, so two daemons on one box share it, and a
    // stale holder's late report would otherwise settle the RECLAIMER's
    // running job. The server matches it when present; an older server
    // ignores the extra key.
    instance: DAEMON_INSTANCE,
    ok: !!outcome.ok,
    deploymentId: outcome.deploymentId ?? null,
    healthOk: outcome.healthOk ?? null,
    message: scrub(outcome.message || ''),
    // `unknown` only when this process leaves without seeing the end of the
    // command (`reportDeploysAbandoned`). A daemon→server report field, so no
    // floor: an older server ignores the key and records `ok: false` — a
    // terminal failure, which is still never handed out again.
    ...(outcome.unknown ? { outcome: 'unknown' } : {}),
  };
}

/**
 * THE WORDS A DEPLOY'S OUTCOME CARRIES WHEN NOBODY SAW IT END — the second
 * Ctrl+C during a stand-down's drain (standDownExit.mjs, ruling 2026-09-26).
 */
export const ABANDONED_DEPLOY_WORDS = 'outcome unknown: operator left mid-deploy';

/** Jobs whose outcome was posted as `unknown`: their own report never follows. */
const abandoned = new Set();

/**
 * A PERSON IS LEAVING BEFORE THE DEPLOYS END — settle each claimed one as
 * `unknown`, ONCE, so the server marks it terminal and never hands the same
 * irreversible job out again (ruling 2026-09-26: a second Ctrl+C during the
 * drain leaves, but says so first). Best-effort and bounded by the caller: one
 * post per job, no retries, never throws. The commands themselves are not
 * touched — they run in their own process groups and only their timeout ends
 * them.
 */
export async function reportDeploysAbandoned() {
  // Only a deploy whose command is still running: one already reporting has
  // its real outcome on the wire (and keeps retrying it), and whichever post
  // landed first would win.
  const held = [...claiming.entries()].filter(([id, c]) => c.held && !c.reporting && !abandoned.has(id));
  await Promise.all(
    held.map(async ([id, { held: h }]) => {
      abandoned.add(id);
      try {
        await post('deploy-report', reportBody(h.job, h.ctx, { ok: false, unknown: true, message: ABANDONED_DEPLOY_WORDS }));
      } catch (e) {
        warn(`deploy: ${h.job.targetId} → ${h.job.env} — could not say its outcome is unknown: ${e.message}`);
      }
    })
  );
}
