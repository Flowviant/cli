/**
 * THE PATH A PERSON'S TERMINAL HAS, for a daemon nobody started from one.
 *
 * Every CLI is found by name on PATH (`claude --version`, `codex`, `agy`,
 * `gh`). A terminal's PATH comes from the shell's startup files; the Windows
 * tray starts the daemon with `wsl.exe -d <distro> -- <binary>`, which reads
 * none of them. That PATH is the distro's bare default, and it misses exactly
 * where the CLIs usually live: `~/.local/bin` (Claude Code's own installer,
 * put on PATH by ~/.profile) and version managers set up in ~/.bashrc (nvm,
 * volta, bun). So a machine whose `claude` works in the owner's WSL terminal
 * measured "not installed" under the tray (2026-09-25).
 *
 * So the daemon asks the person's login shell for its PATH once, and keeps
 * every entry it already had FIRST (a terminal start is unchanged) with the
 * shell's additions after it; then the usual per-user bin directories that
 * exist. Best-effort and bounded: a shell that hangs or prints nothing costs a
 * few seconds once, and nothing is ever removed from PATH.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

const MARK = '__FLOWVIANT_PATH__=';

/** The PATH an interactive login shell ends up with, or null. */
export function loginShellPath({ env = process.env, exec = execFileSync, timeoutMs = 4000 } = {}) {
  const shell = env.SHELL && env.SHELL.startsWith('/') ? env.SHELL : '/bin/bash';
  try {
    // -i so ~/.bashrc runs (nvm lives there, behind the "not interactive?
    // return" guard); -l so ~/.profile runs (~/.local/bin lives there). The
    // marker line survives whatever a startup file prints.
    const out = String(exec(shell, ['-ilc', `printf '\\n${MARK}%s\\n' "$PATH"`], {
      env: { ...env, TERM: 'dumb' },
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'ignore'],
    }));
    const line = out.split('\n').reverse().find((l) => l.startsWith(MARK));
    const value = line?.slice(MARK.length).trim();
    return value ? value : null;
  } catch {
    return null;
  }
}

/** Per-user bin directories CLIs install into, that exist on this box. */
export function userBinDirs({ home = homedir(), exists = existsSync, list = readdirSync } = {}) {
  const dirs = ['.local/bin', '.npm-global/bin', '.bun/bin', '.volta/bin', '.cargo/bin'].map((d) => join(home, d));
  // nvm: the newest installed node's bin (nvm's own "default" needs its shell
  // function to resolve; the newest is the usual answer and only a fallback).
  try {
    const versions = list(join(home, '.nvm/versions/node'))
      .filter((v) => /^v\d+\.\d+\.\d+$/.test(v))
      .sort((a, b) => {
        const pa = a.slice(1).split('.').map(Number);
        const pb = b.slice(1).split('.').map(Number);
        return pb[0] - pa[0] || pb[1] - pa[1] || pb[2] - pa[2];
      });
    if (versions[0]) dirs.push(join(home, '.nvm/versions/node', versions[0], 'bin'));
  } catch { /* no nvm */ }
  return dirs.filter((d) => exists(d));
}

/** Current entries first, then any the others add. Order-preserving, deduped. */
export function mergePath(current, ...more) {
  const seen = new Set();
  const out = [];
  for (const part of [current, ...more].flatMap((p) => (Array.isArray(p) ? p : String(p ?? '').split(':')))) {
    if (!part || seen.has(part)) continue;
    seen.add(part);
    out.push(part);
  }
  return out.join(':');
}

/**
 * Widen process.env.PATH in place. `shell: false` skips the login shell and
 * only adds the fixed per-user directories (for the tray's frequent status
 * polls, where a shell start every 30 s is not worth it).
 */
export function adoptLoginPath({ shell = true, env = process.env, ...deps } = {}) {
  if (platform() === 'win32' || env.FLOWVIANT_KEEP_PATH === '1') return env.PATH;
  const login = shell ? loginShellPath({ env, ...deps }) : null;
  env.PATH = mergePath(env.PATH, login, userBinDirs(deps));
  return env.PATH;
}
