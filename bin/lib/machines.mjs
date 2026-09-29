/**
 * THE MACHINE'S TWO REQUESTS about its own boxes — `GET /fleet/boxes` (0.91.0)
 * and `POST /fleet/boxes/leave` (0.95.0) — and the one rule that classifies
 * what the server answered.
 *
 * Split out of the `machines` command's single module (SOLID audit 2026-09-26,
 * F056): the listing and its copy live in `machineListing.mjs`, the
 * stop → leave → forget orchestration in `machineDisconnect.mjs`, and this
 * file is only the wire. The daemon's startup line and the tray's
 * `status --remote` read the same boxes call from here.
 *
 * ONE CLASSIFICATION FOR BOTH (F170). The read and the leave each spelled the
 * same five decisions — the app rejected the credential, something in front of
 * the app answered 401/403, a 404 is an older SERVER, any other non-OK is an
 * HTTP error, a thrown fetch is a transport failure — and only their success
 * bodies differ. `machineRequest` states them once; each caller validates its
 * own body. Keeping 404 apart from 401 is the part that matters: one means
 * "older server", the other "a credential this box should probably forget",
 * and collapsing them is how somebody deletes a working credential. The tray's
 * third machine-credential read, `GET /fleet/live-agents` (desktopContract.mjs),
 * classifies through the same exported rule.
 *
 * It deliberately imports NOTHING from fleet.mjs: that module pulls the whole
 * daemon, and the `machines` command runs before the auth gate.
 */

import { USER_AGENT } from './config.mjs';
import { credentialRejected } from './authReject.mjs';
import { fleetEndpoint } from './fleetWire.mjs';

/** The boxes read, derived from the roster URL the way the diffstat post is —
 *  one place configures the API base and everything else is a suffix swap. */
export function boxesUrlFrom(fleetUrl) {
  return fleetEndpoint('boxes', fleetUrl);
}

/** Where this box tells the server it has left a project — the boxes read's
 *  own path with a verb on the end, so a server that has the read and not the
 *  verb answers 404 and the caller says "older server" rather than guessing. */
export function leaveUrlFrom(fleetUrl) {
  return fleetEndpoint('boxes/leave', fleetUrl);
}

/**
 * WHAT A NON-SUCCESS ANSWER MEANS, as a shape both callers and the renderer
 * know — or null when the response is an OK the caller should read.
 *
 *   { rejected: true }      the APP refused the credential (its JSON envelope)
 *   { error: 'HTTP 403 from something in front of the app' }
 *                           an edge 401/403 (a challenge page) — not the app
 *   { unsupported: true }   404: an older server without this route
 *   { error: 'HTTP <n>' }   any other non-OK
 */
export async function classifyMachineResponse(res) {
  if (await credentialRejected(res)) return { rejected: true };
  if (res.status === 401 || res.status === 403) return { error: `HTTP ${res.status} from something in front of the app` };
  if (res.status === 404) return { unsupported: true };
  if (!res.ok) return { error: `HTTP ${res.status}` };
  return null;
}

/**
 * Send one request and answer in a shape, never a throw: the classification
 * above for a refusal, `accept(data)` for an OK body's `data`, and the
 * transport's own words for a fetch that threw.
 */
async function machineRequest(send, accept) {
  try {
    const res = await send();
    const refused = await classifyMachineResponse(res);
    if (refused) return refused;
    const body = await res.json();
    return accept(body?.data);
  } catch (e) {
    return { error: String(e?.message ?? e) };
  }
}

/**
 * Ask one credential for its boxes. Never throws: every outcome is a shape the
 * renderer knows, because one dead project must not end the listing.
 *
 * A 404 is an older SERVER rather than a missing project — the route is new —
 * and it is kept apart from a 401, which is a credential this box should
 * probably forget. Two different next moves; collapsing them is how somebody
 * deletes a working credential.
 */
export async function fetchBoxesFor(entry, { url, envpub, fetchImpl = fetch, signal = AbortSignal.timeout(15_000) } = {}) {
  const target = new URL(url);
  if (envpub) target.searchParams.set('envpub', envpub);
  return machineRequest(
    () =>
      fetchImpl(target, {
        headers: { Authorization: `Bearer ${entry.fleetToken}`, 'User-Agent': USER_AGENT },
        signal,
      }),
    (data) => {
      if (!data || !Array.isArray(data.boxes)) return { error: 'unexpected answer shape' };
      return { boxes: data.boxes, latest: data.latest ?? null, me: data.me ?? null };
    }
  );
}

/**
 * TELL THE SERVER THIS BOX HAS LEFT ONE PROJECT — `POST /fleet/boxes/leave`
 * (0.95.0). Never throws; every outcome is a shape the caller can say in words.
 *
 * It is THIS box removing ITSELF: the body carries our own `envpub`, the same
 * label every poll carries, and the server deletes our registry row for that
 * credential outright — no stand-down, because the daemon that would take one
 * has just been stopped by the same hand, and a stand-down waits on a poll
 * that is not coming. If we were the box serving the project, the server says
 * so (`wasHolder`) and the project has no machine until another one polls.
 *
 * A 404 is an OLDER SERVER (the read exists, the verb does not) and is kept
 * apart from a 401/403, which is a credential the app has already killed: the
 * first means "the row goes stale on its own, or remove it in the app", the
 * second means "there was nothing to leave". Collapsing them is how a working
 * credential gets described as dead.
 */
export async function leaveBoxFor(entry, { url, envpub, fetchImpl = fetch } = {}) {
  if (!envpub) return { skipped: true };
  return machineRequest(
    () =>
      fetchImpl(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${entry.fleetToken}`,
          'User-Agent': USER_AGENT,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ envpub }),
        signal: AbortSignal.timeout(15_000),
      }),
    (data) => {
      if (!data || typeof data.removed !== 'boolean') return { error: 'unexpected answer shape' };
      return { removed: data.removed, wasHolder: Boolean(data.wasHolder) };
    }
  );
}
