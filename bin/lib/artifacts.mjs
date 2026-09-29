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
 * Regular files only, to DEPTH FOUR (relative paths, 0.99.0 — a bundle's
 * sidecars), `lstat` and never followed: a symlink an
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
 * list as exact byte substrings (`secretIn`, uplinkScrub.mjs) before it is uploaded,
 * and a hit SKIPS the file with a warn line naming it and the variable — never
 * a redacted copy, never a by-name row the page would draw as a file it merely
 * could not show. STATED: a value inside a deflated stream is not a substring
 * of the file, so this catches what is stored plainly and nothing more.
 *
 * The SERVER computes the sha256 of what it stored; the one sent here is for
 * the log.
 *
 * ── DELIVERY LIVES NEXT DOOR (2026-09-26) ──
 *
 * This module is the DISK half: scan, diff against the snapshot, and prepare
 * one upload body (scrubbed text, withheld binaries). The screenshot of an
 * HTML page is `artifactPreview.mjs` (a browser); the queued POST with its
 * bounded retries is `artifactReporter.mjs` (the network). Three reasons to
 * change, three files — split from one 439-line module (SOLID F051).
 *
 * NO VERSION FLOOR: a daemon→server report on a new endpoint. The prompt
 * paragraph is gated instead, on the roster's `artifactsAccepted` — a server
 * that cannot show an artifact must not have the CLI told it will.
 */

import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { cutKeepingExtension } from './safeFileName.mjs';
import {
  ARTIFACT_BINARY_MODEL_EXTS,
  ARTIFACT_BINARY_MODEL_MAX_BYTES,
  ARTIFACT_MAX_BYTES,
  ARTIFACT_MAX_PER_OWNER,
  ARTIFACT_TYPES,
} from './artifactPolicy.mjs';

/** Relative to the directory the turn stands in. Under `.flowviant/`, which
 *  the exclude file already hides from git (`excludeInWorktree`). */
export const ARTIFACT_DIR = '.flowviant/artifacts';
/**
 * THE ALLOWLIST AND THE CEILINGS are the server's, from its GENERATED snapshot
 * (`artifactPolicy.mjs`, rendered from packages/shared/src/schemas/
 * artifact.schema.ts — 2026-09-26, SOLID F044). They were hand-repeated here,
 * and a type added on one side only was either reported by name while the
 * server could serve it, or sent as a type the server refuses. Re-checked here
 * all the same: this is somebody's disk, and one place checking is one deploy
 * from zero.
 */
export const artifactMaxBytesFor = (name) => {
  const ext = String(name).slice(String(name).lastIndexOf('.') + 1).toLowerCase();
  return ARTIFACT_BINARY_MODEL_EXTS.includes(ext) ? ARTIFACT_BINARY_MODEL_MAX_BYTES : ARTIFACT_MAX_BYTES;
};
/** Listed per scan, newest first — the server keeps as many per owner. */
export const ARTIFACT_MAX_FILES = ARTIFACT_MAX_PER_OWNER;

/**
 * THE ARTIFACTS DIRECTORY, STANDING BEFORE A FENCED KIND TURN SPAWNS (0.114.0).
 *
 * Codex's image profile makes `<place>/.flowviant/artifacts` its ONE writable
 * root, and a root that does not exist cannot be made from inside the fence
 * (measured on 0.156.1: `mkdir` under it failed "Read-only file system"). So
 * the lane makes it first — and only as a REAL directory under a REAL
 * `.flowviant`, the scan's own rule (`scanArtifacts`) on the write side: a
 * repository can commit `.flowviant -> ~/.ssh`, and a fence granted on a path
 * through that link is a write grant on its target. Either component being a
 * symlink or a non-directory answers false and creates nothing; the caller
 * refuses the turn in words.
 */
export function ensureArtifactDir(placeDir) {
  const parent = join(placeDir, '.flowviant');
  const dir = join(placeDir, ARTIFACT_DIR);
  const real = (p) => {
    try {
      const st = lstatSync(p);
      return st.isDirectory() && !st.isSymbolicLink() ? true : false;
    } catch (e) {
      return e?.code === 'ENOENT' ? null : false;
    }
  };
  if (real(parent) === false || real(dir) === false) return false;
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    return false;
  }
  return real(parent) === true && real(dir) === true;
}

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
  const out = [];
  const walk = (at, prefix = '', depth = 0) => {
    if (depth > 4) return;
    let names;
    try { names = readdirSync(at); } catch { return; }
    for (const part of names) {
      if (part.startsWith('.')) continue;
      const name = prefix ? `${prefix}/${part}` : part;
      const path = join(at, part);
      try {
        const st = lstatSync(path);
        if (st.isDirectory() && !st.isSymbolicLink()) walk(path, name, depth + 1);
        else if (st.isFile() && !st.isSymbolicLink()) out.push({ name, path, size: st.size, mtimeMs: st.mtimeMs });
      } catch { /* vanished */ }
    }
  };
  walk(dir);
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

/** What the turn wrote in `placeDir` since `before` — the scanner the reporter
 *  is handed (`artifactReporter.mjs`), as one function. */
export function changedSince(placeDir, before) {
  return changedArtifacts(before, scanArtifacts(placeDir));
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

/**
 * `safeFileName`'s CUT (bin/lib/safeFileName.mjs — `cutKeepingExtension`, the
 * server's rule): keeps the extension through a cut. Applied to each relative
 * path component, so a model under `scene/` keeps that relation to its page.
 * The context rule around the cut is this lane's own: a component that is
 * already safe — spaces included — passes through untouched, because a bundle
 * path names files the page references by exactly that spelling. The cut only
 * differs from the component on an over-long name — but that is exactly the
 * case the server's own `safeFileName(rawName)` would otherwise re-cut
 * DIFFERENTLY from whatever this reported, so applying the same cut here means
 * the server's re-application is a no-op and the name a design or research
 * delivery is judged by is the one this machine reported.
 */
function safeArtifactName(raw) {
  if (typeof raw === 'string' && raw.length <= 80 && /^[A-Za-z0-9][A-Za-z0-9._ -]*$/.test(raw) && !raw.endsWith('.')) return raw;
  const clean = String(raw ?? '').replace(/[^A-Za-z0-9._-]/g, '_');
  return clean ? cutKeepingExtension(clean) : 'artifact';
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
    name: entry.name.split('/').map(safeArtifactName).join('/'),
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
