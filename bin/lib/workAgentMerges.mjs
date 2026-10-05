/** Agent merge claims, pull-request approval, and branch cleanup. */
import { ensureOpenPr, ghFirstLine, ghReady, mergeAndVerifyTip, PR_URL_RE } from './prWorkflow.mjs';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { FLEET_URL, FLEET_TOKEN, USER_AGENT, DAEMON_INSTANCE } from './config.mjs';
import { git, gitNet as gitNetIn, baseBranchName, isSafePathSegment } from './git.mjs';
import { isPublishRef, publishPushArgs, publishDeleteArgs, publishErrorText } from './agentPublish.mjs';
import { mergeOutward as shipMergeOutward } from './shipMerge.mjs';
import { gitMergeIn } from './gitMergeIdentity.mjs';
import { warn } from './ui.mjs';
import { scrub as envScrub } from './uplinkScrub.mjs';
import { fleetEndpoint } from './fleetWire.mjs';
import { gitReportedConflict } from './agentMergeResolution.mjs';

/** Git puts merge conflicts on stdout, while refusals usually use stderr.
 * Keep both before the command wrapper, scrub before bounding, and put Git's
 * reason first so the server's shorter mergeError cap keeps the useful part.
 * A genuine conflict stays in the worktree for the merge_resolve turn. */
export function agentMergeFailureDetail(error) {
  const output = [error?.stdout, error?.stderr]
    .map((value) => String(value ?? '').trim())
    .filter(Boolean)
    .join('\n');
  return envScrub(output || String(error?.message || error)).slice(0, 2000);
}

export function createWorkAgentMerges({
  repoRoot,
  inPlace,
  baseDir,
  gitNet,
  baseRef,
  runReviewEntry,
  onRepoChanged,
  landed,
  agentRemoteAt,
  agentPublished,
}) {
  const AGENT_MERGE_CLAIM_URL = fleetEndpoint('agent-merge-claim', FLEET_URL);
  const AGENT_MERGE_DONE_URL = fleetEndpoint('agent-merge-done', FLEET_URL);

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

  // A merge COMMIT needs an identity the machine may not have; the probe and
  // the daemon's fallback live in gitMergeIdentity.mjs.
  const gitMerge = gitMergeIn(repoRoot);

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
            detail: agentMergeFailureDetail(e),
            conflict: gitReportedConflict(e),
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
       * PUSH, then the shared GitHub rules (`prWorkflow.mjs`, the same ones
       * the session PR job runs): adopt only an OPEN PR into this project's
       * base or create one with `--fill`, merge with `--merge`, and report ok
       * only once the tip is measured on base. What is the AGENT's stays
       * here: which ref is the head, the leased push, and every sentence.
       */
      if (job.prMode) {
        // EVERY `gh` CALL IS TIMED OUT (prWorkflow.mjs) — this one runs
        // INSIDE the place writer lock.
        const ghDown = ghReady();
        if (ghDown) {
          await report({
            agentId,
            ok: false,
            fix: 'person',
            detail: ghDown.missing
              ? 'this project merges through pull requests, and the GitHub CLI (gh) is not installed on this machine'
              : `this project merges through pull requests, and gh is not signed in here: ${ghDown.error}`,
          });
          return;
        }
        const prBase = baseBranchName(baseRef());
        if (branch === prBase) {
          await report({
            agentId,
            ok: false,
            fix: 'person',
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
          // A refused push is the remote or its login (no `origin`, a
          // credential, a protected ref) — the person's to fix, not the branch.
          await report({ agentId, ok: false, fix: 'person', detail: envScrub(ghFirstLine(e)) });
          return;
        }
        const pr = ensureOpenPr(head, prBase, { cwd: repoRoot });
        if (pr.wrongBase) {
          await report({
            agentId,
            ok: false,
            fix: 'person',
            detail: `the open pull request for ${head} targets ${pr.wrongBase}, not ${prBase} — retarget or close it, then approve again`,
          });
          return;
        }
        if (pr.error) {
          await report({ agentId, ok: false, detail: pr.error });
          return;
        }
        const prUrl = pr.url;
        const linked = prUrl && PR_URL_RE.test(prUrl);
        const merged = await mergeAndVerifyTip(head, {
          cwd: repoRoot,
          tip,
          baseRef,
          repoRoot,
          fetchOrigin: () => gitNet(['fetch', 'origin', '--quiet'], 60_000),
        });
        if (merged.error) {
          await report({
            agentId,
            ok: false,
            detail: linked ? `${merged.error} — the pull request is at ${prUrl}` : merged.error,
          });
          return;
        }
        if (merged.notOnBase) {
          // gh said yes and base does not have the tip: a merge queue may
          // still be running it, or an older PR merged. The server closes
          // every delivered card on this sha the moment it hears ok.
          await report({
            agentId,
            ok: false,
            detail:
              "GitHub accepted the merge, but this branch's tip is not on the base branch — a merge queue may still be running it, or the PR that merged was an older one. Approve again once it lands." +
              (linked ? ` The pull request is at ${prUrl}.` : ''),
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
          // WHOSE FIX IT IS (0.108.0), when the merge said: a refusal about
          // the person's side (`shipMerge.mjs`'s dirty checkout) queues no
          // resolve turn on the server. A conflict says nothing, and the
          // agent resolves it in its worktree as before.
          ...(e?.fix === 'person' ? { fix: 'person' } : {}),
          detail: agentMergeFailureDetail(e),
          conflict: gitReportedConflict(e),
        });
        return;
      }
      await report({ agentId, ok: true, sha: tip });
      onRepoChanged();
      landed.observe();
      });
    } catch (e) {
      // Unexpected Git failures must retain their diagnostics too. The belt
      // below remains for paths which exit without an error or a report.
      if (!reported) {
        await report({ agentId, ok: false, detail: agentMergeFailureDetail(e) });
      }
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
