/**
 * THE ARTIFACT REPORTER — the queued POST to `/fleet/artifact` and its bounded
 * retries (2026-09-26, split out of artifacts.mjs — SOLID F051).
 *
 * Network delivery is its own reason to change, apart from what is on the disk
 * (artifacts.mjs) and how a page is screenshotted (artifactPreview.mjs). The
 * reporter imports neither: it is HANDED the three functions it runs —
 * `listChanged(placeDir, before)` (what the turn wrote), `buildUpload(entry,
 * owner, scrub, secretIn)` (one scrubbed body) and `renderPreview(bytes)` (the
 * screenshot) — so the delivery rules below are tested against a fake server
 * and a fake renderer, and a new source of bodies would not edit this file.
 *
 * ── DELIVERY ──
 *
 * A 2xx is delivered. A 4xx (other than 408/429) is TREATED AS DELIVERED — an
 * older SERVER 404s the whole route, and holding bodies it will refuse forever
 * would be the trace relay's wedge wearing a retry's clothes; a refusal of one
 * file (ended session, wrong owner) is equally permanent. A 5xx, 408, 429 or a
 * network error keeps the STORED BODY — the fields and the bytes as they were
 * scrubbed — and retries it on the next report beat, the settle's shape, at
 * most `MAX_TRIES` times; a newer copy of the same file replaces a held one.
 *
 * A PREVIEW THAT FAILS NEVER STOPS THE ARTIFACT: an HTML body goes out with
 * `renderState: 'unavailable'` and no preview, the renderer's explicit answer.
 */

import { fleetEndpoint } from './fleetWire.mjs';

/** A held upload is tried this many times in all, then dropped with a line. */
const MAX_TRIES = 4;
/** Held bodies across every owner — each can be two megabytes. */
const MAX_PENDING = 40;

/**
 * The reporter a work manager holds for its life. `report` is called once per
 * finished turn and never awaited by the turn (a slow uplink must not hold the
 * next turn behind a readout); `retryPending` rides the settle retry beat.
 */
export function createArtifactReporter({
  fleetUrl,
  token,
  userAgent,
  scrub,
  secretIn,
  fetchImpl,
  log = () => {},
  listChanged,
  buildUpload,
  renderPreview,
}) {
  const url = fleetEndpoint('artifact', fleetUrl);
  const doFetch = fetchImpl ?? ((...a) => fetch(...a));
  const pending = new Map(); // `${owner}:${name}` -> { body, tries }

  /** true = settled (delivered or permanently refused); false = hold it. */
  const post = async (body) => {
    const form = new FormData();
    for (const [k, v] of Object.entries(body.fields)) form.set(k, v);
    if (body.bytes) form.set('file', new Blob([body.bytes]), body.fields.name);
    if (body.preview) form.set('preview', new Blob([body.preview], { type: 'image/png' }), 'preview.png');
    try {
      const res = await doFetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'User-Agent': userAgent },
        signal: AbortSignal.timeout(30_000),
        body: form,
      });
      return (
        res.ok || (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429)
      );
    } catch {
      return false;
    }
  };

  const hold = (key, body, tries) => {
    if (tries >= MAX_TRIES) {
      pending.delete(key);
      log(`artifact ${body.fields.name}: not delivered after ${tries} tries — dropped`);
      return;
    }
    pending.delete(key); // re-insert at the tail, so the cap sheds the oldest
    pending.set(key, { body, tries });
    while (pending.size > MAX_PENDING) {
      const shed = pending.keys().next().value;
      pending.delete(shed);
      if (!chains.has(shed)) genOf.delete(shed);
    }
  };

  // ONE COPY OF A FILE IS IN FLIGHT AT A TIME, AND ONLY THE NEWEST MAY
  // DECIDE. Each report of a (owner, name) takes a fresh generation, and every
  // post for that key is chained behind the previous one — so a slow retry of
  // an OLD body can neither land on the server after the newer copy (the
  // server upserts by name, so the last write wins) nor re-hold itself over
  // the newer one when it fails. A body superseded before it went out is not
  // sent at all; one superseded while in flight has its answer discarded.
  let generation = 0;
  const genOf = new Map(); // key -> the generation allowed to decide
  const chains = new Map(); // key -> the tail of that key's post chain

  const send = (key, body, tries, gen) => {
    const run = (chains.get(key) ?? Promise.resolve()).then(async () => {
      if (genOf.get(key) !== gen) return; // superseded before it went out
      const ok = await post(body);
      if (genOf.get(key) !== gen) return; // a newer copy decides for this key
      if (ok) pending.delete(key);
      else hold(key, body, tries + 1);
    });
    const tail = run.catch(() => {});
    chains.set(key, tail);
    tail.then(() => {
      if (chains.get(key) !== tail) return;
      chains.delete(key);
      if (!pending.has(key)) genOf.delete(key); // settled: nothing left to order
    });
    return run;
  };

  let retrying = false;
  const retryPending = async () => {
    if (retrying || pending.size === 0) return;
    retrying = true;
    try {
      for (const [key, held] of [...pending]) {
        if (pending.get(key) !== held) continue; // superseded meanwhile
        await send(key, held.body, held.tries, genOf.get(key));
      }
    } finally {
      retrying = false;
    }
  };

  /** Upload what this turn changed in `placeDir`. Resolves to the number of
   *  bodies SENT this call (delivered or held), for the tests and the log. */
  const report = async ({ placeDir, before, sessionId, agentId, turnId }) => {
    if (!placeDir || (!sessionId && !agentId)) return 0;
    const changed = listChanged(placeDir, before);
    let n = 0;
    for (const entry of changed) {
      const body = buildUpload(entry, { sessionId, agentId, turnId }, scrub, secretIn);
      if (!body) continue;
      if (body.withheld) {
        log(`artifact ${entry.name}: not uploaded — it contains the value of ${body.withheld} from this machine's environment`);
        continue;
      }
      if (body.bytes && /\.html?$/i.test(entry.name)) {
        const measured = await renderPreview(body.bytes);
        body.fields.renderState = measured.renderState;
        if (measured.preview) body.preview = measured.preview;
      }
      const key = `${sessionId ?? agentId}:${entry.name}`;
      pending.delete(key); // this copy supersedes a held older one
      const gen = ++generation;
      genOf.set(key, gen); // …and one still in flight
      await send(key, body, 0, gen);
      n++;
    }
    return n;
  };

  return { report, retryPending, pendingCount: () => pending.size };
}
