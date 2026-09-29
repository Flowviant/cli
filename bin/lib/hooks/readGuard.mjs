#!/usr/bin/env node
/**
 * THE READ GUARD (2026-09-23, 0.97.0) — a Claude Code `PreToolUse` hook that
 * refuses a Bash command able to WRITE A FILE OR RUN A PROGRAM, attached to
 * every curated posture (consult, plan, wiki, design, research) and never to
 * the build posture, whose `--dangerously-skip-permissions` is the operator's
 * own choice.
 *
 * WHY A HOOK AND NOT A NARROWER LIST. `--allowedTools 'Bash(git log:*)'` is a
 * PREFIX match: it says which program may start, never what its arguments may
 * do. And the "read-only" git readers carry arguments that are writes or
 * executions in disguise — `--output=<path>` (log, show and diff write their
 * output to any file you name), `--ext-diff` and `--textconv` (run a
 * configured program), `-c core.fsmonitor=…` / `--config-env` (run one named
 * inline), `-O<pager>`, `--exec-path`, `--git-dir` / `--work-tree` (point git
 * at a planted repository whose config does the above). A reviewer proved it:
 * `git log -1 --format='tformat:x' --output=pwned.txt` landed under
 * RESEARCH_PERM with `permission_denials: []`. Re-measured here with a
 * friendlier phrasing — the file was written and nothing refused it. There is
 * no permission-rule syntax for "this prefix, minus these arguments".
 *
 * PROBED on Claude Code 2.1.281 before relying on it, in a scratch git repo,
 * `-p … --output-format stream-json --verbose --settings '<json>'` with the
 * curated list beside it: the hook FIRED under `--allowedTools` (the input on
 * stdin carried `tool_name: "Bash"` and the exact `tool_input.command`), exit 2
 * BLOCKED the call (the file was not written; the result listed it under
 * `permission_denials`), and the stderr sentence REACHED THE MODEL, which
 * quoted it back. So this is a real fence, not a hint.
 *
 * WHAT IT REFUSES, after one normalisation: every quote and backslash is
 * dropped before matching, because the shell splices `--out''put` and
 * `--out\put` into `--output` and a raw substring test would read neither.
 * Dropping them can only make a harmless command look worse, never a harmful
 * one look better — over-refusal is the safe direction for a read-only turn.
 *
 *  · shell composition — `>`, `<(`, `|`, `;`, `&`, a backtick, any `$`
 *    (command substitution, `${…}`, `$'…'` escapes, a variable that expands
 *    into a flag), a newline. A read-only turn runs ONE plain command; every
 *    one of these is a second command or a redirect wearing the first one's
 *    permission.
 *  · shell syntax that REWRITES A WORD after this guard read it — braces,
 *    parentheses and glob characters (`{ } ( ) * ? [`). `--outp{u,u}t=x` is
 *    `--output=x` by the time git sees it, and the substring tests below can
 *    only judge the word as written. (Quoted or not: the normalisation above
 *    has already dropped the quotes, so a quoted `*` is refused too — the
 *    over-refusal the paragraph above accepts.)
 *  · the git arguments above, as substrings (so `--config` covers
 *    `--config-env`, `--output` covers `--output-directory`), plus a bare `-c`
 *    token and any token beginning `-O`.
 *  · an environment assignment — any `GIT_*=` anywhere, and any `NAME=` as the
 *    command's first word (`GIT_DIR`, `GIT_EXTERNAL_DIFF`, `PAGER`,
 *    `LESSOPEN` all change what a reader runs).
 *
 * FAILS CLOSED: input it cannot parse is refused, because a fence that opens
 * whenever the CLI changes its hook payload is a fence that opens silently.
 * The Read, Grep and Glob tools are untouched by it — the matcher is Bash —
 * so a refused command always has a tool-shaped way to do the reading.
 *
 * OUT OF ITS REACH, stated: an operator who sets `disableAllHooks` (or a
 * managed `allowManagedHooksOnly`) in their own settings turns this off, the
 * way they could turn off anything on their own box; the prefix list is still
 * the first fence and this is the second.
 *
 * Run by the CLI as `node readGuard.mjs`, the hook JSON on stdin. Imported by
 * the tests for `readGuardRefusal`, which is the whole decision.
 */

import { pathToFileURL } from 'node:url';

/** Substrings that turn a git reader into a writer or an executor. */
const BANNED_FLAGS = ['--output', '--ext-diff', '--textconv', '--exec-path', '--git-dir', '--work-tree', '--config'];

/** Shell composition: each is a second command or a redirect. */
const SHELL = [
  ['>', 'a redirect'],
  ['<(', 'process substitution'],
  ['|', 'a pipe'],
  [';', 'a second command'],
  ['&', 'a second command'],
  ['`', 'command substitution'],
  ['$', 'an expansion'],
  ['\n', 'a second line'],
  ['\r', 'a second line'],
  // SHELL SYNTAX THE SUBSTRING TESTS BELOW DO NOT MODEL (2026-09-24, the
  // audit). The shell rewrites a word AFTER this guard has read it, so a banned
  // flag can be ASSEMBLED past a substring check: `--outp{u,u}t=x` and
  // `-{c,c}` brace-expand into `--output=x` and `-c`, and `git log -1
  // --outp{u,u}t=pwned.txt` wrote the file with this guard returning null
  // (measured, git 2.55). Globs do the same with a planted file name —
  // `-?` expands to a file called `-c` — and zsh adds glob QUALIFIERS
  // (`*(e:…:)`, which evaluate code). None of them is something a single
  // plain read needs, so the guard refuses the syntax rather than trying to
  // expand it the way some shell would: over-refusal is the safe direction,
  // and the Glob tool is the tool-shaped way to match names.
  ['{', 'brace expansion'],
  ['}', 'brace expansion'],
  ['(', 'a subshell or glob qualifier'],
  [')', 'a subshell or glob qualifier'],
  ['*', 'a glob'],
  ['?', 'a glob'],
  ['[', 'a glob'],
];

/**
 * The reason this command is refused, or null when it may run.
 * @param {string} command
 */
export function readGuardRefusal(command) {
  if (typeof command !== 'string') return 'the command could not be read';
  const flat = command.replace(/['"\\]/g, '');
  for (const [op, what] of SHELL) {
    if (flat.includes(op)) return `${what} (\`${op === '\n' || op === '\r' ? '\\n' : op}\`)`;
  }
  for (const f of BANNED_FLAGS) if (flat.includes(f)) return `\`${f}\``;
  const words = flat.trim().split(/\s+/).filter(Boolean);
  for (const w of words) {
    if (w === '-c') return '`-c` (an inline config)';
    if (w.startsWith('-O')) return '`-O`';
    if (/^GIT_[A-Za-z0-9_]*=/.test(w)) return `an environment assignment (\`${w.split('=')[0]}=\`)`;
  }
  if (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) {
    return `an environment assignment (\`${words[0].split('=')[0]}=\`)`;
  }
  return null;
}

/** The sentence the model reads when a call is refused. */
export const readGuardSentence = (why) =>
  `flowviant: this turn is read-only, so ${why} is refused here — it can write a file or run a program. ` +
  'Run one plain read command at a time with no redirects, pipes or expansions, or use the Read, Grep and Glob tools.';

function main() {
  // A hook that CRASHES is not a hook that refused: Claude Code treats any
  // exit other than 2 as a non-blocking error and runs the command anyway. So
  // every way out of this process that is not a verdict is a refusal.
  process.on('uncaughtException', () => {
    process.stderr.write(readGuardSentence('a command the guard could not judge'));
    process.exit(2);
  });
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => (buf += d));
  process.stdin.on('end', () => {
    let payload;
    try {
      payload = JSON.parse(buf);
    } catch {
      process.stderr.write(readGuardSentence('a command the guard could not read'));
      process.exit(2);
    }
    // The matcher is Bash; anything else reaching here is not ours to judge.
    if (payload?.tool_name !== 'Bash') process.exit(0);
    const why = readGuardRefusal(payload?.tool_input?.command);
    if (why) {
      process.stderr.write(readGuardSentence(why));
      process.exit(2);
    }
    process.exit(0);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
