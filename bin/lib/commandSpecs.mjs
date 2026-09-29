/**
 * EVERY TERMINAL COMMAND, ONCE (2026-09-26, SOLID F054).
 *
 * A command used to live in three inventories: help.mjs's table, cli.mjs's
 * `noCheckoutCommand` set (whether `--dir` moves the process into the
 * checkout before config.mjs reads the project bound to cwd), and cli.mjs's
 * chain of `process.argv[2] === '<name>'` conditionals — and help.test.mjs
 * only kept two of them aligned. This table is the one list: help.mjs renders
 * it, cli.mjs asks `commandUsesCheckout` for the --dir policy and dispatches
 * by `findCommand(...).name` to a named handler in its HANDLERS map.
 * help.test.mjs pins that every row has exactly one handler (or is one of the
 * BUILTIN rows cli.mjs answers before dispatch).
 *
 * NO IMPORTS, on purpose: cli.mjs reads this before `--dir` is applied, which
 * is before config.mjs may load.
 *
 * `hidden` rows are real commands a person rarely types (an agent calls
 * `shot`; `mcp` manages connectors from a script); they answer
 * `help <name>` but stay off the main screen. `usesCheckout` is true where
 * the command works on the checkout `--dir` names.
 */

export const COMMANDS = [
  {
    name: 'start',
    usesCheckout: true,
    usage: 'flowviant [start] [--project <name|id>]',
    summary: "Serve this repo's project: run agents and Terminal tabs here. Plain `flowviant` does the same.",
    details: [
      'Run it inside the repository you connected. The first run in a new repo asks you to approve this computer.',
      '--project <name|id>   serve that stored project instead of the one this repo is bound to',
    ],
    group: 'run',
  },
  {
    name: 'login',
    usesCheckout: true,
    usage: 'flowviant login [--no-start]',
    summary: 'Connect this repo to a project: approve the code in your browser, then start serving.',
    details: ['--no-start   save the connection without starting the daemon'],
    group: 'run',
  },
  {
    name: 'stop',
    usesCheckout: false,
    usage: 'flowviant stop [--project <name|id>]',
    summary: 'Stop every flowviant daemon on this computer (or just one project’s).',
    group: 'run',
  },
  {
    name: 'status',
    usesCheckout: false,
    usage: 'flowviant status',
    summary: 'Each project connected here: its repo, whether it is running and serving, and its live agents.',
    details: ['--json   the machine-readable form the Windows tray reads'],
    group: 'look',
  },
  {
    name: 'logs',
    usesCheckout: true,
    usage: 'flowviant logs [-f] [--project <name|id>]',
    summary: "The daemon's log for this repo's project.",
    details: ['-f, --follow   keep printing new lines as they are written', '-n <lines>     how many lines to show first (default 80)'],
    group: 'look',
  },
  {
    name: 'open',
    usesCheckout: true,
    usage: 'flowviant open [--project <name|id>]',
    summary: "Open this project's board in your browser (prints the link too).",
    group: 'look',
  },
  {
    name: 'projects',
    usesCheckout: false,
    usage: 'flowviant projects',
    summary: 'Every project this computer has a login for, and the repo each one serves.',
    group: 'look',
  },
  {
    name: 'machines',
    usesCheckout: false,
    usage: 'flowviant machines [--remove <id> | --forget <id>] [--yes]',
    summary: 'Every computer that serves your projects. On a terminal, a menu to disconnect or forget one here.',
    group: 'look',
  },
  {
    name: 'doctor',
    usesCheckout: true,
    usage: 'flowviant doctor',
    summary: 'Check what this computer needs: git, a signed-in CLI, a connection to Flowviant, a running daemon.',
    group: 'look',
  },
  {
    name: 'update',
    usesCheckout: false,
    usage: 'flowviant update',
    summary: 'Install the newest flowviant now. It also updates itself when idle.',
    group: 'manage',
  },
  {
    name: 'clean',
    usesCheckout: false,
    usage: 'flowviant clean',
    summary: 'Delete the kept agent worktrees under ~/.flowviant/worktrees. Stop the daemon first.',
    group: 'manage',
  },
  {
    name: 'uninstall',
    usesCheckout: false,
    usage: 'flowviant uninstall [--purge] [--yes]',
    summary: 'Remove every flowviant copy on this computer. Logins are kept unless you add --purge.',
    details: ['--purge   also disconnect this computer from its projects and delete ~/.flowviant', '--yes     do not ask first'],
    group: 'manage',
  },
  {
    name: 'gh-auth',
    usesCheckout: false,
    usage: 'flowviant gh-auth',
    summary: 'Sign in the GitHub CLI flowviant uses to open pull requests.',
    group: 'manage',
  },
  {
    name: 'version',
    usesCheckout: false,
    usage: 'flowviant --version',
    summary: 'Print the installed version.',
    group: 'manage',
  },
  {
    name: 'help',
    usesCheckout: false,
    usage: 'flowviant help [command]',
    summary: 'This list, or one command in detail.',
    group: 'manage',
  },
  {
    name: 'shot',
    usesCheckout: false,
    usage: 'flowviant shot <url> [--out <file>]',
    summary: 'Screenshot a running page with a headless browser (agents use it to see their change).',
    hidden: true,
  },
  {
    name: 'mcp',
    usesCheckout: false,
    usage: 'flowviant mcp <subcommand>',
    summary: "Manage the project's MCP connectors from a script.",
    hidden: true,
  },
];

/** Rows cli.mjs answers itself rather than through HANDLERS: `version` and
 *  `help` before any command runs, `start` as the fall-through daemon path. */
export const BUILTIN_COMMANDS = ['start', 'help', 'version'];

export const ALIASES = { '--version': 'version', '-v': 'version', '--help': 'help', '-h': 'help' };

export function findCommand(name) {
  const key = ALIASES[name] ?? name;
  return COMMANDS.find((cmd) => cmd.name === key) ?? null;
}

/**
 * Does `--dir` move the process into the checkout before this word runs?
 * Anything the table does not name — a flag such as `--project`, or no word at
 * all — is the start path, which serves the checkout. (An unknown word is
 * refused after the move, exactly as before.)
 */
export function commandUsesCheckout(word) {
  const cmd = findCommand(word);
  return cmd ? cmd.usesCheckout : true;
}
