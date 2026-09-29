/**
 * CLAUDE'S PERMISSION POSTURES — the `--allowedTools` / `--disallowedTools`
 * lists (and the read guard's `--settings`) that ARE each turn profile on
 * Claude Code, looked up by the profile's name (`claudePermFor`).
 *
 * Split out of claude.mjs (SOLID 2026-09-26) because a posture changes for one
 * reason — a measured fact about what the CLI admits under a list — and that
 * reason has nothing to do with how a turn is spawned or how its event stream
 * is read. Every list here was probed on a real CLI; the probes are recorded
 * beside the list they justify, and they move with it.
 */

import { fileURLToPath } from 'node:url';
import { SAFE } from './config.mjs';

/**
 * THE READ GUARD, ON EVERY CURATED POSTURE (2026-09-23) — see
 * hooks/readGuard.mjs for what it refuses and the probe that proved it fires.
 *
 * A `Bash(git log:*)` allow is a PREFIX: it names the program and says nothing
 * about the arguments, and `git log --output=<path>` writes any file while
 * `-c core.fsmonitor=…` / `--ext-diff` run a program. A reviewer landed
 * `git log -1 --format='tformat:x' --output=pwned.txt` under RESEARCH_PERM with
 * no denial, and it re-measured the same way here. So every list below that
 * promises "reads, and nothing else" carries a `PreToolUse` hook through
 * `--settings`, measured on Claude Code 2.1.281: it fires under
 * `--allowedTools`, exit 2 blocks the call, and its sentence reaches the model.
 *
 * NEVER ON THE BUILD POSTURE: `--dangerously-skip-permissions` is the
 * operator's own choice for a turn that is meant to write, and a guard there
 * would be refusing the job. Nor on PLAN_MODE_PERM, which is the CLI's own
 * posture on the owner's own tab, not a list this file promises anything about.
 *
 * The hook runs as `<this node> <readGuard.mjs>` — the daemon's own
 * `process.execPath`, never a `node` looked up on a PATH the operator may not
 * have, because a hook that fails to START is a non-blocking error and the
 * command runs anyway.
 */
export const READ_GUARD_PATH = fileURLToPath(new URL('./hooks/readGuard.mjs', import.meta.url));
const hookQuote = (s) =>
  process.platform === 'win32' ? `"${s}"` : `'${String(s).replace(/'/g, `'\\''`)}'`;
export const READ_GUARD_SETTINGS = JSON.stringify({
  hooks: {
    PreToolUse: [
      {
        matcher: 'Bash',
        hooks: [{ type: 'command', command: `${hookQuote(process.execPath)} ${hookQuote(READ_GUARD_PATH)}` }],
      },
    ],
  },
});
/** Spread FIRST into a curated list: `--allowedTools` is variadic, so the
 *  `--settings` pair must stand before it or be swallowed as a tool name. */
const READ_GUARD = ['--settings', READ_GUARD_SETTINGS];

/** A path a permission rule can name: absolute POSIX, and free of the glob and
 *  rule-syntax characters that would change what the rule means. Anything else
 *  gets no rule — `--add-dir` still admits the directory (measured). */
const ruleSafeAbsolute = (p) =>
  typeof p === 'string' && p.startsWith('/') && !/[*?[\]{}()\\\n]/.test(p) ? p.replace(/\/+$/, '') : null;

/**
 * THE READ FENCE — the worktree, plus the knowledge library by its absolute
 * path, and nothing else on the box (2026-09-24, the audit).
 *
 * Every curated posture used to allow bare `Read`, `Grep` and `Glob`, and a
 * bare allow is not "read the repo": measured on Claude Code 2.1.281, bare
 * `Read` read a file outside the working directory and bare `Grep` searched
 * one. So a design, consult or capture turn — each steered by words anyone who
 * can file a card can write — could read `~/.flowviant/credentials.json`, which
 * holds the MACHINE CREDENTIAL of every project connected on this box, and put
 * it in an artifact, a plan note or a transcript that leaves the machine. That
 * is a cross-project leak from a posture this file calls read-only.
 *
 * The fence is research's, measured the same day in the design shape:
 * `Read(./**)` and `Glob(./**)` read the worktree; the knowledge library reads
 * through `--add-dir` plus its own `//` rule; a file outside both was refused
 * ("Claude requested permissions to read from …, but you haven't granted it
 * yet"). GREP CARRIES NO ALLOW RULE AT ALL, on purpose: with none, Grep in the
 * working directory (and in the added knowledge directory) ran, and Grep of a
 * path outside them was refused. The Bash readers these postures keep are
 * path-validated by the CLI on its own (see CONSULT_BASH).
 */
function fencedReads(knowledgeDir) {
  const kd = ruleSafeAbsolute(knowledgeDir);
  return [
    'Read(./**)',
    ...(kd ? [`Read(/${kd}/**)`] : []),
    'Glob(./**)',
    ...(kd ? [`Glob(/${kd}/**)`] : []),
  ];
}

/** The shell readers CONSULT and PLAN keep. Each one is PATH-VALIDATED by the
 *  CLI itself — measured on 2.1.281 (2026-09-24): with `Bash(cat:*)`,
 *  `Bash(head:*)` and `Bash(ls:*)` allowed, `cat`/`ls`/`head` on a file outside
 *  the working directories were each refused ("Claude Code may only
 *  concatenate files from the allowed working directories") — so it is the
 *  Read/Grep/Glob TOOLS, not these, that needed the fence above. */
const CONSULT_BASH = [
  'Bash(ls:*)',
  'Bash(wc:*)',
  'Bash(head:*)',
  'Bash(cat:*)',
  'Bash(git log:*)',
  'Bash(git show:*)',
  'Bash(git diff:*)',
  'Bash(git rev-parse:*)',
];

/**
 * PLAN — read the repo, write the plan, never the code.
 *
 * The read half is `consultPermFor`'s verbatim (the read fence and the
 * path-validated shell readers): this turn's prompt is steered by
 * anything a project editor can type, so the same threat applies and the same
 * allowlist answers it. What is added is the control plane and NOTHING else —
 * `mcp__flowviant` is the plan principal's token, whose entire tool set is the
 * five plan tools (the server refuses anything else on it). So even a fully
 * hijacked turn's most destructive reachable act is dropping a slice from the
 * plan it is already in, which a human can see and undo in the thread.
 *
 * Note what is absent versus WIKI_PERM: Write, Edit, mkdir and rm. The
 * cartographer needs those because it authors files; a planner authors records
 * through an API, and there is no file on this machine it has any business
 * touching.
 */
export function planPermFor(knowledgeDir) {
  return [
    ...READ_GUARD,
    '--allowedTools',
    'mcp__flowviant',
    ...fencedReads(knowledgeDir),
    ...CONSULT_BASH,
  ];
}

// Unattended (default) skips prompts so the agent never stalls with no terminal;
// FLOWVIANT_SAFE=1 restricts to a curated toolset instead.
const PERM = SAFE
  ? [
      '--allowedTools',
      'mcp__flowviant',
      'Edit',
      'Write',
      'Read',
      'Grep',
      'Glob',
      'Bash(git:*)',
      'Bash(gh:*)',
      'Bash(npm:*)',
      'Bash(bun:*)',
    ]
  : ['--dangerously-skip-permissions'];

// Wiki turns are read-the-repo + write-the-vault ONLY — always curated, never
// --dangerously-skip-permissions: no gh, no push-capable git, no package
// managers, and nothing that can EXECUTE arbitrary commands — no `find`
// (-exec/-delete) and no `git grep` (-O<pager> runs a shell; the Grep tool
// covers search). Command execution is the line: it enables network exfil,
// which plain file writes never do. `rm` IS allowed: pruning a stale vault
// page requires a real file deletion (that's how the sync protocol learns of
// it), and the blast radius is bounded — the daemon resets the repo worktree
// after every wiki turn, and the vault has its own git history.
// (Write/Edit can't be path-scoped here; the worktree reset is the backstop.)
const WIKI_PERM = [
  ...READ_GUARD,
  '--allowedTools',
  'Read',
  'Grep',
  'Glob',
  'Edit',
  'Write',
  'Bash(ls:*)',
  'Bash(wc:*)',
  'Bash(head:*)',
  'Bash(cat:*)',
  'Bash(mkdir:*)',
  'Bash(rm:*)',
  'Bash(git status:*)',
  'Bash(git log:*)',
  'Bash(git show:*)',
  'Bash(git diff:*)',
  'Bash(git rev-parse:*)',
];

// A CONSULT reads and answers. Nothing else.
//
// It used to run on WIKI_PERM, whose comment two blocks up says the quiet part:
// Write/Edit "can't be path-scoped here; the worktree reset is the backstop".
// That is a fine trade for the cartographer, which exists to author files and
// gets reset after every turn. It is the wrong trade for a consult, whose prompt
// is steered by a question ANY project editor can write and which had no reset
// behind it — so a sentence in a chat box could reach Write, rm and mkdir on
// someone else's machine. The permission list is the enforcement; the prompt's
// "do not change anything" is only an instruction, and instructions are exactly
// what an injected question competes with.
export function consultPermFor(knowledgeDir) {
  return [...READ_GUARD, '--allowedTools', ...fencedReads(knowledgeDir), ...CONSULT_BASH];
}

/**
 * THE TWO NON-CODE POSTURES (0.97.0) — a design card and a research card may
 * WRITE, and only under `.flowviant/artifacts/`.
 *
 * The card's words are steered by anyone who can file a card, so "change
 * nothing" as prose is only an instruction, and the permission list is the
 * enforcement. What each carries is the ONE write its contract needs:
 *
 *  · `Edit(.flowviant/artifacts/**)` — PROBED on Claude Code 2.1.281 before
 *    relying on it (2026-09-23): with `--allowedTools 'Read'
 *    'Edit(.flowviant/artifacts/**)'`, a `-p` turn told to write
 *    `.flowviant/artifacts/a.html` AND `b.txt` at the root wrote the first and
 *    was DENIED the second. The Edit rule governs every file-writing tool,
 *    Write included. Spelled `Write(.flowviant/artifacts/**)` — or `./`- or
 *    `//abs`-anchored — the same probe was denied BOTH files, so that spelling
 *    is not a scoped write at all, it is no write. Relative to the turn's cwd,
 *    which is the agent's own worktree, which is where the artifact scan looks.
 *    `**` AND NOT `*`, measured the same day: `Edit(.flowviant/artifacts/*)`
 *    let a Write to `.flowviant/artifacts/sub/b.html` through exactly as `**`
 *    did, so the single-level spelling is not narrower on this CLI and would
 *    only read as if it were. So where a file may sit under the artifacts
 *    directory is the prompt's to say, never the posture's: the design and
 *    research contracts say "no subfolders" (written when the scan kept
 *    top-level files only; it walks to depth four since 0.99.0), and the
 *    3D-model contract, under this same posture, asks for one folder.
 *
 * THEY ARE NOT THE SAME READER, and the difference is the network:
 *
 *  · DESIGN draws THIS product, so it reads the repo — the worktree and the
 *    knowledge library through the read fence (`fencedReads`, 2026-09-24:
 *    it was bare Read/Grep/Glob, which reach the whole box), Grep with no
 *    allow rule, `ls`, and `.env*` denied by name — and has no web at all (a mockup that went looking on the
 *    web would be a mockup of somebody else's product). No git readers and no
 *    cat/head/wc: Read covers every one of them, and each git reader was an
 *    `--output` away from a write (see READ_GUARD, which it still carries for
 *    the `ls` it keeps).
 *  · RESEARCH has the web — WebSearch and WebFetch — and a turn that can both
 *    read a secret and fetch a URL can send one. So its reading is FENCED to
 *    what the card is about: `Read(./**)` (the worktree) plus the project's
 *    knowledge library by its absolute path, `Glob(./**)` for names, NO Grep
 *    (an unscoped search of the home directory prints matching lines), NO
 *    Bash at all, and `.env*` DENIED by name. PROBED on 2.1.281, the whole
 *    list with `--add-dir <knowledge>`: a file in the cwd read; `/etc/hostname`,
 *    a sibling directory's file and `~/.flowviant/credentials.json` were each
 *    refused ("Claude requested permissions to read from …, but you haven't
 *    granted it yet"); `.env` was refused ("File is in a directory that is
 *    denied by your permission settings"); the knowledge file read. Two
 *    controls: WITHOUT the `--disallowedTools` pair, `Read(./**)` read `.env`
 *    — the deny is load-bearing; and a bare `Glob` listed `~/.flowviant`
 *    while `Glob(./**)` refused it and still listed the cwd and the added
 *    directory. The knowledge `Read(//…)` rule is belt: `--add-dir` alone
 *    admitted the file, and the rule keeps the read allowed should the
 *    adapter ever stop passing that flag.
 *    AND `Bash` IS DENIED BY NAME, because leaving it off the allow list is
 *    not "no Bash": measured the same day, with Bash absent from
 *    `--allowedTools` the CLI still ran `git log -1 --format=%s` and `ls` on
 *    its own read-only classifier (it did refuse `git log … --output=…`,
 *    "This command requires approval" — the reviewer's write needed the
 *    explicit `Bash(git log:*)` prefix the old list carried). With `Bash` in
 *    `--disallowedTools` the tool was not there at all.
 *
 * NO MCP, and no shell that could commit: the agent turn has no MCP anyway
 * (see SYSTEM_AGENT's header), and a posture that could run `git commit` could
 * commit the mockup it was told to keep out of git.
 *
 * STATED, not closed: research may still read any file in the worktree and
 * name it in a WebFetch URL — the repository is what a research card is about,
 * and a turn that could not read it could not answer. Design may read any
 * file in its worktree and put it in an artifact the server stores; text
 * artifacts are scrubbed of the machine's known secret values — and of any
 * Flowviant credential, by shape — on the way out (artifacts.mjs, uplinkScrub.mjs), and
 * binary ones are withheld when they carry one.
 * Design still runs a plain `git log` on the CLI's own read-only classifier
 * though no git reader is allowed (measured) — the guard is what refuses its
 * `--output`. And the Agent tool is offered with no allow rule on this CLI:
 * a research turn with Bash denied launched a subagent to run one, and the
 * subagent had no Bash either (measured) — the rules are inherited. Whether
 * the guard's hook sees a subagent's own calls was not measured here.
 */
const ARTIFACT_WRITE = 'Edit(.flowviant/artifacts/**)';
/**
 * PLAN MODE (0.97.0) — a Workbench tab's `planMode` switch, and Claude Code's
 * own `--permission-mode plan` INSTEAD OF every list above: the CLI reads,
 * decides and answers with a plan, and refuses each write itself.
 *
 * PROBED on Claude Code 2.1.281 before relying on it (2026-09-23), in a scratch
 * git repo, `-p … --output-format stream-json --verbose`:
 *
 *  · ALONE, asked to "add a subtract(a, b) function to app.js": the init event
 *    reads `permissionMode: "plan"`, the turn Read the file, ran a read-only
 *    `find`, wrote its plan to `~/.claude/plans/<slug>.md` (the CLI's own plan
 *    file, outside the repo), tried `ExitPlanMode` and was told "Error: No such
 *    tool available: ExitPlanMode. ExitPlanMode is disabled for this session",
 *    and ended with the plan as its result text. app.js was untouched.
 *  · BESIDE `--dangerously-skip-permissions`, same ask: the init event reads
 *    `permissionMode: "bypassPermissions"` — no error, no warning — and the
 *    edit LANDED. The bypass silently wins. So this list is a REPLACEMENT for
 *    `perm`, never an addition, and a plan turn can never carry both.
 *  · WITH `--mcp-config` and `--allowedTools mcp__flowviant`: the server
 *    connected and its tools were listed, but a call was refused — "Cannot
 *    call mcp__flowviant__log_work while in plan mode." — and without the
 *    `--allowedTools` entry, "Claude requested permissions to use
 *    mcp__flowviant__log_work, but you haven't granted it yet." Plan mode
 *    admitted the call ONLY when the server annotated the tool
 *    `readOnlyHint: true`, and none of the session tools (stream_session_turn,
 *    log_work, file_card …) are read-only or annotated so. So a plan turn runs
 *    PLAIN — no MCP, the plain tab's contract — rather than mounting a control
 *    plane whose every call the CLI refuses. See workSessionTurns.mjs.
 */
export const PLAN_MODE_PERM = ['--permission-mode', 'plan'];
export function designPermFor(knowledgeDir) {
  return [
    ...READ_GUARD,
    '--allowedTools',
    ...fencedReads(knowledgeDir),
    'Bash(ls:*)',
    ARTIFACT_WRITE,
    // A mockup is uploaded and runs scripts in a frame that may navigate
    // itself, so the checkout's own secrets are denied by name too — the same
    // pair research carries, measured load-bearing there.
    '--disallowedTools',
    'Read(./.env*)',
    'Read(./**/.env*)',
  ];
}
export const DESIGN_PERM = designPermFor(null);

/**
 * RESEARCH, built at spawn — the knowledge library is the one directory
 * outside the worktree it may read, and only the spawn knows where that is.
 * `//` is the CLI's own spelling for an absolute path in a rule.
 */
export function researchPerm(knowledgeDir) {
  return [
    ...READ_GUARD,
    '--allowedTools',
    ...fencedReads(knowledgeDir),
    'WebSearch',
    'WebFetch',
    ARTIFACT_WRITE,
    '--disallowedTools',
    'Read(./.env*)',
    'Read(./**/.env*)',
    'Bash',
  ];
}
/** The list with no library — what a project that keeps none runs under. */
export const RESEARCH_PERM = researchPerm(null);

/**
 * CLAUDE'S PERMISSION LIST FOR A TURN PROFILE, by the profile's name — one
 * entry per name in turnProfile.mjs (a test holds the two tables equal). The
 * builders that take the knowledge directory get it; the fixed lists ignore it.
 */
const CLAUDE_PERM = {
  build: () => PERM,
  wiki: () => WIKI_PERM,
  consult: (kd) => consultPermFor(kd),
  plan: (kd) => planPermFor(kd),
  'plan-mode': () => PLAN_MODE_PERM,
  design: (kd) => designPermFor(kd),
  research: (kd) => researchPerm(kd),
  // THE IMAGE POSTURE IS CODEX'S (0.114.0) and Claude does not declare it
  // (runtimeClaude.mjs `profiles`), so turnProfile.mjs refuses a Claude turn
  // under it before argv is built. The entry exists because `runTurn` looks
  // Claude's list up BY NAME for every runtime (the adapter that is not Claude
  // ignores it), and a missing name throws. Were it ever reached on Claude it
  // is the consult list: read-only, no write at all — failing closed.
  image: (kd) => consultPermFor(kd),
};
export const CLAUDE_PERM_PROFILES = Object.freeze(Object.keys(CLAUDE_PERM));
export function claudePermFor(profileName, knowledgeDir) {
  const build = Object.hasOwn(CLAUDE_PERM, profileName) ? CLAUDE_PERM[profileName] : null;
  if (!build) throw new Error(`no Claude permission list for profile '${profileName}'`);
  return build(knowledgeDir);
}
