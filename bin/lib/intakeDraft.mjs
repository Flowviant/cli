/** A ticket becomes one card only when the CLI supplied all four fields.
 *  Forgive a JSON fence or a sentence around it, as the plan reader does;
 *  refuse a half-card rather than landing plausible but unactionable work. */
import { candidateObjects } from './agentPlan.mjs';
import { agentTaskTypeOf } from './agentTaskTypes.mjs';
import { scrub as envScrub } from './uplinkScrub.mjs';

export const INTAKE_DRAFT_FIELDS = Object.freeze([
  'title', 'description', 'acceptanceCriteria', 'taskType',
]);

export function parseIntakeDraft(text, typeHint = null, scrub = envScrub) {
  for (const v of candidateObjects(String(text ?? ''))) {
    if (typeof v.title !== 'string' || !v.title.trim() ||
        typeof v.description !== 'string' || !v.description.trim() ||
        !Array.isArray(v.acceptanceCriteria) ||
        v.acceptanceCriteria.length < 1 || v.acceptanceCriteria.length > 5 ||
        v.acceptanceCriteria.some((line) => typeof line !== 'string' || !line.trim()) ||
        !agentTaskTypeOf(v.taskType)) continue;
    const taskType = agentTaskTypeOf(typeHint) ?? v.taskType;
    const clean = (value) => String(scrub(value.trim()));
    return {
      title: clean(v.title),
      description: clean(v.description),
      acceptanceCriteria: v.acceptanceCriteria.map(clean),
      taskType,
    };
  }
  return null;
}
