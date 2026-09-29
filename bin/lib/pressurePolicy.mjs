/**
 * THE PRESSURE GUARD'S DECISION — pure, and nothing else (2026-09-26, SOLID
 * F050).
 *
 * Split out of resources.mjs, which MEASURES the box. The verdict used to read
 * `FLOWVIANT_NO_PRESSURE_GUARD` and the three numeric overrides out of
 * `process.env` itself while deciding from a measurement it was handed, so one
 * measurement could yield two answers depending on ambient state, and every
 * test of a threshold had to mutate the process's global environment.
 *
 * Now the thresholds are an ARGUMENT. `readPressureThresholds(env)` is the one
 * adapter from an environment to them, and admission.mjs calls it per decision
 * (never once at import), so an operator's override is still true of the
 * environment the daemon is in RIGHT NOW rather than the one it booted in.
 *
 * Why the guard exists, and why it is a runaway bound and never a headroom
 * meter, is argued at the top of resources.mjs.
 */

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

/** What a box that nobody tuned is judged against. */
export const DEFAULT_PRESSURE_THRESHOLDS = Object.freeze({
  off: false,
  criticalFreeBytes: 400 * MiB,
  minFreeBytes: 1024 * MiB,
  maxLoadPerCore: 4,
});

/** An operator's override, or the default. Positive finite numbers only: a
 *  typo'd `FLOWVIANT_MIN_FREE_MB=lots` must fall back to the default rather
 *  than turning every comparison into NaN, which compares false and would
 *  silently disable the guard it was trying to tune. */
const envNum = (env, name, fallback) => {
  const n = Number(env?.[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/**
 * The thresholds an environment states. `FLOWVIANT_NO_PRESSURE_GUARD=1` is the
 * escape hatch for a box whose operator knows better than the thresholds;
 * absence and `'0'` both mean the guard is on. The default parameter is
 * evaluated per CALL, so a caller that passes nothing reads the live
 * `process.env`.
 */
export function readPressureThresholds(env = process.env) {
  const d = DEFAULT_PRESSURE_THRESHOLDS;
  return {
    off: env?.FLOWVIANT_NO_PRESSURE_GUARD === '1',
    criticalFreeBytes: envNum(env, 'FLOWVIANT_CRITICAL_FREE_MB', d.criticalFreeBytes / MiB) * MiB,
    minFreeBytes: envNum(env, 'FLOWVIANT_MIN_FREE_MB', d.minFreeBytes / MiB) * MiB,
    maxLoadPerCore: envNum(env, 'FLOWVIANT_MAX_LOAD_PER_CORE', d.maxLoadPerCore),
  };
}

const sizeWord = (n) =>
  n >= GiB ? `${(n / GiB).toFixed(1)} GB` : `${Math.round(n / MiB)} MB`;

/**
 * IS THIS A MOMENT TO START ANOTHER CLI? — null when there is nothing to say.
 *
 * TWO LEVELS, because the two lanes are not the same promise. `churn` is the
 * unattended work — agent turns, a Deploy press's planner, the wiki
 * cartographer — which nobody is sitting in front of and which the server will
 * cheerfully re-offer next poll, so it yields early and generously. A session
 * turn is `interactive`: somebody is watching a composer they just pressed
 * enter in, and deferring that is a visible stall, so it holds out until the
 * box is genuinely about to fall over.
 *
 * THE REASON IS MEASURED WORDS AND NOTHING ELSE. No adjectives about the
 * machine, no advice, no "try again in a few minutes" — a sentence naming the
 * number that fired, which is the only thing this side actually knows.
 *
 * An unreadable measurement contributes NO verdict: memory that could not be
 * read cannot refuse, and a load average this platform does not publish cannot
 * either. A missing measurement altogether is the same ignorance. Ignorance
 * never withholds.
 */
export function pressureVerdict(level, measured, thresholds = DEFAULT_PRESSURE_THRESHOLDS) {
  const t = { ...DEFAULT_PRESSURE_THRESHOLDS, ...(thresholds ?? {}) };
  if (t.off) return null;
  const m = measured ?? null;
  const avail = Number.isFinite(m?.memAvailable) ? m.memAvailable : null;
  if (level === 'interactive') {
    if (avail !== null && avail < t.criticalFreeBytes)
      return { reason: `nearly out of memory — ${sizeWord(avail)} available` };
    return null;
  }
  const total = Number.isFinite(m?.memTotal) && m.memTotal > 0 ? m.memTotal : 0;
  // A fixed floor AND a proportional one, whichever is larger: 1 GB is the
  // right reserve on a laptop and is nothing on a 256 GB box, where six per
  // cent is the honest "the page cache is already being squeezed" line.
  const floor = Math.max(t.minFreeBytes, Math.round(total * 0.06));
  if (avail !== null && avail < floor)
    return { reason: `low memory — ${sizeWord(avail)} of ${sizeWord(total)} available` };
  const cores = Number.isFinite(m?.cores) && m.cores > 0 ? m.cores : null;
  const load = Number.isFinite(m?.load1) ? m.load1 : null;
  if (load !== null && cores !== null && load > cores * t.maxLoadPerCore)
    return {
      reason: `cpu overloaded — load ${load.toFixed(1)} on ${cores} core${cores === 1 ? '' : 's'}`,
    };
  return null;
}
