/**
 * THE RECONCILE WAIT — idle until the next poll deadline OR a push wake,
 * whichever comes first.
 *
 * Split out of fleet.mjs (SOLID audit 2026-09-26, F038): a small piece of
 * timing state (the pending resolver, and a wake that landed mid-reconcile)
 * that the loop only ever touches through these two functions. The socket
 * itself is stream.mjs's; this is what a wake DOES to the loop.
 */

import { RECONCILE_SECONDS } from './config.mjs';

export function createReconcileWait() {
  // ── Push channel: a server wake short-circuits the reconcile sleep so a job is
  // picked up in ~a round trip instead of on the next poll. The socket only
  // nudges — we still fetch the roster below — so it's pure latency, and the
  // poll stays the fallback whenever the socket is down. `waitReconcile()`
  // resolves on either a wake or the RECONCILE_SECONDS timeout, whichever first.
  let wakeSignal = null; // { resolve, timer } while the loop is idling
  let pendingWake = false; // a wake that landed mid-reconcile — honored next wait
  const fireWake = () => {
    if (wakeSignal) {
      clearTimeout(wakeSignal.timer);
      const { resolve } = wakeSignal;
      wakeSignal = null;
      resolve();
    } else {
      pendingWake = true; // not idling right now; don't lose the wake
    }
  };
  const waitReconcile = () => {
    if (pendingWake) {
      pendingWake = false;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        wakeSignal = null;
        resolve();
      }, RECONCILE_SECONDS * 1000);
      wakeSignal = { resolve, timer };
    });
  };
  return { fireWake, waitReconcile };
}
