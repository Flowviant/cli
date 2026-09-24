/** Session branch shipping and settlement. */
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { git, baseBranchName, isSafePathSegment } from './git.mjs';
import { mergeOutward as shipMergeOutward } from './shipMerge.mjs';
import { c, note, ok, warn } from './ui.mjs';
import { scrub as envScrub } from './env.mjs';

export function createWorkShipper({
  inPlace,
  placeOf,
  settleShip,
  REPO_PLACE,
  repoRoot,
  baseDir,
  gitNet,
  baseRef,
  placeWtFor,
  turnLockedByLivePid,
  sessionMetaPath,
  state,
}) {
  const { shipping, pendingShipReports } = state;

  // Ship — a session's branch merging to main, on the human's word.
  //
  // --no-ff, NEVER squash: every delivered card carries commit shas as its
  // receipts, and a squash would point them all at commits that no longer
  // exist on main. Sequence: idempotency FIRST (a re-offered job after a lost
  // report recovers its receipts and re-reports — it must never re-merge, and
  // never be refused by checks that judge a merge this job already made).
  // Then two paths. A LIVE session: re-open the worktree if it was retired,
  // defer while a turn's CLI holds it, refuse a dirty worktree
  // (auto-committing someone's mid-thought state is not shipping, it is
  // guessing), refuse a worktree that left its own branch, fold main INTO the
  // branch first so conflicts surface where the session can resolve them,
  // then merge THE RESOLVED TIP outward through a throwaway worktree so
  // nobody's checkout moves — receipts and merged ref are the same sha by
  // construction. An ENDED session (absent from the roster's
  // activeWorkSessions): the BRANCH is the session now — nobody can commit,
  // discard, or resolve anything in its directory, so the checks whose
  // remedies address a live tab don't apply; merge the tip directly through
  // the throwaway, and a conflict fails honestly. Every exit reports
  // ship-done exactly once — except a deliberate deferral, re-offered next
  // poll; a ship that failed silently leaves the human believing their work
  // is on main.
  const processShipJobs = (jobs, activeIds) => {
    // Field absent (older server) = no liveness signal: treat every session
    // as live, which keeps the stricter checks.
    const liveIds = Array.isArray(activeIds) ? new Set(activeIds) : null;
    for (const job of jobs ?? []) {
      if (!job || typeof job.sessionId !== 'string') continue;
      if (shipping.has(job.sessionId)) continue;
      // The merge already LANDED and only the report is owed — flushing
      // delivers it; re-running the ship would misread its own success.
      if (pendingShipReports.has(job.sessionId)) continue;
      shipping.add(job.sessionId);
      // A WRITER, keyed by PLACE: ship folds and merges with git in this
      // directory, and no CLI running here can coordinate with that. Keyed by
      // place rather than by session id, which is what this used to do while
      // turns keyed on the place — so the two never shared a lock and the
      // guarantee in this comment was not actually held. `shipping` (above)
      // keeps overlapping polls from queueing the same job twice.
      inPlace(placeOf(job.sessionId), true, async () => {
        let settled = false;
        let deferred = false;
        const done = async (payload) => {
          if (settled) return;
          settled = true;
          await settleShip(job.sessionId, payload);
        };
        try {
          if (!isSafePathSegment(job.sessionId)) {
            await done({ ok: false, error: 'invalid session id' });
            return;
          }
          note(`${c.cyan('ship')} ${c.dim(`— "${job.sessionName || job.sessionId}"`)}`);
          /**
           * WHAT IS ACTUALLY CHECKED OUT — not what we named it at birth.
           *
           * Ship used to compute `session/<id>` and then REFUSE if HEAD had
           * moved: "ask it to return to its session branch, then ship again".
           * That refusal is the thing this product says it never does — it had
           * no reason of its own beyond bookkeeping, and in a terminal
           * `git checkout -b` breaks nothing, which is the whole standard this
           * surface is held to.
           *
           * The bug it was written for was real and is fixed properly here
           * rather than frozen out: ship once merged the branch NAME while
           * logging HEAD, so receipts named commits that never landed on main.
           * That was TWO SOURCES OF TRUTH, not branch switching. There is one
           * now, and it is the worktree's own HEAD.
           *
           * Resolved BEFORE the idempotency check below, and that ordering is
           * load-bearing: `session/<id>` can still exist, stale and already an
           * ancestor of base, while the real work sits on the branch that was
           * checked out afterwards. Asking the old name first would answer
           * "already merged — nothing new to ship" over unshipped commits.
           *
           * A directory that is gone (a retired or closed tab) cannot be asked,
           * so the recorded name is the fallback — the one case where the name
           * is the only thing there is.
           */
          // The session's PLACE — the directory it actually works in.
          const shipPlace = placeOf(job.sessionId);
          const wt = shipPlace === REPO_PLACE ? repoRoot : join(baseDir, 'sessions', shipPlace);
          let branch = `session/${job.sessionId}`;
          let detached = false;
          if (existsSync(wt)) {
            try {
              branch = git(['symbolic-ref', '--short', 'HEAD'], wt);
            } catch {
              detached = true;
            }
          }
          // THE ONE REFUSAL LEFT, and it is not policy. A detached HEAD names
          // no branch, so there is nothing to merge and nothing to record —
          // that is an ambiguity in git, not a rule of ours.
          if (detached) {
            await done({
              ok: false,
              error:
                'this session is on a detached HEAD — no branch to ship. Ask it to check out a branch, then ship again',
            });
            return;
          }
          let branchExists = true;
          try {
            git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], repoRoot);
          } catch {
            branchExists = false;
          }
          // "Nothing to ship" is a statement about the BRANCH. A retired
          // directory is not a missing session — retirement promises that
          // committed work survives, and ship re-attaches below to keep it.
          if (!existsSync(wt) && !branchExists) {
            await done({
              ok: false,
              error: 'nothing to ship — this session has no branch on this machine',
            });
            return;
          }
          try {
            gitNet(['fetch', 'origin', '--quiet'], 60_000);
          } catch {
            /* offline fetch — merge against what we have */
          }
          const ancestorOfBase = (ref) => {
            try {
              git(['merge-base', '--is-ancestor', ref, baseRef()], repoRoot);
              return true;
            } catch {
              return false;
            }
          };
          // The machine may have no git identity, and a merge COMMIT needs
          // one. Prefer the user's own config; fall back to the daemon's (the
          // same fallback ship's merge keeps) so a bare machine doesn't fail
          // the fold with "Please tell me who you are".
          let idEnv = null;
          try {
            git(['config', 'user.email'], repoRoot);
          } catch {
            idEnv = {
              GIT_AUTHOR_NAME: 'Flowviant',
              GIT_AUTHOR_EMAIL: 'daemon@flowviant.com',
              GIT_COMMITTER_NAME: 'Flowviant',
              GIT_COMMITTER_EMAIL: 'daemon@flowviant.com',
            };
          }
          const gitMerge = (args, cwd) =>
            execFileSync('git', args, {
              cwd,
              encoding: 'utf8',
              stdio: ['ignore', 'pipe', 'pipe'],
              ...(idEnv ? { env: { ...process.env, ...idEnv } } : {}),
            });
          // Receipts for a range: --no-merges, because fold commits describe
          // plumbing, not work.
          const logCommits = (range) =>
            git(['log', range, '--no-merges', '--format=%H%x09%s'], repoRoot)
              .split('\n')
              .filter(Boolean)
              .map((l) => {
                const [sha, ...rest] = l.split('\t');
                return { sha, subject: envScrub(rest.join('\t')).slice(0, 200) };
              });
          // Merge outward through a throwaway worktree so no checkout moves.
          // The throwaway dies on EVERY exit — success, conflict or throw —
          // or the next ship of this session trips over its corpse.
          // Carry the tip out onto base and push it. See `shipMerge.mjs` for
          // the throwaway-worktree shape, the one retry when two people ship at
          // once, and why the operator's own branch is fast-forwarded after.
          const mergeOutward = (tip, count) =>
            shipMergeOutward({
              tip,
              count,
              branch,
              label: job.sessionName || job.sessionId.slice(0, 8),
              git,
              gitMerge,
              repoRoot,
              tmpDir: join(baseDir, 'ship', job.sessionId),
              baseRef,
              workingTree: placeWtFor(shipPlace)?.wt ?? null,
              warn,
            });
          // Idempotency: base already contains the branch tip. A re-offered
          // job after a lost report lands here — never a re-merge, and never
          // "nothing to ship" AS A FAILURE for work that in fact shipped. The
          // receipts must not die with the lost report: the --no-ff merge
          // commit that carried the tip in holds it as its SECOND parent, so
          // the original commit list is recoverable — settling with none
          // would silently skip the reconciliation backstop for this branch.
          if (branchExists && ancestorOfBase(branch)) {
            const tip = git(['rev-parse', branch], repoRoot);
            let commits = [];
            try {
              const m = git(['log', baseRef(), '--merges', '--format=%H %P', '-n', '500'], repoRoot)
                .split('\n')
                .map((l) => l.trim().split(' '))
                .find((p) => p.length >= 3 && p[2] === tip);
              if (m) commits = logCommits(`${m[1]}..${tip}`);
            } catch {
              /* recovery is best-effort — an ok ship with no receipts beats a false failure */
            }
            await done({
              ok: true,
              commits,
              note: `${baseBranchName(baseRef())} already contains this session's branch — nothing new to merge`,
            });
            ok(`${c.cyan('ship')} ${c.dim('— already on main; nothing new to merge')}`);
            return;
          }
          const ended = liveIds ? !liveIds.has(job.sessionId) : false;
          if (ended) {
            // The tab is closed: no turn can commit, discard, or resolve
            // anything in the directory, so a dirty worktree must not strand
            // the branch's committed work in review forever. Ship the TIP.
            if (!branchExists) {
              await done({
                ok: false,
                error: 'nothing to ship — this session has no branch on this machine',
              });
              return;
            }
            const tip = git(['rev-parse', branch], repoRoot);
            const commits = logCommits(`${baseRef()}..${tip}`);
            if (commits.length === 0) {
              await done({
                ok: false,
                error: 'nothing to ship — no commits on the session branch',
              });
              return;
            }
            try {
              mergeOutward(tip, commits.length);
            } catch (e) {
              const detail = `${e?.stdout ?? ''}\n${e?.stderr ?? ''}\n${e?.message ?? ''}`;
              if (/conflict/i.test(detail)) {
                await done({
                  ok: false,
                  error:
                    'conflicts with main — the tab is closed, so open a new session from this branch to resolve them, then ship again',
                });
              } else {
                const line = envScrub(
                  String(detail)
                    .split('\n')
                    .find((l) => l.trim()) ?? 'git merge failed'
                );
                await done({ ok: false, error: `the merge failed: ${line.slice(0, 300)}` });
              }
              return;
            }
            await done({ ok: true, commits });
            ok(`${c.cyan('ship')} ${c.dim(`— ${commits.length} commit${commits.length === 1 ? '' : 's'} on main`)}`);
            return;
          }
          const dir = placeWtFor(shipPlace);
          if (!dir) {
            await done({
              ok: false,
              error: 'the session worktree could not be opened on this machine',
            });
            return;
          }
          // A live CLI is in this worktree — a restarted daemon's orphan
          // mid-turn (in-process the chain serializes, but the lock is the
          // only guarantee that survives a crash). Folding under it would
          // rewrite HEAD inside a held conversation; defer like the turn
          // path, and the job re-offers next poll.
          if (turnLockedByLivePid(sessionMetaPath(dir.wt, 'flowviant-turn.lock'))) {
            warn(
              `a turn is still running in "${job.sessionName || job.sessionId}" — ship waits for it`
            );
            deferred = true;
            return;
          }
          if (git(['status', '--porcelain'], dir.wt) !== '') {
            await done({
              ok: false,
              error:
                'the session has uncommitted changes — ask it to commit or discard them first',
            });
            return;
          }
          // NO "return to your session branch" GUARD. `branch` was read from
          // this worktree's HEAD above, so the fold, the tip and the receipts
          // below all name the same thing by construction — which is what the
          // old guard was really protecting, and it protected it by refusing
          // instead of by measuring.
          // Fold main into the branch FIRST: conflicts land here, in the
          // session's own worktree, where the next turn can resolve them.
          try {
            gitMerge(['merge', '--no-edit', baseRef()], dir.wt);
          } catch (e) {
            const detail = `${e?.stdout ?? ''}\n${e?.stderr ?? ''}\n${e?.message ?? ''}`;
            // NEVER leave the session mid-merge: a MERGE_HEAD left behind puts
            // every later turn inside someone else's half-finished merge.
            try {
              git(['merge', '--abort'], dir.wt);
            } catch {
              /* nothing in progress */
            }
            if (/conflict/i.test(detail)) {
              await done({
                ok: false,
                error: 'conflicts with main — ask the session to resolve them, then ship again',
              });
            } else {
              // An honest error beats a fabricated conflict — the human can
              // only fix what they are told about.
              const line = envScrub(
                String(detail)
                  .split('\n')
                  .find((l) => l.trim()) ?? 'git merge failed'
              );
              await done({ ok: false, error: `the merge failed: ${line.slice(0, 300)}` });
            }
            return;
          }
          // Resolve the EXACT sha to merge, then compute the receipts from it:
          // one X for both, so the ledger can never carry receipts for commits
          // that did not land.
          const tip = git(['rev-parse', branch], repoRoot);
          const commits = logCommits(`${baseRef()}..${tip}`);
          if (commits.length === 0) {
            // Post-fold this is nearly unreachable (a zero-commit branch is an
            // ancestor of base, settled above) — but if the branch's commits
            // all exist on main already, say so truthfully.
            if (ancestorOfBase(tip)) {
              await done({ ok: true, commits: [], note: 'already merged — nothing new to ship' });
            } else {
              await done({
                ok: false,
                error: 'nothing to ship — no commits on the session branch',
              });
            }
            return;
          }
          mergeOutward(tip, commits.length);
          await done({ ok: true, commits });
          ok(`${c.cyan('ship')} ${c.dim(`— ${commits.length} commit${commits.length === 1 ? '' : 's'} on main`)}`);
        } catch (e) {
          warn(`ship failed: ${e?.message ?? e}`);
          await done({
            ok: false,
            error: envScrub(String(e?.message ?? 'the merge failed')).slice(0, 500),
          });
        } finally {
          if (!settled && !deferred) {
            // Belt over braces: NO exit path may leave the ship unreported —
            // a deferral is the one deliberate exception, re-offered next poll.
            await done({ ok: false, error: 'the ship did not complete — check the daemon log' });
          }
          shipping.delete(job.sessionId);
        }
      });
    }
  };

  return { processShipJobs };
}
