/**
 * HOW CLOSE EACH CLI'S PLAN IS TO ITS LIMIT, IN THE VENDOR'S OWN NUMBERS
 * (2026-09-28, 0.109.0) — a per-process cache of what the CLIs said about
 * their plan windows, relayed on the roster poll as `rtl`.
 *
 * THE OWNER'S CARVE-OUT, stated once here because every reader leans on it:
 * "show activity, never capacity" still stands for Flowviant's own bounds. A
 * plan window is not Flowviant's capacity — it is the VENDOR measuring its own
 * plan, and this file only carries that measurement to Project settings ›
 * Machines, where it reads as "used", never "left" or "free". Nothing here
 * decides, gates, parks or schedules anything off these numbers.
 *
 * TWO SOURCES, ONE SHAPE:
 *
 *  · CLAUDE CODE says it on the stream. Every `-p --output-format stream-json`
 *    turn carries a `rate_limit_event` BEFORE its `result` line, and the
 *    daemon used to drop it. MEASURED on Claude Code 2.1.283, 2026-09-28
 *    (`claude -p "say hi" --model haiku --output-format stream-json
 *    --verbose`): it fires on an ordinary turn (status `allowed` at 3%), not
 *    only near a threshold; `utilization` is a 0–1 FRACTION (hence
 *    CLAUDE_UTILIZATION_SCALE = 100 — one constant, no crossover heuristic);
 *    `resetsAt` is epoch SECONDS; `unifiedWindows` names `five_hour` and
 *    `seven_day`. claudeStream.mjs hands the event's `rate_limit_info` here.
 *  · CODEX says it in a file. `codex exec --json` (0.156.1) puts no limits on
 *    stdout; its rollout `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<thread>
 *    .jsonl` (folder = the LOCAL date the thread STARTED; a resumed thread
 *    appends to its original file) carries `event_msg` → `token_count`
 *    payloads with `rate_limits: {primary, secondary, plan_type, …}`. After a
 *    codex turn closes, runTurn.mjs asks `learnCodexLimits` to read the tail.
 *
 * THREE STATES, the way every machine report here keeps them: null = nothing
 * learned (the param is not sent), a measured value, and — inside a window —
 * null for a number the CLI did not give. An absent or garbage percentage is
 * NULL, never 0: "0% used" is a claim, and nobody measured it.
 *
 * THE BOUNDS are the app's (`packages/shared/src/schemas/runtimeLimits.ts`
 * exports the same four names and values; `scripts/check-app-parity.mjs`
 * rule 7 holds them equal): the server re-applies them, so a looser copy here
 * would only have a report dropped at the boundary.
 */

import { readdir, open, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isoFromStamp } from './isoStamp.mjs';
import { claudeAuthContext } from './claudeAuth.mjs';
import { detectRuntimes } from './runtimeDetection.mjs';
import { CODEX_THREAD_RE } from './workSessionRuntime.mjs';

/** Claude's `utilization` is a fraction (0.03 = 3%) — MEASURED, see above. */
export const CLAUDE_UTILIZATION_SCALE = 100;
/** The whole `rtl` param, as JSON bytes. */
export const RUNTIME_LIMITS_PARAM_MAX = 2000;
/** Windows per CLI entry. */
export const RUNTIME_LIMIT_WINDOWS_MAX = 6;
/** A window id's length (`five_hour`, `seven_day`, `m1440`). */
export const RUNTIME_LIMIT_ID_MAX = 40;
/** A plan slug's length (`max`, `pro`, `prolite`). */
export const RUNTIME_LIMIT_PLAN_MAX = 32;

const WINDOW_ID = new RegExp(`^[a-z0-9_]{1,${RUNTIME_LIMIT_ID_MAX}}$`);
const PLAN_SLUG = new RegExp(`^[A-Za-z0-9_-]{1,${RUNTIME_LIMIT_PLAN_MAX}}$`);
const CLAUDE_STATUSES = new Set(['allowed', 'allowed_warning', 'rejected']);
/** The two windows Claude names whose length is known; any other is null. */
const CLAUDE_WINDOW_MINUTES = { five_hour: 300, seven_day: 10080 };
/** A percentage outside this is garbage, not a reading. */
const PCT_MAX = 1000;
/** The rollout's tail — the last token_count sits near the end of a file
 *  that grows to many megabytes over a long thread. */
const ROLLOUT_TAIL_BYTES = 256 * 1024;
/** Day directories walked for a rollout, newest first. */
const ROLLOUT_DAYS_MAX = 62;
const PLAN_TTL_MS = 60_000;

const iso = (ms) => new Date(ms).toISOString();

/** A percentage to one decimal, or null — never 0 for "not said". */
function pctOf(v, scale = 1) {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  const pct = Math.round(n * scale * 10) / 10;
  return pct <= PCT_MAX ? pct : null;
}

const planOf = (v) => (typeof v === 'string' && PLAN_SLUG.test(v) ? v : null);

/** Per CLI: `{ status, at (ms), plan?, windows: Map<id, window> }`, or null. */
let claudeState = null;
let codexState = null;

/** Keep a window map to the bound, dropping the oldest reading first. */
function capWindows(windows) {
  while (windows.size > RUNTIME_LIMIT_WINDOWS_MAX) {
    let oldest = null;
    for (const w of windows.values()) if (!oldest || w.at < oldest.at) oldest = w;
    windows.delete(oldest.id);
  }
}

/**
 * RECORD WHAT CLAUDE CODE'S `rate_limit_event` SAID.
 *
 * `unifiedWindows` names every window the plan has, each with its own
 * utilization and reset; an older CLI that sends only the single
 * `rateLimitType` window (with whatever `utilization`/`resetsAt` ride beside
 * it) is read as that one window. Windows MERGE by id, each with its own `at`:
 * an event that speaks about one window never erases what an earlier event
 * said about another. The status is the latest event's.
 */
export function recordClaudeRateLimit(info, now = Date.now()) {
  if (!info || typeof info !== 'object' || Array.isArray(info)) return;
  const at = iso(now);
  const state = (claudeState ??= { status: null, at: null, windows: new Map() });
  const put = (id, utilization, resetsAt) => {
    if (typeof id !== 'string' || !WINDOW_ID.test(id)) return;
    state.windows.set(id, {
      id,
      minutes: CLAUDE_WINDOW_MINUTES[id] ?? null,
      usedPct: pctOf(utilization, CLAUDE_UTILIZATION_SCALE),
      resetsAt: isoFromStamp(resetsAt),
      at,
    });
  };
  const unified = info.unifiedWindows;
  if (unified && typeof unified === 'object' && !Array.isArray(unified)) {
    for (const [id, w] of Object.entries(unified)) {
      if (w && typeof w === 'object') put(id, w.utilization, w.resetsAt);
    }
  } else if (typeof info.rateLimitType === 'string') {
    put(info.rateLimitType, info.utilization, info.resetsAt);
  }
  capWindows(state.windows);
  state.status = CLAUDE_STATUSES.has(info.status) ? info.status : 'other';
  state.at = at;
}

/**
 * RECORD WHAT A CODEX ROLLOUT'S `rate_limits` SAID.
 *
 * `primary` and `secondary` are the plan's windows, named by their length:
 * 300 minutes is `five_hour` and 10080 is `seven_day` (Claude's own ids, so
 * the app words them once), any other length `m<N>`. The snapshot is WHOLE —
 * each token_count carries every window the plan has — so it replaces the
 * previous one rather than merging: a window the plan no longer has must not
 * linger. `resets_at` is seconds. Codex gives the plan slug itself
 * (`plan_type`); `rate_limit_reached_type` is non-null once a window is hit.
 */
export function recordCodexRateLimits(rl, now = Date.now()) {
  if (!rl || typeof rl !== 'object' || Array.isArray(rl)) return;
  const at = iso(now);
  const windows = new Map();
  for (const [slot, w] of [['primary', rl.primary], ['secondary', rl.secondary]]) {
    if (!w || typeof w !== 'object') continue;
    const m = Number(w.window_minutes);
    const minutes = Number.isInteger(m) && m > 0 ? m : null;
    const id = minutes === 300 ? 'five_hour' : minutes === 10080 ? 'seven_day' : minutes ? `m${minutes}` : slot;
    if (!WINDOW_ID.test(id)) continue;
    windows.set(id, { id, minutes, usedPct: pctOf(w.used_percent), resetsAt: isoFromStamp(w.resets_at), at });
  }
  codexState = {
    plan: planOf(rl.plan_type),
    status: rl.rate_limit_reached_type != null ? 'rejected' : 'allowed',
    at,
    windows,
  };
}

/** threadId → rollout path, per CODEX_HOME. Bounded: a long-lived daemon
 *  runs many threads and the map must not grow with them. */
const rolloutPaths = new Map();
const ROLLOUT_PATHS_MAX = 64;

const newestFirst = async (dir, re) => {
  try {
    return (await readdir(dir)).filter((n) => re.test(n)).sort().reverse();
  } catch {
    return [];
  }
};

/** Find `rollout-…-<threadId>.jsonl` by NAME — the id is matched against
 *  what `readdir` returned and never joined into a path. */
async function findRollout(root, threadId) {
  const suffix = `-${threadId}.jsonl`;
  let days = 0;
  for (const y of await newestFirst(root, /^\d{4}$/)) {
    for (const m of await newestFirst(join(root, y), /^\d{2}$/)) {
      for (const d of await newestFirst(join(root, y, m), /^\d{2}$/)) {
        if (++days > ROLLOUT_DAYS_MAX) return null;
        const dayDir = join(root, y, m, d);
        const hit = (await newestFirst(dayDir, /^rollout-.*\.jsonl$/)).find((n) => n.endsWith(suffix));
        if (hit) return join(dayDir, hit);
      }
    }
  }
  return null;
}

/** The last token_count's non-null `rate_limits` in the file's tail, or null. */
async function lastRateLimits(file) {
  const fh = await open(file, 'r');
  try {
    const { size } = await fh.stat();
    const len = Math.min(size, ROLLOUT_TAIL_BYTES);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n');
    // A tail that starts mid-file starts mid-line: that first piece is not JSON.
    if (size > len) lines.shift();
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line.includes('"token_count"') || !line.includes('"rate_limits"')) continue;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      const p = ev?.payload;
      if (p?.type === 'token_count' && p.rate_limits && typeof p.rate_limits === 'object') return p.rate_limits;
    }
    return null;
  } finally {
    await fh.close();
  }
}

/**
 * LEARN A CODEX THREAD'S PLAN WINDOWS FROM ITS ROLLOUT, after its turn closed.
 *
 * Best-effort from end to end, and it never throws: an id of the wrong shape,
 * a missing CODEX_HOME, a rollout older than the walk, an unreadable file or a
 * tail with no `rate_limits` all change nothing. Returns whether it learned.
 */
export async function learnCodexLimits(threadId, { env = process.env, now } = {}) {
  try {
    const file = await codexRolloutFile(threadId, { env });
    if (!file) return false;
    const rl = await lastRateLimits(file);
    if (!rl) return false;
    recordCodexRateLimits(rl, now ?? Date.now());
    return true;
  } catch {
    return false;
  }
}

/**
 * WHERE A CODEX THREAD'S ROLLOUT IS, or null — the one lookup (and its cache)
 * every reader of that file shares: the plan windows above, and the model a
 * turn ran on (turnModel.mjs, 2026-09-29). Never throws.
 */
export async function codexRolloutFile(threadId, { env = process.env } = {}) {
  try {
    if (typeof threadId !== 'string' || !CODEX_THREAD_RE.test(threadId)) return null;
    const root = join(env.CODEX_HOME || join(homedir(), '.codex'), 'sessions');
    const key = `${root}\0${threadId}`;
    let file = rolloutPaths.get(key) ?? null;
    if (file) {
      try {
        await stat(file);
      } catch {
        rolloutPaths.delete(key);
        file = null;
      }
    }
    if (!file) {
      file = await findRollout(root, threadId);
      if (!file) return null;
      rolloutPaths.set(key, file);
      if (rolloutPaths.size > ROLLOUT_PATHS_MAX) rolloutPaths.delete(rolloutPaths.keys().next().value);
    }
    return file;
  } catch {
    return null;
  }
}

/**
 * CLAUDE'S PLAN SLUG (`max`, `pro`…) off the OAuth store `claudeAuth.mjs`
 * already reads — never a token, only the plan name it keeps. Read at most
 * once a minute; null when unknown (a keychain machine, an env-var key).
 */
let planMemo = null;
export function claudePlanReading(now = Date.now()) {
  if (planMemo && now - planMemo.readAt < PLAN_TTL_MS) return planMemo;
  let plan = null;
  try {
    plan = planOf(claudeAuthContext().subscriptionType);
  } catch {
    plan = null;
  }
  planMemo = { plan, readAt: now };
  return planMemo;
}
export function claudePlan() {
  return claudePlanReading().plan;
}

const windowOrder = (a, b) =>
  (a.minutes ?? Infinity) - (b.minutes ?? Infinity) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** One CLI's entry on the wire — every key present, newest windows kept. */
function entryOf({ plan, status, at, windows }) {
  const list = [...windows.values()]
    .filter((w) => WINDOW_ID.test(w.id))
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
    .slice(0, RUNTIME_LIMIT_WINDOWS_MAX)
    .sort(windowOrder)
    .map((w) => ({ id: w.id, minutes: w.minutes, usedPct: w.usedPct, resetsAt: w.resetsAt, at: w.at }));
  return { plan: planOf(plan), status: status ?? null, at: at ?? null, windows: list };
}

const bytes = (v) => Buffer.byteLength(JSON.stringify(v), 'utf8');

/**
 * THE REPORT, FITTED TO `maxBytes`: windows are dropped oldest reading first
 * until it fits, and a report that still does not fit with none left is null
 * (not sent) rather than cut mid-entry. Pure; exported for its test.
 */
export function fitRuntimeLimits(report, maxBytes = RUNTIME_LIMITS_PARAM_MAX) {
  if (!report) return null;
  const out = Object.fromEntries(
    Object.entries(report).map(([k, e]) => [k, { ...e, windows: [...(e.windows ?? [])] }])
  );
  while (bytes(out) > maxBytes) {
    let oldest = null;
    for (const [k, e] of Object.entries(out)) {
      e.windows.forEach((w, i) => {
        if (!oldest || String(w.at) < String(oldest.w.at)) oldest = { k, i, w };
      });
    }
    if (!oldest) return null;
    out[oldest.k].windows.splice(oldest.i, 1);
  }
  return out;
}

/**
 * WHAT THE ROSTER POLL SENDS AS `rtl` — `{ claude?, codex? }`, or null when
 * nothing is learned.
 *
 * Claude's entry needs Claude INSTALLED here (the detection the poll already
 * runs) and something to say: its plan from the OAuth store, or a window a
 * turn reported. A plan with no window yet has no status to relay, so its
 * `status` is null — unknown, never a guessed `allowed`. Codex's entry exists
 * once a rollout taught it. `detected` and `plan` are the test's handles.
 */
export function runtimeLimitsReport({ detected, plan, now = Date.now() } = {}) {
  const out = {};
  let claudeInstalled = false;
  try {
    claudeInstalled = Boolean((detected ?? detectRuntimes()).find((d) => d.id === 'claude')?.installed);
  } catch {
    claudeInstalled = false;
  }
  if (claudeInstalled) {
    const reading = plan === undefined ? claudePlanReading(now) : { plan: planOf(plan), readAt: now };
    const learned = claudeState && claudeState.windows.size > 0;
    if (reading.plan || learned) {
      out.claude = entryOf({
        plan: reading.plan,
        status: claudeState?.status ?? null,
        at: claudeState?.at ?? iso(reading.readAt),
        windows: claudeState?.windows ?? new Map(),
      });
    }
  }
  if (codexState) out.codex = entryOf(codexState);
  return Object.keys(out).length ? fitRuntimeLimits(out) : null;
}

/** Test-only: forget everything learned, the plan memo and the path cache. */
export function resetRuntimeLimitsForTest() {
  claudeState = null;
  codexState = null;
  planMemo = null;
  rolloutPaths.clear();
}
