/**
 * THE DEPLOY LANE'S ONE POST — `/fleet/deploy-*`, with the machine credential.
 *
 * Split out of deploy.mjs (SOLID F060) because two halves of the lane speak
 * it: the config report (deployConfig.mjs) and the job lease (deploy.mjs —
 * claim, heartbeat, outcome). A leaf, so neither has to import the other to
 * reach the wire, and a change to how the lane authenticates or times out is
 * one edit.
 */

import { FLEET_URL, FLEET_TOKEN, USER_AGENT } from './config.mjs';
import { fleetEndpoint } from './fleetWire.mjs';
import { isCredentialRejection } from './authReject.mjs';

const deployUrl = (tail) => fleetEndpoint(tail, FLEET_URL);

export async function post(tail, body) {
  const res = await fetch(deployUrl(tail), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${FLEET_TOKEN}`,
      'User-Agent': USER_AGENT,
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout(30_000),
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json?.success === false) {
    // The sentence is unchanged. What rides beside it is whether this was the
    // API's OWN refusal of the credential (a Disconnect rotates it, even
    // mid-deploy) — authReject.mjs's one rule, never the bare status: an edge
    // 401/403 (Cloudflare's bot checks, which this client class trips) is a
    // blip and is retried like any other failed post.
    const e = new Error(`${tail} failed (${res.status}${json?.error ? `: ${json.error}` : ''})`);
    e.status = res.status;
    e.credentialRejected = isCredentialRejection(res.status, res.headers.get('content-type'), json);
    throw e;
  }
  return json?.data;
}
