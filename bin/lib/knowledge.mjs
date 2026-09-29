/**
 * PROJECT KNOWLEDGE, daemon side (2026-09-22, 0.94.0) — the library a person
 * keeps for their own Claude, materialised where a CLI can read it.
 *
 * The owner asked whether the Workbench could be "a clone of claude projects":
 * files uploaded once and a standing Instructions text, read by every turn on
 * the project. The server holds the bytes; the roster carries a MANIFEST
 * (`knowledge: { rev, instructions, files: [{ id, name, bytes, sha256 }] }`);
 * the daemon makes `<checkout>/.flowviant/knowledge/` match it, and the turn
 * prompts name that directory. Nothing here reads a file's CONTENTS for any
 * purpose but writing it — the only brain is the CLI, reading off a disk.
 *
 * ── ONE COPY PER BOX, IN THE CHECKOUT ──
 *
 * Not per worktree. Every session, capture and agent turn on this box runs in
 * some directory under the same user, and every one of them can read an
 * ABSOLUTE path; a copy per worktree would be a copy per agent, fifty megabytes
 * times however many agents are open, and N copies that can each go stale on
 * their own. The prompt hands the absolute path.
 *
 * It is never committed: its paths (`FLOWVIANT_OWN_PATHS` — never the whole
 * `.flowviant/`, 2026-09-23) are written to the exclude file git actually
 * reads (`excludeInWorktree`, which resolves `--git-common-dir`, so one call
 * covers the checkout and every linked worktree alike). An untracked
 * `.flowviant/` in the checkout would make the operator's own `git status`
 * dirty and, for a tab standing in the checkout, show the library in the
 * rail's diffstat as session changes.
 *
 * ── THE THREE STATES OF THE ROSTER KEY ──
 *
 *   ABSENT — an older server, a project that never had knowledge, or a daemon
 *     below the floor (it never sees this code). LEAVE THE DIRECTORY ALONE. An
 *     absence is what an older server says on every poll; letting it mean
 *     "delete the library" would wipe it on a server rollback.
 *   `{ rev, files: [], instructions: null }` — the project HAD knowledge and
 *     the person emptied it. The server sends this for as long as the
 *     project's rev is above zero (forever after the first write), so emptying
 *     is SAID, never inferred. The directory is removed, and with it the
 *     prompt paragraph — which is rendered only while the directory exists.
 *   non-empty — sync to it.
 *
 * ── WHAT A SYNC DOES ──
 *
 * When `rev` differs from the last one materialised (held in memory AND in a
 * marker file beside the directory, so a restart does not re-sync a library
 * that is already on disk): download each file whose sha256 differs from the
 * local copy — a local copy somebody edited by hand is restored, because the
 * library is the server's and the directory is its mirror; delete every
 * regular file the manifest no longer names; write or remove INSTRUCTIONS.md.
 *
 * A FAILED DOWNLOAD DOES NOT ADVANCE THE REV. The next poll tries again — but
 * only the files that still differ, and on a widening backoff, so a server
 * that 500s one file cannot make this box re-download fifty megabytes every
 * ten seconds. A file refused on SIZE is not a failure to retry: it is
 * permanent for that rev, skipped with a warning, and the rest of the library
 * is written.
 *
 * ── WHERE EACH PART LIVES (2026-09-26, SOLID SRP, F049) ──
 *
 * This module is the ROSTER DRIVER alone: the rev held in memory, the
 * serialised sync, the backoff. The pure naming, path and catalog rules —
 * including the kept library's four subdirectories — are knowledgeLibrary.mjs;
 * the disk (the sync itself, the marker, `knowledgeDirFor`) is
 * knowledgeFiles.mjs; the `/fleet/knowledge` and `/fleet/library` download is
 * knowledgeFetch.mjs. Callers import the owner they need.
 */

import { isKnowledgeManifest, libraryItemsOf } from './knowledgeLibrary.mjs';
import {
  knowledgeMarkerHasLibrary,
  libraryMissing,
  libraryStale,
  readKnowledgeMarker,
  syncKnowledge,
  writeKnowledgeMarker,
} from './knowledgeFiles.mjs';

/**
 * The per-process driver: called with every roster's `knowledge` key.
 *
 * Holds the last-materialised rev in memory (seeded from the marker, so a
 * restart does not re-sync), serialises syncs (a slow download must never be
 * overlapped by the next poll's), and backs off after a failure: 30s, 60s,
 * 120s … capped at ten minutes. Never throws into the poll loop.
 */
export function createKnowledgeSync({
  checkoutDir,
  fetchFile,
  onExclude = () => {},
  log = () => {},
  now = () => Date.now(),
}) {
  let rev = readKnowledgeMarker(checkoutDir);
  /** Whether the sync that wrote `rev` carried a library key — the marker's
   *  `:lib`, then this process's own memory. */
  let libSynced = knowledgeMarkerHasLibrary(checkoutDir);
  /** Library paths refused for size at `rev` — not expected on disk. */
  let libRefused = new Set();
  let busy = false;
  let failures = 0;
  let retryAt = 0;
  /** The rev the backoff belongs to. A NEW rev is a new library and is tried
   *  at once — waiting out a backoff earned by a file the person has since
   *  removed would hold their next upload hostage to the last one's failure. */
  let failedRev = null;

  return {
    /** The rev last fully materialised, or null. */
    get rev() {
      return rev;
    },
    /** @returns {Promise<null | ReturnType<typeof syncKnowledge>>} null when
     *  nothing ran (absent key, same rev, busy, or backing off). */
    async onRoster(knowledge) {
      if (knowledge === undefined || knowledge === null) return null; // ABSENT: leave it alone
      if (!isKnowledgeManifest(knowledge)) return null;
      /**
       * THE SAME REV IS NOT ALWAYS THE SAME DISK (2026-09-23). The marker says
       * which rev was written; it cannot say the directory is still there. An
       * `rm -r .flowviant/knowledge` — by hand, or by an agent tidying its
       * checkout — left the marker naming the current rev, so every poll after
       * it matched and returned, the prompt paragraph vanished with the
       * directory (`knowledgeDirFor` answers null), and every turn ran without
       * the library until somebody happened to edit it. A manifest that names
       * something over a directory that does not exist is re-synced; files
       * already on disk match by hash and are not fetched again.
       */
      //
      // …AND THE SAME REV IS NOT ALWAYS THE SAME LIBRARY: an upgrade from a
      // daemon that ignored the `library` key, or a hand-deleted `designs/`,
      // leaves the marker current over files a card's references name. See
      // `libraryStale`.
      if (
        knowledge.rev === rev &&
        !libraryMissing(checkoutDir, knowledge) &&
        !libraryStale(checkoutDir, knowledge, { synced: libSynced, refused: libRefused })
      )
        return null;
      if (busy) return null;
      if (knowledge.rev === failedRev && now() < retryAt) return null;
      busy = true;
      try {
        try {
          onExclude(checkoutDir);
        } catch {
          /* a convenience, never a gate */
        }
        const r = await syncKnowledge({ checkoutDir, manifest: knowledge, fetchFile });
        if (r.ok) {
          rev = knowledge.rev;
          libSynced = libraryItemsOf(knowledge) !== null;
          libRefused = new Set(r.refused);
          failures = 0;
          retryAt = 0;
          failedRev = null;
          writeKnowledgeMarker(checkoutDir, rev, libSynced);
          if (r.wrote.length || r.removed.length) {
            log(
              `knowledge · synced rev ${rev}` +
                (r.wrote.length ? ` · ${r.wrote.length} written` : '') +
                (r.removed.length ? ` · ${r.removed.length} removed` : '')
            );
          }
        } else {
          failures = knowledge.rev === failedRev ? failures + 1 : 1;
          failedRev = knowledge.rev;
          retryAt = now() + Math.min(600_000, 30_000 * 2 ** (failures - 1));
          log(`knowledge · ${r.failed.length} file(s) did not download — retrying`);
        }
        if (r.refused.length) {
          log(`knowledge · skipped over the size cap: ${r.refused.join(', ')}`);
        }
        return r;
      } catch (e) {
        failures = knowledge.rev === failedRev ? failures + 1 : 1;
        failedRev = knowledge.rev;
        retryAt = now() + Math.min(600_000, 30_000 * 2 ** (failures - 1));
        log(`knowledge · sync failed: ${e?.message ?? e}`);
        return null;
      } finally {
        busy = false;
      }
    },
  };
}
