/**
 * DID THE API REJECT THIS CREDENTIAL, OR DID SOMETHING IN FRONT OF IT ANSWER?
 *
 * A 401 or 403 on a machine-token route used to be read as "the credential is
 * revoked" on sight, and the daemon exited for good — exit 0, so nothing
 * restarts it. But Cloudflare sits in front of the API and answers this client
 * class with its own 403s (a bot-management challenge, a 1020 firewall rule, a
 * Browser Integrity Check false positive), as an HTML page. One of those on one
 * poll took an unattended machine offline over a credential that was still
 * valid: in-flight turns expired into Stuck, queued presses failed, and the
 * board said the machine was gone.
 *
 * The API's own refusal always wears its JSON envelope — `app.onError` renders
 * every HTTPException, including the machine-token middleware's "Token
 * revoked", "Invalid machine token" and "Not a machine credential", as
 * `{ success: false, error }` — so THAT is the credential rejection. Anything
 * else carrying the same status is somebody else's answer, and the caller
 * retries it like any other failed request.
 *
 * Reads the body, so call it only on a 401/403 whose body is not needed.
 */
export async function credentialRejected(res) {
  if (res?.status !== 401 && res?.status !== 403) return false;
  const type = String(res.headers?.get?.('content-type') ?? '');
  if (!/\bapplication\/json\b/i.test(type)) return false;
  try {
    const body = await res.json();
    return Boolean(body) && body.success === false;
  } catch {
    return false; // not the API's envelope — an edge page mislabelled as JSON
  }
}
