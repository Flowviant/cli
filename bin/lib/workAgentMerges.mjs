/** Agent merge claims, pull-request approval, and branch cleanup. */
import { ghFirstLine, PR_URL_RE } from './workPullRequests.mjs';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { FLEET_URL, FLEET_TOKEN, USER_AGENT, DAEMON_INSTANCE } from './config.mjs';
import { git, gitNet as gitNetIn, baseBranchName, isSafePathSegment } from './git.mjs';
import { isPublishRef, publishPushArgs, publishDeleteArgs, publishErrorText } from './agentPublish.mjs';
import { mergeOutward as shipMergeOutward } from './shipMerge.mjs';
import { warn } from './ui.mjs';
import { scrub as envScrub } from './env.mjs';

export function createWorkAgentMerges({
  repoRoot,
  inPlace,
  baseDir,
  gitNet,
  baseRef,
  runReviewEntry,
  onRepoChanged,
  landed,
  state,
}) {
  const AGENT_MERGE_CLAIM_URL = FLEET_URL.replace(/\/agents\/?$/, '/agent-merge-claim');
  const AGENT_MERGE_DONE_URL = FLEET_URL.replace(/\/agents\/?$/, '/agent-merge-done');

  const { agentRemoteAt, agentPublished } = state;

  // ── THE MERGE ──────────────────────────────────────────────────────────────
  //
  // LEASED, because two `git merge --no-ff` and two pushes over one branch is
  // the loudest duplicate this system can produce. It reuses `mergeOutward`
  // verbatim — the same throwaway-worktree merge, the same once-only retry when
  // two people land at the same moment — because an agent's branch is not
  // special: it is a branch, and this repo already knows how to land one.
  //
  // A SUCCESS CLOSES NOTHING. Done stays OBSERVED: the merge reaches base, the
  // landed observer's own fetch sees it, and the cards close there.
  const agentMerges = new Set(); // agent ids in flight on this tick

  const claimAgentMerge = async (agentId) => {
    try {
      const res = await fetch(AGENT_MERGE_CLAIM_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${FLEET_TOKEN}`,
          'User-Agent': USER_AGENT,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(15_000),
        body: JSON.stringify({ agentId, instance: DAEMON_INSTANCE }),
      });
      const j = await res.json().catch(() => null);
      return j?.data?.claimed === true;
    } catch {
      return false; // the peer may hold it; doing nothing is the safe answer
    }
  };

  const postAgentMerge = async (body) => {
    try {
      await fetch(AGENT_MERGE_DONE_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${FLEET_TOKEN}`,
          'User-Agent': USER_AGENT,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(30_000),
        body: JSON.stringify({ ...body, instance: DAEMON_INSTANCE }),
      });
    } catch {
      /* the lease lapses and the job is re-offered — a merge is idempotent
         against an already-merged branch, which mergeOutward detects */
    }
  };

  /**
   * A merge COMMIT needs a git identity and the machine may have none. Prefer
   * the operator's own config; fall back to the daemon's, the same fallback
   * ship's merge keeps, so a bare machine does not fail the fold with
   * "Please tell me who you are".
   */
  const gitMerge = (args, cwd) => {
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
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(idEnv ? { env: { ...process.env, ...idEnv } } : {}),
    });
  };

  const runAgentMerge = async (job) => {
    const agentId = String(job.agentId);
    const place = String(job.placeId || '');
    if (!isSafePathSegment(place)) {
      // Before the claim, and before `report` exists — this one is not covered
      // by the belt below because there is nothing yet to be un-reported.
      await postAgentMerge({ agentId, ok: false, detail: 'the agent has no worktree here' });
      return;
    }
    if (!(await claimAgentMerge(agentId))) return;

    /**
     * NO EXIT PATH MAY LEAVE A CLAIMED MERGE UNREPORTED — the same belt the
     * ship path carries, and this function did not.
     *
     * Every branch below reports, but an UNEXPECTED throw reports nothing:
     * several `git()` calls in here are bare, and `git()` is `execFileSync`,
     * which throws on any non-zero exit. The agent then sits in `merging`,
     * which refuses Stop and refuses an answer, until an expiry fires — with
     * nothing anywhere saying what went wrong.
     */
    let reported = false;
    /**
     * THE PUBLISHED REF DIES WHEN THE WORK LANDS (0.86.0) — recorded here,
     * retired in the tail below.
     *
     * A `flowviant/*` branch exists so the work survives the box that cut it.
     * Once the commits are on base that job is done, and one ref per agent
     * forever is a branch list nobody wants to read. The server sends the ref
     * only when it heard about a real push, so this never deletes a name we
     * merely composed — and `publishDeleteArgs` refuses anything outside the
     * prefix, because `:refs/heads/<x>` is the most destructive argv in this
     * file.
     *
     * ONLY ON SUCCESS. A failed merge keeps its branch — that is the whole
     * point of the branch — and stopping or declining an agent deletes nothing
     * anywhere: durability is what this feature is, and a ref whose work never
     * landed is the case it exists for. It is recorded in `report` rather than
     * at the three success sites so a fourth one cannot forget it.
     */
    let landedRef = null;
    const report = async (body) => {
      reported = true;
      if (body?.ok === true) landedRef = job.publishedRef ?? null;
      await postAgentMerge(body);
    };

    // A WRITER on the place, exactly as a ship is. It folds base in and pushes
    // with git in that directory, and no CLI can coordinate with something it
    // does not know exists.
    try {
      await inPlace(place, true, async () => {
      const wt = join(baseDir, 'sessions', place);
      if (!existsSync(wt)) {
        await report({ agentId, ok: false, detail: 'the worktree is gone' });
        return;
      }
      try {
        gitNet(['fetch', 'origin', '--quiet'], 60_000);
      } catch {
        /* offline — the merge fails honestly below */
      }
      // STALE means base moved under this branch while it sat in review. Fold
      // base IN first so the merge that follows is against what is actually
      // there; a conflict here is the same conflict the merge would hit, found
      // one step earlier and in the agent's own directory where it can be
      // resolved.
      if (job.stale) {
        try {
          gitMerge(['merge', '--no-edit', baseRef()], wt);
        } catch (e) {
          await report({
            agentId,
            ok: false,
            detail: envScrub(String(e?.message || e)).slice(0, 2000),
          });
          return;
        }
        // The branch changed, so the previous check — and the previous
        // pre-review — answered about a different tree. Re-read it before
        // anything merges: a failed merge sends the agent BACK to review, which
        // is a review-entry beat like any other, and a stale reading standing
        // over a rebased branch is exactly what `precheckSha` exists to void.
        await runReviewEntry(agentId, wt, job.agentName);
      }
      // `git()` THROWS on a non-zero exit, and `symbolic-ref` exits non-zero on
      // a detached HEAD — so the guard below was unreachable and the throw
      // escaped the claimed merge, leaving it unsettled until its lease lapsed.
      let branch = '';
      try {
        branch = (git(['symbolic-ref', '--quiet', '--short', 'HEAD'], wt) || '').trim();
      } catch {
        branch = '';
      }
      if (!branch) {
        // A detached HEAD names no branch, so there is nothing to merge and
        // nothing to record. An ambiguity in git, not a rule of ours.
        await report({ agentId, ok: false, detail: 'this worktree is on a detached HEAD' });
        return;
      }
      const tip = (git(['rev-parse', 'HEAD'], wt) || '').trim();
      const countOut = git(['rev-list', '--count', `${baseRef()}..HEAD`], wt);
      const count = Number((countOut || '0').trim()) || 0;
      if (count === 0) {
        // Already on base — an idempotent re-offer, or an agent that changed
        // nothing. Reported as a SUCCESS: the branch's work is on base, which
        // is what the caller is asking about.
        await report({ agentId, ok: true, sha: tip || undefined });
        return;
      }
      /**
       * THIS PROJECT MERGES THROUGH A PULL REQUEST.
       *
       * PR mode existed for sessions and was simply not honoured for agents:
       * nothing read the project's merge mode on this path and the direct
       * merge below ran unconditionally. On the repos PR mode exists FOR —
       * branch protection refuses a direct push of a merge commit — every
       * agent approval failed at the push and came back to review carrying
       * git's refusal, forever.
       *
       * PUSH, CREATE, MERGE, in that order, and each step's reasoning is the
       * session PR job's: push first because GitHub merges the REMOTE tip;
       * `--fill` titles from the branch's own commits so nothing is invented;
       * `--merge` and never squash, because the cards' receipts are commit
       * shas and a squash rewrites them off base, orphaning every receipt and
       * blinding the landed observer's trailer read. Adopt only an OPEN PR:
       * gh's branch finder falls back to the most recent merged one, and
       * adopting a dead PR would report success over work that never moves.
       */
      if (job.prMode) {
        try {
          // EVERY `gh` CALL IS TIMED OUT. `execFileSync` blocks the daemon's
          // whole event loop, and this one runs INSIDE the place writer lock —
          // so a `gh` that hangs (an expired token prompting, a network black
          // hole, a hung credential helper) stops every turn on the machine,
          // not merely this merge, and holds the lock while it does.
          execFileSync('gh', ['auth', 'status'], {
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: 20_000,
          });
        } catch (e) {
          await report({
            agentId,
            ok: false,
            detail:
              e?.code === 'ENOENT'
                ? 'this project merges through pull requests, and the GitHub CLI (gh) is not installed on this machine'
                : `this project merges through pull requests, and gh is not signed in here: ${ghFirstLine(e)}`,
          });
          return;
        }
        const prBase = baseBranchName(baseRef());
        if (branch === prBase) {
          await report({
            agentId,
            ok: false,
            detail: `this agent is on the base branch (${prBase}) — there is nothing to open a pull request from`,
          });
          return;
        }
        /**
         * THE PULL REQUEST'S HEAD IS THE PUBLISHED REF, when there is one
         * (0.86.0).
         *
         * Pushing `session/a-<uuid>` here and reviewing THAT would defeat the
         * whole feature on exactly the projects it is most for: the owner asked
         * for "control over what branch the agents are working on", and a PR
         * mode project is one where people read branches in a host UI. Worse, it
         * leaves TWO refs per agent — the uuid one nothing ever deletes, and the
         * readable one the cleanup below retires — so the survivor is the opaque
         * name this feature exists to replace.
         *
         * ONLY when the local branch really is this agent's own. If somebody
         * checked something else out in the worktree, `session/<place>` is not
         * what is being merged and pushing it under the published name would put
         * work on that ref that nobody approved; the plain push of the checked
         * out branch is the honest fallback.
         */
        const ownBranch = branch === `session/${place}`;
        const head =
          ownBranch && isPublishRef(job.publishedRef) ? job.publishedRef : branch;
        try {
          if (head === branch) {
            gitNetIn(['push', '-u', 'origin', branch], wt, 120_000);
          } else {
            // The same lease discipline the publish lane keeps, and TIMED like
            // every other network call on this path: `git()` has no timeout, and
            // this one runs inside the place writer lock.
            const seen = agentRemoteAt.get(place);
            gitNet(
              publishPushArgs(place, head, seen?.ref === head ? seen.sha : null),
              120_000
            );
            agentPublished.set(place, { ref: head, sha: tip });
            agentRemoteAt.set(place, { ref: head, sha: tip });
          }
        } catch (e) {
          // SCRUBBED. Every other failure on this path relays `gh`'s own words,
          // but a push writes the REMOTE URL to stderr and a remote can carry a
          // token in its userinfo — so this one line is the only place on the
          // agent merge path that can leak a credential into a stored,
          // team-visible `mergeError`.
          await report({ agentId, ok: false, detail: envScrub(ghFirstLine(e)) });
          return;
        }
        let prUrl = null;
        try {
          const j = JSON.parse(
            execFileSync('gh', ['pr', 'view', head, '--json', 'url,state,baseRefName'], {
              cwd: repoRoot,
              stdio: ['ignore', 'pipe', 'pipe'],
              timeout: 30_000,
            }).toString()
          );
          if (j?.state === 'OPEN' && typeof j?.url === 'string') {
            // Adoptable only when it points at the project's own base. A PR
            // somebody opened by hand against another branch would otherwise
            // be merged INTO that branch, and the ok settle would claim work
            // reached base that landed somewhere else entirely. Refused only
            // on a MEASURED mismatch — an absent field adopts as before.
            if (typeof j?.baseRefName === 'string' && j.baseRefName !== prBase) {
              await report({
                agentId,
                ok: false,
                detail: `the open pull request for ${head} targets ${j.baseRefName}, not ${prBase} — retarget or close it, then approve again`,
              });
              return;
            }
            prUrl = j.url.trim();
          }
        } catch {
          /* no PR for this branch at all — created below */
        }
        if (!prUrl) {
          try {
            const out = execFileSync(
              'gh',
              // baseBranchName, not baseRef: gh 422s on a remote-tracking name.
              ['pr', 'create', '--head', head, '--base', prBase, '--fill'],
              { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 }
            )
              .toString()
              .trim();
            prUrl = out.split('\n').filter(Boolean).pop() ?? null;
          } catch (e) {
            await report({ agentId, ok: false, detail: ghFirstLine(e) });
            return;
          }
        }
        try {
          execFileSync('gh', ['pr', 'merge', head, '--merge'], {
            cwd: repoRoot,
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: 120_000,
          });
        } catch (e) {
          const line = ghFirstLine(e);
          // Already merged is a SUCCESS: a re-offered job, or somebody merged
          // it in the browser. The observer closes the cards either way.
          if (!/already merged/i.test(line)) {
            await report({
              agentId,
              ok: false,
              detail:
                prUrl && PR_URL_RE.test(prUrl) ? `${line} — the pull request is at ${prUrl}` : line,
            });
            return;
          }
        }
        // VERIFY before reporting ok: modern gh exits 0 on an already-MERGED
        // PR, and on a repo with a merge queue or auto-merge it exits 0 after
        // ENQUEUEING — in both, "merged" is a claim about the future. The tip
        // being an ancestor of base is the fact `ok` asserts, and the server
        // closes every delivered card on this sha the moment it hears it — so
        // measure it, with one short retry for the fetch racing GitHub's
        // merge commit. The same guard the session PR path carries.
        const tipOnBase = () => {
          try {
            git(['merge-base', '--is-ancestor', tip, baseRef()], repoRoot);
            return true;
          } catch {
            return false;
          }
        };
        let landedOnBase = false;
        for (let attempt = 0; attempt < 2 && !landedOnBase; attempt++) {
          if (attempt > 0) await new Promise((r) => setTimeout(r, 2000));
          try {
            gitNet(['fetch', 'origin', '--quiet'], 60_000);
          } catch {
            /* offline — the check below answers from what we have */
          }
          landedOnBase = tipOnBase();
        }
        if (!landedOnBase) {
          await report({
            agentId,
            ok: false,
            detail:
              "GitHub accepted the merge, but this branch's tip is not on the base branch — a merge queue may still be running it, or the PR that merged was an older one. Approve again once it lands." +
              (prUrl && PR_URL_RE.test(prUrl) ? ` The pull request is at ${prUrl}.` : ''),
          });
          return;
        }
        // THE TIP, not the merge commit GitHub made: the tip identifies the
        // state we asked to be merged, which is what the receipt is for — the
        // cards themselves close when the landed observer sees the commits
        // arrive on base.
        await report({ agentId, ok: true, sha: tip });
        onRepoChanged();
        landed.observe();
        return;
      }
      try {
        shipMergeOutward({
          tip,
          count,
          branch,
          label: job.agentName || place.slice(0, 12),
          git,
          gitMerge,
          repoRoot,
          tmpDir: join(baseDir, 'ship', place),
          baseRef,
          workingTree: wt,
          warn,
        });
      } catch (e) {
        await report({
          agentId,
          ok: false,
          detail: envScrub(String(e?.message || e)).slice(0, 2000),
        });
        return;
      }
      await report({ agentId, ok: true, sha: tip });
      onRepoChanged();
      landed.observe();
      });
    } finally {
      if (!reported) {
        // Belt over braces. A merge this daemon claimed and cannot account for
        // is a FAILURE, said out loud, so the agent goes back to Review with a
        // reason instead of waiting out an expiry that blames nobody.
        await postAgentMerge({
          agentId,
          ok: false,
          detail: 'the merge did not complete — check the daemon log',
        }).catch(() => {});
      }
      /**
       * …AND THE RETIREMENT IS TAIL WORK, OUTSIDE THE PLACE LOCK — the same
       * placement the turn's publish argues for, for the same reason.
       *
       * `gitNet` is `execFileSync`: it blocks the whole event loop for up to its
       * timeout, and inside `inPlace(place, true, …)` it would hold this
       * agent's WRITER lock through a remote's bad day, with the merge already
       * settled and nothing left that the delay serves. This block is PAST the
       * lock: `inPlace` has returned (or thrown) before a `finally` runs.
       *
       * IN THE `finally` rather than after it, so a throw between the ok settle
       * and the end of the locked block cannot strand the ref. `landedRef` is
       * set only by a reported success, so there is nothing here to run on any
       * other path — and a remote that refuses the delete only warns: the merge
       * is the thing that matters, and a landed branch must not become a failed
       * approval.
       *
       * The record goes with the ref. `agentPublished` is what the SWEEP
       * republishes from, so leaving the entry behind would let the next sweep
       * push the ref straight back — an orphan no later merge job can ever
       * carry, and therefore one nothing can delete.
       */
      if (landedRef) {
        agentPublished.delete(place);
        agentRemoteAt.delete(place);
        const args = publishDeleteArgs(landedRef);
        if (args) {
          try {
            gitNet(args, 60_000);
          } catch (e) {
            warn(
              `agent ${agentId}: the published branch ${landedRef} could not be deleted — ${publishErrorText(envScrub(e?.stderr?.toString?.() || e?.message || ''))}`
            );
          }
        }
      }
    }
  };

  const processAgentMergeJobs = (jobs) => {
    if (!Array.isArray(jobs) || jobs.length === 0) return;
    for (const job of jobs.slice(0, 2)) {
      const id = String(job?.agentId || '');
      if (!id || agentMerges.has(id)) continue;
      agentMerges.add(id);
      void runAgentMerge(job).finally(() => agentMerges.delete(id));
    }
  };

  return { processAgentMergeJobs, agentMerges };
}
