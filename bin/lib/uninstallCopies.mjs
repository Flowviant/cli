/**
 * WHAT EACH KIND OF INSTALLED COPY MEANS TO UNINSTALL — one entry per kind,
 * holding the three questions uninstall asks of a copy: is it the copy this
 * process runs from, does a live daemon run from it, and how is it removed
 * (plus the words a person reads about it).
 *
 * Split out of uninstall.mjs (SOLID F058): discovery, protection and removal
 * each branched on the kind string separately, so a new kind of install was
 * three coordinated edits and a missed one removed a copy a daemon was
 * running from. `buildUninstallPlan` still owns DISCOVERY (where copies are);
 * this table owns what a copy of each kind IS. A record whose kind has no
 * entry here is refused at planning, never guessed at.
 */
import { basename, dirname, sep } from 'node:path';

export const inside = (path, dir) => path === dir || path.startsWith(`${dir}${sep}`);

/** The installer's PATH block for `dir` in rc file `rc`, byte for byte. */
export function exactBlock(dir, rc) {
  const line = basename(rc) === 'flowviant.fish' ? `fish_add_path "${dir}"` : `export PATH="${dir}:$PATH"`;
  return `\n# flowviant\n${line}\n`;
}

function removePathBlock(o, path, block) {
  const before = o.fs.readFileSync(path);
  const at = before.indexOf(Buffer.from(block));
  if (at < 0) return false;
  const after = Buffer.concat([before.subarray(0, at), before.subarray(at + Buffer.byteLength(block))]);
  const mode = o.fs.statSync(path).mode & 0o7777;
  const temp = `${path}.${process.pid}.flowviant-tmp`;
  try {
    o.fs.writeFileSync(temp, after, { mode });
    o.fs.chmodSync(temp, mode);
    o.fs.renameSync(temp, path);
  } finally {
    try {
      o.fs.rmSync(temp, { force: true });
    } catch {
      /* Renamed. */
    }
  }
  return true;
}

/**
 * The strategies. For each kind:
 *  - `label`: how `doctor` names it;
 *  - `current(source, own)`: is this the copy this process runs from;
 *  - `runsFrom(daemonPath, source)`: does a daemon whose command names
 *    `daemonPath` run from this copy — null for a kind no daemon can run from;
 *  - `othersSkip(copy, plan, o)`: an extra reason `--others` must leave it
 *    (beyond "current" and "a daemon runs from it", which every kind obeys);
 *  - `remove(copy, o)`: the removal itself (may be async);
 *  - `removedLine(copy)`: what a person reads after it;
 *  - `removeHint`: what `doctor` adds after "uninstall --others" when that
 *    removal can need more than the command ('' when it cannot).
 */
export const COPY_KINDS = Object.freeze({
  binary: {
    removeHint: '',
    label: 'binary',
    current: (source, own) => source === own,
    runsFrom: (p, source) => p === source,
    othersSkip: () => null,
    remove: (c, o) => o.fs.rmSync(c.removal, { recursive: false, force: true }),
    removedLine: (c) => `removed ${c.path}`,
  },
  'npm-global': {
    removeHint: ' (if npm refuses, `sudo npm uninstall -g flowviant`)',
    label: 'npm global',
    current: (source, own) => inside(own, source),
    runsFrom: (p, source) => inside(p, source),
    othersSkip: () => null,
    remove: (c, o) =>
      o.execFile('npm', c.npmPrefix ? ['uninstall', '-g', '--prefix', c.npmPrefix, 'flowviant'] : ['uninstall', '-g', 'flowviant'], {
        timeout: 120000,
      }),
    removedLine: (c) => `removed ${c.path}`,
  },
  'npx-cache': {
    removeHint: '',
    label: 'npx cache',
    current: (source, own) => inside(own, source),
    runsFrom: (p, source) => inside(p, source),
    othersSkip: () => null,
    remove: (c, o) => o.fs.rmSync(c.removal, { recursive: true, force: true }),
    removedLine: (c) => `removed ${c.path}`,
  },
  'path-line': {
    removeHint: '',
    label: 'PATH line',
    // An rc file line is never "the copy this process runs from", and no
    // daemon runs from it — but the binary it puts on PATH may be running.
    current: () => false,
    runsFrom: null,
    othersSkip: (c, plan, o) => {
      if (plan.copies.some((copy) => copy.kind === 'binary' && copy.current && c.block === exactBlock(dirname(copy.path), c.path)))
        return 'needed by the running binary';
      if (plan.daemons.length && !o.procAvailable) return 'a daemon may be using this copy';
      return null;
    },
    remove: (c, o) => removePathBlock(o, c.path, c.block),
    removedLine: (c) => `removed the flowviant PATH line from ${c.path}`,
  },
});

/** The strategy for a copy's kind. Throws on a kind with no entry. */
export function copyKind(kind) {
  const k = Object.hasOwn(COPY_KINDS, kind) ? COPY_KINDS[kind] : null;
  if (!k) throw new Error(`unknown installed-copy kind '${kind}'`);
  return k;
}
