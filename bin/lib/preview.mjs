/**
 * Put a password-gated public URL in front of a dev server the DRIVER is
 * already running in their own worktree.
 *
 * This file used to be the other half of a deleted feature: a dispatch run
 * parked for review, and the daemon started the branch's dev server from a
 * repo-declared command and tunnelled it. That whole start path is GONE
 * (2026-08-21) and is not coming back. What it did, stated plainly so nobody
 * rebuilds it: read `.flowviant/preview.json` — a file the BRANCH controls —
 * or infer a command from package.json, then `spawn(cmd, {shell: true})` with
 * `env: {...process.env}`, which ran `npm install` and its lifecycle scripts
 * and handed the resulting internet-exposed process the daemon's own
 * FLOWVIANT_FLEET credential. One click behind a button, and a hostile branch
 * owns the machine.
 *
 * The replacement inverts the direction. The human runs their dev server
 * themselves, exactly as they would in a terminal; `listeners.mjs` NOTICES it;
 * and this file only ever wraps a port that has already been measured inside
 * that session's worktree. Flowviant executes nothing the repo wrote.
 *
 * Two invariants that must survive any edit here:
 *  - THE GATE IS MANDATORY. `startAuthProxy` returning null aborts the share.
 *    There is no un-gated path, no config key that disables it, and no log line
 *    that shrugs and tunnels anyway.
 *  - WE ONLY EXECUTE WHAT WE VERIFIED. An auto-fetched cloudflared is pinned to
 *    a version and checked against a hardcoded SHA-256 before it is made
 *    executable. TLS alone is not integrity for a binary that runs on the
 *    machine holding the repo, the git credentials and the decrypted env vault.
 */

import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync, renameSync, existsSync, mkdirSync, chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, platform, arch } from 'node:os';
import { startAuthProxy } from './authproxy.mjs';
import { forgetInfraPid, isListening, noteInfraPid, originFor } from './listeners.mjs';
import { forgetPreviewPid, recordPreviewPid } from './previewRegistry.mjs';

// ── cloudflared: pinned, verified, or not fetched at all ───────────────────

/**
 * Pinned deliberately. `releases/latest/download/...` meant every machine
 * fetched whatever was newest at the moment it happened to need one, which is
 * both unverifiable and irreproducible. Bumping this is a release act: download
 * the assets, hash them, replace both the tag and the digests.
 */
const CF_VERSION = '2026.8.2';
const CF_SHA256 = {
  'linux-amd64': 'fcfb02b575a52ca1af2e3267af4e1517bcdeb30ac48c834c69abaed3c0576ad2',
  'linux-arm64': '7747d94570fb390cf47dcb4f9555c193c6355cda9793f0d878d9049e5d6a7790',
  'darwin-amd64': 'f1727723c586500e2092368ae21871b3df7ddfd2cb097f22d81bee4a9c458bb4',
  'darwin-arm64': '9042c2c5d8b2de78e60f313d5fb31b6c5c1cebde787a3caf1f2c9588084ac442',
};

function onPath() {
  try {
    execFileSync('cloudflared', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve a cloudflared binary: PATH → previously fetched → download.
 *
 * A cloudflared already on PATH is used as-is and NOT checksummed: the operator
 * installed it (brew, apt, winget) and that is their trust decision, not ours.
 * What we verify is what WE fetch and chmod +x, which is the only case where
 * Flowviant is the one introducing an executable to the machine.
 *
 * Returns { bin } or { error } — the error is the machine's own sentence, meant
 * to be relayed verbatim rather than replaced with a Flowviant-authored one.
 */
async function ensureCloudflared(log) {
  if (onPath()) return { bin: 'cloudflared' };

  const os = platform();
  const a = arch() === 'arm64' ? 'arm64' : 'amd64';
  const key = `${os === 'darwin' ? 'darwin' : 'linux'}-${a}`;
  const dir = join(homedir(), '.flowviant', 'bin');
  // Version-stamped, so a pin bump fetches rather than reusing the old binary.
  const bin = join(dir, `cloudflared-${CF_VERSION}${os === 'win32' ? '.exe' : ''}`);
  if (existsSync(bin)) return { bin };

  const want = CF_SHA256[key];
  if (!want) {
    return {
      error: `cloudflared is not installed, and this machine (${os}/${a}) has no pinned build to fetch. Install cloudflared and try again.`,
    };
  }

  try {
    mkdirSync(dir, { recursive: true });
    const asset = os === 'darwin' ? `cloudflared-darwin-${a}.tgz` : `cloudflared-linux-${a}`;
    const url = `https://github.com/cloudflare/cloudflared/releases/download/${CF_VERSION}/${asset}`;
    log?.(`fetching cloudflared ${CF_VERSION} (${key})…`);
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`http ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());

    // Verify BEFORE anything becomes executable, and before extraction — a
    // tarball is code too.
    const got = createHash('sha256').update(buf).digest('hex');
    if (got !== want) {
      return {
        error: `refused to install cloudflared ${CF_VERSION}: the download did not match its pinned checksum (expected ${want.slice(0, 12)}…, got ${got.slice(0, 12)}…). Install cloudflared yourself if you trust this network.`,
      };
    }

    if (os === 'darwin') {
      const tgz = join(dir, `cloudflared-${CF_VERSION}.tgz`);
      writeFileSync(tgz, buf);
      execFileSync('tar', ['-xzf', tgz, '-C', dir], { stdio: 'ignore' });
      rmSync(tgz, { force: true });
      const extracted = join(dir, 'cloudflared');
      if (!existsSync(extracted)) throw new Error('archive did not contain cloudflared');
      renameSync(extracted, bin);
    } else {
      writeFileSync(bin, buf);
    }
    chmodSync(bin, 0o755);
    return { bin };
  } catch (e) {
    return { error: `could not fetch cloudflared (${e.message}). Install it and try again.` };
  }
}

/**
 * The hostname cloudflared ASSIGNED, and nothing else it happens to print.
 *
 * `[a-z0-9-]+\.trycloudflare\.com` also matched cloudflared's own FAILURE line
 * — `failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel":
 * dial tcp: lookup api.trycloudflare.com: …` — so on any box that could not
 * reach the quick-tunnel API (offline, DNS failure, a proxy blocking it) the
 * share was reported LIVE at Cloudflare's own API host, and cloudflared's real
 * sentence, which the tail exists to relay, was replaced by a wrong one (audit
 * 2026-09-24). `api.` is the service's endpoint and never an assigned name, and
 * the trailing guard stops a longer hostname matching on its prefix.
 */
export const TUNNEL_RE = /https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com(?![a-z0-9.-])/i;

// ── The one thing this file does ───────────────────────────────────────────

/** How long we wait for cloudflared to hand us a hostname. */
const TUNNEL_TIMEOUT_MS = 60_000;
/** Bytes of cloudflared output kept for the failure sentence. */
const TAIL_BYTES = 2000;

/**
 * Gate `port` behind a password and publish it on a quick tunnel.
 *
 * Resolves { url, user, password, gateMode, stop } on success, or { error } — a sentence
 * from this machine, to be relayed as-is. It never resolves a URL without a
 * password, and it never returns a tunnel whose origin was not listening when
 * we checked.
 *
 * `onDead` fires if the ORIGIN stops answering while the tunnel is up:
 * cloudflared happily outlives a dead dev server and the gate answers a dead
 * origin with 502, so without this the product would report "live" over a 502 —
 * Flowviant asserting a state it never measured.
 *
 * `stillServing` (optional, async → boolean) is the ATTRIBUTION check — the
 * same `listenersIn(worktree)` predicate the caller ran at the boundary —
 * and it guards EVERY gate in here, not just the probe: the open-time
 * re-validation, one more look immediately before cloudflared spawns, and the
 * recurring probe. Ports are global to a box and a worktree is not: when the
 * driver's dev server dies and anything else — a teammate's worktree, a
 * database — binds the same number, a bare `isListening` answers yes and the
 * URL+password serve the NEW process, outside every consent gate. Three gates
 * on one predicate, so "the origin is alive" always means "THIS session's
 * origin"; a bare TCP connect stands in only when no predicate was given (an
 * older caller).
 *
 * `onAbuse` fires when the gate closes itself after repeated failed password
 * attempts — AFTER the share is torn down locally — so the caller can report
 * the incident. Without it the abuse close was invisible: the row kept
 * reading "live" until staleness, and endedReason 'abuse' was unreachable.
 *
 * `onTunnelGone` fires when cloudflared exits AFTER the URL was published
 * (quick tunnels are best-effort and do get dropped). The probe cannot see
 * this — it watches the origin — and a daemon that keeps heartbeating a dead
 * hostname confirms "live" over a 530 for up to 8 hours.
 */
export async function openTunnel({
  port,
  log,
  onDead,
  onAbuse,
  onTunnelGone,
  stillServing,
  // The worktree the port was attributed to. When given, the gate dials the
  // address the ATTRIBUTED socket holds (`originFor`) rather than assuming
  // 127.0.0.1, and every liveness check re-derives it — so a neighbour on the
  // other loopback family is never what the tunnel publishes.
  worktree,
  probeMs = 20_000,
  // The members-gate triple, all three or none. Absent = an older server, or a
  // password-mode share: the gate runs exactly as it always has.
  grantSecret,
  shareId,
  authorizeUrl,
}) {
  // ONE predicate for every liveness question this function asks. Attribution
  // when the caller gave it, a bare TCP connect only when it did not; an
  // attribution check that errors is not a "yes".
  // `origin` is decided once, at the gate's start; after that a change of
  // address is a different process and reads as "not serving".
  let origin = null;
  const serving = async () => {
    try {
      if (worktree) {
        const o = originFor(worktree, port);
        if (o.error || (origin && o.host !== origin)) return false;
      }
      return stillServing ? await stillServing() : await isListening(port);
    } catch {
      return false;
    }
  };

  // Re-validate at the machine. The server checked this port against the last
  // report; reports are up to a minute old and a dev server is a process a
  // human can stop at any moment.
  if (!(await serving())) {
    return { error: `nothing is listening on port ${port} in this worktree any more.` };
  }

  const cf = await ensureCloudflared(log);
  if (cf.error) return { error: cf.error };

  let stopped = false;
  let gate = null;
  let tunnel = null;
  let probe = null;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (probe) clearInterval(probe);
    try {
      gate?.stop();
    } catch {
      /* best-effort */
    }
    if (tunnel?.pid) {
      try {
        process.kill(-tunnel.pid, 'SIGKILL'); // the whole detached group
      } catch {
        try {
          tunnel.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }
      forgetPreviewPid(tunnel.pid);
      forgetInfraPid(tunnel.pid);
    }
  };

  // The gate comes up FIRST and the tunnel points at it, never at the origin —
  // so there is no window in which the public hostname is un-gated.
  if (worktree) {
    const o = originFor(worktree, port);
    if (o.error) return { error: o.error };
    origin = o.host;
  }
  gate = await startAuthProxy({
    targetPort: port,
    ...(origin ? { targetHost: origin } : {}),
    log,
    // Never logged, never written to previews.json, never in the reap
    // signature, never in argv or a child env — /proc/<pid>/cmdline is
    // world-readable and this box also runs the driver's dev server and every
    // CLI turn. In-process only.
    grantSecret,
    shareId,
    authorizeUrl,
    onAbuse: () => {
      stop();
      try {
        onAbuse?.();
      } catch {
        /* the caller's report is best-effort */
      }
    },
  });
  if (!gate) {
    return { error: 'could not start the password gate for this preview, so nothing was published.' };
  }

  // The last look BEFORE anything becomes public. Between the check above and
  // here sit a possible cloudflared download and the gate's own bind — long
  // enough for the dev server to die and an unrelated process to take the
  // port, which a check that ran only at the top would never see again until
  // the probe's first beat, up to probeMs later. Same predicate, so the moment
  // the hostname exists it can only be pointing at THIS session's origin.
  if (!(await serving())) {
    stop();
    return { error: `nothing is listening on port ${port} in this worktree any more.` };
  }

  const args = ['tunnel', '--url', `http://localhost:${gate.port}`];
  // Send the origin the Host it expects. Vite and Next reject a Host they do
  // not recognise, so without this the tunnel resolves and then 403s.
  args.push('--http-host-header', 'localhost');

  tunnel = spawn(cf.bin, args, { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  // The signature names THIS tunnel's gate port, not the bare word
  // 'cloudflared': the reap matches cmdline.includes(sig), and the generic
  // word would let a recycled pid land on an operator's own unrelated
  // cloudflared and group-SIGKILL it.
  recordPreviewPid(tunnel.pid, `--url http://localhost:${gate.port}`);
  // Keep our own plumbing out of the listeners measurement (see listeners.mjs:
  // cloudflared's metrics socket lives in the checkout's cwd).
  noteInfraPid(tunnel.pid);

  return new Promise((resolve) => {
    let settled = false;
    let tail = '';
    const finish = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (v.error) stop();
      resolve(v);
    };

    const timer = setTimeout(
      () => finish({ error: `cloudflared did not return a URL within ${TUNNEL_TIMEOUT_MS / 1000}s.${tailSentence()}` }),
      TUNNEL_TIMEOUT_MS,
    );

    // cloudflared's own words. Both `error` and `close` used to resolve null
    // with nothing captured, which made a throttled or blocked tunnel
    // indistinguishable from silence — and silence is the one thing this
    // product is not allowed to turn into a state.
    const tailSentence = () => (tail.trim() ? ` cloudflared said: ${tail.trim().split('\n').slice(-3).join(' ')}` : '');

    const onOut = (d) => {
      const s = d.toString();
      tail = (tail + s).slice(-TAIL_BYTES);
      // ONE URL, ONE PROBE. A second match after we settled (cloudflared
      // repeats the banner, or a later line names another host) used to start
      // a second probe interval and a second close listener on a tunnel whose
      // answer had already been given.
      if (settled) return;
      // Matched over the TAIL, not the chunk: a pipe read can split the
      // hostname across two chunks, and a half never matches.
      const m = TUNNEL_RE.exec(tail);
      if (!m) return;

      // Watch the ORIGIN — with the caller's ATTRIBUTION check when it gave
      // one, never a bare port probe: a freed port rebound by another
      // worktree answers a TCP connect exactly like the origin did, and the
      // share would keep serving a process nobody consented to publish.
      probe = setInterval(async () => {
        if (stopped) return;
        if (!(await serving())) {
          const dead = onDead;
          stop();
          try {
            dead?.();
          } catch {
            /* the caller's teardown is best-effort */
          }
        }
      }, probeMs);
      if (probe.unref) probe.unref();

      // The TUNNEL dying after publish (quick tunnels get dropped) is the one
      // exit the probe cannot see. `stopped` guards our own kill: stop() sets
      // it before signalling, so this only fires for a death nobody asked for.
      tunnel.once('close', () => {
        if (stopped) return;
        const gone = onTunnelGone;
        stop();
        try {
          gone?.();
        } catch {
          /* the caller's report is best-effort */
        }
      });

      finish({ url: m[0], user: gate.user, password: gate.password, gateMode: gate.gateMode, stop });
    };

    tunnel.stdout.on('data', onOut);
    tunnel.stderr.on('data', onOut);
    tunnel.on('error', (e) => finish({ error: `could not run cloudflared (${e.message}).` }));
    tunnel.on('close', () => finish({ error: `cloudflared exited before publishing a URL.${tailSentence()}` }));
  });
}
