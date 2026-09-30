/**
 * CODEX, AS A RUNTIME — its registry row: argv per profile (the kernel
 * sandbox postures), efforts, the env-carried MCP token, and its parser.
 *
 * Split out of runtimes.mjs (2026-09-26, SOLID F045). Each vendor's argv moves
 * on its own vendor's release schedule; the registry (runtimes.mjs) assembles
 * the rows and owns the rule that reads them, and the JSONL parser this row
 * hands out as `parse` lives with the other stream parsers in
 * runtimeEvents.mjs.
 */

import { isAbsolute, join } from 'node:path';
import { SAFE } from './config.mjs';
import { parseCodexLine } from './runtimeEvents.mjs';
import { ARTIFACT_DIR, FENCE_TMP_DIR } from './artifacts.mjs';
import { codexPersonalTurn } from './codexPersonal.mjs';

/**
 * FLOWVIANT'S OWN TOOLS NEED NO APPROVAL FROM A CHAT NOBODY CAN ANSWER
 * (2026-09-29). The owner's Codex New task chat staged nothing: "flowviant
 * rejected the tool calls because approval is required and this session's
 * policy forbids it". MEASURED on codex-cli 0.156.1 with a fake MCP server
 * whose one tool carries no annotations (Flowviant's carry none): under the
 * capture chat's read-only argv the call failed "MCP tool call requires
 * approval, but approval policy is never" and never reached the server; under
 * the build posture (workspace-write) the same call ran unasked. With
 * `mcp_servers.flowviant.default_tools_approval_mode="approve"` beside the
 * read-only argv it ran — and in the same turn a shell write still failed
 * "Read-only file system" and an escalation still failed "approval policy is
 * Never; reject command".
 *
 * So the approval is this ONE server's, never a blanket `approval_policy`:
 * what its tools may do is the per-turn token's scope, which the server
 * enforces (a capture token stages and reads; it files nothing), and every
 * other door — the shell, file writes, escalation, any other server — keeps
 * the posture's own rule. Wherever the server is mounted: the capture chat
 * needs it, and a Terminal tab's build posture already ran the calls.
 */
function codexMcp(token, mcpUrl) {
  return {
    dir: null, // nothing written — the token rides in the environment
    args: [
      '-c',
      `mcp_servers.flowviant.url="${mcpUrl}"`,
      '-c',
      'mcp_servers.flowviant.bearer_token_env_var="FLOWVIANT_MCP_TOKEN"',
      '-c',
      'mcp_servers.flowviant.default_tools_approval_mode="approve"',
    ],
    env: { FLOWVIANT_MCP_TOKEN: token },
  };
}

/**
 * THE POSTURES THAT READ NONE OF THE PERSON'S CONFIG — the branches of `args()`
 * below that pass `--ignore-user-config`, said once so the adapter and its
 * `personal` hook cannot disagree about which turns carry the person's login
 * back (codexPersonal.mjs). A wiki turn with no vault is a build turn there,
 * and so here.
 */
export const codexIgnoresUserConfig = ({ profile = 'build', vaultDir } = {}) =>
  profile === 'consult' || profile === 'plan' || profile === 'image' || profile === 'design' || (profile === 'wiki' && Boolean(vaultDir));

/**
 * WHAT A FENCED CODEX TURN MAY NOT REACH FOR (0.114.0). codex-cli 0.156.1
 * ships `browser_use` (and its external and full-CDP forms), an in-app
 * browser, `computer_use` and `apps` switched ON; a read-only consult, a
 * plan, a capture chat, a wiki or an image turn asked for none of them, and
 * a browser or the desktop is a way around a filesystem fence. A build turn
 * keeps the person's own config.
 */
const NO_REACH_OUT = [
  '-c', 'features.browser_use=false',
  '-c', 'features.browser_use_external=false',
  '-c', 'features.in_app_browser=false',
  '-c', 'features.computer_use=false',
  '-c', 'features.apps=false',
];

export const CODEX_RUNTIME = {
  id: 'codex',
  label: 'Codex',
  vendor: 'OpenAI',
  bin: 'codex',
  install: 'npm i -g @openai/codex',
  login: 'codex login',
  live: false,
  /**
   * BUILD AND CONSULT. See `args()` below for how consult is expressed — the
   * short version is that Codex keeps the promise at the kernel rather than in
   * a verb allowlist, and for a consult's actual threat (exfiltration driven
   * by an injected question) that is sufficient and arguably stronger.
   *
   * ALL THREE, and `wiki` is the one worth pausing on: Codex expresses it
   * MORE strictly than Claude does. A cartographer must read the repo and
   * write only the vault; Claude's WIKI_PERM cannot path-scope Write and says
   * so, leaning on the worktree reset as a backstop. Codex's permission
   * profiles enforce the same rule in the kernel — measured: repo readable,
   * vault writable, repo writes refused, network off.
   *
   * Enforcement was verified on Linux (bubblewrap + seccomp). macOS Seatbelt
   * and Windows are UNTESTED; if this daemon starts running there, re-verify
   * before trusting the consult posture on those platforms.
   *
   * AND `image` (0.114.0), which ONLY Codex declares: the image card's fence —
   * see the branch in `args()`. It is the one kind posture that is not
   * Claude's, because the pictures come from Codex's own image tool.
   *
   * AND `design` (0.115.0), shared with Claude: the mockup, 3D-model and deck
   * cards' fence, expressed as `codexDesignFence` below. Research is NOT
   * declared: its web and Codex's whole-box reads cannot be fenced apart
   * (see that function).
   */
  profiles: ['build', 'consult', 'wiki', 'plan', 'image', 'design'],
  /** `model_reasoning_effort` tops out at `xhigh` — there is no `max`, and a
   *  queued or skewed job naming it would be an argument Codex refuses. */
  efforts: ['low', 'medium', 'high', 'xhigh'],
  mcp: codexMcp,
  /**
   * Codex has NO system-prompt flag. The contract therefore rides inside the
   * prompt, fenced and placed first, and this is a genuine weakening worth
   * stating plainly: a system prompt is a rule, and a prompt preamble is a
   * strong suggestion the model may drift from over a long turn. It is the
   * best available; AGENTS.md was the alternative and is worse, because it is
   * a FILE IN THE WORKTREE — one `git add -A` from being committed into the
   * user's repository, which is not a risk worth taking for a slightly
   * stickier instruction.
   *
   * Agent turns additionally pass reviewed base instructions as a developer
   * config override when the personal config has no developer instruction;
   * the prompt always carries them too. Workbench tabs keep their normal
   * checkout discovery.
   *
   * `--skip-git-repo-check` is deliberately NOT passed: a task always builds
   * in a git worktree, and if it somehow is not one, failing loudly beats
   * silently editing files nobody can diff.
   *
   * THE PROMPT IS LAST, and that is load-bearing rather than tidy. Codex takes
   * it as a trailing POSITIONAL, so every flag — including the two `-c` MCP
   * overrides, which the caller hands in rather than appending — has to be
   * placed before it. Appending them after the positional is the kind of argv
   * that parses today and stops parsing on some future clap upgrade.
   */
  args({ prompt, system, model, effort, resume, resumeThreadId, profile = 'build', vaultDir, cwd, mcp = [], resultSchemaArgs = [], adoptResumeId, agentTools, personal = null }) {
    // Adoption resumes a conversation in ITS OWN CLI's store (claude forks,
    // agy moves) — codex has no adoptable store wired yet. Reaching here
    // with an adopt id is a wiring mistake upstream, and it fails loudly on
    // purpose: quietly dropping the flag would answer that session's held
    // context with a different brain.
    if (adoptResumeId) throw new Error("codex has no adoptable terminal store — an adopt id can't reach this builder");
    const a = ['exec'];
    // BY ID when the caller knows WHICH conversation this is — a Workbench
    // tab's held context, captured off thread.started and stored with its
    // worktree. `--last` resumes the machine's most recent codex conversation,
    // which is only safe on the dispatch path (one lane, one turn at a time,
    // in its own worktree); for a session it is a machine-global guess that
    // two tabs — or a tab plus a dispatch — would cross-resume.
    if (resumeThreadId) a.push('resume', resumeThreadId);
    else if (resume) a.push('resume', '--last');
    a.push('--json');
    if (agentTools) {
      a.push('-c', 'project_doc_max_bytes=0');
      // A person's existing developer instructions keep their authority.
      // The base snapshot is also present in the per-turn prompt preamble.
      if (!agentTools.personalDeveloperInstructions)
        a.push('-c', `developer_instructions=${JSON.stringify(agentTools.instructions)}`);
    }
    if (model) a.push('--model', model);
    // Effort is a config value on Codex rather than a flag.
    if (effort) a.push('-c', `model_reasoning_effort="${effort}"`);

    if (profile === 'consult') {
      // A CONSULT, EXPRESSED THE ONLY WAY CODEX CAN EXPRESS IT — and it is a
      // different shape from Claude's, which is the whole reason `profile` is
      // a promise rather than a flag list.
      //
      // Claude gets a VERB allowlist: Read, Grep, Glob and a handful of
      // read-only Bash forms, with nothing that reaches the network. Codex has
      // no such thing — it has no file-read tool at all, so reading the repo
      // IS command execution (`cat`, `rg`). Removing the shell leaves the
      // model with exactly ["update_plan","request_user_input"], which cannot
      // answer a question about a codebase. You get both capabilities or
      // neither.
      //
      // So the promise is kept one layer down instead. `read-only` is
      // kernel-enforced (bubblewrap + seccomp on Linux): writes fail, and a
      // direct-IP connect fails with "Operation not permitted" — socket() is
      // denied, not merely DNS. An injected command still RUNS and still
      // cannot take the repository anywhere, which is the threat a consult
      // actually has: its prompt is steered by a question any project editor
      // can type. Arguably a stronger guarantee than the allowlist, being
      // below the agent rather than inside it.
      a.push('-c', 'sandbox_mode="read-only"');

      // THE HOLE THE SANDBOX DOES NOT COVER. `web_search` ships in `codex
      // exec`'s default tool list even without --search, and it executes
      // SERVER-SIDE at OpenAI — no local sandbox touches it. An injected turn
      // could pack repo contents into a query and egress them straight past
      // everything above. Both spellings, because the two config systems
      // disagree about which one is live.
      a.push('-c', 'tools.web_search=false', '-c', 'web_search="disabled"');

      // Sub-agents would be a second turn whose posture nobody here chose.
      a.push('-c', 'features.multi_agent=false', '-c', 'features.goals=false', ...NO_REACH_OUT);
      // Image generation ships ON in codex-cli 0.156.1 even under
      // --ignore-user-config (measured 2026-09-29): a turn that asked for no
      // picture is handed no tool that spends image credits.
      a.push('--disable', 'image_generation');

      // HERMETIC. Without these a user's ~/.codex/config.toml, a project
      // `.rules` execpolicy file, or their own MCP servers can widen a posture
      // we are asserting on their behalf — silently, and on the one turn whose
      // prompt comes from someone else's typing.
      a.push('--ignore-user-config', '--ignore-rules');
    } else if (profile === 'plan') {
      // A PLANNING SESSION. Read-only on the filesystem, exactly like a
      // consult — the writes it makes go through the control plane, not
      // through this box — so the kernel sandbox is the same one, and for the
      // same reason: this turn's prompt is steered by anything a project
      // editor can type.
      //
      // Everything the consult branch above closes stays closed, and the
      // reasoning is unchanged, so it is not restated: web_search egresses
      // server-side at OpenAI where no local sandbox reaches it, sub-agents
      // would be a turn whose posture nobody here chose, and a user's own
      // config or MCP servers must not widen a posture we are asserting on
      // their behalf.
      //
      // What differs from a consult is the ONE thing this profile exists for:
      // an MCP config IS passed, carrying this turn's scoped token. The plan
      // token has the planning tools; a capture token has only staging and
      // transcript tools. The server refuses everything outside that scope.
      a.push('-c', 'sandbox_mode="read-only"');
      a.push('-c', 'tools.web_search=false', '-c', 'web_search="disabled"');
      a.push('-c', 'features.multi_agent=false', '-c', 'features.goals=false', ...NO_REACH_OUT);
      // Image generation ships ON in codex-cli 0.156.1 even under
      // --ignore-user-config (measured 2026-09-29): a turn that asked for no
      // picture is handed no tool that spends image credits.
      a.push('--disable', 'image_generation');
      a.push('--ignore-user-config', '--ignore-rules');
    } else if (profile === 'wiki' && vaultDir) {
      // THE CARTOGRAPHER, AND THIS ONE IS STRICTER THAN CLAUDE'S.
      //
      // A wiki turn reads the whole repo and writes ONLY the vault. Claude
      // cannot actually express that: WIKI_PERM hands it Write/Edit and its own
      // comment admits "Write/Edit can't be path-scoped here; the worktree
      // reset is the backstop" — i.e. the cartographer CAN scribble on the
      // checkout and we clean up afterwards.
      //
      // Codex's permission profiles take a per-path filesystem map, so the
      // rule is enforced by the kernel instead of apologised for. Measured:
      // repo readable, vault writable, repo writes fail "Read-only file
      // system", and curl returns 000 — the network is off, which is the half
      // WIKI_PERM was really protecting (its comment: "Command execution is
      // the line: it enables network exfil").
      //
      // The table is set WHOLE rather than as a dotted key, and that is not
      // style: `-c permissions.wiki.filesystem."<path>"="write"` splits the
      // dotted path on the dots INSIDE the path, and every real vault lives
      // under `~/.flowviant/vaults/…`. It fails with "filesystem path must be
      // absolute", which reads like a path problem and is a parsing one.
      a.push('-c', 'permissions.flowviantwiki.extends=":read-only"');
      a.push('-c', `permissions.flowviantwiki.filesystem={"${vaultDir}"="write"}`);
      // Selected by config: `codex exec` (0.156.1) has no `-P`, so every Codex
      // wiki turn was refused before it started (0.114.0).
      a.push('-c', 'default_permissions="flowviantwiki"');
      a.push('--disable', 'image_generation');
      a.push(...NO_REACH_OUT);
      a.push('--ignore-user-config', '--ignore-rules');
    } else if (profile === 'image') {
      // AN IMAGE CARD (0.114.0): read the repo, write ONLY the worktree's
      // `.flowviant/artifacts/`, generate pictures, and nothing else. The
      // cartographer's shape — a permission profile whose filesystem map the
      // kernel enforces — pointed at the artifacts directory instead of a
      // vault. MEASURED on codex-cli 0.156.1 (Linux, bubblewrap), with no model
      // turn spent: under this profile a `cp` from a CODEX_HOME-shaped folder
      // into the artifacts directory landed, a write to a repo file failed
      // "Read-only file system", and curl got no network; `codex debug
      // prompt-input` with these overrides renders a managed profile of
      // `write <worktree>/.flowviant/artifacts` + `read :root`, "Approval
      // policy is currently never".
      //
      // SELECTED BY `default_permissions`, NOT `-P`: `codex exec` (and `exec
      // resume`) on 0.156.1 refuse `-P` as an unexpected argument — only
      // `codex sandbox` takes it — while `-c default_permissions="<name>"`
      // resolves the named profile in both. The directory must EXIST before
      // spawn (measured: a missing one cannot be created from inside the
      // fence), which the agent lane sees to (`ensureArtifactDir`).
      //
      // WHERE THE PICTURES COME FROM. Codex's own `image_gen` tool saves each
      // one under `$CODEX_HOME/generated_images/…` and says the path (the
      // binary's own words: "Generated images are saved to … by default. If
      // you need to use a generated image at another path, copy it"). An agent
      // turn's CODEX_HOME is the agent's own isolated home (projectToolRuntimes,
      // kept per agent since 2026-09-29); `:root` reads admit it, so the agent
      // copies what it keeps into the one writable directory, where the
      // artifact scan finds it.
      //
      // IMAGE GENERATION IS SWITCHED ON HERE AND ONLY HERE — a decision. This
      // is the one turn whose card asks for pictures, so it must not depend
      // on whatever the person's config says about the feature. A BUILD turn
      // keeps the person's own config (not hermetic, by design — see below),
      // and the other fenced postures (consult, plan, wiki) never asked for a
      // picture, so none of them is handed a tool that spends image credits.
      if (!cwd || !isAbsolute(cwd)) {
        throw new Error("an image turn needs its worktree to fence — none reached codex's builder");
      }
      const artifacts = join(cwd, ARTIFACT_DIR);
      a.push('-c', 'permissions.flowviantimage.extends=":read-only"');
      // The table WHOLE (the wiki branch's reason: a dotted key splits on the
      // dots inside the path), the path as a TOML basic string.
      // …and the fence's own scratch (2026-09-29, the design fence's
      // measurement: a `cat > x <<EOF` needs a temp file, and /tmp is
      // read-only in here), named for the shells through TMPDIR/TMPPREFIX.
      const scratch = join(cwd, FENCE_TMP_DIR);
      a.push('-c', `permissions.flowviantimage.filesystem={${JSON.stringify(artifacts)}="write",${JSON.stringify(scratch)}="write"}`);
      a.push('-c', `shell_environment_policy.set={TMPDIR=${JSON.stringify(scratch)},TMPPREFIX=${JSON.stringify(join(scratch, 'zsh'))}}`);
      a.push('-c', 'default_permissions="flowviantimage"');
      a.push(...NO_REACH_OUT);
      // Nobody is on this end of the pipe to approve an escalation.
      a.push('-c', 'approval_policy="never"');
      a.push('--enable', 'image_generation');
      // No web: the consult branch's two spellings, for its reason — web
      // search runs server-side where no sandbox reaches it.
      a.push('-c', 'tools.web_search=false', '-c', 'web_search="disabled"');
      a.push('-c', 'features.multi_agent=false', '-c', 'features.goals=false', ...NO_REACH_OUT);
      a.push('--ignore-user-config', '--ignore-rules');
    } else if (profile === 'design') {
      // A MOCKUP, 3D-MODEL OR DECK CARD (0.115.0): the fence is
      // `codexDesignFence`'s, argued and measured at its definition below.
      a.push(...codexDesignFence(cwd));
    } else {
      // The daemon's build posture, mapped: SAFE keeps writes inside the
      // workspace, the default lets the agent run its own tests and git
      // commands. Neither asks a human — there is no human on this end of the
      // pipe. Deliberately NOT hermetic: a build is work the user asked for by
      // @mentioning this CLI, and their own config is theirs to apply.
      //
      // AS CONFIG, NOT `--sandbox` (0.114.0): `codex exec resume` accepts no
      // `--sandbox` flag (codex-cli 0.156.1 lists only `-c`/`--enable`/…), so
      // every resumed turn — an agent's second card, an answer — was refused
      // before it started. `-c sandbox_mode=` means the same on both.
      a.push('-c', `sandbox_mode="${SAFE ? 'workspace-write' : 'danger-full-access'}"`);
    }

    /**
     * …AND THE PERSON'S LOGIN RIDES BACK BESIDE THE FLAG (2026-09-29,
     * codexPersonal.mjs): where the login lives, the provider and endpoint it
     * signs into, and the model an unpinned turn runs — `-c` pairs after
     * `--ignore-user-config`, never a key that widens the posture above.
     * Keyed on the flag itself, so a fenced branch added later carries the
     * login the day it ignores the file. `personal` is runTurn's, read where
     * the turn's Codex will look (the `personal` hook below); a caller that
     * hands none gets the posture as it was.
     */
    if (a.includes('--ignore-user-config')) a.push(...(personal?.args ?? []));

    a.push(...mcp, ...resultSchemaArgs);
    a.push(`${system}\n\n---\n\n${prompt}`);
    return a;
  },
  /**
   * THE PERSON'S LOGIN FOR A FENCED TURN, read once per spawn by runTurn from
   * the turn's own environment (its CODEX_HOME — an agent's own home when the
   * lane keeps one): `{ args, env }`, the `-c` pairs `args()` places and the
   * literal secrets they name, which ride the child's environment, never argv.
   * Null for a turn that reads the person's config itself.
   */
  personal: ({ profile, vaultDir, env, model, effort } = {}) =>
    codexIgnoresUserConfig({ profile, vaultDir }) ? codexPersonalTurn({ env, model, effort }) : null,
  parse: parseCodexLine,
  /** `codex exec --output-schema <file>` constrains the FINAL message to a
   *  JSON Schema. Only needed on the mediated path; the direct path reports
   *  through MCP tool calls, which are already structured. */
  resultSchema: (path) => ['--output-schema', path],
};

/**
 * THE MOCKUP, 3D-MODEL AND DECK CARDS' FENCE ON CODEX (0.115.0; 2026-09-29, the
 * owner: "its saying 3d models run on claude only but thats not true").
 *
 * The image fence's shape without the image tool: a permission profile that
 * reads the repo and writes ONLY `<worktree>/.flowviant/artifacts/`, selected
 * by `default_permissions` (`codex exec` and `exec resume` refuse `-P` on
 * 0.156.1), no network, no web search, no sub-agents, no browser, computer or
 * apps, nobody's config or rules, and no approvals to wait on. Nothing about
 * the card's contract needs more: every one of the three is one HTML page, and
 * a page's CDN scripts load in the viewer, never on this machine.
 *
 * MEASURED on codex-cli 0.156.1 (Linux, bubblewrap), with gpt-6-luna at low
 * effort, in a scratch git repository (2026-09-29), with exactly this argv:
 *  · the WRITE FENCE holds for both of Codex's ways to write: its
 *    `apply_patch` of `src/escape-patch.txt` was refused by Codex itself
 *    ("patch rejected: writing outside of the project; rejected by user
 *    approval settings"), and `echo x > src/escape-shell.txt` and
 *    `echo x > /tmp/fv-escape.txt` each failed "read-only file system";
 *    `apply_patch` of `.flowviant/artifacts/ok-patch.txt` landed;
 *  · NO NETWORK: `curl https://example.com` failed "Could not resolve host";
 *    NO WEB: the model reported no search tool;
 *  · THE TOOL LIST was `apply_patch`, `clock__curr_time`, `exec_command`,
 *    `view_image`, `write_stdin` — and `image_gen__imagegen` WITHOUT
 *    `--disable image_generation`: image generation ships ON in 0.156.1 even
 *    under `--ignore-user-config`, so it is switched off here by name, and a
 *    mockup never spends the person's image credits;
 *  · THE CONTRACTS DELIVER: the real mockup, 3D-model and deck contracts each
 *    produced their one page under `.flowviant/artifacts/` (the model page
 *    with its `glb-ready`/`export-glb` handshake and GLTFExporter, the deck
 *    with its sections, arrow keys and print rules) and changed no repository
 *    file (`git status` clean but for the ignored directory);
 *  · THE SCRATCH IS LOAD-BEARING: a deck turn that wrote its page with a
 *    here-document got "can't create temp file for here document: read-only
 *    file system", left a 0-byte page and stopped to ask; with the scratch
 *    granted and named (below) the same here-document wrote the page, and a
 *    resumed turn (`exec resume <id>` with this argv, as `CODEX_RUNTIME.args`
 *    builds it) edited it in place.
 *
 * STATED, not closed: Codex's permission profile READS the whole box, where
 * Claude's design list reads only the worktree and the knowledge library. It
 * cannot be narrowed on 0.156.1 — a `"none"` entry over the home directory
 * hides Codex's own sandbox helper when Codex is installed there ("bwrap:
 * execvp …/codex: No such file or directory"), and masking a second FILE
 * fails every command ("bwrap: Can't write data to file …: Bad file
 * descriptor"). With the network and the web shut, the one road out is the
 * artifact itself, which is scrubbed of the machine's known secret values and
 * of any Flowviant credential by shape on the way up — the image fence's
 * standing (0.114.0), and why RESEARCH is not declared here: a write-up needs
 * the web, and a turn that can read `.env` and `~/.flowviant/credentials.json`
 * while holding `web_search` (both measured readable under this profile with
 * `web_search="live"`) is the exfiltration Claude's research list was fenced
 * to prevent.
 */
export function codexDesignFence(cwd) {
  if (!cwd || !isAbsolute(cwd)) {
    throw new Error("a design turn needs its worktree to fence — none reached codex's builder");
  }
  const artifacts = join(cwd, ARTIFACT_DIR);
  // THE TURN'S OWN SCRATCH (artifacts.mjs `ensureFenceScratch`, made empty by
  // the lane before spawn): `/tmp` is read-only in here, and a here-document
  // needs a temp file — measured, a `cat > page.html <<EOF` failed "can't
  // create temp file for here document: read-only file system" and the turn
  // stopped to ask. Granted, and named by the two variables the shells read
  // (`TMPDIR`; zsh's `TMPPREFIX`), set for every command through
  // `shell_environment_policy.set` — measured to reach the sandboxed shell.
  const scratch = join(cwd, FENCE_TMP_DIR);
  return [
    '-c', 'permissions.flowviantdesign.extends=":read-only"',
    // The table WHOLE and the path a TOML basic string — the wiki branch's
    // reason: a dotted key splits on the dots inside the path.
    '-c', `permissions.flowviantdesign.filesystem={${JSON.stringify(artifacts)}="write",${JSON.stringify(scratch)}="write"}`,
    '-c', `shell_environment_policy.set={TMPDIR=${JSON.stringify(scratch)},TMPPREFIX=${JSON.stringify(join(scratch, 'zsh'))}}`,
    '-c', 'default_permissions="flowviantdesign"',
    '-c', 'approval_policy="never"',
    '--disable', 'image_generation',
    '-c', 'tools.web_search=false', '-c', 'web_search="disabled"',
    '-c', 'features.multi_agent=false', '-c', 'features.goals=false',
    ...NO_REACH_OUT,
    '--ignore-user-config', '--ignore-rules',
  ];
}
