/**
 * NO PROMPT ON THE START PATH MAY STOP THE DAEMON.
 *
 * This exists because 0.55.2 added a 20-second timeout to the repo-binding
 * confirm and it did not work in the one case that mattered most. `flowviant &`
 * from an interactive shell puts the process in a background process group; the
 * first TTY read raises SIGTTIN (and a TTY write SIGTTOU), whose DEFAULT
 * disposition is to STOP the process. A stopped process runs no timers, so the
 * AbortController never fires — the guard was on the wrong side of the thing it
 * was guarding against. The shell prints `[1]+ Stopped` and nothing else: no
 * banner, no error, no poll, forever, and `bg` does not rescue it.
 *
 * Two independent defences, because either one alone has a hole:
 *
 *  1. `canPrompt()` — do not ask at all unless we are the terminal's FOREGROUND
 *     process group. `stdin.isTTY` is true for a backgrounded job, so it cannot
 *     answer this on its own; the foreground group is what actually decides
 *     whether a read will succeed or be signalled.
 *
 *  2. `askWithTimeout()` — while asking, install no-op SIGTTIN/SIGTTOU handlers.
 *     A handler (even an empty one) replaces the default STOP, so a misjudged
 *     foreground check degrades to a read that fails or hangs — and a hang is
 *     something the timer can now actually interrupt, because the process is
 *     still running.
 *
 * The detection is best-effort by design and FAILS TOWARDS ASKING: an unknown
 * platform returns true, because refusing to prompt a human who IS there is a
 * worse failure than a prompt that times out on its own.
 */

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

/**
 * Is this process in the controlling terminal's foreground process group?
 *
 * Linux: BOTH numbers come out of one `/proc/self/stat` read — field 5 is our
 * own `pgrp` and field 8 is `tpgid`, the foreground group of our controlling
 * terminal. Parsed from AFTER the last ')' because field 2 is the executable
 * name and may itself contain spaces and parentheses.
 *
 * NOT `process.getpgrp()`: it DOES NOT EXIST in Node (verified on 24.16 — it
 * throws `TypeError: process.getpgrp is not a function`). The first cut of this
 * file called it, the throw was swallowed by the fail-open catch below, and the
 * function therefore returned `true` unconditionally — a detector that always
 * says "yes, a human is here" is not a detector, and only the signal handlers
 * in `askWithTimeout` were doing any work. Caught by probing this function in
 * isolation on a real pty; nothing else would have shown it, because the
 * fallback it degraded to still behaves acceptably.
 *
 * Elsewhere: ask `ps` for both. Unknown: assume foreground (see the header).
 */
export function inForeground() {
  try {
    if (process.platform === 'linux') {
      const stat = readFileSync('/proc/self/stat', 'utf8');
      const after = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
      const pgrp = Number(after[2]); // state ppid PGRP session tty_nr tpgid
      const tpgid = Number(after[5]);
      if (!Number.isFinite(tpgid) || !Number.isFinite(pgrp)) return true;
      if (tpgid <= 0) return true; // no controlling terminal — nothing to be behind
      return tpgid === pgrp;
    }
    const out = execFileSync('ps', ['-o', 'tpgid=,pgid=', '-p', String(process.pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    }).trim().split(/\s+/);
    const tpgid = Number(out[0]);
    const pgrp = Number(out[1]);
    if (!Number.isFinite(tpgid) || !Number.isFinite(pgrp) || tpgid <= 0) return true;
    return tpgid === pgrp;
  } catch {
    return true;
  }
}

/** A human is at this terminal AND can actually be reached by a question. */
export function canPrompt() {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY) && inForeground();
}

/**
 * Ask, and come back no matter what. Resolves the trimmed answer, or `null`
 * when nobody answered within `timeoutMs` — the caller decides what silence
 * means, because it is not the same answer everywhere (the binding confirm
 * serves unbound; the project picker refuses, exactly as it does headless).
 */
export async function askWithTimeout(query, timeoutMs) {
  const noop = () => {};
  // Replacing the DEFAULT disposition is the whole point — an empty handler is
  // enough, and it is what keeps the timer below able to run at all.
  process.on('SIGTTIN', noop);
  process.on('SIGTTOU', noop);
  const rl = (await import('node:readline/promises')).createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return (await rl.question(query, { signal: ac.signal })).trim();
  } catch {
    return null; // aborted, or the read failed because we are not in front
  } finally {
    clearTimeout(timer);
    rl.close();
    process.off('SIGTTIN', noop);
    process.off('SIGTTOU', noop);
  }
}
