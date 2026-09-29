/**
 * ANTIGRAVITY, AS A RUNTIME — its registry row, and the measured record of why
 * it cannot be handed a per-lane MCP config.
 *
 * Split out of runtimes.mjs (2026-09-26, SOLID F045). Each vendor's argv moves
 * on its own vendor's release schedule; the registry (runtimes.mjs) assembles
 * the rows and owns the rule that reads them (`canRun`, `mediated`), and the
 * stream-json parser this row hands out as `parse` lives with the other stream
 * parsers in runtimeEvents.mjs.
 */

import { parseAgyLine } from './runtimeEvents.mjs';

/**
 * DECLARED, NOT DRIVABLE — and this is now MEASURED rather than argued.
 *
 * The reason went wrong twice before it went right, so the evidence is written
 * down here in full. First it cited upstream antigravity-cli#60, which is about
 * `.antigravitycli/mcp_config.json` — the project-DISCOVERY folder — while
 * claiming it was about `.agents/`, the workspace-CUSTOMIZATION folder. Then,
 * on reading the docs (antigravity.google/docs/mcp describes `.agents/`, and
 * Google's own codelab creates it), this comment swung the other way and said
 * the blocker looked wrong. Both were reasoning from paperwork.
 *
 * THE TEST, run against agy 1.1.12, signed in, in a real git repo:
 * the SAME minimal stdio MCP server, declared two ways.
 *   • workspace `<worktree>/.agents/mcp_config.json` → the server process is
 *     NEVER SPAWNED. Not connected-and-failed: never launched. The model
 *     answers "NO_MCP".
 *   • global `~/.gemini/config/mcp_config.json` → spawns immediately and
 *     handshakes: server/discover, initialize, notifications/initialized,
 *     tools/list.
 * stdio deliberately, to remove every confound — no bearer token to reject,
 * no network, no TLS. The difference is the config LOCATION and nothing else.
 *
 * AND IT SURVIVES THE TRUST VARIABLE, which was the obvious objection: agy
 * keeps a `trustedWorkspaces` list in settings.json, a fresh per-task worktree
 * is not on it, and an untrusted folder demonstrably changes behaviour (the
 * model stops treating cwd as its workspace and works out of its own scratch
 * dir). Adding the worktree to `trustedWorkspaces` and re-running changed
 * nothing: the server still never spawned, the model still answered NO_MCP.
 * So the workspace config is not trust-gated, it is simply not read.
 *
 * So Antigravity's MCP config is machine-wide IN PRACTICE, and the original
 * blocker's conclusion stands even though its cited reason never did: every
 * lane on the box would share one worker token, which is exactly the blast
 * radius the per-lane token exists to prevent. That is why this stays
 * undrivable, and it is a property of the CLI rather than something we can
 * work around from here.
 *
 * A TRAP FOR WHOEVER RE-TESTS THIS: agy exposes MCP through a single generic
 * `call_mcp_tool` dispatcher, so per-server tools NEVER appear in the `init`
 * event's tools array even when a server is loaded correctly. Reading that
 * array tells you nothing. Watch the server process instead, or ask the model.
 *
 * FOUR MORE FACTS from the same session, each an independent obstacle:
 *   1. AUTH IS INTERACTIVE OAUTH (bubbletea TUI; needs a real /dev/tty), with
 *      no headless credential path. A signed-out `agy -p` prints a consent URL
 *      and then SITS until `--print-timeout` (default 5m) before erroring — so
 *      a lane on a signed-out agy burns five minutes per turn looking like a
 *      hang. Preflight cannot see it: `--version` succeeds while signed out.
 *   2. `--sandbox` IS A BOOLEAN ("terminal restrictions enabled"), not a mode
 *      selector — but a CONSULT POSTURE IS STILL EXPRESSIBLE, and this was
 *      recorded backwards here for a while. It does not come from `--sandbox`
 *      at all; it comes from headless mode's default. Any tool needing a
 *      permission that cannot be prompted for is AUTO-DENIED:
 *        "User denied permission to run command: <cmd>"
 *        "a tool required the 'command' permission that headless mode cannot
 *         prompt for, so it was auto-denied."
 *      Observed repeatedly, including for an entirely benign `pwd && ls -la`,
 *      and a local listener confirmed no egress in any run. Reads (list_dir,
 *      file reads) work throughout. So: NOT passing
 *      `--dangerously-skip-permissions` IS the consult posture, and passing it
 *      is the build posture — both per invocation, both harness-enforced
 *      rather than model-instructed. `--mode plan` is a separate, WEAKER thing:
 *      it steers behaviour and blocks workspace writes, but it is not what
 *      stops command execution.
 *      RESIDUAL RISK, and it has no fix from here: `permissions.allow` in the
 *      machine-wide settings.json is inherited, so a user who has allowed
 *      `command(...)` widens every consult on that box. Codex has
 *      `--ignore-user-config` for exactly this; agy has no equivalent.
 *   3. No `mcp` subcommand; `/mcp` is interactive-only.
 *   4. It attempts to INSTALL PLAYWRIGHT at startup (observed failing 404
 *      against playwright.azureedge.net). A daemon runtime that downloads and
 *      runs a browser driver is worth knowing before it goes on a machine the
 *      project leaves running.
 *
 * There is no npm package. `antigravity-cli` (0.0.1, "placeholder") and `agy`
 * (0.0.0, empty) on npm are SQUATS by unrelated accounts; the real channel is
 * the install script at antigravity.google, which is why `install` below says
 * to see the docs rather than naming an npm command.
 *
 * WHAT WOULD UNBLOCK IT: a per-invocation MCP flag or env var, or workspace
 * configs actually being honoured. Re-test with the two-location stdio probe
 * above — it is five minutes and it answers the question outright. Pin any
 * wiring to >= 1.1.10 (`--model`/`--effort` were ignored in headless before it;
 * `--output-format` arrived in 1.1.8).
 */
export const ANTIGRAVITY_RUNTIME = {
  id: 'antigravity',
  label: 'Antigravity',
  vendor: 'Google',
  bin: 'agy',
  install: 'see antigravity.google/docs/cli',
  login: 'agy',
  live: false,
  /** None, because it cannot reach the MCP server at all — see `blocked`. */
  /**
   * WIKI AND CONSULT, BUT NOT BUILD — and the split is the whole point of
   * making drivability per-profile rather than one verdict.
   *
   * Only a BUILD needs the MCP control plane: claiming, reporting a blocker,
   * attaching a PR, completing. A wiki turn writes markdown files that the
   * daemon syncs afterwards, and a consult answers a question in prose; BOTH
   * already run with no MCP at all on every runtime, Claude included. Gating
   * them on an MCP capability they never use was a test of the wrong thing,
   * and it is what kept Antigravity at zero for months.
   *
   * Build returns here when the mediated adapter lands (the daemon holds the
   * MCP connection and the CLI just returns schema-enforced JSON via
   * `--json-schema`), which needs no per-invocation MCP config from the vendor
   * at all.
   *
   * PLAN IS ABSENT ON PURPOSE, and NOT because a planning turn is beyond it —
   * it reads code as well as anything here. A plan session is a conversation
   * that makes many control-plane calls as it goes (spawn a slice, re-shape
   * it, drop it, rewrite the spec), and mediation turns a turn into ONE
   * schema-enforced form the daemon then applies. That shape fits a build,
   * whose outcome is a single structured result; it does not yet fit an
   * argument. Note that `canRun` would otherwise say yes via `mediated()` and
   * hand this runtime a job it cannot finish — declaring the profile is the
   * only thing standing between here and that. Mediated planning is a real
   * design (the session returns its writes as a batch), just not a built one.
   */
  profiles: ['build', 'wiki', 'consult'],
  /** No measured ladder, and ignorance never refuses: the full list, as the
   *  server's `RUNTIME_EFFORTS.antigravity` keeps it. */
  efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  mcp: null,
  args({ prompt, system, model, effort, resume, resumeConversationId, profile = 'build', vaultDir, resultSchemaArgs = [], adoptResumeId }) {
    const a = [];
    // WHICH CONVERSATION IS THIS — one decision, answered one way (the same
    // rule as Claude's --resume/--continue). By id when the caller knows:
    // `--conversation <id>` resumes globally, any cwd (measured on 1.1.12).
    // Adoption is the SAME argv because agy has no fork — the id in the db
    // is the identity (a renamed copy fails "trajectory not found",
    // measured), so adopting MOVES the conversation: the tab continues the
    // terminal session itself, appending to its one store. `--continue` is
    // the cwd-keyed fallback for a session whose id was never learned.
    if (adoptResumeId || resumeConversationId) a.push('--conversation', adoptResumeId || resumeConversationId);
    else if (resume) a.push('--continue');
    // No system-prompt flag, same weakening as Codex: the contract rides in
    // the prompt, fenced and first.
    a.push('-p', `${system}\n\n---\n\n${prompt}`);
    a.push('--output-format', 'stream-json');
    if (model) a.push('--model', model);
    if (effort) a.push('--effort', effort);
    a.push(...resultSchemaArgs);

    if (profile === 'wiki') {
      // THE CARTOGRAPHER, at the same bar WIKI_PERM sets for Claude — writes
      // allowed, network shut. Both halves measured on 1.1.12:
      //   • headless cannot prompt, so anything needing approval is
      //     auto-denied — including the file writes a wiki turn exists to
      //     make. `--dangerously-skip-permissions` is what grants them.
      //   • `--sandbox` blocks egress: with it, curl returned 400 and a local
      //     listener saw nothing; without it, 200 and the request arrived.
      // Upstream #36 warns these two cancel out (skip-permissions
      // auto-approving the sandbox-bypass prompt). It does NOT reproduce on
      // 1.1.12 — tested together, the write landed and the network stayed
      // shut. Re-check on upgrade: if it ever does cancel, this posture
      // silently becomes "wiki turn with internet", which is the one line
      // WIKI_PERM draws ("Command execution is the line: it enables network
      // exfil").
      if (vaultDir) a.push('--add-dir', vaultDir);
      a.push('--sandbox', '--dangerously-skip-permissions');
      // A sweep reads a whole repository; the 5m default would guillotine it.
      a.push('--print-timeout', '60m');
    } else if (profile === 'build') {
      // A BUILD WRITES, and headless auto-denies anything needing approval —
      // so without this every edit comes back "User denied permission" and the
      // turn reports failure having touched nothing. Caught only because an
      // end-to-end test had to add the flag by hand to work.
      //
      // NOT `--sandbox` here, unlike wiki: a build has to `git push`, so it
      // needs the network by definition.
      //
      // AND NOTHING ELSE CONTAINS IT EITHER. This comment used to end "the
      // containment is the worktree, as it is for every runtime", which was
      // false and is the kind of false that stops people looking: `cwd` is a
      // starting directory, not a jail. A build turn runs with the operator's
      // full user permissions — it can write outside the worktree, to their
      // home directory, to their other checkouts. Claude gets
      // --dangerously-skip-permissions, codex gets --sandbox
      // danger-full-access, and agy gets no sandbox flag at all. The only
      // real boundary today is that the person driving the tab is trusted.
      //
      // FLOWVIANT_SAFE HAS NO EXPRESSION ON THIS RUNTIME. Claude narrows to an
      // allowlist and Codex to `workspace-write`; agy's only per-invocation
      // control is this boolean, and its allow/deny engine is machine-wide.
      // So a SAFE-mode operator gets an agy build that is not actually
      // narrowed — which is why `mediatedSafeGap` is surfaced rather than
      // quietly ignored.
      a.push('--dangerously-skip-permissions');
      a.push('--print-timeout', '60m');
    } else if (profile === 'consult') {
      // NOTHING GRANTED, deliberately. The headless default IS the consult
      // posture: `run_command` comes back "User denied permission… headless
      // mode cannot prompt for it, so it was auto-denied", observed even for a
      // benign `pwd && ls -la`, with no egress in any run. Reads keep working,
      // which is all a consult needs. Passing --dangerously-skip-permissions
      // here would hand a question ANY project editor can type a shell.
      a.push('--print-timeout', '10m');
    }
    return a;
  },
  parse: parseAgyLine,
  /**
   * `--json-schema` enforces the shape of the final result — verified against
   * 1.1.12, which returned exactly the object asked for. This is what makes a
   * BUILD possible on a runtime that cannot be handed an MCP config: the CLI
   * stops needing to CALL anything and just returns a filled-in form, and the
   * daemon makes the control-plane calls on its behalf with the lane's own
   * per-lane token. Strictly better than parsing markers out of prose, which a
   * model can wrap in a code fence, truncate or hallucinate.
   */
  resultSchema: (path) => ['--json-schema', path],
  blocked:
    'its MCP config is machine-wide — a workspace .agents/mcp_config.json is never loaded (measured), so every lane would share one token',
};
