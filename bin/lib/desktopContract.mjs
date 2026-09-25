/** Local, read-only desktop contract and bounded daemon logs. */
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { format } from 'node:util';
import { FLEET_URL, MACHINE_HOST, USER_AGENT, VERSION } from './config.mjs';
import { listStoredProjects } from './credentials.mjs';
import { readStoredPubB64 } from './env.mjs';
import { daemonRunningFor } from './instance.mjs';
import { runningViaNpx } from './launchCommand.mjs';
import { boxesUrlFrom, fetchBoxesFor } from './machines.mjs';
import { detectRuntimes } from './runtimes.mjs';
import { runningCompiledBinary } from './update.mjs';

export const MAX_DAEMON_LOG_BYTES = 2 * 1024 * 1024;
const store = () => join(homedir(), '.flowviant');
const key = (projectId) => createHash('sha256').update(String(projectId)).digest('hex').slice(0, 16);
export const daemonLogPath = (projectId) => join(store(), `daemon-${key(projectId)}.log`);
export const daemonStatePath = (projectId) => join(store(), `daemon-${key(projectId)}.state.json`);

function readState(projectId) {
  try {
    const value = JSON.parse(readFileSync(daemonStatePath(projectId), 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

export function writeDaemonState(projectId, change) {
  if (!projectId) return;
  try {
    mkdirSync(store(), { recursive: true });
    const path = daemonStatePath(projectId);
    const current = readState(projectId);
    const next = { ...current, ...change, pid: process.pid };
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 });
    renameSync(tmp, path);
  } catch { /* a local readout must never interrupt a daemon */ }
}

export function setRuntimeLimit(projectId, runtime, words) {
  if (!projectId || !runtime) return false;
  const state = readState(projectId);
  const limits = { ...(state.limits ?? {}) };
  if (words == null) {
    if (!Object.hasOwn(limits, runtime)) return false;
    delete limits[runtime];
  } else {
    if (limits[runtime] === words) return false;
    limits[runtime] = words;
  }
  writeDaemonState(projectId, { limits });
  emitMachineEvent({ event: words == null ? 'limit-cleared' : 'limit-hit', runtime, ...(words == null ? {} : { message: words }) });
  return true;
}

export function installChannel() {
  return runningCompiledBinary() ? 'binary' : runningViaNpx() ? 'npx' : 'npm-g';
}

export function desktopStatus({ entries = listStoredProjects(), runtimes = detectRuntimes(), runningFor = daemonRunningFor, stateFor = readState, pidFor = lockPid } = {}) {
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
        lastPoll: state.lastPoll ?? null,
        logFile: daemonLogPath(entry.projectId),
        runtimes: runtimes.map((rt) => ({
          id: rt.id,
          installed: rt.installed,
          version: rt.version ?? null,
          dispatchable: rt.dispatchable,
          ...(liveState?.limits?.[rt.id] ? { parkedByLimit: true, message: liveState.limits[rt.id] } : {}),
        })),
      };
    }),
    // A box with no projects still has installed CLIs.
    runtimes: runtimes.map((rt) => ({ id: rt.id, installed: rt.installed, version: rt.version ?? null, dispatchable: rt.dispatchable })),
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

async function fetchLiveAgentsFor(entry, { url, fetchImpl, signal }) {
  const res = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${entry.fleetToken}`, 'User-Agent': USER_AGENT },
    signal,
  });
  if (!res.ok) return { error: `HTTP ${res.status}` };
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

export async function desktopStatusRemote({ entries = listStoredProjects(), runtimes = detectRuntimes(),
  runningFor = daemonRunningFor, stateFor = readState, pidFor = lockPid,
  fetchImpl = fetch, envpub = readStoredPubB64(), fleetUrl = FLEET_URL, host = MACHINE_HOST,
  now = () => new Date().toISOString(), timeoutMs = REMOTE_TIMEOUT_MS, log = console.error } = {}) {
  const status = desktopStatus({ entries, runtimes, runningFor, stateFor, pidFor });
  const boxesUrl = boxesUrlFrom(fleetUrl);
  const liveUrl = String(fleetUrl).replace(/\/agents\/?$/, '/live-agents');
  const remotes = await Promise.all(entries.map(async (entry) => {
    if (!entry.fleetToken) return null;
    const [boxes, live] = await Promise.all([
      remoteRead((signal) => fetchBoxesFor(entry, { url: boxesUrl, envpub, fetchImpl, signal }), timeoutMs),
      remoteRead((signal) => fetchLiveAgentsFor(entry, { url: liveUrl, fetchImpl, signal }), timeoutMs),
    ]);
    const boxesOk = Array.isArray(boxes.boxes);
    const liveOk = Array.isArray(live.agents);
    if (!boxesOk) {
      const reason = boxes.error ?? (boxes.unsupported ? 'HTTP 404' : boxes.rejected ? 'credential rejected' : 'unexpected answer shape');
      log(`status --remote ${entry.projectId} boxes: ${reason}`);
    }
    if (!liveOk) log(`status --remote ${entry.projectId} live-agents: ${live.error ?? 'unexpected answer shape'}`);
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

function lockPid(token) {
  try {
    const hash = createHash('sha256').update(String(token || 'anon')).digest('hex').slice(0, 12);
    return JSON.parse(readFileSync(join(store(), `daemon-${hash}.lock`), 'utf8')).pid;
  } catch { return null; }
}

let events = false;
let eventWriter = process.stdout.write.bind(process.stdout);
export function enableMachineEvents(write = eventWriter) { events = true; eventWriter = write; }
export function emitMachineEvent(value) {
  if (events) eventWriter(`${JSON.stringify(value)}\n`);
}

/** All human output stays on its existing stream in terminal mode. In desktop
 * mode stdout is reserved for JSONL and those same lines go to stderr. */
export function installDaemonLogging(projectId, { jsonEvents = false } = {}) {
  if (!projectId) return;
  if (jsonEvents) {
    enableMachineEvents();
    process.stdout.write = (...args) => process.stderr.write(...args);
  }
  const original = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  const logPath = daemonLogPath(projectId);
  for (const method of Object.keys(original)) {
    console[method] = (...args) => {
      const line = format(...args);
      try {
        mkdirSync(store(), { recursive: true });
        const encoded = Buffer.from(`${line}\n`);
        const tail = Buffer.from('\n[truncated]\n');
        const chunk = encoded.length > MAX_DAEMON_LOG_BYTES
          ? Buffer.concat([encoded.subarray(0, MAX_DAEMON_LOG_BYTES - tail.length), tail])
          : encoded;
        let size = 0;
        try { size = statSync(logPath).size; } catch { /* new file */ }
        if (size + chunk.length > MAX_DAEMON_LOG_BYTES) {
          try { renameSync(logPath, `${logPath}.1`); } catch { /* no old log */ }
        }
        appendFileSync(logPath, chunk, { mode: 0o600 });
      } catch { /* logging must never stop service */ }
      if (jsonEvents) process.stderr.write(`${line}\n`);
      else original[method](...args);
    };
  }
}
