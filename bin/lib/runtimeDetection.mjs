/**
 * WHAT THIS MACHINE HAS — which declared CLIs are installed here, and, of
 * those, which one runs a job nobody @mentioned.
 *
 * Split out of runtimes.mjs (2026-09-26, SOLID F045). The registry is a
 * statement about the CLIs (their argv, their profiles); this file is a
 * measurement of the box (a `--version` exec per CLI, cached with a TTL), and a
 * probe changing is not a reason to edit a table of argv builders.
 *
 * `pickRuntimeFor` lives HERE rather than beside `canRun` because it is the one
 * reader that joins the registry's promise with this box's measurement: the
 * registry imports nothing machine-stateful, so the dependency runs one way
 * (this file → runtimes.mjs) and never in a cycle.
 */

import { execFileSync } from 'node:child_process';
import { RUNTIMES, canRun, drivableHere } from './runtimes.mjs';

/**
 * WHICH RUNTIME RUNS A JOB THAT NOBODY @MENTIONED.
 *
 * Building a task has an author: you @mentioned a CLI, and that is the only
 * dispatch in this product. The other turns have none — the wiki sweep, the
 * re-ground, the plan check, the quick edit and the consult are all started by
 * the daemon or the server, and until now every one of them took `runTurn`'s
 * default parameter value and ran Claude. That was not a decision; it was five
 * call sites omitting an argument, and it only looked correct while Claude was
 * the only runtime and preflight refused to start without it.
 *
 * A PROFILE is a promise about what is IMPOSSIBLE during the turn, not a flag
 * list — flag lists are per-vendor, promises are not, and the goal is that every
 * runtime behaves the same way predictably. A runtime declares the profiles it
 * can actually express; one that cannot express a profile does not get that job,
 * rather than getting it with weaker guarantees nobody wrote down.
 *
 * Claude first when it qualifies — not favouritism, and worth saying plainly:
 * these prompts were written and tuned against it, so it is the known-good
 * answer and anything else is a substitution. When it is absent, any runtime
 * that can express the profile runs the job, which is the whole point.
 */
export function pickRuntimeFor(profile, { detected } = {}) {
  const rows = detected ?? detectRuntimes();
  const ok = (id) =>
    canRun(RUNTIMES[id], profile) && Boolean(rows.find((d) => d.id === id)?.installed);
  if (ok('claude')) return 'claude';
  return Object.keys(RUNTIMES).find(ok) ?? null;
}

/**
 * Which of these is on this machine, asked at most once per DETECT_TTL_MS.
 *
 * `--version` rather than `which`: a binary on PATH that cannot execute (a
 * broken install, a wrong-arch download, a shell alias pointing at nothing) is
 * not a runtime you can dispatch to, and reporting it as one sends work into a
 * hole. 5s is generous for a version print and short enough that three missing
 * CLIs cannot stall a roster poll.
 *
 * Reported to the server on the roster poll so the app can stop saying "we have
 * not looked". It is a statement about THIS MACHINE and nothing else — no
 * account, no quota, no entitlement. Flowviant relays; it does not enforce.
 */
let detectedCache = null;
let detectedAt = 0;
// The cache EXPIRES rather than living for the process: pickRuntimeFor's whole
// premise is "a CLI can be installed while the daemon runs", and both it and
// the roster poll read this cache — a forever-cache made that comment a lie
// (nothing after preflight ever passed refresh, so a mid-run install was
// invisible until restart, to the server included). 5 minutes keeps the probes
// (3 sync --version execs) off the hot path while an install still surfaces on
// the next poll or job.
const DETECT_TTL_MS = 5 * 60 * 1000;
/**
 * THE POLL'S `runtimes` VALUE — the CLIs this machine can drive, comma-joined,
 * and '' when a detection that RAN found none (2026-09-26, SOLID F015).
 *
 * Three states on the wire, like `skills`: absent = nothing was measured (an
 * older daemon, or a detection that threw); '' = measured, and none; a list =
 * measured. Omitting the param after an empty detection — the old spelling —
 * read as "said nothing", so the server kept advertising the last CLI a
 * machine lost.
 */
export function runtimesReport(detected) {
  return detected
    .filter((r) => r.dispatchable)
    .map((r) => r.id)
    .join(',');
}

export function detectRuntimes({ refresh = false } = {}) {
  if (detectedCache && !refresh && Date.now() - detectedAt < DETECT_TTL_MS) return detectedCache;
  detectedAt = Date.now();
  detectedCache = Object.values(RUNTIMES).map((rt) => {
    let version = null;
    try {
      version = String(
        execFileSync(rt.bin, ['--version'], {
          timeout: 5000,
          stdio: ['ignore', 'pipe', 'ignore'],
        })
      )
        .trim()
        .split('\n')[0]
        .slice(0, 40);
    } catch {
      version = null;
    }
    return {
      id: rt.id,
      installed: version !== null,
      version,
      // Installed and drivable are different questions, and conflating them is
      // how a user ends up @mentioning something that silently never starts.
      // THREE questions, in fact — see `drivableHere`: the CLI can be installed,
      // and this module can know how to spawn it, and the worker this daemon is
      // running can still be unable to drive it.
      dispatchable: version !== null && drivableHere(rt),
      blocked: rt.blocked ?? null,
    };
  });
  return detectedCache;
}
