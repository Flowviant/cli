/** Parsed configuration: env vars, CLI flags, and the chosen credentials. */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, cpus, totalmem } from 'node:os';

// Read the daemon's version from its OWN package.json (always shipped in the npm
// tarball) — never hardcode it. The hardcoded constant drifted: it sat at
// '0.28.0' across every release through 0.28.6, so the startup banner, the
// User-Agent the server version-gates on, and the self-update check all reported
// a stale version (and the "update available" nag never cleared).
export const VERSION = (() => {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json');
    return JSON.parse(readFileSync(pkgPath, 'utf8')).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

// The model EVERY daemon Claude turn runs on — pinned so autonomous work never
// inherits your interactive `~/.claude/settings.json` default. That matters: a
// default of `opus[1m]` puts big prompts (wiki-gen over a whole repo, >200K
// tokens) onto the 1M long-context premium tier, which a Max plan does NOT cover
// — the turn dies with "usage credits required for this model". Standard `opus`
// is fully covered. Override with FLOWVIANT_MODEL (e.g. `sonnet` for cheaper/faster).
export const MODEL = process.env.FLOWVIANT_MODEL || 'opus';

// Credential stored by `flowviant login` (device auth) — the no-token,
// no-env-var path. An explicit --fleet flag or FLOWVIANT_FLEET env still wins.
function readStoredCredential() {
  try {
    return JSON.parse(readFileSync(join(homedir(), '.flowviant', 'credentials.json'), 'utf8'));
  } catch {
    return null;
  }
}
const stored = readStoredCredential();

function argFlag(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** A bare boolean flag (no value follows it). */
function hasFlag(name) {
  return process.argv.includes(name);
}

const API_BASE = process.env.FLOWVIANT_API_URL || 'https://api.flowviant.com/api/v2';
export const MCP_URL = process.env.FLOWVIANT_MCP_URL || `${API_BASE}/mcp`;
export const FLEET_URL = process.env.FLOWVIANT_FLEET_URL || `${API_BASE}/fleet/agents`;
// Push channel: the daemon holds this WebSocket open and the server nudges it
// the instant a job lands, so dispatch is ~a round-trip instead of a full poll.
// Derived from FLEET_URL (…/fleet/agents → …/fleet/stream, http→ws) unless set.
export const STREAM_URL =
  process.env.FLOWVIANT_STREAM_URL ||
  FLEET_URL.replace(/\/agents(\/?)$/, '/stream$1').replace(/^http/, 'ws');
export const POLL_SECONDS = Number(process.env.POLL_SECONDS || 20);

/**
 * What this machine can actually be given, read from the machine.
 *
 * `os.totalmem()` and `cpus().length` report the HOST inside a container: a
 * 4GB container on a 256GB box reads 256GB and cheerfully oversubscribes until
 * the OOM killer picks a victim — which, because it picks by resident size, is
 * frequently not the task that caused it. cgroup v2 publishes the real limits,
 * so read those first and treat the os module as the fallback it is.
 */
function machineLimits() {
  const readCgroup = (f) => {
    try {
      return readFileSync(`/sys/fs/cgroup/${f}`, 'utf8').trim();
    } catch {
      return null;
    }
  };
  let memBytes = totalmem();
  const memMax = readCgroup('memory.max');
  if (memMax && memMax !== 'max') {
    const n = Number(memMax);
    if (Number.isFinite(n) && n > 0) memBytes = Math.min(memBytes, n);
  }
  let cores = cpus().length || 2;
  // "<quota> <period>" in microseconds, or "max <period>" for unlimited.
  const cpuMax = readCgroup('cpu.max');
  if (cpuMax && !cpuMax.startsWith('max')) {
    const [q, p] = cpuMax.split(/\s+/).map(Number);
    if (Number.isFinite(q) && Number.isFinite(p) && p > 0) {
      cores = Math.max(1, Math.min(cores, Math.floor(q / p)));
    }
  }
  return { memBytes, cores };
}

export const MACHINE = machineLimits();

/**
 * How many tasks THIS MACHINE will build at once.
 *
 * The limit belongs here, not on the server: a task in flight is a Claude Code
 * session plus its own git worktree plus whatever the project's dev server and
 * tests want, and this process is the only party that can see the cores, the
 * RAM and the fan.
 *
 * Sent to the server on every roster poll so it can grow lanes to meet waiting
 * work UNDER this ceiling, and enforced locally besides — the roster can carry
 * more lanes than this, and a ceiling that only exists as a request is not one.
 *
 * MEMORY is the bound, not cores. Cores oversubscribe gracefully (everything
 * gets slower); memory does not (something dies, and not necessarily the
 * offender). A task is a Claude session plus a dev server plus whatever the
 * test runner spawns — call it 2GB, keep 2GB back for the operating system,
 * and let cores cap it only when they are the scarcer thing.
 *
 * This used to be `min(4, cores/2)` — half the cores because "the user is
 * working on this machine too", and a hard 4 because a personal Claude plan
 * ran out before the CPU did. Both were laptop assumptions. The machine is now
 * a box the project leaves running, so it reserves one core rather than half of
 * them, and the ceiling is what the hardware can hold rather than a guess about
 * somebody's plan.
 */
export const MAX_CONCURRENT = (() => {
  const asked = Number(process.env.FLOWVIANT_MAX_CONCURRENT);
  if (Number.isFinite(asked) && asked >= 1) return Math.min(Math.floor(asked), 32);
  const byMem = Math.floor((MACHINE.memBytes / 2 ** 30 - 2) / 2);
  const byCpu = MACHINE.cores - 1;
  return Math.max(1, Math.min(32, byMem, byCpu));
})();
export const IDLE_SECONDS = Number(process.env.IDLE_SECONDS || 30);
// Live mode: after this long idle-parked on a blocker, tear the session down to
// free the Claude process (the intent stays claimed; it resumes when answered).
export const PARK_TIMEOUT_SECONDS = Number(process.env.PARK_TIMEOUT_SECONDS || 900);
export const RECONCILE_SECONDS = Number(process.env.RECONCILE_SECONDS || 10);
// Proactively refresh a worker token this many seconds before its lease lapses,
// so a long-lived daemon never silently 401s on an expired token.
export const REFRESH_BEFORE_SECONDS = Number(process.env.REFRESH_BEFORE_SECONDS || 3600);
export const SAFE = process.env.FLOWVIANT_SAFE === '1';
// Self-update: a running daemon updates itself to the latest published version
// (at startup + when idle) and re-execs. On by default; FLOWVIANT_NO_UPDATE=1
// keeps it nag-only (it still tells you to update, never installs). Below the
// server's MIN version it updates regardless, since live mode won't work.
export const AUTO_UPDATE = process.env.FLOWVIANT_NO_UPDATE !== '1';
// Live mode (DEFAULT since 0.8.0): persistent Agent-SDK session per task —
// streams into the task channel, injectable mid-task, blocker-parks in place,
// delivery card on complete, branch preview tunnels. The legacy poll/sentinel
// path (one-shot `claude -p` turns) survives behind FLOWVIANT_POLL=1 as the
// escape hatch; FLOWVIANT_LIVE=1 is still honored for old scripts.
export const LIVE = process.env.FLOWVIANT_POLL !== '1';
/**
 * Does this machine accept PATCHES — commits cherry-picked straight into your
 * working checkout, with no PR and no review?
 *
 * Patch placement is chosen by a model, and any teammate who @mentions one of
 * your agents can trigger it, so whether it happens at all belongs to whoever
 * owns the checkout. Turning it off does not lose the work: the task falls back
 * to branch placement and arrives as a PR like anything else.
 *
 * On by default — the guard that actually protects you (never touching a file
 * you have uncommitted edits in) is enforced at apply time, and the whole point
 * of patches is to spare you a review cycle for a nine-character diff.
 * `--no-patches` or FLOWVIANT_PATCHES=0 to refuse them.
 */
export const ALLOW_PATCHES =
  !hasFlag('--no-patches') && process.env.FLOWVIANT_PATCHES !== '0';
// Sent on the daemon's own HTTP calls so Cloudflare Bot Fight Mode doesn't 403
// them (Node's default UA is treated as a bot). Claude Code sends its own UA.
export const USER_AGENT = `flowviant/${VERSION}`;

// The ONE credential. `tokens` (FLOWVIANT_TOKEN / FLOWVIANT_TOKENS / --token /
// --tokens) stood beside it and carried WORKER tokens into the pre-daemon loop;
// that principal owns zero tools since dispatch was deleted, and the kind can no
// longer be minted, so the plumbing went with the entrypoint (2026-08-19).
export const FLEET_TOKEN =
  argFlag('--fleet') || process.env.FLOWVIANT_FLEET || stored?.fleetToken || '';
