/**
 * `flowviant machines --remove` and the menu's first verb: DISCONNECT THIS BOX
 * FROM ONE PROJECT — stop the daemon here, leave the app's machines list,
 * forget the credential here.
 *
 * THE VERBS ACT ON THIS BOX'S OWN CONNECTIONS AND NOTHING ELSE. It does not
 * stop, remove or move a daemon on another computer; decisions about other
 * machines stay in the app (the ruling the `machines` command amends, argued
 * in `machineListing.mjs`'s header).
 *
 * Split out of the `machines` command's single module (SOLID audit 2026-09-26,
 * F056) because it is the one DESTRUCTIVE workflow there, with its own callers
 * (machinesCommand.mjs's `--remove` and menu, `uninstall`) and its own test needs (the
 * order and the sentences, under injected deps). It reads the listing's
 * `projectPhrase` so a project is named the same way in both, and the leave
 * request from `machines.mjs`.
 *
 * IT ALSO OWNS WHAT A DISCONNECT ACHIEVED — the outcome contract
 * `disconnectHere` returns beside the sentences it prints, and the one reading
 * of it every caller that must ACT on the result uses (SOLID F004), because
 * `flowviant uninstall --purge` decided whether the app had been told by
 * matching four phrases in the log lines, and then deleted `~/.flowviant`
 * even after a failure it had just recorded. The sentences are for a person
 * at a terminal; a decision reads this.
 *
 * The shape: `{ ok, stop, leave, forget }` —
 *   stop:   'stopped' | 'none' | 'failed' | 'draining'
 *   leave:  'left' | 'not-listed' | 'skipped' | 'rejected' | 'unsupported' | 'failed' | 'not-run'
 *           (+ `leaveError` when 'failed')
 *   forget: 'forgotten' | 'kept' | 'failed' | 'not-run'
 *           (+ `forgetError` when 'failed')
 * `ok` keeps its meaning for the `machines` verbs (false when the stop
 * refused, the forget failed, or the caller asked to keep the credential
 * after a failed leave and it was kept).
 */

import { projectPhrase } from './machineListing.mjs';
import { leaveBoxFor } from './machines.mjs';
import { terminalCommand } from './launchCommand.mjs';

/**
 * Where a person removes a box's row by hand when this box could not: the
 * project's Machines page (it took over Settings › Machines, 2026-09-25).
 * One spelling for every terminal sentence that points there.
 */
export const removeOnMachinesPage = (what = 'it') => `remove ${what} on the project's Machines page`;

/** The leave's answer (see `leaveBoxFor`) as one word. */
export function leaveOutcomeOf(left) {
  if (left?.skipped) return 'skipped';
  if (left?.rejected) return 'rejected';
  if (left?.unsupported) return 'unsupported';
  if (left?.error) return 'failed';
  if (!left?.removed) return 'not-listed';
  return 'left';
}

/**
 * What the disconnect did NOT achieve, or null when it achieved everything it
 * can. `retryable` says whether running it again could change the answer:
 * a daemon that would not stop, a leave the network or the app refused, a
 * credential that could not be forgotten. An older server with no leave
 * route is reported but not retryable — asking it again changes nothing.
 *
 * An outcome with none of the fields (a caller's own stub, an older shape) is
 * read by `ok` alone.
 */
export function disconnectShortfall(outcome) {
  if (!outcome || typeof outcome !== 'object') return { reason: 'the disconnect reported nothing', retryable: true };
  if (outcome.stop === 'failed')
    return { reason: 'a daemon for it is still running here and was not stopped', retryable: true };
  if (outcome.stop === 'draining')
    return { reason: 'a daemon for it is finishing a deploy here; wait for it to finish', retryable: true };
  if (outcome.leave === 'failed')
    return { reason: `could not tell the app this box has left (${outcome.leaveError ?? 'failed'})`, retryable: true };
  if (outcome.forget === 'failed')
    return { reason: `could not forget the credential here: ${outcome.forgetError ?? 'failed'}`, retryable: true };
  if (outcome.leave === 'unsupported')
    return { reason: 'the app does not take a leave from a machine yet (older server)', retryable: false };
  if (outcome.ok === false) return { reason: 'failed', retryable: true };
  return null;
}

/**
 * DISCONNECT THIS BOX FROM ONE PROJECT — the three steps, in the only order
 * that is safe, with every outcome said as it happens (0.95.0).
 *
 *  1. STOP the daemon serving that credential HERE. One lock, identified
 *     before it is signalled, through the same stand-down `flowviant stop`
 *     uses — never a sweep, because the person named ONE project. A daemon
 *     that is alive and could not be stopped ABORTS the disconnect: forgetting
 *     a credential under a running daemon changes nothing about the daemon
 *     (it holds the token in memory) and telling the server we have left while
 *     it keeps polling is a row that comes back in ten seconds wearing the
 *     name we just said was gone.
 *     A daemon FINISHING A DEPLOY aborts it too (ruling 2026-09-26: a
 *     stand-down lets a deploy finish and report). The stop was obeyed and is
 *     never forced, but the daemon is still alive: its report needs the
 *     credential and the app's row of this box, and the leave would delete
 *     that row, which is how the app knows to refuse its own Disconnect while
 *     the deploy is in flight. So nothing is left or forgotten, and it says to
 *     wait, in the app's own words.
 *  2. LEAVE in the app — see `leaveBoxFor`. Skipped, and said, when this box
 *     has no identity file: a box that never ran a daemon never polled, so
 *     the app has no row to remove.
 *  3. FORGET the credential here. Last, so a failure in 1 or 2 leaves the
 *     store able to try again.
 *
 * `deps` is injected so the ORDER and the SENTENCES are provable without a
 * daemon, a socket or a credential file; `realDisconnectDeps` builds the live
 * set. Returns the OUTCOME (above) — `{ ok, stop, leave, forget }` — so a
 * caller that must act on what happened reads fields, never the sentences.
 * `ok` is false only when step 1 refused, step 3 failed, or the credential
 * was kept (below).
 *
 * `forgetAfterFailedLeave` (default true, the `machines` verbs' rule): after
 * a leave the app could not be told, the stopped box's store is still the
 * last thing to clean. `uninstall --purge` passes false — it is about to
 * delete the store whole, and a credential forgotten before a failed leave is
 * one it can never use to try again.
 */
export async function disconnectHere(entry, deps, { log = (m) => console.log(m), forgetAfterFailedLeave = true } = {}) {
  const who = projectPhrase(entry);
  const tally = deps.stopDaemon(entry.fleetToken);
  if (tally.failed > 0) {
    log(
      `not disconnected from ${who}: a daemon for it is still running here and was not stopped. ` +
        'Stop it first (the line above says how), then run this again.'
    );
    return { ok: false, stop: 'failed', leave: 'not-run', forget: 'not-run' };
  }
  if (tally.draining > 0) {
    log(
      `not disconnected from ${who}: a deploy is in flight on this box; wait for it to finish, ` +
        'then run this again. Its daemon stops by itself once the outcome is reported.'
    );
    return { ok: false, stop: 'draining', leave: 'not-run', forget: 'not-run' };
  }
  const stop = tally.running === 0 ? 'none' : 'stopped';
  if (tally.running === 0) log(`no daemon for ${who} was running here.`);

  const left = await deps.leave(entry);
  const leave = leaveOutcomeOf(left);
  const leaveFacts = leave === 'failed' ? { leave, leaveError: String(left.error) } : { leave };
  if (left.skipped) {
    log('this box has never run a daemon, so the app has no row of it to remove.');
  } else if (left.rejected) {
    log(`the app had already disconnected or deleted ${who} — nothing to leave.`);
  } else if (left.unsupported) {
    log(
      'the app does not take a leave from a machine yet (older server) — its row goes quiet on its own, ' +
        `or ${removeOnMachinesPage()}.`
    );
  } else if (left.error) {
    log(
      `could not tell the app this box has left ${who} (${left.error}) — its row goes quiet on its own, ` +
        `or ${removeOnMachinesPage()}.`
    );
  } else if (!left.removed) {
    log(`the app was not listing this box on ${who}.`);
  } else {
    log(
      `removed this box from ${who}’s machines list in the app.` +
        (left.wasHolder ? ' It was the machine serving that project, which has none until another polls.' : '')
    );
  }

  if (leave === 'failed' && !forgetAfterFailedLeave) {
    log(`kept ${who}’s credential on this box, so the leave can be tried again.`);
    return { ok: false, stop, ...leaveFacts, forget: 'kept' };
  }
  const gone = deps.forget(entry.projectId);
  if (gone.error) {
    log(`could not forget the credential here: ${gone.error}`);
    return { ok: false, stop, ...leaveFacts, forget: 'failed', forgetError: String(gone.error) };
  }
  log(`forgot ${who}’s credential on this box. \`${terminalCommand('login')}\` in its repo connects it again.`);
  return { ok: true, stop, ...leaveFacts, forget: 'forgotten' };
}

/**
 * THE LIVE DEPENDENCIES for `disconnectHere`, built lazily: `instance.mjs`
 * and `boxIdentity.mjs` are imported here and not at the top so that rendering the
 * listing — the piped, scripted, most common use — loads nothing that reads a
 * lock directory or a keypair. `readStoredPubB64` READS the key and never
 * mints one, the rule machinesCommand.mjs is pinned to.
 */
export async function realDisconnectDeps({ url, log = (m) => console.log(m) } = {}) {
  const { stopDaemonFor } = await import('./instance.mjs');
  const { forgetStoredProject } = await import('./credentials.mjs');
  let envpub = null;
  try {
    const env = await import('./boxIdentity.mjs');
    envpub = env.readStoredPubB64();
  } catch {
    /* unreadable keypair — the leave is skipped and said */
  }
  return {
    stopDaemon: (fleetToken) => stopDaemonFor(fleetToken, { log: (m) => log(`  ${m}`) }),
    leave: (entry) => leaveBoxFor(entry, { url, envpub }),
    forget: (projectId) => forgetStoredProject(projectId),
  };
}
