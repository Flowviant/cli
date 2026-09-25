/**
 * `flowviant help` — what you can type, in one screen.
 *
 * There was no help at all, and a bare word fell through to STARTING the
 * daemon: `flowviant --help`, `flowviant status` and a typo like
 * `flowviant hlep` all started serving. The owner, 2026-09-25: "everytime i
 * type flowviant it just starts, but what if i wanted to do --help or some cmd
 * to see what cmds are there?" So this table is the list, `help <command>`
 * and `<command> --help` print one entry, and an unknown word is refused with
 * the nearest command instead of being served.
 *
 * THE TABLE IS PINNED TO THE DISPATCH: help.test.mjs reads every
 * `process.argv[2] === '<name>'` in cli.mjs and fails if one is missing here
 * (or listed here and not dispatched). `hidden` rows are real commands a
 * person rarely types (an agent calls `shot`; `mcp` manages connectors from a
 * script); they answer `help <name>` but stay off the main screen.
 */

import { c } from './ui.mjs';

export const COMMANDS = [
  {
    name: 'start',
    usage: 'flowviant [start] [--project <name|id>]',
    summary: "Serve this repo's project: run agents and Workbench tabs here. Plain `flowviant` does the same.",
    details: [
      'Run it inside the repository you connected. The first run in a new repo asks you to approve this computer.',
      '--project <name|id>   serve that stored project instead of the one this repo is bound to',
    ],
    group: 'run',
  },
  {
    name: 'login',
    usage: 'flowviant login [--no-start]',
    summary: 'Connect this repo to a project: approve the code in your browser, then start serving.',
    details: ['--no-start   save the connection without starting the daemon'],
    group: 'run',
  },
  {
    name: 'stop',
    usage: 'flowviant stop [--project <name|id>]',
    summary: 'Stop every flowviant daemon on this computer (or just one project’s).',
    group: 'run',
  },
  {
    name: 'status',
    usage: 'flowviant status',
    summary: 'Each project connected here: its repo, whether it is running and serving, and its live agents.',
    details: ['--json   the machine-readable form the Windows tray reads'],
    group: 'look',
  },
  {
    name: 'logs',
    usage: 'flowviant logs [-f] [--project <name|id>]',
    summary: "The daemon's log for this repo's project.",
    details: ['-f, --follow   keep printing new lines as they are written', '-n <lines>     how many lines to show first (default 80)'],
    group: 'look',
  },
  {
    name: 'open',
    usage: 'flowviant open [--project <name|id>]',
    summary: "Open this project's board in your browser (prints the link too).",
    group: 'look',
  },
  {
    name: 'projects',
    usage: 'flowviant projects',
    summary: 'Every project this computer has a login for, and the repo each one serves.',
    group: 'look',
  },
  {
    name: 'machines',
    usage: 'flowviant machines [--remove <id> | --forget <id>] [--yes]',
    summary: 'Every computer that serves your projects. On a terminal, a menu to disconnect or forget one here.',
    group: 'look',
  },
  {
    name: 'doctor',
    usage: 'flowviant doctor',
    summary: 'Check what this computer needs: git, a signed-in CLI, a connection to Flowviant, a running daemon.',
    group: 'look',
  },
  {
    name: 'update',
    usage: 'flowviant update',
    summary: 'Install the newest flowviant now. It also updates itself when idle.',
    group: 'manage',
  },
  {
    name: 'clean',
    usage: 'flowviant clean',
    summary: 'Delete the kept agent worktrees under ~/.flowviant/worktrees. Stop the daemon first.',
    group: 'manage',
  },
  {
    name: 'uninstall',
    usage: 'flowviant uninstall [--purge] [--yes]',
    summary: 'Remove every flowviant copy on this computer. Logins are kept unless you add --purge.',
    details: ['--purge   also disconnect this computer from its projects and delete ~/.flowviant', '--yes     do not ask first'],
    group: 'manage',
  },
  {
    name: 'gh-auth',
    usage: 'flowviant gh-auth',
    summary: 'Sign in the GitHub CLI flowviant uses to open pull requests.',
    group: 'manage',
  },
  {
    name: 'version',
    usage: 'flowviant --version',
    summary: 'Print the installed version.',
    group: 'manage',
  },
  {
    name: 'help',
    usage: 'flowviant help [command]',
    summary: 'This list, or one command in detail.',
    group: 'manage',
  },
  {
    name: 'shot',
    usage: 'flowviant shot <url> [--out <file>]',
    summary: 'Screenshot a running page with a headless browser (agents use it to see their change).',
    hidden: true,
  },
  {
    name: 'mcp',
    usage: 'flowviant mcp <subcommand>',
    summary: "Manage the project's MCP connectors from a script.",
    hidden: true,
  },
];

const GROUPS = [
  ['run', 'Run'],
  ['look', 'Look'],
  ['manage', 'Manage'],
];

const ALIASES = { '--version': 'version', '-v': 'version', '--help': 'help', '-h': 'help' };

export function findCommand(name) {
  const key = ALIASES[name] ?? name;
  return COMMANDS.find((cmd) => cmd.name === key) ?? null;
}

/** The main screen: every visible command, grouped, one line each. */
export function renderHelp(version) {
  const width = Math.max(...COMMANDS.filter((cmd) => !cmd.hidden).map((cmd) => cmd.name.length));
  const lines = [`${c.bold('flowviant')} ${c.dim(version ? `v${version}` : '')}`.trimEnd(), '', `Usage: flowviant [command] [options]`, ''];
  for (const [group, title] of GROUPS) {
    lines.push(c.bold(title));
    for (const cmd of COMMANDS.filter((row) => row.group === group && !row.hidden)) {
      lines.push(`  ${cmd.name.padEnd(width)}   ${cmd.summary}`);
    }
    lines.push('');
  }
  lines.push(`Run ${c.cyan('flowviant help <command>')} for one command's options. Everything else happens in the app: https://app.flowviant.com`);
  return lines.join('\n');
}

/** One command, with its options. */
export function renderCommandHelp(cmd) {
  const lines = [`${c.bold(cmd.usage)}`, '', cmd.summary];
  if (cmd.details?.length) lines.push('', ...cmd.details.map((line) => `  ${line}`));
  return lines.join('\n');
}

/** Edit distance with a swapped pair counting once ("hlep" is one slip from
 *  "help"), for "did you mean". Small inputs only. */
function distance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

/** The nearest real command to a mistyped word, or null when nothing is close. */
export function nearestCommand(word) {
  const w = String(word ?? '').toLowerCase();
  let best = null;
  for (const cmd of COMMANDS) {
    const d = cmd.name.startsWith(w) && w.length >= 2 ? 0 : distance(w, cmd.name);
    if (d <= Math.max(1, Math.floor(cmd.name.length / 3)) && (!best || d < best.d)) best = { name: cmd.name, d };
  }
  return best?.name ?? null;
}

export function unknownCommandMessage(word) {
  const near = nearestCommand(word);
  return `flowviant: '${word}' is not a command.${near ? ` Did you mean \`flowviant ${near}\`?` : ''}\nRun \`flowviant help\` to see them all.`;
}
