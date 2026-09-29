/**
 * The local, read-only desktop contract: `flowviant status --json` and its
 * `--remote` form. It READS the per-project state (daemonState.mjs); the
 * daemon's output and events live in daemonLogging.mjs (split 2026-09-26,
 * SOLID F061).
 */
import { FLEET_URL, MACHINE_HOST, USER_AGENT, VERSION } from './config.mjs';
import { listStoredProjects } from './credentials.mjs';
import { readStoredPubB64 } from './boxIdentity.mjs';
import { daemonRunningFor, drainingFor } from './instance.mjs';
import { runningViaNpx } from './launchCommand.mjs';
import { boxesUrlFrom, classifyMachineResponse, fetchBoxesFor } from './machines.mjs';
import { daemonLockPid, daemonLogPath, readDaemonState } from './daemonState.mjs';
import { detectRuntimes } from './runtimeDetection.mjs';
import { readClaudeAuthStatus } from './runtimeAuth.mjs';
import { runningCompiledBinary } from './update.mjs';
import { fleetEndpoint } from './fleetWire.mjs';

/**
 * HOW OLD A BUSY MEASUREMENT MAY BE and still be one (2026-09-26, SOLID F034).
 * The daemon writes it every reconcile tick (seconds apart); a reading older
 * than this is from a daemon that stopped ticking, and is unknown.
 */
export const BUSY_FRESH_MS = 2 * 60_000;

/**
 * IS THE DAEMON RUNNING HERE WORKING — `true`, `false`, or `null` for unknown.
 *
 * Measured by the daemon itself (`machineBusy` in fleet.mjs: turns, plans,
 * merges, ships, deploys, the wiki lane, undelivered settles) and read from
 * its own state file, so it covers work the server's agent list cannot see.
 * Unknown — no live daemon state, an older daemon that never wrote the field,
 * or a stale reading — is NEVER idle: the desktop app installs an update on
 * its own only over a measured `false`.
 */
export function busyOf(liveState, now = Date.now()) {
  if (!liveState || typeof liveState.busy !== 'boolean') return null;
  const at = Date.parse(liveState.busyAt ?? '');
  if (!Number.isFinite(at) || now - at > BUSY_FRESH_MS || at - now > BUSY_FRESH_MS) return null;
  return liveState.busy;
}

export function installChannel() {
  return runningCompiledBinary() ? 'binary' : runningViaNpx() ? 'npx' : 'npm-g';
}

export function desktopStatus({ entries = listStoredProjects(), runtimes = detectRuntimes(), runningFor = daemonRunningFor, stateFor = readDaemonState, pidFor = daemonLockPid, drainFor = drainingFor, nowMs = Date.now(), authFor = readClaudeAuthStatus, refreshAuth = false } = {}) {
  const runtimeRows = runtimes.map((rt) => ({
    id: rt.id, installed: rt.installed, version: rt.version ?? null, dispatchable: rt.dispatchable,
    ...(rt.id === 'claude' ? (rt.installed ? authFor({ refresh: refreshAuth }) : { signedIn: null, billing: null, subscriptionType: null }) :
      { signedIn: null, billing: null, subscriptionType: null }),
  }));
  return {
    schema: 1,
    version: VERSION,
    installChannel: installChannel(),
    projects: entries.map((entry) => {
      const running = runningFor(entry.fleetToken);
      const state = stateFor(entry.projectId);
      const liveState = running === true && state.pid != null && state.pid === pidFor(entry.fleetToken) ? state : null;
      return {
        id: entry.projectId,
        name: entry.name ?? null,
        dir: entry.repoRoot ?? null,
        running,
        holder: liveState?.holder ?? null,
        // Measured by the daemon; null = unknown, never idle (see `busyOf`).
        busy: busyOf(liveState, nowMs),
        // What a standing-down daemon is finishing (`web → prod`), from its
        // lock's draining mark; null when it is not draining or unknown. A
        // daemon→desktop report field: an older tray ignores it.
        draining: running === true ? drainFor(entry.fleetToken) : null,
        lastPoll: state.lastPoll ?? null,
        logFile: daemonLogPath(entry.projectId),
        runtimes: runtimeRows.map((rt) => ({
          ...rt,
          ...(liveState?.limits?.[rt.id] ? { parkedByLimit: true, message: liveState.limits[rt.id] } : {}),
        })),
      };
    }),
    // A box with no projects still has installed CLIs.
    runtimes: runtimeRows,
  };
}

const REMOTE_TIMEOUT_MS = 4_000;

async function remoteRead(read, timeoutMs) {
  const controller = new AbortController();
  let timer;
  try {
    // Abort the request and bound body parsing even if a fetch ignores its signal.
    return await Promise.race([
      read(controller.signal),
      new Promise((resolve) => {
        timer = setTimeout(() => {
          controller.abort();
          resolve({ error: `timed out after ${timeoutMs}ms` });
        }, timeoutMs);
      }),
    ]);
  } catch (error) {
    return { error: String(error?.message ?? error) };
  } finally {
    clearTimeout(timer);
  }
}

function liveAgent(row) {
  if (!row || typeof row !== 'object' || typeof row.id !== 'string' || !row.id ||
      typeof row.name !== 'string' || !row.name || typeof row.status !== 'string' ||
      typeof row.runtime !== 'string' || !row.runtime ||
      !['delivered', 'total'].every((field) => Number.isInteger(row[field]) && row[field] >= 0) ||
      !['asks', 'parked'].every((field) => typeof row[field] === 'boolean') ||
      !(row.since === null || typeof row.since === 'string')) return null;
  const { id, name, status, runtime, delivered, total, asks, parked, since } = row;
  return { id, name, status, runtime, delivered, total, asks, parked, since };
}

/**
 * The live-agents read, refused in the SAME classes as the boxes read
 * (`classifyMachineResponse`, review 2026-09-26): an app rejection, an edge
 * 401/403 and an older server's 404 are three different facts about a
 * credential, and the tray's log said `HTTP n` for all of them.
 */
async function fetchLiveAgentsFor(entry, { url, fetchImpl, signal }) {
  const res = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${entry.fleetToken}`, 'User-Agent': USER_AGENT },
    signal,
  });
  const refused = await classifyMachineResponse(res);
  if (refused) return refused;
  const body = await res.json();
  const data = body?.data ?? body;
  if (!data || !Array.isArray(data.agents)) return { error: 'unexpected answer shape' };
  const pressure = data.pressure;
  return {
    agents: data.agents.map(liveAgent).filter(Boolean),
    pressure: pressure && typeof pressure.reason === 'string' && typeof pressure.at === 'string'
      ? { reason: pressure.reason, at: pressure.at } : null,
  };
}

/** One log phrase for a classified refusal, for both remote reads. */
const refusalWords = (r) =>
  r.error ?? (r.unsupported ? 'HTTP 404' : r.rejected ? 'credential rejected' : 'unexpected answer shape');

export async function desktopStatusRemote({ entries = listStoredProjects(), runtimes = detectRuntimes(),
  runningFor = daemonRunningFor, stateFor = readDaemonState, pidFor = daemonLockPid,
  authFor = readClaudeAuthStatus, refreshAuth = false,
  fetchImpl = fetch, envpub = readStoredPubB64(), fleetUrl = FLEET_URL, host = MACHINE_HOST,
  now = () => new Date().toISOString(), timeoutMs = REMOTE_TIMEOUT_MS, log = console.error } = {}) {
  const status = desktopStatus({ entries, runtimes, runningFor, stateFor, pidFor, authFor, refreshAuth });
  const boxesUrl = boxesUrlFrom(fleetUrl);
  const liveUrl = fleetEndpoint('live-agents', fleetUrl);
  const remotes = await Promise.all(entries.map(async (entry) => {
    if (!entry.fleetToken) return null;
    const [boxes, live] = await Promise.all([
      remoteRead((signal) => fetchBoxesFor(entry, { url: boxesUrl, envpub, fetchImpl, signal }), timeoutMs),
      remoteRead((signal) => fetchLiveAgentsFor(entry, { url: liveUrl, fetchImpl, signal }), timeoutMs),
    ]);
    const boxesOk = Array.isArray(boxes.boxes);
    const liveOk = Array.isArray(live.agents);
    if (!boxesOk) log(`status --remote ${entry.projectId} boxes: ${refusalWords(boxes)}`);
    if (!liveOk) log(`status --remote ${entry.projectId} live-agents: ${refusalWords(live)}`);
    if (!boxesOk && !liveOk) return null;
    const mine = boxesOk ? boxes.boxes.find((box) => box?.boxId === boxes.me) : null;
    const serving = boxesOk ? boxes.boxes.find((box) => box?.role === 'serving') : null;
    return {
      at: now(),
      boxName: boxesOk ? (typeof mine?.boxName === 'string' && mine.boxName ? mine.boxName : host || null) : null,
      role: mine?.role === 'serving' || mine?.role === 'inactive' ? mine.role : null,
      servingBoxName: typeof serving?.boxName === 'string' ? serving.boxName : null,
      daemonVersion: typeof mine?.daemonVersion === 'string' ? mine.daemonVersion : null,
      latest: boxesOk ? boxes.latest : null,
      agents: liveOk ? live.agents : null,
      pressure: liveOk ? live.pressure : null,
    };
  }));
  status.projects.forEach((project, index) => { project.remote = remotes[index]; });
  return status;
}
