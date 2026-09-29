/**
 * THE DAEMON'S OUTPUT: bounded per-project logs and the desktop JSONL events
 * (2026-09-26, SOLID F061).
 *
 * Split out of desktopContract.mjs, which also built the status readout — so a
 * change to how the daemon writes its output (console redirection, log
 * rotation, the JSON event stream) and a change to the status wire edited one
 * module. This one owns output only; it is handed the log path and never
 * decides where per-project files live (daemonState.mjs does).
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { format } from 'node:util';

export const MAX_DAEMON_LOG_BYTES = 2 * 1024 * 1024;

let events = false;
let eventWriter = process.stdout.write.bind(process.stdout);
export function enableMachineEvents(write = eventWriter) { events = true; eventWriter = write; }
export function emitMachineEvent(value) {
  if (events) eventWriter(`${JSON.stringify(value)}\n`);
}

/** All human output stays on its existing stream in terminal mode. In desktop
 * mode stdout is reserved for JSONL and those same lines go to stderr. Every
 * line is also appended to `logPath`, rotated at MAX_DAEMON_LOG_BYTES. */
export function installDaemonLogging(logPath, { jsonEvents = false } = {}) {
  if (!logPath) return;
  if (jsonEvents) {
    enableMachineEvents();
    process.stdout.write = (...args) => process.stderr.write(...args);
  }
  const original = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  for (const method of Object.keys(original)) {
    console[method] = (...args) => {
      const line = format(...args);
      try {
        mkdirSync(dirname(logPath), { recursive: true });
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
