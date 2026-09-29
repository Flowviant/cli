/**
 * A CARD'S TYPE — the daemon's one table of what each type ASKS (0.106.0).
 *
 * A type is the kind of WORK a card asks for — a Bug fix, a Refactor, a Code
 * review — a flavour over the card's KIND (agentTaskKinds.mjs), which stays the
 * end product and the posture the turn runs under. Every type runs as exactly
 * one kind (`kind` below, the app's `TASK_TYPE_KIND`), and adds the one thing
 * the kind cannot say: a bug fix reproduces first, a refactor must not change
 * behaviour, a code review changes nothing.
 *
 * The server sends the id — `agentTurnJobs[].task.taskType` and
 * `agentPlanJobs[].tasks[].taskType` — and only to a daemon at 0.106.0 (below
 * it the server parks a typed card's turn rather than hand it to a daemon that
 * would drop the key). THE DAEMON OWNS THE WORDS: each type's `contract` is
 * the one sentence an agent is held to, printed inside THE CARD right after
 * the kind line (`AGENT_TASK_SPEC`), so the spec stashed for the pre-review
 * carries it too. Each sentence is true to what its kind's posture can do: a
 * code type may build and test; a write-up type reads and writes one Markdown
 * file; a mockup type writes under .flowviant/artifacts/ and nothing else; the
 * Image type (0.114.0) generates pictures with Codex's own tool and copies
 * them there.
 *
 * `label` is the app's `TASK_TYPE_LABEL`, the word a person picked. The ids
 * (in the app's picker order), their kinds and their labels are held to the
 * app's `taskType.ts` by the release gate (`scripts/check-app-parity.mjs`,
 * rule 6): a type the server sends that this table lacks is printed as
 * nothing, and one it has that the server never sends is dead.
 *
 * Pure data and pure functions; its one import is the kind table's reader.
 */

import { agentTaskKindOf } from './agentTaskKinds.mjs';

export const AGENT_TASK_TYPES = Object.freeze({
  feature: Object.freeze({
    label: 'Feature',
    kind: 'code',
    contract: 'new behaviour: build it, and cover it with tests where the repository has them.',
  }),
  fix: Object.freeze({
    label: 'Bug fix',
    kind: 'code',
    contract:
      'reproduce it first, with a failing test where the repository has tests, then make that test pass.',
  }),
  tests: Object.freeze({
    label: 'Tests',
    kind: 'code',
    contract:
      'add tests for code that already exists and change no production code; if a test exposes a bug, ' +
      'say so in your summary instead of fixing it.',
  }),
  refactor: Object.freeze({
    label: 'Refactor',
    kind: 'code',
    contract: 'behaviour must not change; if an existing test would have to change, stop and ask.',
  }),
  infra: Object.freeze({
    label: 'Infra & deploy',
    kind: 'code',
    contract: 'change the configuration in the repository; never run a deploy or touch a live environment.',
  }),
  automation: Object.freeze({
    label: 'Automation',
    kind: 'code',
    contract:
      "add the scheduled job to the repository (a CI schedule, or a script and its schedule) so it runs " +
      "where the repository's CI runs; do not run it.",
  }),
  review: Object.freeze({
    label: 'Code review',
    kind: 'research',
    contract:
      'read the code the card names and write up what is wrong, by file and line, most serious first; ' +
      'change nothing.',
  }),
  ui: Object.freeze({
    label: 'UI design',
    kind: 'design',
    contract: "draw the screens and flows the card names as the mockup page, in this product's own components and words.",
  }),
  prototype: Object.freeze({
    label: 'Prototype',
    kind: 'design',
    contract: 'make every control in the flow work, with realistic sample data, in the one page.',
  }),
  slides: Object.freeze({
    label: 'Slides',
    kind: 'deck',
    contract: 'one deck for the audience and the length the card asks for, one point to a slide.',
  }),
  model3d: Object.freeze({
    label: '3D model',
    kind: 'model',
    contract:
      'model the object the card describes in the one three.js page, at the scale and in the units of the ' +
      'target the card names, else of any 3D assets the repository already has.',
  }),
  vector: Object.freeze({
    label: 'Icons & vector',
    kind: 'design',
    contract:
      'write each icon as its own .svg file directly in .flowviant/artifacts/, and make the mockup page ' +
      'the sheet that shows them all, inline, at the sizes they are used.',
  }),
  image: Object.freeze({
    label: 'Image',
    kind: 'image',
    contract:
      'generate the picture the card describes with your image tool, at the size and in the style it ' +
      'names, and hand back each image it asks for as its own PNG or WebP file.',
  }),
  research: Object.freeze({
    label: 'Research',
    kind: 'research',
    contract: 'answer the question the card asks, leading with the answer and citing what you read.',
  }),
  writing: Object.freeze({
    label: 'Writing',
    kind: 'research',
    contract: 'write the document the card asks for, for the reader it names, in words that reader uses.',
  }),
});

/**
 * A CARD'S TYPE, READ THE ONE WAY THE DAEMON READS IT — a type this table
 * knows, else null. ABSENT IS NO TYPE (every card before 0.106.0, and every
 * job from an older server), and an unknown id (a newer server, a typo) is
 * dropped rather than guessed at: a type only adds a sentence, so dropping one
 * leaves the card running on its kind, which is what it always did.
 */
export const agentTaskTypeOf = (v) => (typeof v === 'string' && Object.hasOwn(AGENT_TASK_TYPES, v) ? v : null);

/**
 * The type of a card AS IT WILL BE PRINTED — null unless the card's type is
 * known here AND runs as the card's own kind. The server sends a type only on
 * its kind, but the card is a document any editor writes; a Bug fix sentence
 * ("with a failing test") under a mockup's posture is a contract the turn
 * cannot keep, so a type on another kind is printed as nothing.
 */
export const agentTaskTypeFor = (task) => {
  const type = agentTaskTypeOf(task?.taskType);
  return type && AGENT_TASK_TYPES[type].kind === agentTaskKindOf(task?.taskKind) ? type : null;
};
