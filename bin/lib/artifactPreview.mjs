/**
 * THE DESIGN PREVIEW — a screenshot of an HTML artifact, taken in a browser
 * (2026-09-26, split out of artifacts.mjs — SOLID F051).
 *
 * Browser rendering is its own reason to change: a Chrome flag, a CSP tweak or
 * a viewport size has nothing to do with how the artifact directory is scanned
 * or how an upload is retried. The reporter (`artifactReporter.mjs`) is handed
 * this function rather than importing it, so a test can stand in a renderer
 * that never launches a browser.
 *
 * It renders the SCRUBBED bytes, never the checkout's source, under the
 * artifact box's own network fence (`PREVIEW_CSP`) placed before any
 * model-written markup executes. A failed measurement is explicit
 * (`renderState: 'unavailable'`); a daemon older than this simply sends no
 * `renderState`, which the server reads as unmeasured.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { captureScreenshot } from './shot.mjs';

export const DESIGN_PREVIEW_MAX_BYTES = 2 * 1024 * 1024;
const PREVIEW_CSP = "default-src 'none'; script-src 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net/npm/ https://unpkg.com; style-src 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net/npm/ https://unpkg.com https://fonts.googleapis.com; img-src data: blob:; font-src data: https://fonts.gstatic.com; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

/** Render the scrubbed HTML, never the checkout's unsanitized source. A
 * failed browser measurement is explicit; older daemon reports are absent. */
export async function renderDesignPreview(bytes, capture = captureScreenshot) {
  const dir = mkdtempSync(join(tmpdir(), 'flowviant-design-'));
  try {
    const html = join(dir, 'design.html');
    const png = join(dir, 'design.png');
    // A fresh Chrome profile has no Flowviant credentials. Put the artifact
    // box's network fence before any model-written markup executes.
    writeFileSync(html, Buffer.concat([
      Buffer.from(`<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}">`),
      bytes,
    ]));
    const result = await capture({ url: pathToFileURL(html).href, out: png, width: 720, height: 450, timeoutMs: 15_000 });
    if (!result.ok) return { renderState: 'unavailable' };
    const image = readFileSync(png);
    if (image.byteLength > DESIGN_PREVIEW_MAX_BYTES || !image.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) {
      return { renderState: 'unavailable' };
    }
    return { renderState: 'rendered', preview: image };
  } catch {
    return { renderState: 'unavailable' };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
