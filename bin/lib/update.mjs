/**
 * Self-update — keep a long-running daemon current without babysitting it.
 *
 * A daemon runs for hours/days from one launch, so "latest at launch" (even with
 * `npx flowviant@latest`) doesn't help a process that's already up when a new
 * version ships. The server reports {latest, min} on every roster poll; the
 * daemon compares its own VERSION and, at a SAFE boundary (startup or idle —
 * never mid-task), self-updates + re-execs. Below `min` it updates regardless
 * (older protocol is known-broken); otherwise it honors AUTO_UPDATE.
 *
 * NPX UPDATES TOO, SINCE 0.58.0 — and until then it never did, which is the
 * whole reason this comment is longer than it was. `AUTO_UPDATE` is ON by
 * default (`FLOWVIANT_NO_UPDATE !== '1'`), so the flag was never what held
 * machines back: the npx branch was. It refused to install — correctly, since
 * `npm i -g` lands where the running process will never look — and then only
 * NAGGED A CONSOLE NOBODY READS. The README meanwhile told everyone to launch
 * with `npx flowviant@latest` and promised that "a running daemon also
 * self-updates", which was false for exactly the audience it was written for.
 * The result, measured across one account's five machines on 2026-08-25:
 * 0.48.3, 0.51.1, 0.51.2, 0.54.2 and 0.56.0, each frozen at whatever npx had
 * cached the day it launched. The clincher was the 0.56.0 one — it polled that
 * morning, saw LATEST 0.56.1, had AUTO_UPDATE on, and still did not move.
 *
 * The fix is that under npx the RE-EXEC IS THE UPDATE. There is nothing to
 * install: relaunching through `npx -y flowviant@latest` makes npx resolve
 * `latest` against the registry and fetch it (measured — it pulled 0.57.0 into
 * a new cache entry beside the stale 0.54.2). So the npx path stops nagging and
 * starts restarting itself, honouring AUTO_UPDATE and the same idle gate as the
 * global path.
 */

import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, mkdtemp, open, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { platform, arch } from 'node:process';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { runningViaNpx, terminalCommand } from './launchCommand.mjs';
import { VERSION } from './config.mjs';
import { note, ok, warn } from './ui.mjs';

/** Compare x.y.z version strings → -1 | 0 | 1 (missing parts read as 0). */
export function cmpVersion(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** Bun marks compiled entrypoints with a virtual /$bunfs/ script path. */
export function runningCompiledBinary() {
  return Boolean(process.versions.bun && process.argv[1]?.startsWith('/$bunfs/'));
}

const RELEASE_ORIGIN = 'https://api.flowviant.com';

/** Download and verify before replacing the executable. Exposed for temp-dir tests. */
export async function installBinaryUpdate({
  executable = process.execPath,
  target = `${platform === 'darwin' ? 'darwin' : platform}-${arch}`,
  fetchImpl = fetch,
  origin = RELEASE_ORIGIN,
  minimumVersion = null,
} = {}) {
  if (!/^(linux|darwin)-(x64|arm64)$/.test(target)) throw new Error(`unsupported binary target ${target}`);
  const manifestResponse = await fetchImpl(`${origin}/dl/latest.json`);
  if (!manifestResponse.ok) throw new Error(`release manifest: HTTP ${manifestResponse.status}`);
  const manifest = await manifestResponse.json();
  const version = manifest?.version;
  const file = manifest?.files?.[target];
  if (!/^\d+\.\d+\.\d+$/.test(version) ||
      file?.name !== `flowviant-${version}-${target}` ||
      !/^[a-f0-9]{64}$/.test(file?.sha256) ||
      !Number.isSafeInteger(file?.bytes) || file.bytes <= 0) {
    throw new Error('invalid release manifest');
  }
  if (minimumVersion && cmpVersion(version, minimumVersion) < 0) {
    throw new Error(`release manifest still serves ${version}; waiting for ${minimumVersion}`);
  }
  const binaryResponse = await fetchImpl(`${origin}/dl/${version}/${file.name}`);
  if (!binaryResponse.ok || !binaryResponse.body) throw new Error(`binary download: HTTP ${binaryResponse.status}`);
  const parent = dirname(executable);
  const temporaryDir = await mkdtemp(join(parent, '.flowviant-update-'));
  const temporaryFile = join(temporaryDir, file.name);
  try {
    await pipeline(Readable.fromWeb(binaryResponse.body), createWriteStream(temporaryFile, { mode: 0o755 }));
    const digest = createHash('sha256');
    let bytes = 0;
    for await (const chunk of createReadStream(temporaryFile)) {
      digest.update(chunk);
      bytes += chunk.length;
    }
    if (bytes !== file.bytes || digest.digest('hex') !== file.sha256) {
      throw new Error('downloaded binary failed SHA-256 or size verification');
    }
    await chmod(temporaryFile, 0o755);
    const handle = await open(temporaryFile, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
    await rename(temporaryFile, executable);
    // The rename has committed. Directory fsync is best effort on filesystems
    // that do not support it; a failure here must not claim the binary survived.
    try {
      const dirHandle = await open(parent, 'r');
      try { await dirHandle.sync(); } finally { await dirHandle.close(); }
    } catch { /* rename already succeeded */ }
    return version;
  } finally {
    await rm(temporaryDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Replace this process with a fresh one running the just-installed version.
 * `npm i -g` overwrote the global package in place, so re-running argv[1] loads
 * the NEW code. We tear down first (idle-gated, so nothing's mid-task) and keep
 * this process alive only as a thin proxy waiting on the child, so the user's
 * shell stays attached to one foreground process.
 */
function reexec(teardown, { viaNpx = false, viaBinary = false, target = null } = {}) {
  try {
    teardown?.();
  } catch {
    /* best-effort */
  }
  // UNDER NPX THE RE-EXEC IS THE UPDATE, so it must not re-run our own argv[1]:
  // that path points into the npx cache entry holding the version we are trying
  // to leave, and re-running it would reload the stale copy forever. Going back
  // through `npx -y flowviant@latest` is what makes npx resolve `latest` against
  // the registry and fetch the new one. `-y` because a restart must never stop
  // on npx's install prompt — the same rule FLOWVIANT_REEXEC keeps below.
  const [cmd, args] = viaNpx
    ? ['npx', ['-y', 'flowviant@latest', ...process.argv.slice(2)]]
    : [process.execPath, process.argv.slice(viaBinary ? 2 : 1)];
  const child = spawn(cmd, args, {
    stdio: 'inherit',
    // MARK THE CHILD AS A RESTART, not as a person typing `flowviant`.
    // stdio is inherited, so the child sees two TTYs and believes a human is
    // watching — and 0.55.0 asks a one-time binding question on exactly that
    // signal. An auto-update that lands while nobody is looking would then sit
    // on `Serve this repo as X? [Y/n]` with the machine dark until someone
    // walks past. The rule credentials.mjs already states for systemd applies
    // verbatim here: a RESTART must not hang on a prompt. Skipping the confirm
    // is not a widening — the daemon serves exactly the credential it was
    // already serving one second ago, and the question gets asked the next
    // time a human starts it by hand.
    env: {
      ...process.env,
      FLOWVIANT_REEXEC: '1',
      // WHICH DAEMON THE SUCCESSOR IS REPLACING. Under npx the successor's
      // parent is `npm exec`, not us, so the instance lock's ppid check read us
      // as a rival and the new daemon SIGTERMed this proxy. instance.mjs adopts
      // the lock from this pid when it is really an ancestor of the successor.
      FLOWVIANT_REEXEC_FROM: String(process.pid),
      // WHAT WE RESTARTED IN ORDER TO BECOME. The successor compares its own
      // VERSION against this: if it came back still short, the update did not
      // take (a registry serving a stale `latest`, an npx cache that refused to
      // move, a half-written global install) and it must NAG rather than
      // restart again. Without this the npx path is a re-exec loop — and unlike
      // the global path there is no install step whose failure would throw and
      // stop it.
      ...(target ? { FLOWVIANT_UPDATE_TARGET: target } : {}),
    },
  });
  child.on('exit', (code) => process.exit(code ?? 0));
}

/**
 * Did a restart that was supposed to land us on `target` fail to?
 *
 * True only when a PREVIOUS process handed us a target we are still below. A
 * plain start has no marker, and a successful update is at or above it — so
 * this is false in every case except the one it exists for.
 */
export function updateRestartFailed(target) {
  const attempted = process.env.FLOWVIANT_UPDATE_TARGET;
  if (!attempted) return false;
  return cmpVersion(VERSION, attempted) < 0 && cmpVersion(target ?? attempted, attempted) <= 0;
}

/** Install @latest globally. Throws on failure (EACCES without sudo, offline…). */
function installLatest() {
  execFileSync('npm', ['install', '-g', 'flowviant@latest'], { stdio: 'inherit' });
}

/** `flowviant update` — explicit, manual update. Does not re-exec into a daemon
 *  (the user ran a one-shot command); it installs and tells them to relaunch. */
export async function runUpdateCommand() {
  if (runningCompiledBinary()) {
    try {
      const version = await installBinaryUpdate();
      ok(`updated to ${version}. Relaunch \`flowviant\` to run the new version.`);
    } catch (e) {
      warn(`update failed (${e?.message ?? e}) — running binary untouched.`);
    }
    return;
  }
  if (runningViaNpx()) {
    note('running via npx — just relaunch with `npx flowviant@latest` to get the newest.');
    return;
  }
  try {
    note(`updating flowviant (currently ${VERSION})…`);
    installLatest();
    ok('updated. Relaunch `flowviant` to run the new version.');
  } catch (e) {
    warn(`update failed (${e?.message ?? e}). Try: ${terminalCommand('update')}`);
  }
}

// Nag at most once per target version, so a poll every ~10s doesn't spam.
let naggedFor = null;
/**
 * When the last install ATTEMPT failed, so a failure can be retried instead of
 * being final. It used to set `naggedFor` and stop: one unwritable global
 * prefix, one npm blip, or one offline moment and the daemon stayed on its old
 * version until the server announced a DIFFERENT one — which on a box nobody
 * logs into means features silently missing for days (measured: a machine sat
 * on 0.47.0 through two releases). A readout in the app now surfaces it too,
 * but the machine should also just try again.
 */
let lastInstallFailAt = 0;
const INSTALL_RETRY_MS = 15 * 60_000;

/**
 * React to the server's {latest, min} signal from a roster poll.
 * @returns true if it kicked off a self-update + re-exec (caller must stop).
 */
export async function handleVersionSignal({ latest, min, autoUpdate, safeToUpdate, teardown }) {
  const cur = VERSION;
  const belowMin = min && cmpVersion(cur, min) < 0;
  const belowLatest = latest && cmpVersion(cur, latest) < 0;
  if (!belowMin && !belowLatest) return false; // current — nothing to do
  const target = latest || min;
  const npx = runningViaNpx();
  const binary = runningCompiledBinary();
  const wantInstall = belowMin || autoUpdate;

  // A RESTART THAT DID NOT TAKE must not be tried again on the next poll. The
  // global path is self-limiting (a failed `npm i -g` throws and lands in the
  // 15-minute backoff), but the npx path has no install step to fail — it just
  // relaunches, so a registry or cache that keeps serving the old version would
  // loop this process forever, tearing down live turns every ten seconds.
  if (updateRestartFailed(target)) {
    if (naggedFor !== target) {
      naggedFor = target;
      warn(
        `restarted to pick up ${target} but came back as ${cur} — staying put. Update by hand: ${
          binary ? 'run `flowviant update`' : npx ? 'relaunch with `npx flowviant@latest`' : `run \`${terminalCommand('update')}\``
        }.`
      );
    }
    return false;
  }

  if (wantInstall && binary) {
    if (!safeToUpdate) {
      if (naggedFor !== target) {
        naggedFor = target;
        note(`flowviant ${cur} → ${target} available — self-updating once no turn is running.`);
      }
      return false;
    }
    if (Date.now() - lastInstallFailAt < INSTALL_RETRY_MS) return false;
    try {
      note(`flowviant ${cur} → ${target}: downloading binary…`);
      const installed = await installBinaryUpdate({ minimumVersion: target });
      ok('updated — restarting into the new version.');
      reexec(teardown, { viaBinary: true, target: installed });
      return true;
    } catch (e) {
      lastInstallFailAt = Date.now();
      warn(`binary self-update failed (${e?.message ?? e}) — running binary untouched; retrying in 15m.`);
      return false;
    }
  }

  // UNDER NPX THERE IS NOTHING TO INSTALL — the relaunch IS the update, because
  // `npx -y flowviant@latest` resolves `latest` against the registry. Same two
  // gates as the global path: the operator's AUTO_UPDATE choice, and an idle
  // machine, because a re-exec mid-turn SIGTERMs the tab's CLI. No npm-view
  // probe here: npx is about to ask the registry itself, and the loop guard
  // above is what a stale answer runs into.
  if (wantInstall && npx) {
    if (!safeToUpdate) {
      if (naggedFor !== target) {
        naggedFor = target;
        note(`flowviant ${cur} → ${target} available — restarting once no turn is running.`);
      }
      return false;
    }
    note(`flowviant ${cur} → ${target}: restarting through npx to pick it up…`);
    reexec(teardown, { viaNpx: true, target });
    return true;
  }

  if (wantInstall && !npx && !binary) {
    if (!safeToUpdate) {
      // Outdated but a turn is running — wait until the machine is quiet. Nag
      // once meanwhile.
      if (naggedFor !== target) {
        naggedFor = target;
        note(`flowviant ${cur} → ${target} available — self-updating once no turn is running.`);
      }
      return false;
    }
    // A failed install is retried on a cooldown, not abandoned: the common
    // causes (an unwritable global prefix mid-fix, a registry blip, a network
    // that came back) are all transient, and the poll runs every ~10s so
    // without this a single failure is effectively permanent. Checked BEFORE
    // the npm-view probe below, which is a SYNCHRONOUS network call — during
    // backoff every ~10s poll would otherwise block the whole event loop on a
    // question whose answer we already decided not to act on.
    if (Date.now() - lastInstallFailAt < INSTALL_RETRY_MS) return false;
    // Loop guard: the server can announce a version before it's published. npm is
    // the source of truth — only install if npm ACTUALLY has something newer than
    // us, else `npm i -g @latest` reinstalls our own version and we'd re-exec
    // forever.
    let published = null;
    try {
      published = execFileSync('npm', ['view', 'flowviant', 'version'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        // Synchronous, so it holds the event loop hostage for however long it
        // runs — a hung registry must not become a hung daemon.
        timeout: 10_000,
      }).trim();
    } catch {
      /* offline / npm hiccup — treat as "can't confirm", skip this poll */
    }
    if (!published || cmpVersion(published, cur) <= 0) {
      if (naggedFor !== target) {
        naggedFor = target;
        note(`update ${target} announced but npm still serves ${published ?? '?'} — waiting for the publish.`);
      }
      return false;
    }
    try {
      note(`flowviant ${cur} → ${published}: self-updating…`);
      installLatest();
      ok('updated — restarting into the new version.');
      reexec(teardown, { target: published });
      return true;
    } catch (e) {
      lastInstallFailAt = Date.now();
      warn(
        `self-update failed (${e?.message ?? e}) — retrying in 15m; to fix it now: ${terminalCommand('update')}`
      );
      return false;
    }
  }

  // Can't or won't auto-install → nag once per target version.
  if (naggedFor !== target) {
    naggedFor = target;
    const how = binary ? 'run `flowviant update`' : npx ? 'relaunch with `npx flowviant@latest`' : `run \`${terminalCommand('update')}\``;
    if (belowMin) {
      warn(`flowviant ${cur} is below the minimum ${min} — live mode may not work. Update: ${how}.`);
    } else {
      note(`flowviant ${cur} → ${latest} available. Update: ${how}.`);
    }
  }
  return false;
}
