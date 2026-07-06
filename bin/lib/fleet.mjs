/**
 * Fleet daemon. Install ONCE with a fleet credential; manage everything from
 * Flowviant. The daemon polls GET /api/v2/fleet/agents, reconciles one persistent
 * git worktree + worker loop per roster agent, rotates each worker's short-lived
 * MCP token, and only spawns Claude when the server says an agent has work.
 */

import { mkdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';
import {
  VERSION,
  FLEET_URL,
  FLEET_TOKEN,
  USER_AGENT,
  MCP_URL,
  SAFE,
  POLL_SECONDS,
  IDLE_SECONDS,
  RECONCILE_SECONDS,
  REFRESH_BEFORE_SECONDS,
  LIVE,
} from './config.mjs';
import { c, LABEL_COLORS, info, note, ok, warn, fail } from './ui.mjs';
import {
  sleep,
  mcpConfigFor,
  runTurn,
  sawSentinel,
  blockedId,
  SYSTEM_SINGLE,
  SINGLE_KICKOFF,
  SINGLE_RESUME,
} from './claude.mjs';
import { git, repoRootOrDie, detectBaseRef, resetWorktree } from './git.mjs';
import { runLiveWorker } from './live.mjs';
import { preflight } from './preflight.mjs';

async function fetchRoster(haveIds) {
  const url = new URL(FLEET_URL);
  if (haveIds.length) url.searchParams.set('have', haveIds.join(','));
  // An explicit User-Agent is required: Node's default ("node"/empty) trips
  // Cloudflare Bot Fight Mode (403). A descriptive product UA passes.
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${FLEET_TOKEN}`, 'User-Agent': USER_AGENT },
  });
  if (res.status === 401 || res.status === 403) {
    // Fleet credential revoked/expired — retrying can't recover; signal exit.
    const e = new Error(`fleet credential rejected (${res.status})`);
    e.auth = true;
    throw e;
  }
  if (!res.ok) throw new Error(`fleet poll failed (${res.status})`);
  const body = await res.json();
  return body.data; // { mcpUrl, leaseTtlSeconds, agents: [{agentId,name,token,reviewGate,hasWork}] }
}

// One roster agent's loop: persistent worktree, one intent per turn, reset to
// base between tasks (fresh conversation), resume in place while on a blocker.
async function runFleetWorker({ agentId, label, cwd, baseRef, getToken, getHasWork, getMcpUrl, isAlive, onChild, onTokenSuspect }) {
  let resuming = false;
  let needsReset = true; // reset to base before a FRESH task, not on idle polls
  let phase = ''; // '', 'idle', 'blocked' — log each transition once, not per poll
  const enter = (p, fn, msg) => {
    if (phase !== p) {
      phase = p;
      fn(`${label} ${msg}`);
    }
  };
  while (isAlive()) {
    const token = getToken(agentId);
    if (!token) {
      await sleep(IDLE_SECONDS);
      continue;
    }
    // Idle = no claimable work (the server tells us via the roster poll). Don't
    // spawn Claude just to find nothing — that's a wasted API call. A blocked
    // task (resuming) still polls, so its resolution gets picked up.
    if (!resuming && !getHasWork(agentId)) {
      enter('idle', info, 'idle — no work assigned');
      await sleep(IDLE_SECONDS);
      continue;
    }
    if (!resuming && needsReset) {
      resetWorktree(cwd, baseRef); // clean slate for a new task
      needsReset = false;
    }
    const { dir, path: mcpConfig } = mcpConfigFor(token, getMcpUrl());
    let out = '';
    try {
      out = await runTurn({
        prompt: resuming ? SINGLE_RESUME : SINGLE_KICKOFF,
        resume: resuming,
        system: SYSTEM_SINGLE,
        cwd,
        mcpConfig,
        label,
        onSpawn: (ch) => onChild?.(ch),
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
      onChild?.(null);
    }
    if (!isAlive()) break;
    if (blockedId(out)) {
      enter('blocked', warn, `${c.yellow('paused')}${c.dim(' — waiting on your review/answer in Flowviant')}`);
      resuming = true;
      await sleep(POLL_SECONDS);
      continue;
    }
    if (sawSentinel(out, 'NOTHING')) {
      enter('idle', info, 'idle — no work assigned');
      resuming = false;
      await sleep(IDLE_SECONDS);
      continue;
    }
    if (sawSentinel(out, 'DONE')) {
      ok(`${label} ${c.dim('finished a task — PR opened for your review')}`);
      phase = '';
      resuming = false;
      needsReset = true;
      continue;
    }
    // No sentinel — the turn didn't complete the protocol. Almost always the
    // flowviant MCP failed to surface its tools (usually a stale worker token).
    // Drop the cached token so the next poll re-mints a fresh one, then retry —
    // don't fake a blocker or a completion.
    enter('reconnect', warn, `${c.yellow('no result')}${c.dim(' — refreshing token, retrying')}`);
    onTokenSuspect?.(agentId);
    // A no-sentinel turn while RESUMING a blocked task is a transient MCP/token
    // failure, not completion — retry in place and KEEP the worktree. Resetting
    // here would wipe the blocked task's uncommitted changes. Only a fresh-task
    // turn (not resuming) warrants a clean slate next time.
    if (!resuming) needsReset = true;
    await sleep(IDLE_SECONDS);
  }
  info(`${label} stopped`);
}

export async function runFleetDaemon() {
  console.log('');
  console.log(`  ${c.bold(c.cyan('◣ flowviant'))}  ${c.dim(`fleet daemon · v${VERSION}`)}`);
  console.log(`  ${c.dim('──────────────────────────────────────────────')}`);
  const repoRoot = repoRootOrDie();
  const baseRef = detectBaseRef(repoRoot);
  info(SAFE ? 'mode   · safe (restricted toolset)' : 'mode   · unattended (skips permission prompts)');
  info(`repo   · ${repoRoot}`);
  info(`base   · ${baseRef}`);
  info(`server · ${FLEET_URL}`);
  console.log('');
  preflight({ needGit: true });

  // Persistent worktree home (0.9.0) — survives daemon restarts AND reboots,
  // so Ctrl+C mid-task never loses local work. Keyed per repo path; each
  // agent's worktree carries a task marker so a resumed claim keeps its files.
  const repoKey = `${basename(repoRoot)}-${createHash('sha256').update(repoRoot).digest('hex').slice(0, 8)}`;
  const baseDir = join(homedir(), '.flowviant', 'worktrees', repoKey);
  mkdirSync(baseDir, { recursive: true });
  try {
    const kb = Number(execFileSync('du', ['-sk', baseDir], { encoding: 'utf8' }).split('\t')[0]);
    if (kb > 1024)
      info(
        `disk   · worktrees ${(kb / 1024 / 1024).toFixed(1)} GB at ~/.flowviant/worktrees — \`flowviant clean\` reclaims`
      );
  } catch {
    /* du unavailable (Windows) — skip the disk line */
  }
  const tokenByAgent = new Map(); // agentId -> latest worker token
  const mintedAt = new Map(); // agentId -> ms when we last got a fresh token
  const hasWorkByAgent = new Map(); // agentId -> server says it has claimable work
  let leaseTtlSeconds = 24 * 60 * 60; // updated from each roster response
  let mcpUrl = MCP_URL;
  const workers = new Map(); // agentId -> { state, promise, wt, label }

  // Shutdown KEEPS the worktrees: in-flight local work survives Ctrl+C and
  // resumes in place on the next run (the task marker matches). Worktrees are
  // only removed when an agent is deleted from the roster, or by
  // `flowviant clean`.
  const teardown = () => {
    for (const [, w] of workers) {
      w.state.alive = false;
      try {
        w.state.child?.kill('SIGKILL');
      } catch {
        /* best-effort */
      }
    }
  };
  process.on('SIGINT', () => {
    console.log('');
    note('shutting down — stopping workers. Worktrees are kept: in-flight work resumes next run.');
    teardown();
    process.exit(130);
  });

  // Merge jobs (Flowvy-commanded): approved PRs to squash-merge to main on the
  // user's own gh. `merging` guards against re-processing a job mid-flight.
  const MERGE_DONE_URL = FLEET_URL.replace(/\/agents\/?$/, '/merge-done');
  const MERGE_FAILED_URL = FLEET_URL.replace(/\/agents\/?$/, '/merge-failed');
  const merging = new Set();
  const mergeAttempts = new Map(); // job.id -> transient-failure count
  const reportMergeOutcome = async (url, body) => {
    try {
      await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${FLEET_TOKEN}`,
          'User-Agent': USER_AGENT,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
    } catch {
      /* best-effort — the job reappears next poll if this failed */
    }
  };
  const processMergeJobs = (jobs) => {
    for (const job of jobs ?? []) {
      if (merging.has(job.id)) continue;
      merging.add(job.id);
      (async () => {
        try {
          note(`${c.cyan('merge')} ${c.dim(`— ${job.title}`)}`);
          let merged = false;
          let failedReason = null; // permanent — tell the thread, clear the flag
          try {
            execFileSync('gh', ['pr', 'merge', job.prUrl, '--squash', '--delete-branch'], {
              cwd: repoRoot,
              stdio: ['ignore', 'pipe', 'pipe'],
            });
            merged = true;
          } catch (e) {
            const err = e.stderr?.toString?.() || e.message || '';
            const line = err.split('\n')[0] || 'gh pr merge failed';
            if (/already merged|not open|closed/i.test(err)) merged = true;
            else if (/conflict|not mergeable|CONFLICTING/i.test(err)) {
              // Permanent until a human/agent acts — don't spin on it.
              failedReason = `merge conflict with ${baseRef} — the branch needs a rebase`;
            } else {
              // Transient (auth hiccup, network, CI requirement): retry a few
              // polls, then surface it instead of silently looping forever.
              const n = (mergeAttempts.get(job.id) ?? 0) + 1;
              mergeAttempts.set(job.id, n);
              if (n >= 3) failedReason = line;
              else warn(`merge failed for "${job.title}": ${line} — will retry`);
            }
          }
          if (merged) {
            mergeAttempts.delete(job.id);
            await reportMergeOutcome(MERGE_DONE_URL, { intentId: job.id });
            ok(`${c.cyan('merged')} ${c.dim(`— ${job.title} → ${baseRef}`)}`);
          } else if (failedReason) {
            // Report into the thread (server narrates + re-arms the merge
            // button + notifies) — the job disappears from the roster.
            mergeAttempts.delete(job.id);
            await reportMergeOutcome(MERGE_FAILED_URL, {
              intentId: job.id,
              message: failedReason,
            });
            warn(`merge failed for "${job.title}": ${failedReason} — reported to the thread`);
          }
        } finally {
          merging.delete(job.id);
        }
      })();
    }
  };

  // Cleanup jobs (task restarts): close the abandoned PR + delete its remote
  // branch on the user's own gh, so a restart doesn't litter the repo.
  const CLEANUP_DONE_URL = FLEET_URL.replace(/\/agents\/?$/, '/cleanup-done');
  const cleaning = new Set();
  const processCleanupJobs = (jobs) => {
    for (const job of jobs ?? []) {
      if (cleaning.has(job.id)) continue;
      cleaning.add(job.id);
      (async () => {
        try {
          note(`${c.cyan('cleanup')} ${c.dim(`— ${job.title} (restarted)`)}`);
          if (job.prUrl) {
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
                { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] }
              );
            } catch (e) {
              // Already closed/merged/missing = fine; anything else we still
              // report done — a restart must never wedge on stale remotes.
              const err = e.stderr?.toString?.() || e.message || '';
              warn(`cleanup for "${job.title}": ${err.split('\n')[0] || 'gh pr close failed'}`);
            }
          } else if (job.branch) {
            try {
              execFileSync('git', ['push', 'origin', '--delete', job.branch], {
                cwd: repoRoot,
                stdio: ['ignore', 'pipe', 'pipe'],
              });
            } catch {
              /* branch already gone — fine */
            }
          }
          await reportMergeOutcome(CLEANUP_DONE_URL, { intentId: job.id });
          ok(`${c.cyan('cleaned')} ${c.dim(`— ${job.title}`)}`);
        } finally {
          cleaning.delete(job.id);
        }
      })();
    }
  };

  let connected = false; // log the first successful poll once
  let rosterSig = null; // last roster membership, to log changes only
  let idleBeatAt = 0; // throttle the "still alive" idle heartbeat
  let joinCount = 0; // for stable per-agent label colours

  // Which agents to tell the server we already hold a good token for. We keep
  // our token (omit a re-mint) UNLESS it's near expiry AND the worker is idle
  // (no child mid-turn) — then we drop it from `have` to force a fresh token,
  // safely between turns so we never swap a credential out from under a run.
  const buildHave = () =>
    [...tokenByAgent.keys()].filter((id) => {
      const ageS = (Date.now() - (mintedAt.get(id) ?? 0)) / 1000;
      const nearExpiry = ageS > leaseTtlSeconds - REFRESH_BEFORE_SECONDS;
      const midTurn = workers.get(id)?.state.child != null;
      return !nearExpiry || midTurn;
    });

  // Reconcile loop: poll roster, start new workers, stop removed ones.
  for (;;) {
    let roster;
    try {
      roster = await fetchRoster(buildHave());
    } catch (e) {
      if (e.auth) {
        fail(`${e.message} — credential revoked or invalid. Shutting down.`);
        teardown();
        process.exit(1);
      }
      warn(`roster poll failed: ${e.message} — retrying in ${RECONCILE_SECONDS}s`);
      await sleep(RECONCILE_SECONDS);
      continue;
    }
    if (!connected) {
      connected = true;
      ok('Connected to Flowviant — watching your roster.');
    }
    if (roster.mcpUrl) mcpUrl = roster.mcpUrl;
    if (roster.leaseTtlSeconds) leaseTtlSeconds = roster.leaseTtlSeconds;
    processMergeJobs(roster.mergeJobs);
    processCleanupJobs(roster.cleanupJobs);
    const rosterIds = new Set(roster.agents.map((a) => a.agentId));

    // Announce roster size only when it changes (not every poll).
    const sig = [...rosterIds].sort().join(',');
    if (sig !== rosterSig) {
      rosterSig = sig;
      if (rosterIds.size === 0) {
        warn('No agents on your roster yet.');
        info('Add agents in Flowviant → Cockpit → Fleet; they spin up here automatically.');
      } else {
        note(`Roster: ${c.bold(String(rosterIds.size))} agent${rosterIds.size === 1 ? '' : 's'}.`);
      }
    }
    // Heartbeat so a quiet/empty daemon visibly stays alive.
    if (rosterIds.size === 0 && Date.now() - idleBeatAt > 60_000) {
      idleBeatAt = Date.now();
      info('idle — waiting for agents…');
    }

    for (const a of roster.agents) {
      if (a.token) {
        tokenByAgent.set(a.agentId, a.token);
        mintedAt.set(a.agentId, Date.now());
      }
      hasWorkByAgent.set(a.agentId, !!a.hasWork);
      if (!workers.has(a.agentId)) {
        const wt = join(baseDir, `agent-${a.agentId}`);
        try {
          if (!existsSync(wt)) {
            try {
              git(['worktree', 'add', '--detach', wt, baseRef], repoRoot);
            } catch {
              // A stale registration (e.g. after `flowviant clean` rm'd the
              // dir) blocks re-adding the same path — prune and retry once.
              git(['worktree', 'prune'], repoRoot);
              git(['worktree', 'add', '--detach', wt, baseRef], repoRoot);
            }
          }
        } catch (e) {
          fail(`could not create worktree for "${a.name}": ${e.message}`);
          continue;
        }
        const colorFn = LABEL_COLORS[joinCount++ % LABEL_COLORS.length];
        const label = colorFn(`[${a.name}]`);
        const state = { alive: true, child: null };
        ok(`${label} ${c.dim(`online — worktree ready${LIVE ? ' · live session' : ''}`)}`);
        const workerFn = LIVE ? runLiveWorker : runFleetWorker;
        const promise = workerFn({
          agentId: a.agentId,
          label,
          cwd: wt,
          baseRef,
          getToken: (id) => tokenByAgent.get(id),
          getHasWork: (id) => hasWorkByAgent.get(id) ?? false,
          getMcpUrl: () => mcpUrl,
          isAlive: () => state.alive,
          onChild: (ch) => {
            state.child = ch;
          },
          // A turn that couldn't reach the MCP server: forget the cached token so
          // the next reconcile poll re-mints a fresh one (self-heals a token that
          // was rotated/expired out from under a running session).
          onTokenSuspect: (id) => {
            tokenByAgent.delete(id);
            mintedAt.delete(id);
          },
        });
        workers.set(a.agentId, { state, promise, wt, label });
      }
    }

    // Stop workers whose agent left the roster (removed in the app).
    for (const [id, w] of [...workers]) {
      if (!rosterIds.has(id)) {
        warn(`${w.label} removed — stopping it now, freeing its worktree.`);
        w.state.alive = false;
        // Immediate teardown (Q6=B): kill the in-flight Claude process now; its
        // task was already requeued server-side on removal.
        try {
          w.state.child?.kill('SIGKILL');
        } catch {
          /* best-effort */
        }
        try {
          git(['worktree', 'remove', '--force', w.wt], repoRoot);
        } catch {
          /* best-effort */
        }
        workers.delete(id);
        tokenByAgent.delete(id);
        hasWorkByAgent.delete(id);
      }
    }

    await sleep(RECONCILE_SECONDS);
  }
}
