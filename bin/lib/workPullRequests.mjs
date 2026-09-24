/** Session pull-request claims, publishing, and merges. */
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { FLEET_URL, FLEET_TOKEN, USER_AGENT, DAEMON_INSTANCE } from './config.mjs';
import { git, gitNet as gitNetIn, baseBranchName, isSafePathSegment } from './git.mjs';

export const ghFirstLine = (e) =>
  ((e?.stderr?.toString?.() || e?.message || 'failed').split('\n').find((l) => l.trim()) ||
    'failed')
    .slice(0, 400);
export const PR_URL_RE = /^https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/\d+$/;

export function createWorkPullRequests({
  placeOf,
  REPO_PLACE,
  repoRoot,
  baseDir,
  baseRef,
  gitNet,
  landed,
  onRepoChanged,
}) {
  const PR_CLAIM_URL = FLEET_URL.replace(/\/agents\/?$/, '/pr-claim');
  const PR_DONE_URL = FLEET_URL.replace(/\/agents\/?$/, '/pr-done');

  // ── PR-mode jobs (projects.mergeMode === 'pr') ──────────────────────────
  // 'open' = push the session's branch and open a PR; 'merge' = merge it.
  // Both under the operator's own `gh` credential from the daemon's inherited
  // env — the same posture the dispatch-era merge path took, and the same one
  // claude.mjs documents for turns. LEASED like a kill: two daemons pushing
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
    try {
      // TIMED OUT, like every other `gh` call. `execFileSync` blocks the whole
      // event loop, so a hung `gh` — an expired token whose refresh hits a
      // black hole, a credential helper waiting on a keyring prompt that has
      // no terminal — stops the roster poll, every in-flight settle, the
      // worktree sweep and the deploy heartbeat (whose 3-minute staleness
      // window then re-queues a deploy this daemon is still running). The
      // AGENT merge path was given exactly these timeouts in 0.77.1; this
      // copy, forty lines of the same logic, was missed.
      execFileSync('gh', ['auth', 'status'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 20_000,
      });
    } catch (e) {
      const missing = e?.code === 'ENOENT';
      await settlePr({
        id,
        outcome: 'unsupported',
        detail: missing
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
    /** Adopt only an OPEN PR. gh's branch finder falls back to the most recent
     *  MERGED/CLOSED PR when no open one exists, and adopting a dead PR turns
     *  every later delivery on a long-lived session branch into a silent
     *  black hole ('opened'/'merged' over work that never moves). */
    /** …and ONLY ONE THAT TARGETS THE PROJECT'S BASE. A PR somebody opened by
     *  hand into another branch (`staging`, to try it there) was adopted as
     *  this delivery's PR, and Approve then merged the unreviewed branch INTO
     *  that branch — the ancestry check afterwards blamed "an older PR". The
     *  agent merge path has refused this since it shipped; this is the same
     *  guard, measured the same way: refused only on a MEASURED mismatch, an
     *  absent field adopts as before. Returns `{ url, base }` or null. */
    const openPr = () => {
      try {
        const j = JSON.parse(
          execFileSync('gh', ['pr', 'view', branch, '--json', 'url,state,baseRefName'], {
            cwd: repoRoot,
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: 30_000,
          }).toString()
        );
        if (j?.state !== 'OPEN' || typeof j?.url !== 'string') return null;
        return {
          url: j.url.trim(),
          base: typeof j?.baseRefName === 'string' ? j.baseRefName : null,
        };
      } catch {
        return null; // no PR for the branch at all
      }
    };
    const otherBase = (pr) =>
      pr && pr.base && pr.base !== baseName
        ? `the open pull request for ${branch} targets ${pr.base}, not ${baseName} — retarget or close it, then try again`
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
      const existing = openPr();
      const wrongBase = otherBase(existing);
      if (wrongBase) {
        await settlePr({ id, outcome: 'failed', detail: wrongBase });
        return;
      }
      let url = existing?.url ?? null;
      if (!url) {
        try {
          const out = execFileSync(
            'gh',
            // `--fill` titles the PR from the branch's own commits — no model
            // call, nothing invented. baseBranchName, not baseRef: gh 422s on
            // a remote-tracking name like origin/main.
            ['pr', 'create', '--head', branch, '--base', baseName, '--fill'],
            { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 }
          )
            .toString()
            .trim();
          url = out.split('\n').filter(Boolean).pop() ?? null;
        } catch (e) {
          await settlePr({ id, outcome: 'failed', detail: ghFirstLine(e) });
          return;
        }
      }
      await settlePr({
        id,
        outcome: 'opened',
        ...(url && PR_URL_RE.test(url) ? { prUrl: url } : {}),
      });
      return;
    }
    // MERGE: push FIRST — GitHub merges the REMOTE PR tip, and the quiz the
    // reviewer just passed fingerprinted the LOCAL worktree, so merging
    // without a push would land a stale tip while the observer closed the
    // cards over commits that never reached base. Then a MERGE COMMIT, never
    // squash and never rebase — the cards' receipts are commit shas, and a
    // squash rewrites them off base, which would orphan every receipt AND
    // blind the landed walk's trailer read.
    // No --delete-branch: the local branch may be a live worktree's HEAD.
    // THE BASE IS RE-ASKED BEFORE THE MERGE, never trusted from the open step:
    // somebody can retarget a PR between Deliver and Approve, and `gh pr merge
    // <branch>` merges whichever open PR the branch has, into whatever it
    // targets now.
    const wrongBase = otherBase(openPr());
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
    try {
      execFileSync('gh', ['pr', 'merge', branch, '--merge'], {
        cwd: repoRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 120_000,
      });
    } catch (e) {
      const line = ghFirstLine(e);
      if (!/already merged/i.test(line)) {
        await settlePr({ id, outcome: 'failed', detail: line });
        return;
      }
    }
    // VERIFY before settling 'merged': modern gh exits 0 on an
    // already-MERGED PR, so a dead PR from an earlier delivery reads as
    // success while this branch's newest commits sit unmerged. The branch
    // tip being an ancestor of base is the fact 'merged' claims — check it,
    // with one short retry for the fetch racing GitHub's merge commit.
    const tipSha = (() => {
      try {
        return git(['rev-parse', branch], pushCwd);
      } catch {
        return null;
      }
    })();
    const tipOnBase = () => {
      if (!tipSha) return false;
      try {
        git(['merge-base', '--is-ancestor', tipSha, baseRef()], repoRoot);
        return true;
      } catch {
        return false;
      }
    };
    let merged = false;
    for (let attempt = 0; attempt < 2 && !merged; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 2000));
      try {
        gitNet(['fetch', 'origin', '--quiet'], 60_000);
      } catch {
        /* offline — the check below answers from what we have */
      }
      merged = tipOnBase();
    }
    if (!merged) {
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
