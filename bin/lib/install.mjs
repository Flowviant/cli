/**
 * Consent-based prerequisite installers. cloudflared is fetched silently (no
 * login, isolated), but claude + gh are auth-bearing CLIs you likely manage
 * yourself — so we DETECT-FIRST and only install on your explicit yes, never
 * silently and never clobbering an existing install. Interactive login stays
 * yours (`claude` sign-in, `flowviant gh-auth`).
 *
 * gh is dropped into ~/.flowviant/bin (like cloudflared) rather than a system
 * path, so there's nothing to conflict with; addLocalBinToPath() puts that dir
 * on PATH so the daemon (and `flowviant gh-auth`) find it.
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync, existsSync, mkdirSync, chmodSync, rmSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, platform, arch } from 'node:os';

export const LOCAL_BIN = join(homedir(), '.flowviant', 'bin');

/** Put ~/.flowviant/bin first on PATH so bundled binaries (gh, cloudflared)
 *  resolve by bare name for this process and everything it spawns. Idempotent. */
export function addLocalBinToPath() {
  const sep = platform() === 'win32' ? ';' : ':';
  const parts = (process.env.PATH || '').split(sep);
  if (!parts.includes(LOCAL_BIN)) {
    process.env.PATH = `${LOCAL_BIN}${sep}${process.env.PATH || ''}`;
  }
}

/** TTY-guarded y/N. Non-interactive (no TTY) never auto-installs → returns false
 *  so a headless/cron run just prints the manual instructions instead. */
export async function promptYesNo(question, defaultYes) {
  if (!process.stdin.isTTY) return false;
  const { createInterface } = await import('node:readline');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((res) =>
    rl.question(`${question} ${defaultYes ? '[Y/n]' : '[y/N]'} `, res),
  );
  rl.close();
  const a = answer.trim().toLowerCase();
  if (!a) return defaultYes;
  return a === 'y' || a === 'yes';
}

/** Install Claude Code via its official npm package (npm is present — you got
 *  here through node). Lands on PATH; you still sign in by running `claude`. */
export function installClaude(log) {
  try {
    log?.('installing Claude Code (npm i -g @anthropic-ai/claude-code)…');
    execFileSync('npm', ['install', '-g', '@anthropic-ai/claude-code'], { stdio: 'inherit' });
    return true;
  } catch (e) {
    log?.(`could not install Claude Code automatically (${e?.message ?? e}). Install: https://claude.com/claude-code`);
    return false;
  }
}

async function latestGhVersion() {
  const res = await fetch('https://api.github.com/repos/cli/cli/releases/latest', {
    headers: { 'User-Agent': 'flowviant', Accept: 'application/vnd.github+json' },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`gh release lookup failed (http ${res.status})`);
  const tag = (await res.json())?.tag_name;
  if (!tag) throw new Error('no gh release tag');
  return String(tag).replace(/^v/, '');
}

/** Fetch the gh release archive into ~/.flowviant/bin and extract the binary —
 *  the cloudflared pattern: isolated, no sudo, nothing to conflict with. Returns
 *  the binary path or null (falls back to manual instructions). */
export async function installGh(log) {
  const os = platform();
  const a = arch() === 'arm64' ? 'arm64' : 'amd64';
  const osName = os === 'darwin' ? 'macOS' : os === 'win32' ? 'windows' : 'linux';
  const ext = os === 'linux' ? 'tar.gz' : 'zip';
  const binName = os === 'win32' ? 'gh.exe' : 'gh';
  const dest = join(LOCAL_BIN, binName);
  let archive;
  let innerDir;
  try {
    mkdirSync(LOCAL_BIN, { recursive: true });
    const ver = await latestGhVersion();
    const stem = `gh_${ver}_${osName}_${a}`;
    const url = `https://github.com/cli/cli/releases/download/v${ver}/${stem}.${ext}`;
    log?.(`fetching gh ${ver} (${osName}-${a})…`);
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`http ${res.status}`);
    archive = join(LOCAL_BIN, `${stem}.${ext}`);
    writeFileSync(archive, Buffer.from(await res.arrayBuffer()));
    // linux ships tar.gz (GNU tar); mac + windows ship zip (bsdtar reads zip).
    execFileSync('tar', [os === 'linux' ? '-xzf' : '-xf', archive, '-C', LOCAL_BIN], {
      stdio: 'ignore',
    });
    innerDir = join(LOCAL_BIN, stem);
    const inner = join(innerDir, 'bin', binName);
    if (!existsSync(inner)) throw new Error('gh binary not found in the archive');
    cpSync(inner, dest);
    if (os !== 'win32') chmodSync(dest, 0o755);
    return dest;
  } catch (e) {
    log?.(
      `could not install gh automatically (${e?.message ?? e}). Install from https://cli.github.com, then run: gh auth login`,
    );
    return null;
  } finally {
    if (archive) rmSync(archive, { force: true });
    if (innerDir) rmSync(innerDir, { recursive: true, force: true });
  }
}
