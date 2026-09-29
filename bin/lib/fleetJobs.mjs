/**
 * TWO ROSTER JOB LANES THAT ACT ON THIS CHECKOUT AND SETTLE BACK: patch
 * reverts and task-restart cleanups.
 *
 * Split out of fleet.mjs (SOLID audit 2026-09-26, F038). Each lane dedups its
 * in-flight job ids, does its work fire-and-forget, and ALWAYS reports the job
 * done — the roster re-serves a job until it is reported, so a lane that could
 * wedge on a failure would redo it every poll. The loop in fleet.mjs only
 * hands each lane its roster array.
 *
 * Factories rather than module state because each lane is bound to the
 * checkout this daemon serves (and cleanup to the live base ref, read at call
 * time — the roster can move it mid-run).
 */

import { execFileSync } from 'node:child_process';
import { FLEET_URL } from './config.mjs';
import { gitNetAsync, originSlug, isValidPrUrl, isValidBranch } from './git.mjs';
import { c, note, ok, warn } from './ui.mjs';
import { revertPatch, withPatchLock } from './patchRevert.mjs';
import { fleetEndpoint } from './fleetWire.mjs';
import { postToFleet } from './fleetPost.mjs';

export function createPatchRevertLane({ repoRoot }) {
  // Patch reverts: a patch landed straight in this checkout, and a human took it
  // back. The commits are HERE, not on the server, so the reverse-apply happens
  // here too — a revert, never a reset, because the owner has almost certainly
  // worked on top by now. Serialised through the same lock as applies.
  const PATCH_REVERT_DONE_URL = fleetEndpoint('patch-revert-done', FLEET_URL);
  const reverting = new Set();
  const processPatchRevertJobs = (jobs) => {
    for (const job of jobs ?? []) {
      if (!job || typeof job.id !== 'string' || !Array.isArray(job.shas)) continue;
      if (reverting.has(job.id)) continue;
      reverting.add(job.id);
      (async () => {
        try {
          note(`${c.cyan('revert')} ${c.dim(`— ${job.title}`)}`);
          const res = await withPatchLock(() =>
            Promise.resolve(revertPatch({ repoRoot, shas: job.shas }))
          );
          if (res.ok) ok(`${c.dim('reverted')} ${job.title}`);
          else warn(`revert failed for "${job.title}": ${res.error}`);
          // ALWAYS report, success or not. Without this the flag stays set, the
          // roster re-serves the job every poll, and each pass reverts the
          // revert — the change flapping in and out of the owner's tree forever.
          await postToFleet(PATCH_REVERT_DONE_URL, {
            taskId: job.id,
            ok: res.ok,
            error: res.ok ? undefined : String(res.error ?? 'revert failed'),
          });
        } finally {
          reverting.delete(job.id);
        }
      })();
    }
  };
  return processPatchRevertJobs;
}

export function createCleanupLane({ repoRoot, getBaseRef }) {
  // Cleanup jobs (task restarts): close the abandoned PR + delete its remote
  // branch on the user's own gh, so a restart doesn't litter the repo.
  const CLEANUP_DONE_URL = fleetEndpoint('cleanup-done', FLEET_URL);
  const cleaning = new Set();
  const processCleanupJobs = (jobs) => {
    for (const job of jobs ?? []) {
      if (!job || typeof job.id !== 'string') continue; // a null element would wedge the loop
      if (cleaning.has(job.id)) continue;
      cleaning.add(job.id);
      (async () => {
        try {
          note(`${c.cyan('cleanup')} ${c.dim(`— ${job.title} (restarted)`)}`);
          // Same guards as merge: only close a PR in THIS repo, only delete a
          // well-formed non-base branch. A bad server must not close a stranger's
          // PR or delete `main` (`--delete` with `main`) via a cleanup job.
          if (job.prUrl && isValidPrUrl(job.prUrl, originSlug(repoRoot))) {
            try {
              execFileSync(
                'gh',
                [
                  'pr',
                  'close',
                  job.prUrl,
                  '--comment',
                  'Task restarted in Flowviant — this attempt was discarded.',
                  '--delete-branch',
                ],
                { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 }
              );
            } catch (e) {
              // Already closed/merged/missing = fine; anything else we still
              // report done — a restart must never wedge on stale remotes.
              const err = e.stderr?.toString?.() || e.message || '';
              warn(`cleanup for "${job.title}": ${err.split('\n')[0] || 'gh pr close failed'}`);
            }
          } else if (job.branch && isValidBranch(job.branch, repoRoot, getBaseRef())) {
            try {
              // Explicit refspec form so a leading '-' can't be a git flag.
              // NETWORK call, so timed and non-interactive (2026-09-24, the
              // audit): a bare execFileSync here had no timeout and could
              // prompt on /dev/tty, freezing every poll and lease on the
              // machine behind this cleanup's own async loop.
              await gitNetAsync(['push', 'origin', `:refs/heads/${job.branch}`], repoRoot);
            } catch {
              /* branch already gone — fine */
            }
          } else if (job.prUrl || job.branch) {
            warn(`cleanup REFUSED for "${job.title}": untrusted PR/branch value`);
          }
          await postToFleet(CLEANUP_DONE_URL, { taskId: job.id });
          ok(`${c.cyan('cleaned')} ${c.dim(`— ${job.title}`)}`);
        } finally {
          cleaning.delete(job.id);
        }
      })();
    }
  };
  return processCleanupJobs;
}
