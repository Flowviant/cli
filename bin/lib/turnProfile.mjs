/**
 * A TURN'S PROFILE — the one name a caller gives `runTurn` for the posture a
 * CLI turn runs under, and what that name means before any adapter sees it.
 *
 * Split out (SOLID F047) because `runTurn` took five independent posture
 * switches — `wikiPerm`, `readOnly`, `planPerm`, `planMode`, `posture` — and
 * resolved them through two separate precedence chains (one for the adapter's
 * profile name, one for Claude's permission list). A caller could say two
 * things at once (a plan turn that is also read-only) and the answer was
 * whichever branch came first. Now a caller names ONE profile; a name this
 * table does not know, or any of the retired switches, fails the turn in
 * words instead of falling through to the build posture.
 *
 * The profiles:
 *  - build     — the default: the operator's own build posture;
 *  - wiki      — the cartographer: writes only the vault;
 *  - consult   — read-only (the scratch planner, the AI pre-review);
 *  - plan      — the capture chat: read-only plus its control plane;
 *  - plan-mode — a Workbench plan turn: Claude Code's own
 *                `--permission-mode plan`, REPLACING the build posture, no MCP.
 *                Claude only. The adapter sees `build` (argv is `perm`);
 *  - design / research / image — a non-code card's posture
 *                (agentTaskKinds.mjs), refused on any runtime that does not
 *                DECLARE it, because every other adapter's fallback is its
 *                build branch. design and research are Claude Code's; image
 *                (0.114.0) is Codex's.
 *
 * Claude's permission list for each name lives beside the lists themselves
 * (`claudePermFor`, claudePosture.mjs); this module owns the vocabulary and the
 * refusals, and imports the card-kind table and the runtime registry (whose
 * declared `profiles` say which CLI a kind posture runs on).
 */
import { KIND_POSTURES } from './agentTaskKinds.mjs';
import { RUNTIMES } from './runtimes.mjs';

/** The CLIs that DECLARE a posture, by label — "Claude Code", "Codex". Read
 *  from the registry, so the refusal names whoever can run it, never a CLI
 *  written into the sentence by hand. */
const declaredBy = (name) =>
  Object.values(RUNTIMES)
    .filter((rt) => (rt.profiles ?? []).includes(name))
    .map((rt) => rt.label)
    .join(' or ') || 'no CLI this daemon knows';
const article = (word) => (/^[aeiou]/i.test(word) ? 'an' : 'a');

const plain = (adapterProfile) => Object.freeze({ adapterProfile, onlyOn: null, strictMcp: false });

export const TURN_PROFILES = Object.freeze({
  build: plain('build'),
  wiki: plain('wiki'),
  consult: plain('consult'),
  plan: plain('plan'),
  'plan-mode': Object.freeze({
    adapterProfile: 'build',
    // Plan mode is Claude's own flag. The other adapters build argv from the
    // profile name and never read `perm`, so on them it would be a BUILD turn
    // wearing the word "plan".
    onlyOn: (rt) => (rt.id === 'claude' ? null : `plan mode runs on Claude Code only — not '${rt.label}'`),
    strictMcp: true,
  }),
  // The kind postures: fenced to "write only the artifacts directory", and a
  // runtime that does not declare one would run its build branch instead.
  // The sentence names the CLI(s) that do declare it: "a design card runs on
  // Claude Code only", "an image card runs on Codex only".
  ...Object.fromEntries(
    KIND_POSTURES.map((name) => [
      name,
      Object.freeze({
        adapterProfile: name,
        onlyOn: (rt) =>
          (rt.profiles ?? []).includes(name)
            ? null
            : `${article(name)} ${name} card runs on ${declaredBy(name)} only — not '${rt.label}'`,
        strictMcp: false,
      }),
    ])
  ),
});

/** The switches `profile` replaced. Passing one is a caller nobody updated —
 *  and silently ignoring it would run that caller's turn as a BUILD turn. */
export const RETIRED_POSTURE_KEYS = Object.freeze(['wikiPerm', 'readOnly', 'planPerm', 'planMode', 'posture']);

/**
 * `{ name, adapterProfile, onlyOn, strictMcp }` for a turn's options, or
 * `{ error }` in words. Absent `profile` is build.
 */
export function resolveTurnProfile(opts = {}) {
  const retired = RETIRED_POSTURE_KEYS.filter((k) => opts[k] !== undefined);
  if (retired.length) return { error: `the turn named a retired posture switch (${retired.join(', ')}) — name one profile instead` };
  const name = opts.profile ?? 'build';
  if (typeof name !== 'string' || !Object.hasOwn(TURN_PROFILES, name)) {
    return { error: `unknown turn profile '${String(name).slice(0, 40)}'` };
  }
  return { name, ...TURN_PROFILES[name] };
}
