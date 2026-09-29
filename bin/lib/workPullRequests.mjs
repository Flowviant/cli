/**
 * Session pull-request claims, publishing, and merges.
 *
 * What is the SESSION's lives here: the lease, which branch a session's job
 * pushes (its worktree's HEAD, never base, never detached), and the words each
 * outcome settles with. The GitHub rules themselves — adopt only an open PR
 * into base, `--fill`, `--merge`, verify the tip — are `prWorkflow.mjs`'s,
 * shared with the agent approve path.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { FLEET_URL, FLEET_TOKEN, USER_AGENT, DAEMON_INSTANCE } from './config.mjs';
import { git, gitNet as gitNetIn, baseBranchName, isSafePathSegment } from './git.mjs';
import {
  ensureOpenPr,
  findOpenPr,
  ghFirstLine,
  ghReady,
  mergeAndVerifyTip,
  PR_URL_RE,
  prTargetsOtherBase,
} from './prWorkflow.mjs';
import { fleetEndpoint } from './fleetWire.mjs';
import { REPO_PLACE } from './workPlaces.mjs';

export function createWorkPullRequests({
  placeOf,
  repoRoot,
  baseDir,
  baseRef,
  gitNet,
  landed,
  onRepoChanged,
}) {
  const PR_CLAIM_URL = fleetEndpoint('pr-claim', FLEET_URL);
  const PR_DONE_URL = fleetEndpoint('pr-done', FLEET_URL);

  // ── PR-mode jobs (projects.mergeMode === 'pr') ──────────────────────────
  // 'open' = push the session's branch and open a PR; 'merge' = merge it.
  // Both under the operator's own `gh` credential from the daemon's inherited
  // env — the same posture the dispatch-era merge path took, and the same one
  // runTurn.mjs documents for turns. LEASED like a kill: two daemons pushing
  // one branch would open two PRs. NOTHING here closes a card — done is
  // observed by the landed walk when the merge reaches base.
  const prWorking = new Set();
  const claimPr = async (id) => {
    try {
      const res = await fetch(PR_CLAIM_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${FLEET_TOKEN}`,
          'User-Agent': USER_AGENT,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(15_000),
        body: JSON.stringify({ id, instance: DAEMON_INSTANCE }),
      });
      const j = await res.json().catch(() => null);
      return j?.data?.claimed === true;
    } catch {
      return false; // could not claim → do nothing. The other daemon may have.
    }
  };
  const settlePr = async (body) => {
    try {
      await fetch(PR_DONE_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${FLEET_TOKEN}`,
          'User-Agent': USER_AGENT,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(20_000),
        body: JSON.stringify({ ...body, instance: DAEMON_INSTANCE }),
      });
    } catch {
      /* the row expires into an honest no_answer; the re-request is the retry */
    }
  };
  const runPrJob = async (job) => {
    const id = String(job.id);
    if (!(await claimPr(id))) return;
    // gh present and authenticated, or the honest 'unsupported' — its own
    // outcome because "the machine cannot do this at all" and "GitHub said
    // no" read differently to the person who asked.
    // TIMED OUT, like every other `gh` call (prWorkflow.mjs says why: a hung
    // `gh` blocks the roster poll, every settle and the deploy heartbeat).
    const ghDown = ghReady();
    if (ghDown) {
      await settlePr({
        id,
        outcome: 'unsupported',
        detail: ghDown.missing
          ? 'the GitHub CLI (gh) is not installed on this machine'
          : 'gh is not authenticated on this machine — run `gh auth login` there',
      });
      return;
    }
    // The branch is whatever the session's own worktree HEAD says — the same
    // resolution ship uses, for the same reason (the branch is where the
    // driver left it, not where we put it).
    const sessionId = String(job.sessionId);
    const place = placeOf(sessionId);
    const wt = place === REPO_PLACE ? repoRoot : join(baseDir, 'sessions', place);
    let branch = `session/${sessionId}`;
    let detached = false;
    if (existsSync(wt)) {
      try {
        branch = git(['symbolic-ref', '--short', 'HEAD'], wt);
      } catch {
        detached = true;
      }
    }
    if (detached) {
      await settlePr({
        id,
        outcome: 'failed',
        detail: 'the session is on a detached HEAD — no branch to push',
      });
      return;
    }
    // NEVER the base branch. A checkout-place tab (the operator's, at N=1)
    // commonly stands on base, and pushing it would BE the direct push this
    // mode exists to replace — on an unprotected repo the work lands with no
    // PR and the observer closes the cards as landed, PR mode silently
    // defeated by its own open job.
    const baseName = baseBranchName(baseRef());
    if (branch === baseName) {
      await settlePr({
        id,
        outcome: 'failed',
        detail: `the session is on the base branch (${baseName}) — nothing to open a pull request from; work on a branch first`,
      });
      return;
    }
    const pushCwd = existsSync(wt) ? wt : repoRoot;
    // A PR into another branch is refused, never adopted (prWorkflow.mjs) —
    // in the session's words.
    const otherBase = (target) =>
      target
        ? `the open pull request for ${branch} targets ${target}, not ${baseName} — retarget or close it, then try again`
        : null;
    if (job.kind !== 'merge') {
      // OPEN: push, then create — or adopt a PR already OPEN for the branch
      // (a re-delivery, or one the driver opened by hand).
      try {
        gitNetIn(['push', '-u', 'origin', branch], pushCwd, 120_000);
      } catch (e) {
        await settlePr({ id, outcome: 'failed', detail: ghFirstLine(e) });
        return;
      }
      const pr = ensureOpenPr(branch, baseName, { cwd: repoRoot });
      if (pr.wrongBase || pr.error) {
        await settlePr({ id, outcome: 'failed', detail: otherBase(pr.wrongBase) ?? pr.error });
        return;
      }
      await settlePr({
        id,
        outcome: 'opened',
        ...(pr.url && PR_URL_RE.test(pr.url) ? { prUrl: pr.url } : {}),
      });
      return;
    }
    // MERGE: push FIRST — GitHub merges the REMOTE PR tip, and the quiz the
    // reviewer just passed fingerprinted the LOCAL worktree, so merging
    // without a push would land a stale tip while the observer closed the
    // cards over commits that never reached base.
    // No --delete-branch: the local branch may be a live worktree's HEAD.
    // THE BASE IS RE-ASKED BEFORE THE MERGE, never trusted from the open step:
    // somebody can retarget a PR between Deliver and Approve, and `gh pr merge
    // <branch>` merges whichever open PR the branch has, into whatever it
    // targets now.
    const wrongBase = otherBase(prTargetsOtherBase(findOpenPr(branch, { cwd: repoRoot }), baseName));
    if (wrongBase) {
      await settlePr({ id, outcome: 'failed', detail: wrongBase });
      return;
    }
    try {
      gitNetIn(['push', 'origin', branch], pushCwd, 120_000);
    } catch (e) {
      await settlePr({ id, outcome: 'failed', detail: ghFirstLine(e) });
      return;
    }
    // The tip is the LOCAL branch — the state the reviewer approved and the
    // push just sent; GitHub's merge does not move it.
    const tipSha = (() => {
      try {
        return git(['rev-parse', branch], pushCwd);
      } catch {
        return null;
      }
    })();
    const merged = await mergeAndVerifyTip(branch, {
      cwd: repoRoot,
      tip: tipSha,
      baseRef,
      repoRoot,
      fetchOrigin: () => gitNet(['fetch', 'origin', '--quiet'], 60_000),
    });
    if (merged.error) {
      await settlePr({ id, outcome: 'failed', detail: merged.error });
      return;
    }
    if (merged.notOnBase) {
      await settlePr({
        id,
        outcome: 'failed',
        detail:
          'GitHub reports a merge, but this branch\'s newest commits are not on the base branch — the PR that merged was an older one. Deliver again to open a fresh pull request.',
      });
      return;
    }
    await settlePr({ id, outcome: 'merged' });
    // The merge moved base. Observe NOW, so the cards close on this beat
    // rather than the next 3-minute sweep — the same re-measure-after-an-
    // action rule the kill and ship paths keep. (The fetch already ran in
    // the verify loop above.)
    void landed.observe().catch(() => {});
    onRepoChanged();
  };
  const processPrJobs = (jobs) => {
    if (!Array.isArray(jobs) || jobs.length === 0) return;
    for (const job of jobs.slice(0, 5)) {
      const id = String(job?.id || '');
      const sid = String(job?.sessionId || '');
      if (!id || !isSafePathSegment(sid)) continue;
      // Keyed by SESSION, not job id: a deliver-time open and an approve-time
      // merge for one session must run in order (the roster offers them FIFO;
      // running them concurrently would merge before the push-and-create).
      if (prWorking.has(sid)) continue;
      prWorking.add(sid);
      void runPrJob(job)
        .catch(() => {})
        .finally(() => prWorking.delete(sid));
    }
  };

  return { processPrJobs };
}
