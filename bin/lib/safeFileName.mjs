/**
 * THE EXTENSION-PRESERVING 80-CHARACTER NAME, daemon side (2026-09-26, split
 * out of knowledge.mjs, artifacts.mjs and work.mjs — SOLID F043).
 *
 * The rule is the server's `safeFileName` (apps/api/src/routes/
 * sessionsAttachments.routes.ts), and it had THREE hand-kept daemon copies —
 * one per caller — each re-stating the FNV-1a hash and the stem cut. A copy
 * that drifted by one character would store a file under one name while the
 * server re-derived another, which is exactly the disagreement the rule was
 * adopted to end (2026-09-24: a bare `slice(0, 80)` cut an 84-character
 * `….html` mockup to `….` and its bytes were discarded).
 *
 * Two layers, because the callers need different context rules around one
 * common cut:
 *   - `cutKeepingExtension(clean)` — the cut alone, over an ALREADY sanitised
 *     name. Artifacts use only this: a bundle path is cut per component and
 *     keeps its safe spaces (see `safeArtifactName`).
 *   - `safeFileName(raw, fallback)` — the server's whole rule: last path
 *     component, `[^A-Za-z0-9._-]` → `_`, no leading dot or dash, then the cut.
 *     Each caller names its own fallback for an empty name ('file' for the
 *     knowledge library, 'attachment' for turn uploads — the server's).
 *
 * The server keeps its own independent validation (the daemon is published
 * separately and a server deploy cannot upgrade it); `safeFileName.test.mjs`
 * and the API's `sessionsAttachments.routes.test.ts` pin the SAME table of
 * canonical outputs, so a change on one side fails the other's release check.
 */

/** The longest name either function returns. */
export const SAFE_NAME_MAX = 80;
/** What counts as an extension worth keeping through a cut. */
const SAFE_EXT_RE = /^[A-Za-z0-9]{1,10}$/;

/** FNV-1a, 32-bit, as 8 hex — deterministic, so the same long name always maps
 *  to the same stored name. Verbatim against the server's `fnv1a8`. */
export function fnv1a8(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * An over-long name is its stem, cut, plus an 8-hex hash of the WHOLE name,
 * plus the extension: stable across calls, at most 80 characters, and a name
 * that already fits is returned unchanged — so it is idempotent over its own
 * output and the server's re-application is a no-op.
 */
export function cutKeepingExtension(clean) {
  if (clean.length <= SAFE_NAME_MAX) return clean;
  const dot = clean.lastIndexOf('.');
  const ext = dot > 0 && SAFE_EXT_RE.test(clean.slice(dot + 1)) ? clean.slice(dot + 1) : '';
  const stem = ext ? clean.slice(0, dot) : clean;
  const tag = `-${fnv1a8(clean)}`;
  const room = SAFE_NAME_MAX - tag.length - (ext ? ext.length + 1 : 0);
  return `${stem.slice(0, room)}${tag}${ext ? `.${ext}` : ''}`;
}

/**
 * The server's `safeFileName`: drops every path separator, never starts with a
 * dot or a dash, keeps the extension through a cut. `fallback` answers a name
 * that sanitises to nothing.
 */
export function safeFileName(raw, fallback) {
  const clean = String(raw ?? '')
    .split(/[\\/]/)
    .pop()
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/^[.-]+/, '');
  if (!clean) return fallback;
  return cutKeepingExtension(clean);
}
