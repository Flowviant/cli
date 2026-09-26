/**
 * The terminal's read-only views: `status`, `logs`, `open` and `doctor`.
 *
 * They decide nothing. Every decision is made in the app (the app repo's
 * CLAUDE.md), so each of these only SHOWS what this computer knows, with the
 * command or page that acts on it. Everything unmeasured renders nothing: a
 * status line for a server that did not answer is left out, never guessed.
 */

import { execFileSync, spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import { FLEET_URL, USER_AGENT, VERSION } from './config.mjs';
import { detectRepoRoot, listStoredProjects, projectLabel, resolveStoredCredential } from './credentials.mjs';
import { daemonLogPath, desktopStatusRemote, installChannel } from './desktopContract.mjs';
import { daemonRunningFor } from './instance.mjs';
import { agoFrom } from './machines.mjs';
import { detectRuntimes } from './runtimes.mjs';
import { c } from './ui.mjs';

const APP_URL = process.env.FLOWVIANT_APP_URL || 'https://app.flowviant.com';

function olderVersion(version, latest) {
  const parse = (v) => /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v ?? ''))?.slice(1, 4).map(Number);
  const a = parse(version);
  const b = parse(latest);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
}

function agentLine(agent, now) {
  if (agent.asks) return `${agent.name} · ${c.yellow('asks you a question')}`;
  const since = agent.status === 'working' && !agent.parked && agent.since ? Date.parse(agent.since) : NaN;
  const minutes = Number.isFinite(since) ? Math.max(0, Math.floor((now - since) / 60_000)) : null;
  const took = minutes == null ? '' : ` ${minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`}`;
  const word = agent.parked ? 'parked' : agent.status;
  const cards = `${agent.delivered} of ${agent.total} ${agent.total === 1 ? 'card' : 'cards'}${agent.delivered ? ' delivered' : ''}`;
  return `${agent.name} · ${word === 'working' ? c.blue(`working${took}`) : word} · ${cards}`;
}

/** `flowviant status`, rendered from the same document `status --json --remote` prints. */
export function renderStatus(status, { now = Date.now() } = {}) {
  const lines = [`${c.bold('flowviant')} ${c.dim(`v${status.version} · ${status.installChannel}`)}`, ''];
  if (status.projects.length === 0) {
    lines.push('No project is connected on this computer yet.', `Run ${c.cyan('flowviant login')} inside your repository.`, '');
  }
  for (const project of status.projects) {
    const remote = project.remote ?? null;
    const label = (key, value) => `  ${c.dim(key.padEnd(8))}  ${value}`;
    lines.push(`${c.bold(project.name ?? project.id)}  ${c.dim(`${project.id.slice(0, 8)}…`)}`);
    lines.push(label('repo', project.dir ?? c.dim('not bound yet — the first start in its repo binds it')));
    const role = remote?.role ?? null;
    if (project.running === false) {
      lines.push(label('here', `not running — run ${c.cyan('flowviant')} in that repo`));
    } else if (project.running === true) {
      const serves = role === 'serving' ? c.green('serving')
        : role === 'inactive' ? `inactive${remote?.servingBoxName ? ` — ${remote.servingBoxName} serves this project` : ''}`
        : project.holder === 'serving' ? c.green('serving') : null;
      lines.push(label('here', serves ? `running · ${serves}` : 'running'));
    }
    const heard = agoFrom(project.lastPoll, now);
    if (heard) lines.push(label('polled', heard));
    const agents = remote?.agents ?? null;
    if (agents && agents.length > 0) {
      agents.forEach((agent, i) => lines.push(label(i === 0 ? 'agents' : '', agentLine(agent, now))));
    }
    if (remote?.pressure?.reason) lines.push(label('waiting', `Waiting for the machine — ${remote.pressure.reason}.`));
    for (const rt of project.runtimes ?? []) {
      if (rt.parkedByLimit && rt.message) lines.push(label('limit', `${rt.id} hit its limit: “${rt.message}”`));
    }
    const version = remote?.daemonVersion ?? status.version;
    if (remote?.latest && olderVersion(version, remote.latest)) {
      lines.push(label('update', `flowviant ${remote.latest} is out; this computer runs ${version}. It updates itself when idle.`));
    }
    lines.push('');
  }
  const clis = (status.runtimes ?? []).map((rt) => `${rt.id} ${rt.installed ? (rt.version ?? 'installed') : c.dim('not installed')}`);
  if (clis.length) lines.push(`${c.dim('CLIs')}      ${clis.join(' · ')}`);
  return lines.join('\n').trimEnd();
}

export async function runStatus() {
  console.log(renderStatus(await desktopStatusRemote({ log: () => {} })));
}

/** Which stored project a `logs`/`open` means: `--project`, else this repo's,
 *  else the only one. Several and none are answered in words, never guessed. */
export function resolveProjectForView(argv = process.argv, cwd = process.cwd()) {
  const resolved = resolveStoredCredential(argv, cwd);
  if (resolved.entry) return { entry: resolved.entry };
  if (resolved.error) return { message: `error: ${resolved.error}` };
  const entries = listStoredProjects();
  if (entries.length === 0) return { message: `No project is connected on this computer yet. Run \`flowviant login\` inside your repository.` };
  return {
    message: `Several projects are connected here, and this folder is not one of their repos. Pick one with --project:\n${
      entries.map((e) => `  ${projectLabel(e)}  ${c.dim(e.projectId)}`).join('\n')}`,
  };
}

/** The last `count` lines of a file, read from its end. */
export function tailLines(path, count) {
  const size = statSync(path).size;
  const want = Math.min(size, 256 * 1024);
  const buf = Buffer.alloc(want);
  const fd = openSync(path, 'r');
  try { readSync(fd, buf, 0, want, size - want); } finally { closeSync(fd); }
  const lines = buf.toString('utf8').split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (want < size) lines.shift(); // the first line is cut mid-way
  return { text: lines.slice(-count).join('\n'), size };
}

export async function runLogs(argv = process.argv) {
  const which = resolveProjectForView(argv);
  if (!which.entry) { console.error(which.message); process.exit(1); }
  const path = daemonLogPath(which.entry.projectId);
  const at = argv.indexOf('-n');
  const count = at >= 0 && Number(argv[at + 1]) > 0 ? Math.floor(Number(argv[at + 1])) : 80;
  const follow = argv.includes('-f') || argv.includes('--follow');
  if (!existsSync(path)) {
    console.log(`No log yet for ${projectLabel(which.entry)}. It starts when the daemon first runs: ${c.cyan('flowviant')} in its repo.`);
    if (!follow) return;
  } else {
    const { text } = tailLines(path, count);
    if (text) console.log(text);
  }
  if (!follow) return;
  // Poll rather than fs.watch: the daemon rotates the file (a rename), and a
  // watch on the old inode would go quiet exactly then.
  let offset = existsSync(path) ? statSync(path).size : 0;
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (!existsSync(path)) continue;
    const size = statSync(path).size;
    if (size < offset) offset = 0; // rotated
    if (size === offset) continue;
    const buf = Buffer.alloc(size - offset);
    const fd = openSync(path, 'r');
    try { readSync(fd, buf, 0, buf.length, offset); } finally { closeSync(fd); }
    process.stdout.write(buf);
    offset = size;
  }
}

/** The command that opens a URL in this computer's browser. Inside WSL that is
 *  Windows' own browser, reached through explorer.exe. */
export function browserCommand(url, { platform = process.platform, env = process.env } = {}) {
  if (platform === 'darwin') return ['open', [url]];
  if (platform === 'win32') return ['cmd', ['/c', 'start', '', url]];
  if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) return ['explorer.exe', [url]];
  return ['xdg-open', [url]];
}

export function runOpen(argv = process.argv) {
  const which = resolveProjectForView(argv);
  if (!which.entry) { console.error(which.message); process.exit(1); }
  const url = `${APP_URL}/projects/${encodeURIComponent(which.entry.projectId)}/board`;
  console.log(url);
  const [cmd, args] = browserCommand(url);
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => {}); // no browser here: the printed link is the answer
    child.unref();
  } catch { /* the link above is enough */ }
}

/** One doctor line: ✓ measured fine, ✗ measured wrong (with what to do), · unknown. */
function check(state, text, fix) {
  const mark = state === true ? c.green('✓') : state === false ? c.red('✗') : c.dim('·');
  return `${mark} ${text}${state === false && fix ? `\n    ${c.dim(fix)}` : ''}`;
}

export async function runDoctor({ cwd = process.cwd(), fetchImpl = fetch } = {}) {
  const lines = [`${c.bold('flowviant')} ${c.dim(`v${VERSION} · ${installChannel()}`)}`, ''];
  let failed = 0;
  const add = (state, text, fix) => { if (state === false) failed++; lines.push(check(state, text, fix)); };

  let git = null;
  try { git = String(execFileSync('git', ['--version'], { timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] })).trim(); } catch { /* absent */ }
  add(Boolean(git), git ?? 'git is not installed', 'Install git; agents work in git worktrees.');

  const installed = detectRuntimes().filter((rt) => rt.installed);
  add(installed.length > 0,
    installed.length ? `CLIs here: ${installed.map((rt) => `${rt.id}${rt.version ? ` ${rt.version}` : ''}`).join(', ')}` : 'No coding CLI found (Claude Code, Codex or Antigravity)',
    'Install Claude Code or Codex on this computer and sign in to it; agents run through its login.');

  const repo = detectRepoRoot(cwd);
  add(Boolean(repo), repo ? `This folder is the repo ${repo}` : 'This folder is not inside a git repository',
    'Run flowviant inside the repository you want agents to work in.');

  const resolved = resolveStoredCredential(process.argv, cwd);
  const entry = resolved.entry ?? null;
  add(entry ? true : repo ? false : null,
    entry ? `Connected to ${projectLabel(entry)}` : 'This repo is not connected to a project',
    'Run `flowviant login` here and approve it in your browser.');

  // EVERY COPY ON THIS BOX, and which one a daemon runs from. An old copy with a
  // live daemon is the usual reason the app reports a version older than the
  // one just installed: `uninstall --others` skips a copy a daemon runs from,
  // and a global npm install that needed sudo cannot update itself.
  try {
    const { buildUninstallPlan } = await import('./uninstall.mjs');
    const plan = await buildUninstallPlan();
    const copies = plan.copies.filter((copy) => copy.kind !== 'path-line');
    for (const copy of copies) {
      const where = copy.kind === 'npm-global' ? 'npm global' : copy.kind === 'npx-cache' ? 'npx cache' : 'binary';
      const running = copy.runningPid ? `, a daemon runs from it (pid ${copy.runningPid})` : '';
      const older = copy.version && olderVersion(copy.version, VERSION);
      const text = `flowviant ${copy.version ?? '(unknown version)'} · ${where} · ${copy.path}${copy.current ? ' (this one)' : ''}${running}`;
      if (older && copy.runningPid) {
        add(false, text, `An older daemon is serving. Run \`flowviant stop\`, then \`flowviant uninstall --others\`${copy.kind === 'npm-global' ? ' (if npm refuses, `sudo npm uninstall -g flowviant`)' : ''}, then start flowviant again.`);
      } else if (older) {
        add(false, text, `An older copy. Remove it with \`flowviant uninstall --others\`${copy.kind === 'npm-global' ? ' (if npm refuses, `sudo npm uninstall -g flowviant`)' : ''}.`);
      } else {
        add(true, text);
      }
    }
  } catch { /* the listing is best-effort */ }

  const health = String(FLEET_URL).replace(/\/api\/.*$/, '/health');
  let reach = null;
  try {
    const res = await fetchImpl(health, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(5000) });
    reach = res.ok ? true : `HTTP ${res.status}`;
  } catch (error) { reach = String(error?.message ?? error); }
  add(reach === true, reach === true ? 'Flowviant is reachable' : `Flowviant is not reachable (${reach})`,
    'Check this computer’s internet connection or proxy.');

  if (entry) {
    const running = daemonRunningFor(entry.fleetToken);
    // No lock file is UNKNOWN (an older daemon runs without one), so only a
    // dead lock holder is said to be "not running".
    add(running === true ? true : null,
      running === true ? 'The daemon is running for this project'
        : running === false ? 'The daemon is not running — start it with `flowviant`'
        : 'No daemon has registered for this project here — start one with `flowviant`');
  }
  lines.push('', failed ? `${failed} thing${failed === 1 ? '' : 's'} to fix.` : 'Nothing to fix.');
  console.log(lines.join('\n'));
  return failed;
}
