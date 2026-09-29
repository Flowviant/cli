/**
 * WHERE A PROJECT'S DAEMON KEEPS ITS LOCAL READOUT, AND WHAT IT WRITES THERE
 * (2026-09-26, SOLID F061).
 *
 * The per-project state file (holder, last poll, CLI limits) and log file
 * under ~/.flowviant, named by a hash of the project id. Split out of
 * desktopContract.mjs so the status readout only READS this, and so the
 * daemon's writers (fleet.mjs, workAgentTurnExecution.mjs) do not import the status
 * builder. A limit change is announced as a machine event (daemonLogging.mjs).
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { emitMachineEvent } from './daemonLogging.mjs';
import { instanceLockPath } from './instance.mjs';

const store = () => join(homedir(), '.flowviant');
const key = (projectId) => createHash('sha256').update(String(projectId)).digest('hex').slice(0, 16);
export const daemonLogPath = (projectId) => join(store(), `daemon-${key(projectId)}.log`);
export const daemonStatePath = (projectId) => join(store(), `daemon-${key(projectId)}.state.json`);

export function readDaemonState(projectId) {
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
    const current = readDaemonState(projectId);
    const next = { ...current, ...change, pid: process.pid };
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 });
    renameSync(tmp, path);
  } catch { /* a local readout must never interrupt a daemon */ }
}

export function setRuntimeLimit(projectId, runtime, words) {
  if (!projectId || !runtime) return false;
  const state = readDaemonState(projectId);
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

/** The pid in the instance lock for this credential, or null. */
export function daemonLockPid(token) {
  try {
    return JSON.parse(readFileSync(instanceLockPath(token), 'utf8')).pid;
  } catch { return null; }
}
