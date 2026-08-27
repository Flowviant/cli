/**
 * What is LISTENING inside a session's worktree.
 *
 * The Workbench preview never starts an app. The driver runs their own dev
 * server in their own tab, exactly as they would in a terminal, and this file
 * is how the machine NOTICES — a browser has no `ss -ltnp` to run, so the
 * daemon runs it. That direction is the whole design: a control that can only
 * exist once the machine has measured the thing it acts on cannot invent a
 * state, cannot guess a port, and cannot time out waiting for a cold start.
 *
 * A listener is attributed to a session by the CWD OF THE PROCESS HOLDING THE
 * SOCKET, never by the port number. Ports are global to the box; a worktree is
 * not. Without that attribution `share_preview(5432)` tunnels Postgres and
 * `share_preview(<a teammate's port>)` publishes somebody else's worktree — so
 * this measurement is a security control, not a convenience, and it is why the
 * MCP tool must not ship before it.
 *
 * Deliberately NOT a probe: nothing here connects to the port, sends bytes, or
 * asks what is on the other end. It reads the kernel's own socket table. A
 * daemon that spoke to whatever the driver happened to be running would be a
 * second actor in their session.
 *
 * Linux (including WSL2) reads /proc. macOS shells out to lsof twice. Windows
 * reports NOTHING and says so through the empty array — the same answer
 * `stillOurs` gives, and the same rule the rest of the product keeps: an
 * unmeasured thing renders nothing rather than rendering "none".
 *
 * CHOSEN vs KERNEL-ASSIGNED, and why this is a measurement rather than a guess.
 * `wrangler dev` opens NINE listening sockets; exactly one of them is the URL a
 * person opens. The other eight were opened on port 0 and given whatever the
 * kernel had free, and nobody will ever type one into a browser. The box itself
 * says where that range is (`/proc/sys/net/ipv4/ip_local_port_range`, or
 * `sysctl net.inet.ip.portrange.*`), so "was this port CHOSEN" is a fact we can
 * read rather than a heuristic about anybody's stack — the same character as
 * `bind`, and it needs no allowlist, no framework detection and no probe.
 *
 * IT IS THE ONE DISCRIMINATOR A PROBE COULD NOT PROVIDE. Connecting to each
 * port and keeping the ones that answer HTTP is the obvious alternative and it
 * is WRONG, not merely rude: under `wrangler dev` the app's internal entry
 * socket returns byte-for-byte what the dev URL returns, because the dev URL
 * proxies straight to it. A probe promotes the wrong port. The free fact beats
 * the expensive one on accuracy.
 *
 * WHAT THE ROW MAY CARRY, and the line that must not be crossed. `pid` and
 * `rss` are numbers about a process; the LABEL is still only the basenames of
 * argv[0] and argv[1], and argv[1] is skipped outright when it starts with `-`.
 * That is why no row here is ever passed through `envScrub`: it cannot carry a
 * secret, by construction rather than by filtering. Widening the label to "the
 * first argument that is not a flag" would break exactly that — it reads a
 * flag's VALUE, so `node --require hunter2 app.js` would relay `hunter2`. Do
 * not widen it. Add fields that are numbers; never add argv.
 */

import { execFileSync } from 'node:child_process';
import { createConnection } from 'node:net';
import { readFileSync, readdirSync, readlinkSync, realpathSync } from 'node:fs';
import { platform } from 'node:os';
import { rssBytes } from './processes.mjs';
import { sep } from 'node:path';

/** A box with more processes than this is not one we walk per sweep. The scan
 *  is one readlink per pid and runs every reconcile; this is the runaway
 *  bound, not a capacity statement. */
const MAX_PIDS = 4000;
/**
 * Rows reported per session.
 *
 * It was 8, and `wrangler dev` alone opens NINE — so the cap was silently
 * eating a row on an ordinary stack while the wire carried no flag saying it
 * had. Both halves of that are fixed: the number is 12, and `measureListeners`
 * reports the TOTAL so a surface can say it is not showing everything.
 *
 * The cap is also no longer allowed to eat the row that matters. Sorting was by
 * port ascending, which is arbitrary with respect to importance — a dev server
 * on :8080 beside eight kernel-assigned sockets in the 30000s survives by luck,
 * and one on :9000 would not. CHOSEN ports sort first now, so the cut falls on
 * the ephemeral tail, which is the half nobody opens.
 */
const MAX_ROWS = 12;
/** Longest process label we relay. */
const MAX_LABEL = 40;

// ── /proc/net/tcp parsing (linux) ──────────────────────────────────────────

// local_address is "<hex addr>:<hex port>". The address is little-endian per
// 4-byte word; the PORT is big-endian. Only the port and the coarse bind scope
// are worth relaying — a browser cannot reach a loopback bind through a tunnel
// any differently than an any-bind, but the operator can read the difference.
function parseLocal(hex) {
  const [addr, port] = String(hex).split(':');
  if (!addr || !port) return null;
  const p = parseInt(port, 16);
  if (!Number.isInteger(p) || p <= 0 || p > 65535) return null;
  const zeros = /^0+$/.test(addr);
  const v4Loopback = addr.toUpperCase() === '0100007F';
  // ::1 in /proc/net/tcp6 is 24 zeros then 01000000 (little-endian per word).
  const v6Loopback = addr.toUpperCase() === '00000000000000000000000001000000';
  return { port: p, bind: zeros ? 'any' : v4Loopback || v6Loopback ? 'loopback' : 'other' };
}

/** inode -> { port, bind } for every socket in LISTEN state. */
function listeningByInode() {
  const out = new Map();
  for (const f of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let text;
    try {
      text = readFileSync(f, 'utf8');
    } catch {
      continue; // no ipv6 stack, or not linux
    }
    for (const line of text.split('\n').slice(1)) {
      const c = line.trim().split(/\s+/);
      if (c.length < 10) continue;
      if (c[3] !== '0A') continue; // TCP_LISTEN
      const local = parseLocal(c[1]);
      if (!local) continue;
      const inode = c[9];
      if (inode && inode !== '0') out.set(inode, local);
    }
  }
  return out;
}

/**
 * WHAT TO CALL A LISTENING PROCESS.
 *
 * This used to be `basename(argv[0])`, which names the RUNTIME and not the
 * program — so half the rows in a JavaScript repo read `node` and told the
 * reader nothing about which of their servers this was. The question that
 * changed it: "a non developer wouldnt know what node is or workerd."
 *
 * THE FIX IS NOT A LOOKUP TABLE. Mapping `workerd` → "Cloudflare Worker" is
 * the `DEV_ARGV0` shape: a hardcoded list of tools that is wrong for every
 * stack nobody enumerated, needing a release per ecosystem forever. What is
 * always available instead is argv[1] — the thing the runtime was asked to
 * run — so `node …/node_modules/.bin/vite` becomes `node vite` and
 * `node server.js` becomes `node server.js`. No list, works on every stack.
 *
 * A FLAG IS SKIPPED rather than guessed past: `python3 -m http.server` keeps
 * `python3` instead of claiming to be called `-m`. Only the first two argv
 * elements are ever read — enough to name the program, far short of the whole
 * command line, which is the thing this deliberately does not relay.
 *
 * And this is still only a MEASUREMENT. The name a person gives a share lives
 * on `session_previews.label`, is written by a human PATCH, and is what a
 * teammate actually reads — no amount of argv produces "Storefront".
 */
export function labelFromArgv(argv) {
  const base = (v) => (v || '').split('/').pop() || v || '';
  const head = base(argv?.[0]);
  if (!head) return null;
  // argv[1] only when it NAMES something rather than configuring it. A `-`
  // prefix is the one universally reliable tell, and skipping is the honest
  // answer — `python3 -m http.server` keeps `python3` rather than claiming to
  // be called `-m`.
  const next = argv?.[1] && !argv[1].startsWith('-') ? base(argv[1]) : '';
  const label = next && next !== head ? `${head} ${next}` : head;
  return label.slice(0, MAX_LABEL) || null;
}

/**
 * THE KERNEL'S OWN EPHEMERAL PORT RANGE, or null where we cannot read it.
 *
 * A socket opened on port 0 is given a port out of this range; a port outside
 * it was named by a person or their config. That is the whole of the CHOSEN
 * test, and the reason it is honest: the range is READ FROM THIS BOX, never
 * assumed. Linux's default is 32768-60999 and macOS's is 49152-65535, and both
 * are tunable — hardcoding either would turn a measurement into a guess that is
 * wrong on exactly the machines somebody bothered to tune.
 *
 * THREE STATES, as everywhere else here: `undefined` before we look, `null` for
 * "this box would not say" (which must leave `chosen` OFF every row rather than
 * defaulting it), and a pair once measured. Cached for the life of the process
 * because the range does not move under a running kernel.
 */
let EPHEMERAL;
function ephemeralRange() {
  if (EPHEMERAL !== undefined) return EPHEMERAL;
  EPHEMERAL = null;
  try {
    if (platform() === 'linux') {
      const [lo, hi] = readFileSync('/proc/sys/net/ipv4/ip_local_port_range', 'utf8')
        .trim()
        .split(/\s+/)
        .map(Number);
      if (Number.isInteger(lo) && Number.isInteger(hi) && lo > 0 && hi >= lo) EPHEMERAL = [lo, hi];
    } else if (platform() === 'darwin') {
      const one = (k) =>
        Number(
          execFileSync('sysctl', ['-n', k], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
            timeout: 3000,
          }).trim()
        );
      const lo = one('net.inet.ip.portrange.first');
      const hi = one('net.inet.ip.portrange.last');
      if (Number.isInteger(lo) && Number.isInteger(hi) && lo > 0 && hi >= lo) EPHEMERAL = [lo, hi];
    }
  } catch {
    /* unreadable — stays null, and `chosen` is then absent rather than guessed */
  }
  return EPHEMERAL;
}

/**
 * True/false once the range is known, `undefined` when it is not — so the
 * caller can omit the key entirely rather than assert a default.
 *
 * Split from the cached reader so the RULE is testable without a kernel: the
 * three-state answer is the part worth pinning, and it is the part a later
 * refactor is most likely to flatten into a boolean.
 */
export function isChosenPort(port, range) {
  if (!range) return undefined;
  return port < range[0] || port > range[1];
}

function chosenPort(port) {
  return isChosenPort(port, ephemeralRange());
}

function labelFor(pid) {
  try {
    const raw = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    return labelFromArgv(raw.split('\0').filter(Boolean));
  } catch {
    return null;
  }
}

function scanLinux(worktree) {
  const inodes = listeningByInode();
  if (inodes.size === 0) return [];

  let root;
  try {
    root = realpathSync(worktree);
  } catch {
    return []; // the directory is gone — retired under us
  }
  const prefix = root.endsWith(sep) ? root : root + sep;
  const inside = (p) => p === root || p.startsWith(prefix);

  let pids;
  try {
    pids = readdirSync('/proc').filter((d) => /^\d+$/.test(d));
  } catch {
    return [];
  }
  if (pids.length > MAX_PIDS) pids = pids.slice(0, MAX_PIDS);

  const found = new Map(); // port -> row
  for (const pid of pids) {
    // Cheap filter FIRST: one readlink rejects almost every process on the box,
    // and only survivors pay for a readdir of their fd table.
    let cwd;
    try {
      cwd = readlinkSync(`/proc/${pid}/cwd`);
    } catch {
      continue; // not ours, or gone
    }
    if (!inside(cwd)) continue;

    let fds;
    try {
      fds = readdirSync(`/proc/${pid}/fd`);
    } catch {
      continue;
    }
    for (const fd of fds) {
      let link;
      try {
        link = readlinkSync(`/proc/${pid}/fd/${fd}`);
      } catch {
        continue;
      }
      const m = /^socket:\[(\d+)\]$/.exec(link);
      if (!m) continue;
      const hit = inodes.get(m[1]);
      if (!hit) continue;
      if (found.has(hit.port)) continue;
      const chosen = chosenPort(hit.port);
      const rss = rssBytes(pid);
      found.set(hit.port, {
        port: hit.port,
        bind: hit.bind,
        label: labelFor(pid),
        // The pid was always in hand here — it is what resolves the cwd — and
        // was thrown away the moment the row was built. Keeping it is what lets
        // a surface group nine sockets under the ONE program that opened them,
        // and it is the only thing a kill could ever be aimed at.
        pid: Number(pid),
        ...(rss != null ? { rss } : {}),
        ...(chosen === undefined ? {} : { chosen }),
      });
    }
  }
  return [...found.values()];
}

// ── macOS ──────────────────────────────────────────────────────────────────

function lsof(args) {
  try {
    return execFileSync('lsof', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch {
    return ''; // lsof absent or nothing matched — both are "no measurement"
  }
}

function scanDarwin(worktree) {
  // Pass 1: every listening socket, as pid → ports.
  const byPid = new Map();
  let pid = null;
  // RSS for every pid on the box, in one call. `lsof` cannot report memory and
  // a per-pid `ps` would be one fork per row; this is one fork per sweep.
  const rssByPid = new Map();
  try {
    for (const line of execFileSync('ps', ['-axo', 'pid=,rss='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
      maxBuffer: 4 * 1024 * 1024,
    }).split('\n')) {
      const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
      if (m) rssByPid.set(m[1], Number(m[2]) * 1024); // ps reports KB
    }
  } catch {
    /* no memory on this box — rows simply carry no rss */
  }
  for (const line of lsof(['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pn']).split('\n')) {
    if (line.startsWith('p')) pid = line.slice(1);
    else if (line.startsWith('n') && pid) {
      const m = /:(\d+)$/.exec(line.slice(1));
      if (!m) continue;
      const p = Number(m[1]);
      const bind = /^n\*:/.test(line) ? 'any' : /^n(127\.0\.0\.1|\[::1\])/.test(line) ? 'loopback' : 'other';
      if (!byPid.has(pid)) byPid.set(pid, []);
      byPid.get(pid).push({ port: p, bind });
    }
  }
  if (byPid.size === 0) return [];

  let root;
  try {
    root = realpathSync(worktree);
  } catch {
    return [];
  }
  const prefix = root.endsWith(sep) ? root : root + sep;

  // Pass 2: the cwd of exactly those pids, in ONE batched call.
  const out = new Map();
  let cur = null;
  for (const line of lsof(['-a', '-d', 'cwd', '-F', 'pn', '-p', [...byPid.keys()].join(',')]).split('\n')) {
    if (line.startsWith('p')) cur = line.slice(1);
    else if (line.startsWith('n') && cur) {
      const cwd = line.slice(1);
      if (cwd !== root && !cwd.startsWith(prefix)) continue;
      for (const row of byPid.get(cur) || []) {
        if (out.has(row.port)) continue;
        const chosen = chosenPort(row.port);
        out.set(row.port, {
          ...row,
          // Still null on darwin: `lsof -F pn` is asked for name and pid, never
          // a command, and adding `-F c` would relay a command name we have no
          // scrub for. The CHOSEN test needs no label, which is the other
          // reason it is the right discriminator — it is the only one that
          // works identically on a Mac.
          label: null,
          pid: Number(cur),
          ...(rssByPid.has(cur) ? { rss: rssByPid.get(cur) } : {}),
          ...(chosen === undefined ? {} : { chosen }),
        });
      }
    }
  }
  return [...out.values()];
}

// ── public ─────────────────────────────────────────────────────────────────

/**
 * ORDER, and why it is not the port number any more.
 *
 * CHOSEN ports first, each group by port ascending. Two reasons, and the second
 * is the load-bearing one:
 *
 *  · A person scanning this list is looking for the URL they are about to open,
 *    and that is always a port somebody named. The seven sockets `wrangler dev`
 *    was handed by the kernel are not candidates and should not be read past.
 *  · The list is CAPPED. Ordering by port number let the cap fall wherever the
 *    numbers happened to land, so a dev server on a high port could be the row
 *    that got dropped. Sorting by chosen-ness puts the cut on the tail nobody
 *    opens.
 *
 * Where the range could not be read `chosen` is absent on every row, `Number()`
 * of undefined is NaN, and the comparison is false both ways — so the order
 * degrades to the old port sort rather than to something arbitrary.
 */
export function byChosenThenPort(a, b) {
  const ac = a.chosen === true ? 0 : 1;
  const bc = b.chosen === true ? 0 : 1;
  return ac !== bc ? ac - bc : a.port - b.port;
}

/**
 * Every TCP port in LISTEN held by a process whose cwd is inside `worktree`,
 * with the TOTAL the cap was applied to.
 *
 * The total is the whole point of the pair. A list silently cut at twelve
 * answers "what is running in here" with a number that is not true, and the
 * Repository block already settled that trade for branches and worktrees: the
 * capped list rides beside the count it was cut from. An empty array on an
 * unsupported platform means "we did not look" — callers must not turn it into
 * "nothing is running".
 */
export function measureListeners(worktree) {
  if (!worktree) return { rows: [], total: 0 };
  let rows;
  try {
    rows = platform() === 'linux' ? scanLinux(worktree) : platform() === 'darwin' ? scanDarwin(worktree) : [];
  } catch {
    return { rows: [], total: 0 };
  }
  return { rows: rows.sort(byChosenThenPort).slice(0, MAX_ROWS), total: rows.length };
}

/** The capped rows alone, for callers with nowhere to put a total. */
export function listenersIn(worktree) {
  return measureListeners(worktree).rows;
}

/** Does this platform measure listeners at all? The web must render no preview
 *  affordance where the answer is no, rather than an empty one. */
export function listenersSupported() {
  return platform() === 'linux' || platform() === 'darwin';
}

/**
 * Is something accepting connections on this loopback port RIGHT NOW?
 *
 * Used at two moments, both of them re-validation rather than discovery: the
 * daemon re-checks a port the server told it to share, and a live share checks
 * that its origin has not died under the tunnel. cloudflared happily outlives a
 * dead dev server and the gate answers a dead origin with 502, so without this
 * the product would print "live" over a 502 — which is Flowviant asserting a
 * state it never measured.
 *
 * A TCP connect and an immediate close: no bytes sent, nothing read.
 */
export function isListening(port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return resolve(false);
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      try {
        sock.destroy();
      } catch {
        /* already gone */
      }
      resolve(v);
    };
    const sock = createConnection({ port, host: '127.0.0.1' });
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
  });
}
