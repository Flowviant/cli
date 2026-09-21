/** Parsed configuration: env vars, CLI flags, and the chosen credentials. */

import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cpus, hostname, totalmem } from 'node:os';

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
// Since 0.55.0 the store holds MANY projects and resolution is BY REPO — see
// credentials.mjs for the whole rule. `CREDENTIAL` carries the resolution so
// cli.mjs can turn an ambiguity into a picker instead of a guess.
import { resolveStoredCredential } from './credentials.mjs';
export const CREDENTIAL = resolveStoredCredential();

function argFlag(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/**
 * THE SERVER'S API ROOT.
 *
 * `/api`, not `/api/v2`. The server collapsed its two prefixes into one
 * namespace on 2026-09-08 — they had held DISJOINT resources and neither was
 * ever a version of the other, so there was nothing to choose between.
 *
 * ── DEPLOY ORDER IS NOW LOAD-BEARING FOR THIS LINE ──
 *
 * A daemon on this version calls `/api/fleet/agents`. An older SERVER does not
 * serve that path, so publishing this release before the server that answers it
 * 404s the roster poll for anyone who updates. The order in the app repo's
 * ARCHITECTURE.md already says it and now it matters: deploy `flowviant-api`
 * FIRST, publish this SECOND. The same applies to a rollback — rolling the
 * server back past that merge strands every daemon at this version or newer.
 *
 * The other direction is safe and needs nothing: the server keeps `/api/v2` as
 * an alias onto the same router precisely because every daemon published before
 * this one has that string baked in and cannot be upgraded by a deploy. That
 * alias retires when the app's `DAEMON_MIN_VERSION` clears this release.
 */
const API_BASE = process.env.FLOWVIANT_API_URL || 'https://api.flowviant.com/api';
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
 * …AND SINCE 2026-09-17 THE APP MAY NAME A NUMBER TOO, which narrows that
 * sentence rather than reversing it. What stays true is that the DERIVATION
 * belongs here and that the enforcement is local: a ceiling that only exists as
 * a request is not one. What changed is that a person may now say "run two at
 * once" without going to the box, because the owner's answer to being stuck at
 * one was "it shouldnt be a variable on the npx to make it friendly for non
 * tech users. why cant it be on the web interface?". The precedence — env, then
 * the app's dial, then this derivation — lives in `pickMaxTurns`
 * (admission.mjs), and this value is what that falls back to.
 *
 * Sent to the server on every roster poll so it can pace what it offers UNDER
 * this ceiling, and ENFORCED LOCALLY BESIDES — a ceiling that only exists as a
 * request is not one, and the roster can always offer more than this.
 *
 * That second clause was FALSE for a month and this comment went on asserting
 * it (found 2026-09-14, after the daemon froze somebody's computer). The local
 * enforcement lived in the dispatch lane's claim path and was deleted with
 * dispatch on 2026-08-19; nothing replaced it, so every lane that spawns a CLI
 * — session turns with no slice at all, four agent turns a tick, the planner,
 * the cartographer — started whatever it was handed. It is true again:
 * `admission.mjs` counts the live CLI children across every lane and refuses a
 * new spawn at this number, deferring the job rather than settling it. A stale
 * comment describing a guard that is not there reads, to the next person,
 * exactly like a guard that holds — which is how this survived so long.
 *
 * AND IT BINDS WITHIN ONE TICK, which the first cut did not. Every lane loop is
 * synchronous while every spawn under it is not, so the child registry could
 * not grow between iterations and a single reconcile still admitted everything
 * it was offered against the count it started with — a ceiling that only bit on
 * the NEXT tick, after the box was already loaded. `admission.mjs` reserves the
 * slot at the decision; the reservation argument lives there.
 *
 * MEMORY is the bound, not cores. Cores oversubscribe gracefully (everything
 * gets slower); memory does not (something dies, and not necessarily the
 * offender).
 *
 * BOTH HALVES WERE RETUNED 2026-09-17, after the owner's box computed ONE and
 * he met it as "theres nothing telling me that i could only have one agent on
 * the board". The old numbers were `floor((memGB − 2) / 2)` and `cores − 1`,
 * and each was a guess this file had stopped examining:
 *
 *  · 2GB PER TURN assumed every turn drags a dev server and a test runner
 *    behind it. Most do not — an agent turn is a CLI that reads, edits and
 *    commits, and it is API-bound for nearly all of its life. 1GB per turn with
 *    the same 2GB held back for the operating system is the honest sizing, and
 *    the PRESSURE guard (resources.mjs) is what catches the turn that really
 *    does hold gigabytes: it measures at the moment of spawning, which is a
 *    thing a static divisor cannot do.
 *  · `cores − 1` is the laptop assumption this comment already claims to have
 *    retired, reborn one line down. The paragraph above says cores
 *    OVERSUBSCRIBE GRACEFULLY and memory is what does not — so cores must not
 *    be the half that binds first. On a 2-core VM `cores − 1` was 1, and that
 *    single subtraction is the whole reason the owner's machine serialized
 *    every agent. `cores * 2` lets the scheduler do what it is for, and memory
 *    stays the bound that actually refuses.
 *
 * `min(32, …)` and the env override are untouched: the hard 32 is a runaway
 * bound on a box, not a product decision, and an operator who typed a number at
 * the machine gets exactly that number.
 */
export function deriveMaxConcurrent(memBytes, cores) {
  const byMem = Math.floor(memBytes / 2 ** 30 - 2);
  const byCpu = Number(cores) * 2;
  return Math.max(1, Math.min(32, byMem, byCpu));
}

/**
 * WAS THE ENV VAR THE SOURCE? — the one fact the precedence rule cannot
 * reconstruct afterwards.
 *
 * `FLOWVIANT_MAX_CONCURRENT=4` and a box that happens to derive 4 produce the
 * identical number, and they are not the same statement: one is an operator's
 * last word and must outrank the app's dial, the other is a default the app may
 * override. See `pickMaxTurns` in admission.mjs for what is done with it.
 */
export const MAX_CONCURRENT_FROM_ENV = (() => {
  const asked = Number(process.env.FLOWVIANT_MAX_CONCURRENT);
  return Number.isFinite(asked) && asked >= 1;
})();

export const MAX_CONCURRENT = (() => {
  const asked = Number(process.env.FLOWVIANT_MAX_CONCURRENT);
  if (Number.isFinite(asked) && asked >= 1) return Math.min(Math.floor(asked), 32);
  return deriveMaxConcurrent(MACHINE.memBytes, MACHINE.cores);
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
// Sent on the daemon's own HTTP calls so Cloudflare Bot Fight Mode doesn't 403
// them (Node's default UA is treated as a bot). Claude Code sends its own UA.
export const USER_AGENT = `flowviant/${VERSION}`;

/**
 * WHICH DAEMON PROCESS this is — not which credential.
 *
 * Two daemons legitimately share one fleet token (that is exactly what
 * `machineDaemonsDisagree` reports, and the instance lock added in 0.51.2
 * cannot see a peer OLDER than itself). So the token cannot identify a lease
 * holder, and anything that must be done exactly once needs this instead.
 *
 * Regenerated every start, deliberately: a daemon that restarted is a daemon
 * that lost whatever it was holding, and a stale lease should not follow it
 * back. Sent on the poll as `di`; its ABSENCE is what an older daemon looks
 * like, and the server hands preview work to nobody who cannot name themselves.
 */
export const DAEMON_INSTANCE = randomBytes(12).toString('hex');

/**
 * WHICH BOX, in words a person recognises — and nothing else.
 *
 * Identity for arbitration is the env keypair's public key (`envpub`), which is
 * durable per box and already on every poll. This is the LABEL beside it: the
 * app has to be able to say "your machine is mac-mini" rather than "your machine
 * is a base64 string", and a box that cannot be named is the one thing a
 * standby daemon's whole sentence is about.
 *
 * Capped like every other bounded write that leaves this process — a query
 * string is not a log — and null rather than '' when the host has no name, so
 * the param is ABSENT and reads as an older daemon instead of as a box called
 * nothing.
 */
export const MACHINE_HOST = (() => {
  try {
    return String(hostname() || '').trim().slice(0, 64) || null;
  } catch {
    return null;
  }
})();

/**
 * WHEN THIS PROCESS STARTED (0.91.0), measured ONCE at import.
 *
 * It rides the poll as `st` beside `pid`, and together they are what somebody
 * who has lost track of their daemons actually needs: the owner, verbatim, "im
 * not sure if i have any duplicate or redundant daemons running". A pid alone
 * cannot tell one long-lived daemon from a process that has restarted nine
 * times since you last looked; a start time can.
 *
 * Derived from `process.uptime()` rather than stamped at import for its own
 * sake, so it stays true across a lazy import and reads as the process's own
 * age rather than this module's. Computed once, deliberately: a value that
 * drifts by a millisecond every poll would rewrite the column for ever.
 */
export const PROCESS_STARTED_AT = new Date(
  Date.now() - Math.max(0, process.uptime() * 1000)
).toISOString();

// The ONE credential. `tokens` (FLOWVIANT_TOKEN / FLOWVIANT_TOKENS / --token /
// --tokens) stood beside it and carried WORKER tokens into the pre-daemon loop;
// that principal owns zero tools since dispatch was deleted, and the kind can no
// longer be minted, so the plumbing went with the entrypoint (2026-08-19).
// `let`, because ES named imports are LIVE bindings: when cli.mjs answers an
// ambiguous store with a picker, adoptStoredCredential updates every importer
// before the daemon touches the network. Everything before that point (the
// resolution, the flags) is settled synchronously at import, as it always was.
export let FLEET_TOKEN =
  argFlag('--fleet') || process.env.FLOWVIANT_FLEET || CREDENTIAL.entry?.fleetToken || '';

/**
 * WHICH PROJECT THIS DAEMON SERVES, or null when nothing on this box names one.
 *
 * ADDED 2026-09-21 for one consumer: it SALTS the env report's value
 * fingerprints (`env.mjs`), so an eight-character hash over `production` or
 * `3000` stops being a dictionary lookup anybody with the stored report can
 * perform. The whole comparison is between the boxes of ONE project, so a
 * per-project salt costs the feature nothing.
 *
 * NULL IS A REAL ANSWER AND IS NOT PAPERED OVER. A credential handed in through
 * `FLOWVIANT_FLEET` or `--fleet` names no project until the roster does, and the
 * consumer's rule is that a box which cannot name its project reports NO env
 * files rather than fingerprints salted with something else — incomparable
 * hashes would render as a confident "these boxes differ" beside a box holding
 * the identical value. Ignorance renders nothing.
 *
 * `let`, for the same reason `FLEET_TOKEN` is: when cli.mjs answers an
 * ambiguous store with a picker, `adoptStoredCredential` is what settles both,
 * and ES named imports are LIVE bindings so every importer sees the answer.
 * A frozen copy read at import would salt a picked project's report with null
 * and report nothing at all, for the whole life of the process.
 */
export let PROJECT_ID = CREDENTIAL.entry?.projectId ?? null;

/** cli.mjs's picker chose. Must run BEFORE runFleetDaemon — nothing here
 *  re-authenticates a connection already made. */
export function adoptStoredCredential(entry) {
  if (entry?.fleetToken) FLEET_TOKEN = entry.fleetToken;
  // The project id travels WITH the token, always. They are one answer, and a
  // picker that updated only the credential left the fingerprint salt null on
  // exactly the boxes that had to be asked which project they serve.
  if (entry?.projectId) PROJECT_ID = entry.projectId;
}
