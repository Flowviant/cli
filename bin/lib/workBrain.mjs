/**
 * WHICH BRAIN, AT WHICH EFFORT — the one guard every turn's `--model` and
 * `--effort` pass through before they ride argv.
 *
 * Split out of work.mjs (2026-09-26, SOLID F037). Two lanes read it — the
 * Workbench tab (workSessionTurns.mjs) and the agent turn (workAgentTurns.mjs)
 * — each importing it directly — and it is pure over the job and the runtime
 * table, so its home is a module of its own rather than either lane.
 */
import { RUNTIMES } from './runtimes.mjs';

/**
 * The shape a per-tab model name must have before it rides argv as
 * `--model <name>`. Conservative for the same reason the codex thread id is
 * (below): it comes off the wire and lands in a child process's arguments —
 * alphanumerics plus dot/dash/underscore, at most 40 characters, and NEVER a
 * leading dash, which is an argv that parses as a flag.
 */
const WORK_MODEL_RE = /^[a-zA-Z0-9._][a-zA-Z0-9._-]{0,39}$/;

/**
 * WHICH BRAIN, AT WHICH EFFORT — the tab's own pick, off the roster.
 *
 * Absent is the resting state and it must stay genuinely absent: every tab ran
 * with no `--model` and no `--effort` until now, so a job that names neither
 * has to produce the byte-identical argv it produced yesterday — Claude falling
 * back to the machine's MODEL pin, codex and agy to their own defaults. Hence
 * an object with the key MISSING rather than one holding null: a null would
 * reach the builders as a value and Claude's `model || MODEL` is the only one
 * that would survive it.
 *
 * A value that fails its guard is DROPPED, not passed through and not an error.
 * The honest outcome of "the server named a model this machine can't spell" is
 * the machine's own default — a turn that runs — rather than a flag no CLI
 * understands and a tab that fails every message.
 */
/**
 * THE EFFORT IS CHECKED AGAINST THE CLI THAT WILL RUN THE TURN (2026-09-26).
 * One global ladder once accepted `max` for every runtime, and Codex has no
 * `max`: a skewed or previously queued Codex job reached argv as a
 * `model_reasoning_effort` its CLI refuses. The per-CLI list lives beside each
 * runtime's argv builder (`RUNTIMES[id].efforts`, runtime{Claude,Codex,Antigravity}.mjs); a runtime this
 * daemon does not define runs nothing, so it spells no effort either.
 */
export function brainFor(job, runtimeId) {
  const out = {};
  const model = typeof job?.model === 'string' ? job.model.trim() : '';
  if (model && WORK_MODEL_RE.test(model)) out.model = model;
  const effort = typeof job?.effort === 'string' ? job.effort.trim() : '';
  const efforts = RUNTIMES[runtimeId]?.efforts ?? [];
  if (effort && efforts.includes(effort)) out.effort = effort;
  return out;
}
