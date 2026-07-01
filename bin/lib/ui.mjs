/** Zero-dep ANSI output. Respects NO_COLOR and non-TTY pipes. */

const COLOR = !!process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (open) => (s) => (COLOR ? `\x1b[${open}m${s}\x1b[0m` : `${s}`);

export const c = {
  bold: wrap(1), dim: wrap(2),
  red: wrap(31), green: wrap(32), yellow: wrap(33),
  blue: wrap(34), magenta: wrap(35), cyan: wrap(36), gray: wrap(90),
};

// Stable, cycled colours so each agent's label is easy to scan in a fleet.
export const LABEL_COLORS = [c.cyan, c.magenta, c.blue, c.yellow, c.green, c.red];

const stamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return c.gray(`${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`);
};
const line = (sym, msg) => console.log(`${stamp()} ${sym} ${msg}`);

export const info = (m) => line(c.dim('·'), c.dim(m));
export const note = (m) => line(c.blue('›'), m);
export const ok = (m) => line(c.green('✓'), m);
export const warn = (m) => line(c.yellow('!'), m);
export const fail = (m) => line(c.red('✗'), m);
