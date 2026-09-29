/** One leased incoming ticket, drafted by this machine's read-only CLI. */
import { FLEET_URL, FLEET_TOKEN, USER_AGENT, DAEMON_INSTANCE } from './config.mjs';
import { fleetEndpoint } from './fleetWire.mjs';
import { runTurn as defaultRunTurn } from './runTurn.mjs';
import { pickRuntimeFor as defaultPickRuntimeFor } from './runtimeDetection.mjs';
import { removeProbeTranscript } from './runtimeCapabilities.mjs';
import { REPO_PLACE } from './workPlaces.mjs';
import { SYSTEM_INTAKE, INTAKE_KICKOFF } from './prompts.mjs';
import { parseIntakeDraft } from './intakeDraft.mjs';
import { addUsage } from './turnUsage.mjs';
import { scrub as envScrub } from './uplinkScrub.mjs';
import { c, note } from './ui.mjs';

/** These names ride the app's intake handout. The parity gate checks them. */
export const INTAKE_ROSTER_KEY = 'intakeJobs';
export const INTAKE_CLAIM_ENDPOINT = 'intake-claim';
export const INTAKE_DONE_ENDPOINT = 'intake-done';
export const INTAKE_JOB_FIELDS = Object.freeze([
  'id', 'source', 'title', 'text', 'url', 'typeHint', 'repeats', 'recurrenceOf',
]);
export const INTAKE_DONE_FIELDS = Object.freeze([
  'id', 'instance', 'outcome', 'draft', 'error', 'usage',
]);
export const INTAKE_OUTCOMES = Object.freeze({ drafted: 'drafted', nothing: 'nothing' });

export function createWorkIntake({
  postBestEffort, inPlace, repoRoot, admit, workChildren,
  runTurn = defaultRunTurn, pickRuntimeFor = defaultPickRuntimeFor,
}) {
  const claiming = fleetEndpoint(INTAKE_CLAIM_ENDPOINT, FLEET_URL);
  const done = fleetEndpoint(INTAKE_DONE_ENDPOINT, FLEET_URL);
  const intake = new Set();

  const claim = async (id) => {
    try {
      const res = await fetch(claiming, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${FLEET_TOKEN}`,
          'User-Agent': USER_AGENT,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(15_000),
        body: JSON.stringify({ id, instance: DAEMON_INSTANCE }),
      });
      // A 409 means another holder (or a dismissed/landed ticket). No CLI and
      // no settle: this machine never acquired the right to answer for it.
      return res.status === 200 && (await res.json().catch(() => null))?.ok === true;
    } catch {
      return false;
    }
  };

  const report = async (body) => {
    await postBestEffort(done, { ...body, instance: DAEMON_INSTANCE });
  };

  const run = async (job, releaseSlot) => {
    const id = String(job.id);
    // No stand-down check here, as in the plan lane: a standing-down loop stops
    // processing the roster, and the one spawn gate is runTurn's own
    // (standDownGate.mjs; its pin keeps the askers few).
    if (!(await claim(id))) return;
    const runtime = pickRuntimeFor('consult');
    if (!runtime) {
      await report({ id, outcome: INTAKE_OUTCOMES.nothing, error: 'no CLI on this machine can run a read-only turn' });
      return;
    }

    let out = '';
    let child = null;
    let session = null;
    let timer = null;
    let wedged = false;
    let usage = null;
    // A spawned CLI can fail before reporting counters. Null records that the
    // spend is unmeasured; four zeroes would falsely say it spent nothing.
    const spent = () => child ? { usage } : {};
    try {
      await inPlace(REPO_PLACE, false, async () => {
        let stopWaiting = () => {};
        const capped = new Promise((resolve) => { stopWaiting = resolve; });
        const turn = runTurn({
          prompt: INTAKE_KICKOFF(job),
          system: SYSTEM_INTAKE,
          profile: 'consult',
          cwd: repoRoot,
          runtime,
          streamJson: true,
          answerFromResult: true,
          label: c.cyan('[intake]'),
          // There is no MCP principal for a ticket, and no model or effort pin:
          // this one-shot reader uses the machine's consult defaults.
          onInit: (i) => {
            if (typeof i?.sessionId === 'string' && i.sessionId.trim()) session = i.sessionId.trim();
          },
          onUsage: (u) => { usage = addUsage(usage, { ...u, runtime }); },
          onSpawn: (ch) => {
            child = ch;
            workChildren.set(ch, null);
            releaseSlot();
            // Start the cap at spawn, never while a checkout writer holds the
            // reader lock; SIGKILL and resolve even if a grandchild holds stdio.
            timer = setTimeout(() => {
              wedged = true;
              try { ch.kill('SIGKILL'); } catch { /* already gone */ }
              stopWaiting('');
            }, 10 * 60_000);
            timer.unref?.();
          },
        });
        out = await Promise.race([turn, capped]);
      });
    } catch (e) {
      await report({ id, outcome: INTAKE_OUTCOMES.nothing, error: envScrub(String(e?.message || e)).slice(0, 500), ...spent() });
      return;
    } finally {
      if (timer) clearTimeout(timer);
      if (child) workChildren.delete(child);
      if (session) setTimeout(() => removeProbeTranscript(repoRoot, session), 750).unref?.();
    }

    if (wedged) {
      await report({ id, outcome: INTAKE_OUTCOMES.nothing, error: 'the intake turn ran past ten minutes on this machine and was stopped', ...spent() });
      return;
    }
    const draft = parseIntakeDraft(out, job.typeHint);
    if (draft) await report({ id, outcome: INTAKE_OUTCOMES.drafted, draft, ...spent() });
    else await report({
      id, outcome: INTAKE_OUTCOMES.nothing,
      error: String(out ?? '').trim()
        ? `the ticket draft did not come back as JSON: ${envScrub(String(out)).slice(0, 300)}`
        : 'the ticket drafting turn produced no output — the CLI may be signed out',
      ...spent(),
    });
  };

  const processIntakeJobs = (jobs) => {
    if (!Array.isArray(jobs) || !jobs.length || intake.size) return;
    try {
      // The server offers at most one, and the process owns at most one across
      // polls. Pressure declines BEFORE claim so the ticket remains waiting.
      const job = jobs[0];
      const id = typeof job?.id === 'string' ? job.id : '';
      if (!id || intake.has(id)) return;
      const hold = admit('churn');
      if (hold) {
        note(`${c.cyan('intake')} ${c.dim(`— holding off: ${hold.reason}`)}`);
        return;
      }
      const releaseSlot = admit.reserve();
      intake.add(id);
      void run(job, releaseSlot).catch((e) => {
        // A failed report or unexpected CLI error must not break the roster
        // poll; the lease expires and the server offers the ticket again.
        note(`${c.cyan('intake')} ${c.dim(`— ${envScrub(String(e?.message || e)).slice(0, 300)}`)}`);
      }).finally(() => {
        releaseSlot();
        intake.delete(id);
      });
    } catch (e) {
      note(`${c.cyan('intake')} ${c.dim(`— ${envScrub(String(e?.message || e)).slice(0, 300)}`)}`);
    }
  };

  return { processIntakeJobs, intake };
}
