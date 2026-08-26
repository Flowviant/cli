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
 */

import { execFileSync } from 'node:child_process';
import { createConnection } from 'node:net';
import { readFileSync, readdirSync, readlinkSync, realpathSync } from 'node:fs';
import { platform } from 'node:os';
import { sep } from 'node:path';

/** A box with more processes than this is not one we walk per sweep. The scan
 *  is one readlink per pid and runs every reconcile; this is the runaway
 *  bound, not a capacity statement. */
const MAX_PIDS = 4000;
/** Rows reported per session. A dev server, its HMR socket and an API is three;
 *  twenty is somebody's docker-compose and the extra rows say nothing. */
const MAX_ROWS = 8;
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
      found.set(hit.port, { port: hit.port, bind: hit.bind, label: labelFor(pid) });
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
        if (!out.has(row.port)) out.set(row.port, { ...row, label: null });
      }
    }
  }
  return [...out.values()];
}

// ── public ─────────────────────────────────────────────────────────────────

/**
 * Every TCP port in LISTEN held by a process whose cwd is inside `worktree`.
 * Smallest port first, capped. An empty array on an unsupported platform means
 * "we did not look" — callers must not turn it into "nothing is running".
 */
export function listenersIn(worktree) {
  if (!worktree) return [];
  let rows;
  try {
    rows = platform() === 'linux' ? scanLinux(worktree) : platform() === 'darwin' ? scanDarwin(worktree) : [];
  } catch {
    return [];
  }
  return rows.sort((a, b) => a.port - b.port).slice(0, MAX_ROWS);
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
