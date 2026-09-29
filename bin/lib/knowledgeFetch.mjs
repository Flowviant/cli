/**
 * THE KNOWLEDGE DOWNLOAD (2026-09-26, split out of knowledge.mjs — SOLID SRP,
 * F049): the one place the daemon spells the `/fleet/knowledge/:id` and
 * `/fleet/library/:id` requests. The sync takes the bytes through an injected
 * `fetchFile`, so the transport changes here without touching the disk rules
 * (knowledgeFiles.mjs) or the roster driver (knowledge.mjs).
 */

import { fleetEndpoint } from './fleetWire.mjs';
import { KNOWLEDGE_BINARY_MODEL_MAX_BYTES } from './knowledgeLibrary.mjs';

/**
 * The `/fleet/knowledge/:id` download, in the attachment fetch's own shape:
 * the machine credential as a bearer, a 60s ceiling, and the size checked on
 * the header AND on the bytes (a lying header must not decide the cap). The
 * URL is derived from the roster URL the way every `/fleet/*` path is, so a
 * self-hosted `FLOWVIANT_FLEET_URL` is honoured.
 */
export function knowledgeFetcher({ fleetUrl, token, userAgent, maxBytes = KNOWLEDGE_BINARY_MODEL_MAX_BYTES }) {
  const base = fleetEndpoint('knowledge', fleetUrl);
  // A kept library item (0.97.0) is its sibling, `GET /fleet/library/:id` —
  // the same credential, the same shape, the same caps.
  const libraryBase = fleetEndpoint('library', fleetUrl);
  return async (id, { library = false, preview = false, fileIndex = null } = {}) => {
    const suffix = preview ? '/preview' : Number.isSafeInteger(fileIndex) && fileIndex >= 0 ? `/file/${fileIndex}` : '';
    const res = await fetch(`${library ? libraryBase : base}/${encodeURIComponent(id)}${suffix}`, {
      headers: { Authorization: `Bearer ${token}`, 'User-Agent': userAgent },
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (Number(res.headers.get('content-length') ?? '0') > maxBytes) {
      // Returned rather than thrown: over the cap is a REFUSAL, permanent for
      // this rev, not a failure the backoff should keep retrying.
      return Buffer.alloc(maxBytes + 1);
    }
    return Buffer.from(await res.arrayBuffer());
  };
}
