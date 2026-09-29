/**
 * WHICH CLI builds a task, and how you drive it.
 *
 * The daemon spoke exactly one runtime for its whole life, and that assumption
 * is spread thinner than it looks: `claude -p` argv in one place, but also a
 * `--mcp-config` file, an `--append-system-prompt`, a `stream-json` event schema
 * and a set of sentinel words the turn loop reads out of stdout. A second CLI is
 * not a different binary name — it is a different answer to each of those.
 *
 * So each runtime declares its own answers — one row per vendor, in
 * runtimeClaude.mjs, runtimeCodex.mjs and runtimeAntigravity.mjs, assembled
 * into RUNTIMES here — and everything else in the daemon asks this module
 * rather than knowing them.
 *
 * WHAT A RUNTIME MUST BE ABLE TO DO to build a Flowviant task at all:
 *   1. run headless from one prompt and exit,
 *   2. talk to the flowviant MCP server — this is the whole control plane, and a
 *      runtime that cannot reach it cannot claim work, report a blocker, attach
 *      a PR or complete, which is to say it cannot participate,
 *   3. act without asking permission per tool call (there is no terminal here),
 *   4. emit machine-readable progress, or the thread goes silent for the length
 *      of a build.
 * Claude Code and Codex both do all four. Antigravity does 1, 3 and 4 and is
 * declared in runtimeAntigravity.mjs with the exact reason it cannot yet do 2.
 *
 * BUT ONLY A BUILD NEEDS ALL FOUR, and that qualifier was missing long enough to
 * cost Antigravity every capability it has. Requirement 2 is the CONTROL PLANE —
 * claiming, blockers, PRs, completing — and only a build uses it. A wiki turn
 * writes markdown the daemon syncs afterwards; a consult answers a question in
 * prose. Both already run with no MCP on every runtime, Claude included. So
 * drivability is per PROFILE (`canRun`), not one verdict per runtime, and a CLI
 * that cannot be handed a per-invocation MCP config is still a perfectly good
 * cartographer.
 *
 * WHAT THIS MODULE DELIBERATELY DOES NOT DO: pick. Which runtime runs a task is
 * decided in the app, by @mentioning it (CLAUDE.md: the @mention is the only
 * dispatch), and arrives on the brief. Detection (runtimeDetection.mjs) answers
 * "what does this machine HAVE" — activity, never capacity, and never a
 * default we invented.
 *
 * WHAT MOVED OUT (2026-09-26, SOLID F045), each to the module named for its
 * own reason to change: what a CLI's stream MEANT → runtimeEvents.mjs; which
 * CLIs this box has, and which runs an unmentioned job → runtimeDetection.mjs;
 * the skills and MCP servers a CLI reported, and the one-shot probe that
 * learns them → runtimeCapabilities.mjs; and each vendor's own row (argv,
 * profiles, efforts, MCP mint) → runtime{Claude,Codex,Antigravity}.mjs, since
 * a vendor renaming a flag is no reason to open another vendor's builder. This
 * file keeps the registry's assembly, the lookup and the per-profile
 * drivability rule.
 */

import { SAFE } from './config.mjs';
import { CLAUDE_RUNTIME } from './runtimeClaude.mjs';
import { CODEX_RUNTIME } from './runtimeCodex.mjs';
import { ANTIGRAVITY_RUNTIME } from './runtimeAntigravity.mjs';

// ── The registry ───────────────────────────────────────────────────────────

/**
 * How each runtime is told about the flowviant MCP server.
 *
 * This is the part that differs most, and it is worth naming why it matters:
 * the token handed over here is a WORKER token scoped to one lane, minted fresh
 * and dropped at the end of the turn. Anything that forces a machine-wide config
 * file forces one shared token for every lane instead, which is a real downgrade
 * in blast radius — so a runtime that cannot take per-invocation config does not
 * get to run, rather than getting to run less safely.
 *
 * Claude takes a config file path (`--mcp-config`), so the token lands in a
 * 0600 temp file the caller deletes. Codex takes dotted `-c` overrides and can
 * read the bearer token from an ENV VAR (`bearer_token_env_var`), so its token
 * never touches disk at all — strictly better, and the reason Codex was the
 * first second-runtime rather than the easiest-looking one.
 *
 * Each row's `mcp` is that mint (`claudeMcp` in runtimeClaude.mjs, `codexMcp`
 * in runtimeCodex.mjs); Antigravity's is null, and its row says why.
 */
export const RUNTIMES = {
  claude: CLAUDE_RUNTIME,
  codex: CODEX_RUNTIME,
  antigravity: ANTIGRAVITY_RUNTIME,
};

// DELETED: `DISPATCHABLE`, a `mcp && args` filter last described as "runtimes
// this daemon can actually put a task on". It had no importers left — `canRun`
// replaced it — but it was the exact predicate the per-profile split exists to
// correct, still exported under a name that invites reuse, and it answers FALSE
// for Antigravity on every job. The next caller to reach for the obvious-looking
// constant would have silently undone this release. `canRun(rt, profile)` /
// `drivableHere(rt)` below are the answers.

/**
 * The adapter for a runtime id, or NULL for an id this daemon does not declare.
 *
 * NEVER A SUBSTITUTE (2026-09-26, SOLID F048). This used to fall back to
 * Claude, so a misspelled id — or one a newer server learned ahead of this
 * daemon — minted Claude's MCP config or spawned Claude under another
 * runtime's requested identity. The callers (`mcpFor`, `runTurn`) refuse a
 * null in words, naming the id they were given. A caller that OMITS the
 * runtime still gets Claude, from its own explicit default, never from here.
 */
export const runtimeById = (id) => (typeof id === 'string' && Object.hasOwn(RUNTIMES, id) ? RUNTIMES[id] : null);

/**
 * Can the worker this daemon is running actually DRIVE this runtime right now?
 *
 * `dispatchable` on a detection row answers "is the CLI installed"; this answers
 * "and can this process build with it", which is a different question and was
 * briefly a narrower one.
 *
 * THE HISTORY MATTERS, because the answer moved twice. Live mode became the
 * default and does not spawn a CLI at all — it drives the Anthropic Agent SDK
 * in-process — so for one release this returned false for every non-live runtime
 * under LIVE. That was honest rather than correct: a machine with Codex reported
 * it could not drive Codex, which was true of the worker as it then existed, and
 * `@codex` tasks visibly waited instead of being silently built by Claude.
 *
 * 0.40.0 made it wrong by making it unnecessary. `driveSubprocess` (live.mjs)
 * gives live mode a subprocess path for non-live runtimes, sharing the same
 * worktree prep, patch landing, checkpointing and teardown as the session path.
 * So the restriction is gone and this is back to "installed, and this module
 * knows how to spawn it" — which is what the registry's `live` flag always
 * described: not which runtimes can run, but which get a session instead of a
 * subprocess.
 *
 * LIVE is no longer read here. That is deliberate and load-bearing: this
 * predicate feeds both the roster report AND the claim, and if the two ever
 * disagree the daemon either claims work it cannot build or refuses work it can.
 */
/**
 * WHICH PROFILES NEED THE MCP CONTROL PLANE. Two do.
 *
 * A BUILD has to claim work, report a blocker, attach a PR and complete — that
 * is the control plane, and a runtime that cannot reach it cannot participate.
 * A WIKI turn writes markdown the daemon syncs afterwards. A CONSULT answers a
 * question in prose. Neither passes an MCP config on ANY runtime today, Claude
 * included — check the two call sites in wikiRunner.mjs, they hand `runTurn` no
 * `mcpArgs` at all.
 *
 * A PLAN is the second one, and it is the reason the consult stopped being the
 * whole story: a planning session does not answer a question, it WRITES the plan
 * — spawns the slices, re-shapes them, drops them, maintains the spec. Every one
 * of those is a control-plane call, so a runtime that cannot reach MCP cannot
 * host a session, however well it reads code.
 *
 * Conflating them cost Antigravity every capability it has: `mcp && args` was
 * the single drivability test, so a machine-wide MCP config disqualified it from
 * two jobs that never open an MCP connection.
 */
const PROFILE_NEEDS_MCP = {
  build: true,
  wiki: false,
  consult: false,
  plan: true,
  // An agent turn has no MCP at all (SYSTEM_AGENT's header) — everything it
  // says rides the final JSON — so neither non-code posture needs one.
  design: false,
  research: false,
  // …and the image posture's (0.114.0), for the same reason: no MCP on an
  // agent turn.
  image: false,
};

/**
 * A build needs the control plane, but NOT necessarily an MCP config of its own.
 * A runtime that can return schema-enforced output is driven MEDIATED: the
 * daemon holds the MCP connection with the lane's own token and makes the calls,
 * and the CLI just returns a filled-in form. So "can build" is "can reach the
 * control plane, by either route".
 */
export const mediated = (rt) => Boolean(rt && !rt.mcp && rt.resultSchema);

/**
 * A mediated runtime whose only permission control is all-or-nothing, so
 * FLOWVIANT_SAFE cannot narrow its BUILD. Surfaced rather than swallowed: an
 * operator who set SAFE asked for something we cannot give them here, and
 * silently running unnarrowed would be the daemon deciding that on their behalf.
 */
export const mediatedSafeGap = (rt) => SAFE && mediated(rt);

/** Can this runtime do this job on this machine? */
export const canRun = (rt, profile) =>
  Boolean(rt?.args) &&
  (rt.profiles ?? []).includes(profile) &&
  (!PROFILE_NEEDS_MCP[profile] || Boolean(rt.mcp) || mediated(rt));

/**
 * Reported on the roster poll and sent on every claim, so it answers the
 * DISPATCH question specifically: can an @mention of this runtime result in a
 * task being built? That is `build`, and build is the profile that needs MCP —
 * which is why a runtime can be undispatchable and still run wiki and consult.
 */
export const drivableHere = (rt) => canRun(rt, 'build');
