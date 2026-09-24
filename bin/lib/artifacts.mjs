/**
 * ARTIFACTS, daemon side (2026-09-22, 0.94.0) — the files a turn wrote to SHOW
 * the person, found after the turn and relayed.
 *
 * The owner asked whether Flowviant could "have it generate artifacts and
 * display artifacts there". The turn contracts gain one paragraph
 * (`ARTIFACTS_PARAGRAPH`, prompts.mjs): to show a page, a document, a chart or
 * an image, write it under `.flowviant/artifacts/` in the directory you stand
 * in. After each session turn and each agent turn this module lists that
 * directory and uploads what the turn changed to `POST /fleet/artifact`; the
 * Workbench draws it beside the thread. NOTHING HERE MAKES AN ARTIFACT — it
 * reads what the CLI wrote and relays it, scrubbed.
 *
 * ── WHAT THE TURN CHANGED, NOT WHAT IS THERE ──
 *
 * The directory is snapshotted (name → size:mtime) BEFORE the CLI spawns and
 * compared after it exits. The spec's words were "changed since the last
 * report", and a per-turn snapshot is the strict form of that, chosen for two
 * reasons: (1) every tab one person owns shares ONE place (the checkout, or
 * their own copy), so a file one tab wrote is on disk when a sibling tab's turn
 * ends — diffing against "last reported" per session would hand tab B every
 * artifact tab A ever drew; and (2) a snapshot needs no memory across a daemon
 * restart, which a "last reported" map would lose on every auto-update and then
 * re-upload the whole directory. The residual, stated: two tabs in one place
 * running turns AT THE SAME TIME (the place lock admits concurrent readers) can
 * each see the other's write land inside their window. The server's upsert by
 * (owner, name) and its bound keep that a duplicate, never a wrong answer.
 *
 * ── THE BOUNDS ──
 *
 * Regular files only, DEPTH ONE, `lstat` and never followed: a symlink an
 * agent planted at `.flowviant/artifacts/x.txt -> ~/.ssh/id_ed25519` is
 * reported as nothing, and the read itself opens with `O_NOFOLLOW` so a swap
 * between the lstat and the open cannot turn one into a follow. The directory
 * itself must be a real directory for the same reason. At most 40 files,
 * newest first. Types off the allowlist (the server's list, repeated here —
 * this is somebody's disk and one place checking is one deploy from zero) are
 * reported BY NAME and never read. Over `ARTIFACT_MAX_BYTES` likewise.
 *
 * ── TEXT IS SCRUBBED; A BINARY CARRYING A SECRET IS WITHHELD ──
 *
 * html, md, svg, json, csv and txt pass through `envScrub` before upload — the
 * turn trace's own scrub, for the trace's own reason: a page the agent wrote
 * can quote a value out of the checkout's `.env`, and an artifact is served to
 * a browser.
 *
 * The binary types CAN carry text, and this header used to say they could
 * not. A PNG has tEXt chunks, a PDF has streams that are often stored
 * uncompressed, a docx/pptx/xlsx is a zip whose entries may be STORED rather
 * than deflated — and a turn that can write a file can write a secret into
 * any of them. What they cannot be is REWRITTEN: `envScrub` swapping bytes
 * inside one corrupts it, and a corrupted binary served as the thing the agent
 * made is worse than none. So each binary is checked against the same scrub
 * list as exact byte substrings (`secretIn`, env.mjs) before it is uploaded,
 * and a hit SKIPS the file with a warn line naming it and the variable — never
 * a redacted copy, never a by-name row the page would draw as a file it merely
 * could not show. STATED: a value inside a deflated stream is not a substring
 * of the file, so this catches what is stored plainly and nothing more.
 *
 * The SERVER computes the sha256 of what it stored; the one sent here is for
 * the log.
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
 * NO VERSION FLOOR: a daemon→server report on a new endpoint. The prompt
 * paragraph is gated instead, on the roster's `artifactsAccepted` — a server
 * that cannot show an artifact must not have the CLI told it will.
 */

import { constants, closeSync, fstatSync, lstatSync, openSync, readdirSync, readSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { captureScreenshot } from './shot.mjs';

/** Relative to the directory the turn stands in. Under `.flowviant/`, which
 *  the exclude file already hides from git (`excludeInWorktree`). */
export const ARTIFACT_DIR = '.flowviant/artifacts';
/** The server's per-file ceiling, re-checked here. */
export const ARTIFACT_MAX_BYTES = 2 * 1024 * 1024;
export const ARTIFACT_BINARY_MODEL_MAX_BYTES = 20 * 1024 * 1024;
export const DESIGN_PREVIEW_MAX_BYTES = 2 * 1024 * 1024;
const PREVIEW_CSP = "default-src 'none'; script-src 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net/npm/ https://unpkg.com; style-src 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net/npm/ https://unpkg.com https://fonts.googleapis.com; img-src data: blob:; font-src data: https://fonts.gstatic.com; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
export const artifactMaxBytesFor = (name) => /\.(?:glb|bin)$/i.test(name)
  ? ARTIFACT_BINARY_MODEL_MAX_BYTES : ARTIFACT_MAX_BYTES;
/** Listed per scan, newest first — the server keeps as many per owner. */
export const ARTIFACT_MAX_FILES = 40;
/** A held upload is tried this many times in all, then dropped with a line. */
const MAX_TRIES = 4;
/** Held bodies across every owner — each can be two megabytes. */
const MAX_PENDING = 40;

/** The allowlist, by extension. The server's `ARTIFACT_TYPES`, repeated. */
export const ARTIFACT_TYPES = {
  html: { mime: 'text/html', text: true },
  htm: { mime: 'text/html', text: true },
  md: { mime: 'text/markdown', text: true },
  svg: { mime: 'image/svg+xml', text: true },
  png: { mime: 'image/png', text: false },
  jpg: { mime: 'image/jpeg', text: false },
  jpeg: { mime: 'image/jpeg', text: false },
  gif: { mime: 'image/gif', text: false },
  webp: { mime: 'image/webp', text: false },
  json: { mime: 'application/json', text: true },
  csv: { mime: 'text/csv', text: true },
  txt: { mime: 'text/plain', text: true },
  // DOCUMENTS (0.97.0): a Word file, a deck, a sheet or a PDF — what the
  // machine's docx/pptx/xlsx/pdf skills write. Binary, so never REWRITTEN (a
  // scrub inside a zip or a PDF corrupts it) but checked for a known secret's
  // bytes and withheld on a hit — see the header. Under the same cap. The app
  // offers the first three as a download and frames the PDF.
  docx: { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', text: false },
  pptx: { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', text: false },
  xlsx: { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', text: false },
  pdf: { mime: 'application/pdf', text: false },
  gltf: { mime: 'model/gltf+json', text: true },
  obj: { mime: 'model/obj', text: true },
  glb: { mime: 'model/gltf-binary', text: false },
  bin: { mime: 'application/octet-stream', text: false },
};

export function artifactTypeFor(name) {
  const dot = String(name).lastIndexOf('.');
  if (dot <= 0) return null;
  return ARTIFACT_TYPES[String(name).slice(dot + 1).toLowerCase()] ?? null;
}

/**
 * The directory's regular files, newest first, at most `ARTIFACT_MAX_FILES`.
 * `[]` for a directory that does not exist, is not a directory, or is a
 * symlink — nothing to report is the only honest reading of any of those.
 */
export function scanArtifacts(placeDir) {
  const dir = join(placeDir, ARTIFACT_DIR);
  /**
   * BOTH components are checked, not only the last (2026-09-23). `lstat` on
   * `.flowviant/artifacts` refuses a symlink AT that name, but it resolves
   * THROUGH a symlinked `.flowviant` — and git commits symlinks, so a cloned
   * repo carrying `.flowviant -> /some/dir` would have had this scan listing,
   * reading and uploading `/some/dir/artifacts/*`, a directory outside the
   * place the turn stood in. The knowledge sync already refuses a `.flowviant`
   * that is not a real directory (`flowviantDirOk`); this is the same check on
   * the read side.
   */
  try {
    const parent = lstatSync(join(placeDir, '.flowviant'));
    if (parent.isSymbolicLink() || !parent.isDirectory()) return [];
    if (!lstatSync(dir).isDirectory()) return [];
  } catch {
    return [];
  }
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    if (name.startsWith('.')) continue; // editor swap files, `.DS_Store`
    try {
      const st = lstatSync(join(dir, name));
      if (!st.isFile()) continue; // symlinks, directories, sockets: nothing
      out.push({ name, path: join(dir, name), size: st.size, mtimeMs: st.mtimeMs });
    } catch {
      /* vanished between the list and the stat */
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name));
  return out.slice(0, ARTIFACT_MAX_FILES);
}

const sigOf = (e) => `${e.size}:${e.mtimeMs}`;

/** name → size:mtime, taken before the CLI spawns. */
export function snapshotArtifacts(placeDir) {
  return new Map(scanArtifacts(placeDir).map((e) => [e.name, sigOf(e)]));
}

/** What the turn wrote: every entry whose (name, size, mtime) is not what the
 *  snapshot held. A deleted file is not reported — the server's copy is
 *  scrollback and goes with the session or the agent. */
export function changedArtifacts(before, entries) {
  return entries.filter((e) => before?.get(e.name) !== sigOf(e));
}

/** Read a regular file WITHOUT following a symlink planted after the lstat. */
function readNoFollow(path, limit) {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > limit) return null;
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = readSync(fd, buf, off, st.size - off, off);
      if (n <= 0) break;
      off += n;
    }
    return buf.subarray(0, off);
  } finally {
    closeSync(fd);
  }
}

/** FNV-1a, 32-bit, as 8 hex — verbatim against the server's `fnv1a8`
 *  (apps/api/src/routes/sessionsAttachments.routes.ts). */
function artifactFnv1a8(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
const ARTIFACT_SAFE_EXT_RE = /^[A-Za-z0-9]{1,10}$/;
/**
 * `safeFileName`, verbatim in effect (apps/api/src/routes/sessionsAttachments.
 * routes.ts): keeps the extension through a cut. `entry.name` is already a
 * real, depth-one, separator-free basename off this disk, so this only ever
 * differs from it on an over-long name — but that is exactly the case the
 * server's own `safeFileName(rawName)` would otherwise re-cut DIFFERENTLY
 * from whatever this reported, since a bare truncation and an
 * extension-preserving one disagree past 80 characters. Applying the same
 * rule here means the server's re-application is a no-op and the name a
 * design or research delivery is judged by is the one this machine reported.
 */
function safeArtifactName(raw) {
  const clean = String(raw ?? '').replace(/[^A-Za-z0-9._-]/g, '_');
  if (clean.length <= 80) return clean || 'artifact';
  const dot = clean.lastIndexOf('.');
  const ext = dot > 0 && ARTIFACT_SAFE_EXT_RE.test(clean.slice(dot + 1)) ? clean.slice(dot + 1) : '';
  const stem = ext ? clean.slice(0, dot) : clean;
  const tag = `-${artifactFnv1a8(clean)}`;
  const room = 80 - tag.length - (ext ? ext.length + 1 : 0);
  return `${stem.slice(0, room)}${tag}${ext ? `.${ext}` : ''}`;
}

/**
 * ONE UPLOAD BODY, as data — fields plus optional bytes — so a held body is
 * re-sent exactly as it was first built (scrubbed once, never re-read from a
 * disk the agent may have changed since).
 */
export function buildArtifactUpload(entry, { sessionId, agentId, turnId }, scrub = (s) => s, secretIn = () => null) {
  const type = artifactTypeFor(entry.name);
  const fields = {
    ...(sessionId ? { sessionId } : { agentId }),
    ...(turnId ? { turnId } : {}),
    name: safeArtifactName(entry.name),
    bytes: String(entry.size),
  };
  if (!type) return { fields, bytes: null }; // reported by name only
  const maxBytes = artifactMaxBytesFor(entry.name);
  if (entry.size > maxBytes) return { fields: { ...fields, tooLarge: '1' }, bytes: null };
  let bytes;
  try {
    bytes = readNoFollow(entry.path, maxBytes);
  } catch {
    return null; // vanished, or a symlink swapped in: nothing to say
  }
  if (!bytes) return { fields: { ...fields, tooLarge: '1' }, bytes: null };
  if (!type.text) {
    // A binary is never rewritten; one carrying a known secret is not sent.
    const secret = secretIn(bytes);
    if (secret) return { withheld: secret, fields };
  } else {
    bytes = Buffer.from(String(scrub(bytes.toString('utf8'))), 'utf8');
    // A redaction marker can be longer than the value it replaced.
    if (bytes.byteLength > maxBytes) {
      return { fields: { ...fields, bytes: String(bytes.byteLength), tooLarge: '1' }, bytes: null };
    }
  }
  return {
    fields: {
      ...fields,
      bytes: String(bytes.byteLength),
      mime: type.mime,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    },
    bytes,
  };
}

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

/**
 * The reporter a work manager holds for its life. `report` is called once per
 * finished turn and never awaited by the turn (a slow uplink must not hold the
 * next turn behind a readout); `retryPending` rides the settle retry beat.
 */
export function createArtifactReporter({ fleetUrl, token, userAgent, scrub, secretIn, fetchImpl, log = () => {} }) {
  const url = String(fleetUrl).replace(/\/agents\/?$/, '/artifact');
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
    const changed = changedArtifacts(before, scanArtifacts(placeDir));
    let n = 0;
    for (const entry of changed) {
      const body = buildArtifactUpload(entry, { sessionId, agentId, turnId }, scrub, secretIn);
      if (!body) continue;
      if (body.withheld) {
        log(`artifact ${entry.name}: not uploaded — it contains the value of ${body.withheld} from this machine's environment`);
        continue;
      }
      if (body.bytes && /\.html?$/i.test(entry.name)) {
        const measured = await renderDesignPreview(body.bytes);
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
