/**
 * WHERE A SESSION WORKS — the place map, the directory it resolves to, the
 * worktree cut on first use, and the per-tab marker files beside its git dir.
 *
 * Split out of work.mjs (2026-09-26, SOLID F037). Every other beat — a turn's
 * spawn, the worktree sweep, ship, a preview re-check, the agent lane — asks
 * one of these four questions, and they have to agree: a tab in the checkout
 * measured against `sessions/<id>` reports nothing, and a marker written
 * unscoped hands one tab another's conversation. One home keeps them one
 * answer. The trust boundary (`isSafePathSegment` / `REPO_PLACE`) lives here
 * with the map it guards; the session lane is the only other writer and keeps
 * the same check (its comment says why).
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { git, isSafePathSegment, hasCommits, gitFailure } from './git.mjs';

/** The place id meaning "the checkout", not a worktree. Must match the
 *  server's REPO_PLACE — it is a wire value, not a local convention. */
export const REPO_PLACE = 'repo';

export function createWorkPlaces({ repoRoot, baseDir, baseRef, onRepoChanged }) {
  /**
   * WHERE EACH SESSION WORKS, learned from the turns we are handed.
   *
   * Every other beat — the worktree sweep, ship, the preview re-check — has to
   * ask the SAME directory the turn ran in, and only the turn job carries
   * `place`. Caching it here is what keeps them agreeing without a second
   * server→daemon field: a session absent from this map has never run a turn,
   * and its own id is the right answer for that case anyway (it is the default
   * place, and a session with no turn has no worktree either).
   *
   * A tab standing in the CHECKOUT is the case this exists for: its directory
   * is not `sessions/<id>` and never will be, so a sweep that assumed the
   * default would measure a directory that does not exist and report nothing —
   * which is exactly why "I still do not see a preview URL" was true of a tab
   * opened in the checkout.
   */
  const sessionPlaces = new Map();
  const placeOf = (sessionId) => sessionPlaces.get(sessionId) ?? sessionId;
  /**
   * Places straight off the roster, so a tab is measured the moment it EXISTS
   * rather than after somebody types into it.
   *
   * Learning only from turn jobs meant a tab nobody had spoken to yet was
   * measured at `sessions/<id>` — a directory that does not exist for a tab
   * working in the checkout — so it reported no branch, no diffstat and no
   * ports, and every control reading those had nothing to render.
   *
   * The roster is authoritative and turn jobs still agree with it; a session
   * the server does not name keeps whatever a turn taught, and failing that its
   * own id, which is the pre-places default.
   */
  /**
   * WHERE EACH TAB WORKS — and it has to be able to UNLEARN.
   *
   * This only ever set. Combined with a server that omitted null places, a tab
   * moved from the checkout back to its own worktree simply stopped being
   * mentioned, and this map kept the old value forever. `placeDir` decides
   * where a turn is SPAWNED and where the worktree is measured, so the browser
   * said "its own worktree" while the CLI went on working in the checkout, and
   * the tab reported the checkout's listeners as its own. That is the exact
   * confusion the whole places feature exists to prevent.
   *
   * An explicit `null` now means "its own worktree" and DELETES the entry.
   * Absence of the whole map still means "an older server said nothing", which
   * is the only thing absence can safely mean.
   */
  const learnPlaces = (map) => {
    if (!map || typeof map !== 'object') return;
    for (const [sid, place] of Object.entries(map)) {
      // VALIDATE AT THE TRUST BOUNDARY. `placeDir` joins this value straight
      // into `sessions/<place>` and it is the directory a turn is SPAWNED in
      // and a preview port is measured against — the security boundary for the
      // whole preview feature. The server resolves place to an enum (never a
      // path), but a server bug or compromise sending `../../etc` would
      // otherwise point a session's measured directory anywhere on the box and
      // defeat the port attribution. `sessionWorktreeReport` and `placeWtFor`
      // already reject an unsafe segment; checking at the intake covers the
      // consumers that do not (the preview-claim `placeDir` did not re-check).
      // NOT the only writer: `processWorkTurns` stores a turn job's place too,
      // and keeps the same check — validating one intake and not the other is
      // one deploy away from validating neither. REPO_PLACE resolves to
      // repoRoot, so it is allowed through despite not being a path segment.
      if (typeof place === 'string' && place && (place === REPO_PLACE || isSafePathSegment(place)))
        sessionPlaces.set(sid, place);
      // null / '' / an unsafe value: the server is telling us this tab is in its
      // OWN worktree (or is malformed). Falling back to the default requires
      // forgetting, not ignoring.
      else sessionPlaces.delete(sid);
    }
  };
  /** The DIRECTORY a session works in. Every path that used to build
   *  `sessions/<id>` by hand goes through here, or a tab in the checkout gets
   *  measured against a directory that does not exist. */
  const placeDir = (sessionId) => {
    const place = placeOf(sessionId);
    return place === REPO_PLACE ? repoRoot : join(baseDir, 'sessions', place);
  };

  /**
   * This tab's worktree — its held context, expressed as a place, ON A BRANCH.
   *
   * Fresh: branch `session/<id>` off the current base. Existing: touched not at
   * all — no fetch-reset-clean like a plan directory, because the dirty state
   * is the point. If the directory was retired but the branch survives, the
   * worktree re-attaches to the branch and the committed work is still there.
   */
  /**
   * WHERE A SESSION WORKS — its PLACE, which is a directory on a branch.
   *
   * A session used to BE a worktree: one tab, one directory, cut at birth and
   * retired at close. That binding was never an isolation guarantee — a turn
   * runs with permissions skipped, so the worktree is a starting directory and
   * not a fence, and any agent could always `cd` into another one. The product
   * was asserting an invariant it did not have.
   *
   * So a session now REFERENCES a place rather than being one. Many sessions
   * may name the same place; a session may name the repo checkout itself; and
   * `session/<own-id>` is simply the DEFAULT place, cut fresh at first turn,
   * which is why an absent `place` behaves exactly as every existing tab does.
   *
   * `'repo'` IS NOT A DIRECTORY NAME AND MUST NOT BECOME ONE. It resolves to
   * the checkout the daemon already serves — never created, never retired,
   * because it is not ours to remove. The value reaching here is a server-side
   * enum, never a browser-supplied path: `sessions.routes.ts` resolves it the
   * same way adoption resolves a cwd, and for the same reason.
   */
  const placeWtFor = (placeId, baseAt) => {
    if (placeId === REPO_PLACE) {
      // The checkout. `fresh: false` on purpose — nothing was opened, so no
      // caller may treat this as a newly-cut branch.
      return { wt: repoRoot, fresh: false };
    }
    if (!isSafePathSegment(placeId)) return null;
    const sessionId = placeId;
    const wt = join(baseDir, 'sessions', sessionId);
    const fresh = !existsSync(wt);
    if (fresh) {
      const branch = `session/${sessionId}`;
      // `baseAt` is the adoption override: a tab born from a terminal session
      // branches from THAT checkout's HEAD, because the conversation being
      // resumed was had against those commits — putting it on the project base
      // would hand it a repo state it has never seen. Everything else is
      // unchanged, the attach fallback included: a surviving branch already
      // chose its base, and re-basing it here would move committed work.
      const at = baseAt || baseRef();
      try {
        git(['worktree', 'add', '-b', branch, wt, at], repoRoot);
      } catch {
        git(['worktree', 'prune'], repoRoot);
        // A directory and a branch just stopped existing. The Repository block
        // would otherwise keep listing both until its own 60s scan came round.
        onRepoChanged();
        try {
          // The branch may already exist (a retired directory's work) — attach.
          git(['worktree', 'add', wt, branch], repoRoot);
        } catch {
          try {
            git(['worktree', 'add', '-b', branch, wt, at], repoRoot);
          } catch (e) {
            // Kept for the caller to SAY: an agent turn that cannot get a
            // worktree used to end "nothing" with no words at all.
            placeWtFor.lastError = hasCommits(repoRoot)
              ? `git could not create the worktree from ${at}: ${gitFailure(e)}`
              : `the repository ${repoRoot} has no commits yet, so there is nothing to branch from. Make a first commit there, then send the agent any message to try again.`;
            return null;
          }
        }
      }
      // NOTHING IS MATERIALIZED INTO A FRESH WORKTREE ANY MORE (2026-09-21),
      // and nothing replaced it.
      //
      // Two blocks stood here: one that wrote the decrypted vault bundle into a
      // newly-created worktree, and a second that retried on the next turn for
      // the restart window where the bundle had not warmed yet. The vault is
      // deleted — the owner: "no i dont want it" — so Flowviant holds no secret
      // for this project and has nothing to write.
      //
      // WHAT THE SOURCE OF A WORKTREE'S ENV IS NOW: the repo's own `.env`
      // files, wherever the repo puts them. A worktree branches from the
      // checkout, and a gitignored `.env` is by definition not in a fresh one —
      // which is the ordinary behaviour of `git worktree add`, the same thing a
      // person gets typing it themselves, and the operator's problem to solve
      // the way they already solve it (a symlink, a `direnv`, a copy in a
      // setup script). This product no longer claims otherwise, and the claim
      // is what was worth deleting: a promise that every session tab comes up
      // with the team's secrets is only kept while a vault exists to keep it.
      //
      // The CLI child still inherits the daemon's own environment exactly as it
      // always did (runTurn.mjs spawns with `{...process.env}`), so anything
      // exported in the shell the daemon was started from is present here.
    }
    return { wt, fresh };
  };

  /**
   * A file in the worktree's PRIVATE git dir (…/.git/worktrees/<name>). It
   * travels with the worktree, dies with `git worktree remove`, and is
   * invisible to `git status` — so nothing stored here can ever make the
   * session look dirty (a dirty tree refuses ships). A marker file in the
   * working tree itself would show up as an untracked path and block every
   * ship of an otherwise-clean session.
   */
  /**
   * A file beside the worktree's git dir, holding something about ONE TAB.
   *
   * `scope` is the session id and is NOT optional for anything per-tab. These
   * markers were named bare — `flowviant-codex-thread`, `flowviant-agy-
   * conversation` — which was unambiguous while one directory meant one tab.
   * The day tabs moved into their driver's project folder, every tab there
   * started reading and writing ONE marker: tab B would resume tab A's codex
   * thread, and the last turn to finish would overwrite the id for both.
   *
   * The turn LOCK is deliberately still un-scoped — it guards the directory
   * against a second CLI, which is a property of the place and not of a tab.
   */
  const sessionMetaPath = (wt, name, scope) => {
    try {
      const safe = scope && /^[A-Za-z0-9_-]{1,64}$/.test(String(scope)) ? `-${scope}` : '';
      return join(git(['rev-parse', '--absolute-git-dir'], wt), `${name}${safe}`);
    } catch {
      return null;
    }
  };

  return { sessionPlaces, placeOf, learnPlaces, placeDir, placeWtFor, sessionMetaPath };
}
