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
 * THE TABLE is commandSpecs.mjs (one list for help, the --dir checkout policy
 * and cli.mjs's dispatch); this module renders it and answers a slip.
 */

import { c } from './ui.mjs';
import { COMMANDS } from './commandSpecs.mjs';

const GROUPS = [
  ['run', 'Run'],
  ['look', 'Look'],
  ['manage', 'Manage'],
];

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
