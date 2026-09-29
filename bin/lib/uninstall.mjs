import * as nodeFs from 'node:fs';
import { execFile as nodeExecFile } from 'node:child_process';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { runningCompiledBinary } from './update.mjs';
import { VERSION } from './config.mjs';
import { parseVersion } from './versionOrder.mjs';
import { copyKind, exactBlock, inside } from './uninstallCopies.mjs';
import { disconnectShortfall, removeOnMachinesPage } from './machineDisconnect.mjs';

const execFileAsync = promisify(nodeExecFile);
const errorWords = (error) => String(error?.stderr || error?.message || error).trim();

function defaults(options = {}) {
  return {
    fs: nodeFs,
    home: homedir(),
    path: process.env.PATH || '',
    execFile: (file, args, opts) => execFileAsync(file, args, opts),
    pidLive: (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } },
    procReader: (pid, file) => file === 'exe' || file === 'cwd'
      ? nodeFs.readlinkSync(`/proc/${pid}/${file}`) : nodeFs.readFileSync(`/proc/${pid}/${file}`),
    procAvailable: nodeFs.existsSync('/proc/self/cmdline'),
    compiled: runningCompiledBinary(),
    execPath: process.execPath,
    argvPath: process.argv[1],
    stopAllDaemons: null,
    projects: null,
    disconnect: null,
    prompt: null,
    tty: Boolean(process.stdin.isTTY),
    log: (line) => console.error(line),
    stdout: (line) => process.stdout.write(`${line}\n`),
    ...options,
  };
}

function real(fs, path) { try { return fs.realpathSync(path); } catch { return resolve(path); } }
function readVersion(fs, path) {
  try {
    const value = JSON.parse(fs.readFileSync(path, 'utf8')).version;
    return typeof value === 'string' ? value : undefined;
  } catch { return undefined; }
}
function files(fs, dir) { try { return fs.readdirSync(dir); } catch { return []; } }
function regular(fs, path) { try { return fs.statSync(path).isFile(); } catch { return false; } }
function executable(fs, path) { try { const stat = fs.statSync(path); return stat.isFile() && Boolean(stat.mode & 0o111); } catch { return false; } }
// A compiled flowviant is an ELF or Mach-O file. A shell wrapper someone named
// `flowviant` is not a copy of ours and is never removed.
function compiledExecutable(fs, path) {
  try {
    const fd = fs.openSync(path, 'r');
    const head = Buffer.alloc(4);
    try { fs.readSync(fd, head, 0, 4, 0); } finally { fs.closeSync(fd); }
    const magic = head.readUInt32BE(0);
    return magic === 0x7f454c46 || [0xfeedfacf, 0xcffaedfe, 0xfeedface, 0xcefaedfe, 0xcafebabe].includes(magic);
  } catch { return false; }
}

function liveDaemons(o) {
  const found = [];
  for (const name of files(o.fs, join(o.home, '.flowviant'))) {
    if (!/^daemon-[0-9a-f]{12}\.lock$/.test(name)) continue;
    try {
      const pid = JSON.parse(o.fs.readFileSync(join(o.home, '.flowviant', name), 'utf8')).pid;
      if (!Number.isInteger(pid) || pid <= 0 || !o.pidLive(pid)) continue;
      let paths = [];
      if (o.procAvailable) {
        try {
          const exe = o.procReader(pid, 'exe');
          const command = o.procReader(pid, 'cmdline');
          const args = Buffer.from(command).toString('utf8').split('\0').filter(Boolean);
          let scripts = args.filter((arg) => isAbsolute(arg));
          const relative = args.filter((arg) => !arg.startsWith('-') && arg.includes('/') && !isAbsolute(arg));
          if (relative.length) {
            const cwd = String(o.procReader(pid, 'cwd'));
            scripts.push(...relative.map((arg) => resolve(cwd, arg)));
          }
          const executable = String(exe).replace(/ \(deleted\)$/, '');
          paths = basename(executable).startsWith('node') && !scripts.length ? [] :
            [executable, ...scripts].map((path) => real(o.fs, path));
        } catch { /* The live pid is still protected when its command is hidden. */ }
      }
      found.push({ pid, paths });
    } catch { /* An unreadable lock is not evidence of a live daemon. */ }
  }
  return found;
}

export async function buildUninstallPlan(options = {}) {
  const o = defaults(options);
  const copies = [];
  const add = (kind, path, removal = path, version) => {
    if (!copies.some((c) => c.kind === kind && c.path === path)) copies.push({ kind, path, removal, ...(version ? { version } : {}) });
  };
  let npmRoot;
  try { npmRoot = String((await o.execFile('npm', ['root', '-g'], { timeout: 5000 })).stdout).trim(); }
  catch { /* npm may not be installed. */ }
  const npmPackage = npmRoot && join(npmRoot, 'flowviant');
  if (npmPackage && o.fs.existsSync(npmPackage)) add('npm-global', npmPackage, npmPackage, readVersion(o.fs, join(npmPackage, 'package.json')));

  const npxRoot = join(o.home, '.npm', '_npx');
  for (const hash of files(o.fs, npxRoot)) {
    const dir = join(npxRoot, hash);
    const pkg = join(dir, 'node_modules', 'flowviant');
    if (!o.fs.existsSync(pkg)) continue;
    const version = readVersion(o.fs, join(pkg, 'package.json'));
    let alone = false;
    try {
      const meta = JSON.parse(o.fs.readFileSync(join(dir, 'package.json'), 'utf8'));
      const names = Object.keys({ ...meta.dependencies, ...meta.devDependencies, ...meta.optionalDependencies });
      alone = names.length === 1 && names[0] === 'flowviant';
    } catch { /* Unknown cache contents must not be removed as a whole. */ }
    add('npx-cache', pkg, dir, version);
    copies.at(-1).skipReason = alone ? null : 'cache contains other packages or its dependencies could not be read';
  }

  const ownBin = join(o.home, '.flowviant', 'bin');
  // Trusted: the installer's default directory and any directory an installer
  // PATH block names. Anything else on PATH must prove itself.
  const trusted = new Set([real(o.fs, ownBin)]);
  const addBinary = (dir, fromPath = false) => {
    const candidate = join(dir, 'flowviant');
    if (!(fromPath ? executable(o.fs, candidate) : regular(o.fs, candidate))) return;
    const target = real(o.fs, candidate);
    if (inside(target, npxRoot)) return;
    const packagePath = target.match(/^(.*\/node_modules\/flowviant)(?:\/|$)/)?.[1];
    if (packagePath) {
      if (!copies.some((c) => c.kind === 'npm-global' && real(o.fs, c.path) === real(o.fs, packagePath))) {
        let npmPrefix = dirname(dirname(packagePath));
        if (basename(npmPrefix) === 'lib') npmPrefix = dirname(npmPrefix);
        const version = readVersion(o.fs, join(packagePath, 'package.json'));
        copies.push({ kind: 'npm-global', path: packagePath, removal: packagePath,
          npmPrefix, ...(version ? { version } : {}) });
      }
      return;
    }
    // Outside the installer's own directory a file must PROVE it is ours:
    // compiled, and answering `--version` with a version (checked below).
    const proven = trusted.has(real(o.fs, dir));
    if (!proven && !compiledExecutable(o.fs, target)) return;
    add('binary', target);
    if (!proven) copies.at(-1).mustProve = true;
  };
  addBinary(join(o.home, '.flowviant', 'bin'));
  for (const dir of o.path.split(':').filter(Boolean)) addBinary(dir, true);
  for (const rc of ['.zshrc', '.bashrc', '.profile', '.config/fish/conf.d/flowviant.fish']) {
    const path = join(o.home, rc);
    let content;
    try { content = o.fs.readFileSync(path, 'utf8'); } catch { continue; }
    const pattern = basename(path) === 'flowviant.fish'
      ? /\n# flowviant\nfish_add_path "([^"\n]+)"\n/g
      : /\n# flowviant\nexport PATH="([^"\n]+):\$PATH"\n/g;
    for (const match of content.matchAll(pattern)) {
      const dir = match[1];
      if (match[0] !== exactBlock(dir, path)) continue;
      copies.push({ kind: 'path-line', path, removal: path, block: match[0] });
      trusted.add(real(o.fs, dir));
      addBinary(dir);
    }
  }
  const own = real(o.fs, o.compiled ? o.execPath : o.argvPath || '');
  if (o.compiled && regular(o.fs, own)) add('binary', own);
  for (const copy of copies.filter((c) => c.kind === 'binary')) {
    if (o.compiled && copy.path === own) { copy.version = VERSION; continue; }
    try {
      const output = await o.execFile(copy.path, ['--version'], { timeout: 5000 });
      const version = String(output.stdout).trim();
      // The same rule that orders versions decides what IS one (versionOrder.mjs).
      if (parseVersion(version)) copy.version = version;
    } catch { /* A foreign or older binary may not answer. */ }
  }
  for (let i = copies.length - 1; i >= 0; i--) {
    if (copies[i].mustProve && !copies[i].version && !(o.compiled && copies[i].path === own)) copies.splice(i, 1);
    else delete copies[i].mustProve;
  }
  const daemons = liveDaemons(o);
  for (const copy of copies) {
    // Every discovered record carries a kind the strategy table knows —
    // `copyKind` throws on one it does not, so a new kind cannot be planned
    // without saying what protects it and how it goes.
    const kind = copyKind(copy.kind);
    const source = real(o.fs, copy.path);
    copy.current = kind.current(source, own);
    if (!kind.runsFrom) continue;
    const daemon = daemons.find((d) => !o.procAvailable || !d.paths.length || d.paths.some((p) => kind.runsFrom(p, source)));
    if (daemon) copy.runningPid = daemon.pid;
  }
  return { copies, daemons, home: o.home };
}

export async function runUninstall(options = {}) {
  const o = defaults(options);
  const { others = false, purge = false, yes = false, json = false } = options;
  const result = { ok: true, removed: [], skipped: [], kept: [], errors: [] };
  const line = (m) => o.log(m);
  const plan = await buildUninstallPlan(o);
  if (!json || !yes) {
    for (const c of plan.copies) line(`${c.kind} ${c.path}${c.version ? ` (${c.version})` : ''}${c.runningPid ? ` (daemon pid ${c.runningPid})` : ''}`);
    if (!plan.copies.length && !purge) line('no flowviant copies found on this machine.');
  }
  if (!yes && (plan.copies.length || purge)) {
    if (!o.tty || json) result.errors.push('re-run with --yes to remove');
    else if (!/^y(es)?$/i.test(await o.prompt?.('Remove these? [y/N] ') || '')) result.errors.push('cancelled');
    if (result.errors.length) {
      result.ok = false;
      if (json) o.stdout(JSON.stringify(result)); else result.errors.forEach(line);
      return result;
    }
  }

  if (!others) {
    try {
      const stop = o.stopAllDaemons || (await import('./instance.mjs')).stopAllDaemons;
      const tally = await stop({ log: line });
      if (tally.failed) result.errors.push(`${tally.failed} daemon(s) could not be stopped`);
    } catch (e) { result.errors.push(`stopping daemons: ${errorWords(e)}`); }
  }
  /**
   * THE PURGE READS THE DISCONNECT'S OUTCOME, NEVER ITS SENTENCES.
   *
   * This used to match four phrases in the log lines to decide whether the
   * app had been told, and then deleted `~/.flowviant` anyway — so a leave the
   * app never heard destroyed the only credential that could tell it. Now a
   * RETRYABLE shortfall (a daemon that would not stop, a leave the network or
   * the app refused, a credential that could not be forgotten, or a disconnect
   * that threw) keeps the local state, and the disconnect is asked to keep
   * that project's credential after a failed leave, so running the purge again
   * can finish it. An older server with no leave route is reported and does
   * not hold the purge: asking it again changes nothing.
   */
  const unfinished = [];
  if (purge && !others) {
    try {
      const projects = o.projects || (await import('./credentials.mjs')).listStoredProjects;
      const disconnect = o.disconnect || (async (entry, log) => {
        const { disconnectHere, realDisconnectDeps } = await import('./machineDisconnect.mjs');
        const { leaveUrlFrom } = await import('./machines.mjs');
        const { FLEET_URL } = await import('./config.mjs');
        return disconnectHere(entry, await realDisconnectDeps({ url: leaveUrlFrom(FLEET_URL), log }), { log, forgetAfterFailedLeave: false });
      });
      for (const entry of await projects()) {
        try {
          const short = disconnectShortfall(await disconnect(entry, line));
          if (short) {
            result.errors.push(`registry removal for ${entry.projectId}: ${short.reason}`);
            if (short.retryable) unfinished.push(entry.projectId);
          }
        } catch (e) {
          result.errors.push(`registry removal for ${entry.projectId}: ${errorWords(e)}`);
          unfinished.push(entry.projectId);
        }
      }
    } catch (e) {
      result.errors.push(`reading projects: ${errorWords(e)}`);
      unfinished.push(null);
    }
  }

  for (const c of plan.copies) {
    const item = { kind: c.kind, path: c.path };
    const kind = copyKind(c.kind);
    let reason = c.skipReason;
    if (others && c.current) reason = 'running copy';
    if (others && c.runningPid) reason = `a daemon is running from it (pid ${c.runningPid})`;
    if (others) reason = kind.othersSkip(c, plan, o) ?? reason;
    if (reason) {
      result.skipped.push({ ...item, reason });
      // The copy doing the work is not news; every other skip is.
      if (!json && reason !== 'running copy') line(`skipped ${c.path}: ${reason}`);
      continue;
    }
    try {
      await kind.remove(c, o);
      result.removed.push(item);
      if (!json) line(kind.removedLine(c));
    } catch (e) { result.errors.push(`${c.path}: ${errorWords(e)}`); }
  }
  if (purge && !others && unfinished.length) {
    result.kept.push(join(o.home, '.flowviant'));
    // Every retryable shortfall lands here (a daemon that would not stop, a
    // leave or a forget that failed, projects that could not be read); the
    // `error:` lines below name which, so this line claims none of them.
    if (!json) line(`Kept ~/.flowviant: the purge did not finish for every project (see the errors below). Reinstall and run \`flowviant uninstall --purge\` again to finish, or ${removeOnMachinesPage('this box')}.`);
  } else if (purge && !others) {
    try { o.fs.rmSync(join(o.home, '.flowviant'), { recursive: true, force: true }); }
    catch (e) { result.errors.push(`local purge: ${errorWords(e)}`); }
  } else {
    result.kept.push(join(o.home, '.flowviant'));
    if (!json && !others) line('Kept logins and local state in ~/.flowviant; reinstalling resumes them.');
  }
  result.ok = result.errors.length === 0;
  for (const error of result.errors) if (!json) line(`error: ${error}`);
  if (json) o.stdout(JSON.stringify(result));
  return result;
}
