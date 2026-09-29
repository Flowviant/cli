/**
 * AN EPOCH STAMP THE DAEMON DID NOT WRITE, AS ISO — or null.
 *
 * One home (2026-09-28) because two readers of other programs' files need the
 * same tolerance: `claudeAuth.mjs` reads Claude Code's OAuth expiries, and
 * `runtimeLimits.mjs` reads the plan windows' `resetsAt` (Claude's stream) and
 * `resets_at` (Codex's rollout). Neither vendor promises a unit, so a value
 * above 1e11 is read as milliseconds and anything else as seconds — 1e11
 * seconds is the year 5138, and 1e11 milliseconds is 1973, so the two ranges
 * a real stamp can fall in never meet.
 *
 * AN UNREADABLE STAMP IS ABSENT, never zero and never "now": a non-number, a
 * NaN, an Infinity, zero or a negative all answer null. A leaf module on
 * purpose — it imports nothing, so either reader may import it without a cycle.
 */
export function isoFromStamp(v) {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  const ms = n > 1e11 ? n : n * 1000;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
