/**
 * ONE DAEMON PER REPO (and per credential), ARBITRATED at startup — a second
 * run in the same repo takes the first one's place rather than being turned
 * away. See "WHAT A SECOND RUN DOES" below for the whole rule.
 *
 * WHY THIS EXISTS. Nothing stopped two daemons before, and the server USED to
 * hand work out by READING, never claiming: `listWorkTurnJobs` selected every
 * pending turn for the machine credential, `listShipJobs` read a flag. So two
 * daemons on one credential were offered the SAME turn — and the ProjectRoom
 * nudges every connected daemon socket at once, so they did not even drift out
 * of phase.
 *
 * That half is fixed on the server now: since 0.53.0 each SESSION is leased to
 * one daemon INSTANCE nonce — `di`, regenerated every start (config.mjs) and
 * sent on every poll beside `ws`, the list of sessions this daemon holds a
 * worktree for — so a turn is handed to the instance holding that session and
 * to no one else. It does NOT retire this lock. The lease fails OPEN when no
 * instance is reported (an older daemon cannot name itself), and it arbitrates
 * only what rides a session: the wiki sweep, env materialization, previews,
 * deploys and every worktree operation the server never sees are still first
 * come, first served.
 *
 * The per-worktree `flowviant-turn.lock` cannot save it. That lock is written
 * AFTER the work token is minted and the attachments are fetched — a window
 * containing a network round trip — so both daemons clear the check and both
 * spawn a CLI into one held conversation. It was built for a RESTARTED daemon
 * (its own comment says so, work.mjs), where the holder is already live when
 * the successor looks; it was never a concurrency primitive.
 *
 * What a duplicate run cost before the session lease, all of it invisible in
 * the tab: two Claudes editing one worktree, two cards from one `file_card` (no
 * idempotency key), the session write budget spent twice, quota spent twice —
 * and then exactly ONE answer surviving, because `settleWorkTurn` is atomic.
 * The side effects landed twice and the transcript showed one turn. Two daemons
 * in one checkout still cost the un-leased half of that: two `git fetch`, two
 * worktree sweeps, and the collisions listed under ONE DAEMON PER REPO below.
 *
 * KEYED ON THE CREDENTIAL — and, as the next paragraph adds, on the REPO as
 * well; both checks run, and either one is enough. The credential is stored once, at
 * ~/.flowviant/credentials.json, so `flowviant` in two DIFFERENT checkouts is
 * still one project served twice — and that case is strictly worse, because the
 * two daemons have different worktree roots and the turn lock cannot even see
 * across them. Keying on the token catches both, and still lets a second
 * credential run a second project on the same machine.
 *
 * ...AND ONE DAEMON PER REPO, which is NOT the same statement. The lock above
 * is keyed on the credential, and the two coincide only while one credential
 * serves one project — which is the product's law but not a thing this file can
 * assume. Two DIFFERENT credentials pointing at one checkout both acquired
 * happily (measured), giving two daemons in one working tree: two `git fetch`,
 * two worktree sweeps, `retireWorkSessions` in one removing directories the
 * other is serving, and a ship in one racing a rebase in the other. No server
 * lease can arbitrate any of that, because the server never sees a directory.
 * So the repo is checked too, across every credential's lock.
 *
 * WHAT A SECOND RUN DOES, and this is the whole rule:
 *
 *   SAME REPO      -> the new run WINS. The holder is asked to stand down and
 *                     this daemon takes its place. Re-running `flowviant` in a
 *                     directory you are working in means "serve this repo", and
 *                     the process already serving it is by definition the one
 *                     you are replacing. That is a restart, and a restart
 *                     should not require you to go and find a pid.
 *
 *   DIFFERENT REPO -> REFUSED, and nothing is signalled. That daemon is serving
 *                     other work; killing it because you happened to run this
 *                     command elsewhere is not a restart, it is collateral.
 *                     `--takeover` overrides, deliberately explicitly.
 *
 * One rule, and it is the invariant stated as behaviour: one daemon per repo.
 * `--no-takeover` (or FLOWVIANT_NO_TAKEOVER=1) makes even the same-repo case
 * refuse, for anyone who wants the old ceremony.
 *
 * IT FAILS OPEN. A home directory we cannot write to is not a reason to refuse
 * to start; it is a reason to say so and carry on unguarded.
 */

import { execFileSync } from 'node:child_process';
import {
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { VERSION } from './config.mjs';

/** Deliberately a HASH: a credential must never become a filename. */
export function instanceLockPath(fleetToken) {
  const key = createHash('sha256').update(String(fleetToken || 'anon')).digest('hex').slice(0, 12);
  return join(homedir(), '.flowviant', `daemon-${key}.lock`);
}

/** Numeric dotted compare, -1/0/1. Unparsable compares EQUAL, so a version we
 *  cannot read never silently authorises a downgrade. */
function cmpVersion(a, b) {
  const x = String(a).split('.').map((n) => Number.parseInt(n, 10));
  const y = String(b).split('.').map((n) => Number.parseInt(n, 10));
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const p = x[i] ?? 0;
    const q = y[i] ?? 0;
    if (Number.isNaN(p) || Number.isNaN(q)) return 0;
    if (p !== q) return p > q ? 1 : -1;
  }
  return 0;
}

/** Signal 0 — a liveness probe, not a kill. EPERM means alive and not ours. */
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

function readHolder(path) {
  try {
    const v = JSON.parse(readFileSync(path, 'utf8'));
    return v && Number.isInteger(v.pid) && v.pid > 0 ? v : null;
  } catch {
    return null; // absent, truncated, or half-written — treat as no holder
  }
}

const record = (repoRoot) =>
  JSON.stringify({
    pid: process.pid,
    repoRoot,
    startedAt: new Date().toISOString(),
    // The script we were started from, and what we are. A takeover matches the
    // live command line against `entry` before signalling anything — a lock
    // records a PID, and a crashed daemon's PID can be reused by anything.
    // Locks written before this field existed (0.51.2 through 0.53.0) are
    // matched on the holder's process START TIME instead; stillTheHolder says
    // why that is the weaker of the two claims and still strong enough.
    entry: process.argv[1] || '',
    version: VERSION,
  });

/** Same directory, whatever it is spelled as — symlinks and trailing slashes
 *  included. A repo compared by string would let `/repo` and `/repo/` past. */
function samePath(a, b) {
  if (!a || !b) return false;
  const norm = (v) => {
    try {
      return realpathSync(v);
    } catch {
      return String(v).replace(/\/+$/, '');
    }
  };
  return norm(a) === norm(b);
}

/**
 * A LIVE daemon in this same checkout, under a DIFFERENT credential.
 *
 * The lock above cannot see one: it is keyed on the credential, so a second
 * token in the same directory opens its own file and takes it. Every other
 * lock file on this machine is ours to read, so read them.
 *
 * Returns the holder, or null. A stale file never blocks — it is cleared by
 * whichever acquire owns it, and blocking on a corpse would be worse than the
 * thing this prevents.
 */
/** Which lock file a neighbour holder was read from — takeOverFrom waits on it. */
const NEIGHBOUR_PATHS = new WeakMap();
function neighbourLockPath(holder, fallback) {
  return NEIGHBOUR_PATHS.get(holder) ?? fallback;
}

export function daemonInSameRepo(repoRoot, ownPath) {
  const dir = join(homedir(), '.flowviant');
  let files;
  try {
    files = readdirSync(dir).filter((f) => /^daemon-[0-9a-f]{12}\.lock$/.test(f));
  } catch {
    return null;
  }
  for (const f of files) {
    const path = join(dir, f);
    if (path === ownPath) continue; // our own credential — the lock above owns that question
    const holder = readHolder(path);
    if (!holder || !alive(holder.pid)) continue;
    if (holder.pid === process.ppid) continue; // ourselves mid self-update re-exec
    if (samePath(holder.repoRoot, repoRoot)) {
      NEIGHBOUR_PATHS.set(holder, path);
      return holder;
    }
  }
  return null;
}

/** How far a holder's actual start may sit BEFORE the `startedAt` line it wrote
 *  and still be the same process. Measured on this exact path: node boot to the
 *  first line of JS is 20ms, and the whole way through importing this module,
 *  `git rev-parse --show-toplevel` and base-ref detection to record() is 29-32ms.
 *  The worst realistic run is a start that had to take over a NEIGHBOUR's lock
 *  first (a 20s grace, then 600ms) and then its own (another 20s), which lands
 *  around 41s. 120s is ~3x that worst path and ~4000x the typical one, and it is
 *  still short enough that pid reuse cannot reach into it: reuse means cycling
 *  the entire pid space (4194304 by default), which no machine does inside two
 *  minutes. */
const TAKEOVER_START_WINDOW_MS = 120_000;

/** ...and how far the OTHER way, which is a unit problem rather than a real
 *  possibility. `starttime` is quantised to clock ticks and `ps -o etime=` to
 *  whole seconds, so a process that genuinely started a moment before its own
 *  lock line can compute a hair after it. 5s covers that granularity and
 *  nothing else. The window is deliberately asymmetric and BACKWARD-looking: it
 *  brackets the daemon's own startup, not "recently", so a freshly forked
 *  impostor that inherited a recycled pid lands on this side and is refused. */
const TAKEOVER_START_SLACK_MS = 5_000;

/** USER_HZ — the unit `/proc` publishes `starttime` in. NOT the kernel's internal
 *  CONFIG_HZ (250/300/1000): the kernel converts before writing, and USER_HZ is a
 *  fixed ABI constant, 100 on every architecture that matters. So the fallback
 *  below is the ABI and not a guess, and `getconf` is only belt and braces.
 *
 *  A wrong value here fails SAFE in BOTH directions, which is why it is allowed
 *  to be a guess at all: too low and the process computes as far older than its
 *  lock (refused by the 120s window), too high and it computes as newer than a
 *  lock it supposedly wrote (refused by the 5s slack). */
function userHz() {
  try {
    const n = Number.parseInt(
      execFileSync('getconf', ['CLK_TCK'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 3000,
      }).trim(),
      10,
    );
    if (Number.isInteger(n) && n > 0 && n <= 1_000_000) return n;
  } catch {
    /* no getconf — the constant below IS the ABI */
  }
  return 100;
}

/**
 * Wall-clock milliseconds at which `pid` started, or null.
 *
 * NULL IS NOT "UNKNOWN, PROBABLY FINE". Every caller must read it as refuse —
 * this feeds a check that gates a SIGTERM and then a SIGKILL, and there is no
 * such thing as a harmless guess about which process to kill.
 */
function processStartedAt(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    if (platform() === 'linux') {
      // FIELD 22 OF /proc/<pid>/stat, and the parse is the whole trap. Field 2
      // is `comm`, which the kernel wraps in parens and which may contain BOTH
      // spaces and parens — it is the first 15 bytes of the executable's name,
      // and a name is not a token. A naive split on whitespace taking $22 then
      // lands on `nice` for any such process, and `nice` is a small integer, so
      // the answer is not a parse error but a plausible-looking "started at
      // boot" that sails past any isFinite guard. Measured: a binary named
      // `ev (i l) x` read 28308s too old that way.
      //
      // Every field after `comm` is a number or a single-character state, so no
      // ')' can appear later: the LAST ')' in the line is always the kernel's
      // own closing paren, even when comm itself ends in one.
      const raw = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const close = raw.lastIndexOf(')');
      if (close < 0) return null;
      const fields = raw.slice(close + 1).trim().split(/\s+/); // fields[0] IS field 3
      const ticks = Number.parseInt(fields[19], 10); // field 22 => 22 - 3
      if (!Number.isFinite(ticks) || ticks < 0) return null;
      // `/proc/uptime` rather than `/proc/stat`'s btime, and not for precision
      // alone (measured 6ms out against 162ms). Date.now() and uptime are read
      // at the same instant, so a realtime clock stepped since boot cancels
      // out of the subtraction; btime bakes in a boot-realtime estimate that a
      // later NTP step silently invalidates. `starttime` is in ticks either
      // way — uptime gives seconds-since-boot, so the division by USER_HZ is
      // not optional.
      const up = Number.parseFloat(readFileSync('/proc/uptime', 'utf8').split(/\s+/)[0]);
      if (!Number.isFinite(up) || up < 0) return null;
      const ageMs = (up - ticks / userHz()) * 1000;
      if (!Number.isFinite(ageMs) || ageMs < 0) return null;
      return Date.now() - ageMs;
    }
    if (platform() === 'darwin') {
      // `etime`, not `lstart`. A DURATION has no locale, no timezone, and no
      // ambiguous repeated hour at the DST fall-back — where `lstart` is an
      // hour out and would refuse a genuine holder twice a year. It also dodges
      // Date.parse being LENIENT rather than strict: a localized `lstart` can
      // parse to a wrong-but-finite instant instead of failing honestly.
      // (`etimes`, the seconds-only form, is procps-only and not a BSD keyword.)
      // Both derive from the same kinfo_proc.p_starttime, so 1s resolution
      // against a 120s window costs nothing. LC_ALL is pinned anyway, since a
      // localized number format would be a wrong answer rather than no answer.
      const out = execFileSync('ps', ['-o', 'etime=', '-p', String(pid)], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 3000,
        env: { ...process.env, LC_ALL: 'C', LC_TIME: 'C' },
      });
      const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(out.trim()); // [[dd-]hh:]mm:ss
      if (!m) return null;
      const age =
        Number(m[1] || 0) * 86400 + Number(m[2] || 0) * 3600 + Number(m[3]) * 60 + Number(m[4]);
      if (!Number.isFinite(age) || age < 0) return null;
      return Date.now() - age * 1000;
    }
    return null; // win32, and anything else — never signalled rather than guessed at
  } catch {
    return null; // no /proc (hidepid=2, a pid namespace, a stripped container), no ps
  }
}

/**
 * THE FALLBACK, for a lock that carries no `entry`.
 *
 * `entry` arrived after the lock did. Every daemon from 0.51.2 through 0.53.0
 * wrote `{pid, repoRoot, startedAt}` and nothing else, and stillTheHolder used
 * to refuse those outright. Refusing was right in spirit and useless in fact:
 * it made takeover impossible on precisely the locks takeover exists for, since
 * the daemon you are replacing is by definition the OLD one. `--takeover` did
 * nothing, and re-running `flowviant` in the repo you were working in printed a
 * refusal and sent you hunting for a pid — the exact ceremony the same-repo rule
 * was written to abolish. (Those locks carry no `version` either, so a legacy
 * takeover also skips takeOverFrom's downgrade guard, which short-circuits on
 * `holder.version &&`. Separate hole, not this function's to close.)
 *
 * WHY START TIME PROVES IDENTITY, which is the only question worth asking here,
 * because what this gates is a SIGTERM and then a SIGKILL. A pid alone proves
 * nothing: pids are recycled, and a crashed daemon's number goes to whatever
 * forks next. The PAIR (pid, start time) is the standard POSIX process
 * identity — pidfd, systemd and procps all key on it — because the kernel
 * stamps a start time at fork and it is immutable for the life of the process,
 * unforgeable by anything that started later. And `startedAt` was written BY
 * the process being identified, measured 29-32ms after its own fork, so the
 * lock is that process's own witness to when it began.
 *
 * It is a WEAKER statement than `entry`, which says what the process IS rather
 * than when it started, and that is why `entry` stays the primary path. What
 * makes this one acceptable anyway is that a false positive needs two things at
 * once that are close to mutually exclusive: the pid space must have wrapped
 * back to this exact number, AND the new occupant must have started inside a
 * 2-minute window that ENDS at the lock write. Wrapping takes millions of
 * forks; the window ends before the impostor could have been born.
 *
 * EVERY ERROR MODE HERE PUSHES TOWARD REFUSAL, never toward signalling — an
 * unreadable /proc, a pid namespace, a kernel before 5.5 whose starttime drifts
 * across suspend, a realtime clock stepped in either direction, a locale that
 * mangles `ps`, Windows. All of them return false, and false costs a person a
 * manual kill. The other direction costs somebody else's process.
 */
function startedAroundLockWrite(holder) {
  try {
    const written = Date.parse(holder?.startedAt ?? '');
    if (!Number.isFinite(written)) return null; // no witness — nothing was measured
    const started = processStartedAt(holder.pid);
    if (started === null) return null; // could not measure — see the tri-state note
    const delta = written - started; // >0: the process predates its own lock line, as it must
    return delta >= -TAKEOVER_START_SLACK_MS && delta <= TAKEOVER_START_WINDOW_MS;
  } catch {
    return null;
  }
}

/**
 * IS THIS PID STILL THE DAEMON THAT TOOK THE LOCK?
 *
 * `process.kill(pid, 0)` says "a process exists", which is not the same claim,
 * and the difference matters the moment we are about to signal it. Matched on
 * the holder's own recorded ENTRYPOINT, never on the word "flowviant": a
 * command line merely CONTAINING it matches a shell, an editor, or a test
 * runner living under a `…-flowviant/` directory. That last one is not
 * hypothetical — a looser version of this check SIGTERMed one.
 *
 * A lock with no `entry` is no longer refused outright. Those locks are real
 * and current — every daemon 0.51.2 through 0.53.0 wrote one — so refusing
 * them meant takeover never worked on the upgrade it was built for. They fall
 * back to the holder's PROCESS START TIME, which is the same claim made a
 * weaker way; startedAroundLockWrite above argues why that is a proof rather
 * than a guess, and why every way it can go wrong ends in a refusal.
 *
 * TRI-STATE, and the third value is the point: `true` identified, `false`
 * measured-and-it-is-someone-else, `null` COULD NOT MEASURE. Both `false` and
 * `null` refuse — that never changes — but they are not the same sentence, and
 * collapsing them made the refusal assert a fact nobody had established: on a
 * `hidepid=2` host (ordinary Debian/Ubuntu hardening) the daemon told the user
 * their live holder "is no longer the daemon that took this lock", i.e. that
 * the lock was stale. Acting on that — deleting the lock, or taking the
 * ALLOW_MULTI escape printed underneath it — lands them in two daemons in one
 * working tree, which this module's header says no server lease can arbitrate.
 * Ignorance is not a state this product renders as fact.
 */
function stillTheHolder(holder) {
  const want = typeof holder?.entry === 'string' ? holder.entry : null;
  // An `entry` of '' is a field with nothing in it — record() writes
  // `process.argv[1] || ''` — and matching on '' would match every process
  // alive, so it takes the same road as a missing one.
  if (!want) return startedAroundLockWrite(holder);
  try {
    if (platform() === 'linux') {
      return readFileSync(`/proc/${holder.pid}/cmdline`, 'utf8').replace(/\0/g, ' ').includes(want);
    }
    return execFileSync('ps', ['-o', 'command=', '-p', String(holder.pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
    }).includes(want);
  } catch {
    // NOT `false`. takeOverFrom already returned early if the pid were gone, so
    // reaching here means the process is alive and we could not READ it —
    // hidepid=2, a pid namespace, a stripped image with no `ps`. Saying `false`
    // here is what made the refusal claim the pid belonged to somebody else.
    return null;
  }
}

/** Blocking, because this runs before there is an event loop worth yielding to
 *  and the caller cannot proceed until it knows whether the holder is gone. */
const sleep = (ms) => {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    /* no SharedArrayBuffer — check again immediately */
  }
};

/** How long the outgoing daemon gets to stand down cleanly. Its SIGTERM handler
 *  kills the CLI children it spawned and stops its preview tunnels; both are
 *  why we ask before we insist. */
const TAKEOVER_GRACE_MS = 20_000;

/**
 * Ask the holder to stand down, then take its place.
 *
 * SIGTERM FIRST, and not out of politeness: the daemon's handler runs its
 * teardown — it kills the CLI children it spawned and stops its preview
 * tunnels, which are DETACHED and would otherwise keep a public hostname
 * serving a worktree until the box reboots.
 *
 * WAIT ON THE LOCK FILE, not the pid. A departing daemon's release() removes it
 * on exit, so the file changing IS the handover. `kill(pid, 0)` cannot see it:
 * a process that exited but has not been reaped is a ZOMBIE and answers signal
 * 0 exactly like a living one — measured, a peer that exited cleanly still read
 * as alive for the full grace window.
 *
 * And "gone" is NOT "the file stopped naming our pid". It can stop naming it
 * because the holder SELF-UPDATED: update.mjs re-execs and the successor adopts
 * this same lock through the ppid branch. Treating that as free steals a live
 * daemon's lock and leaves it running unguarded — measured doing exactly that.
 */
function takeOverFrom(holder, path, log, { allowDowngrade = false } = {}) {
  if (!holder?.pid || !alive(holder.pid)) return null; // already gone
  const identified = stillTheHolder(holder);
  if (identified === null) {
    // We know nothing about this pid, and said so. The remedy is a human
    // stopping it, NOT running a second daemon alongside it.
    return {
      failed:
        `cannot confirm what pid ${holder.pid} is on this host — no readable /proc or ps — ` +
        `so it will not be signalled. Stop that process yourself and start this one again.`,
      unidentified: true,
    };
  }
  if (identified === false) {
    return { failed: `pid ${holder.pid} is no longer the daemon that took this lock — refusing to signal it` };
  }
  if (!allowDowngrade && holder.version && cmpVersion(VERSION, holder.version) < 0) {
    return {
      failed: `the running daemon is ${holder.version} and this one is ${VERSION} — refusing to replace a newer daemon with an older one (--takeover-downgrade if you mean it)`,
    };
  }

  log?.(`asking daemon pid ${holder.pid} to stand down…`);
  try {
    process.kill(holder.pid, 'SIGTERM');
  } catch {
    return { failed: `could not signal pid ${holder.pid}` };
  }

  const standing = () => {
    const now = readHolder(path);
    if (!now || !alive(now.pid)) return null;
    return now;
  };
  const deadline = Date.now() + TAKEOVER_GRACE_MS;
  for (;;) {
    const now = standing();
    if (!now) break;
    if (now.pid !== holder.pid) {
      return {
        failed: `the daemon handed over to pid ${now.pid}${now.version ? ` (${now.version})` : ''} while we waited — it is mid-update, so try again in a moment`,
      };
    }
    if (Date.now() >= deadline) {
      log?.(`pid ${holder.pid} did not stand down within ${TAKEOVER_GRACE_MS / 1000}s — forcing it.`);
      try {
        process.kill(holder.pid, 'SIGKILL');
      } catch {
        /* exited in the gap */
      }
      sleep(600);
      const after = standing();
      if (after && after.pid !== holder.pid) {
        return { failed: `the daemon handed over to pid ${after.pid} — try again in a moment` };
      }
      if (after) return { failed: `pid ${holder.pid} would not stop` };
      break;
    }
    sleep(400);
  }

  // A SIGKILLed daemon never ran its release(), so clear what it left.
  try {
    rmSync(path, { force: true });
  } catch {
    return { failed: 'could not clear the lock file' };
  }
  log?.(`daemon pid ${holder.pid} stopped — taking over.`);
  return null;
}

/**
 * Take the lock, or report who holds it.
 *
 * Returns `{ ok: true, release }` — call `release()` to drop it, and it is
 * already wired to process exit — or `{ ok: false, holder }` with the other
 * daemon's pid and repo so the caller can say something useful.
 *
 * `wx` is the whole guarantee: create-exclusive is one atomic syscall, which is
 * the property the turn lock's check-then-write does not have.
 */
export function acquireInstanceLock(fleetToken, repoRoot, opts = {}) {
  const { takeover: force = false, noTakeover = false, allowDowngrade = false, log } = opts;
  if (process.env.FLOWVIANT_ALLOW_MULTI === '1') return { ok: true, release: () => {} };
  const path = instanceLockPath(fleetToken);
  try {
    mkdirSync(join(homedir(), '.flowviant'), { recursive: true });
  } catch {
    return { ok: true, release: () => {}, unguarded: true };
  }

  // ONE DAEMON PER REPO, checked across every credential — see the header. This
  // runs BEFORE we take our own lock, so a refusal leaves nothing behind.
  const neighbour = daemonInSameRepo(repoRoot, path);
  if (neighbour) {
    // Same working tree, another credential. Under "one daemon per repo" the
    // new run wins here too — but it is signalling a process that belongs to a
    // DIFFERENT project, so it is worth saying out loud rather than doing
    // quietly.
    if (noTakeover) return { ok: false, holder: neighbour, sameRepo: true };
    log?.(`another project's daemon is serving this repo (pid ${neighbour.pid}).`);
    const bad = takeOverFrom(neighbour, neighbourLockPath(neighbour, path), log);
    if (bad)
      return { ok: false, holder: neighbour, sameRepo: true, takeoverFailed: bad.failed, unidentified: bad.unidentified };
  }

  // Two passes at most: one to clear a stale holder, one to take the lock. A
  // loop here would spin against a peer that keeps re-taking it.
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd;
    try {
      fd = openSync(path, 'wx');
    } catch (e) {
      if (e.code !== 'EEXIST') return { ok: true, release: () => {}, unguarded: true };
      const holder = readHolder(path);
      if (!holder || !alive(holder.pid)) {
        // A crashed daemon's leftover. Clear it and take it on the next pass.
        try {
          rmSync(path, { force: true });
        } catch {
          return { ok: true, release: () => {}, unguarded: true };
        }
        continue;
      }
      // OUR OWN PARENT, which is not a second daemon — it is this one, mid
      // re-exec. The SELF-UPDATE is the case: a live daemon holding this lock
      // installs a new version, spawns it, and stays alive as a proxy awaiting
      // it (update.mjs), so the successor's ppid IS the holder. Refusing there
      // would brick every auto-update. Adopt instead; the parent's release is
      // ownership-checked, so it will not delete the lock it handed over.
      // (`flowviant login` also proxies a child, but that parent never reached
      // the daemon and holds nothing — the child simply acquires.)
      if (holder.pid === process.ppid) {
        try {
          writeFileSync(path, record(repoRoot));
        } catch {
          return { ok: true, release: () => {}, unguarded: true };
        }
        return { ok: true, release: makeRelease(path) };
      }
      // THE RULE. Same repo -> this run replaces it; different repo -> refuse
      // and signal nothing, unless --takeover says otherwise. See the header.
      const here = samePath(holder.repoRoot, repoRoot);
      const wanted = force || (here && !noTakeover);
      if (wanted) {
        const bad = takeOverFrom(holder, path, log, { allowDowngrade });
        if (bad)
          return { ok: false, holder, takeoverFailed: bad.failed, sameRepo: here, unidentified: bad.unidentified };
        continue; // the file is gone — the next pass takes it
      }
      return { ok: false, holder, sameRepo: here };
    }
    try {
      writeSync(fd, record(repoRoot));
    } finally {
      closeSync(fd);
    }
    return { ok: true, release: makeRelease(path) };
  }
  // Both passes lost to something re-creating the file — assume a peer.
  return { ok: false, holder: readHolder(path) };
}

/** Release ONLY what we still own: a successor that adopted the lock (see the
 *  ppid branch) must not have it deleted out from under it when we exit. */
function makeRelease(path) {
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    const holder = readHolder(path);
    if (holder && holder.pid !== process.pid) return; // handed over — leave it
    try {
      rmSync(path, { force: true });
    } catch {
      /* best-effort; a stale file is cleared by the next acquire */
    }
  };
  // 'exit' covers the SIGINT/SIGTERM handlers too — both call process.exit().
  process.on('exit', release);
  return release;
}
