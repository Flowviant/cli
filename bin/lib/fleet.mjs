/**
 * Fleet daemon. Install ONCE with a fleet credential; manage everything from
 * Flowviant. The daemon polls GET /api/v2/fleet/agents, reconciles one persistent
 * git worktree + worker loop per roster agent, rotates each worker's short-lived
 * MCP token, and only spawns Claude when the server says an agent has work.
 */

import { mkdirSync, existsSync, rmSync } from 'node:fs';
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
  AUTO_UPDATE,
} from './config.mjs';
import { handleVersionSignal } from './update.mjs';
import {
  git,
  resetWorktree,
  repoRootOrDie,
  detectBaseRef,
  originSlug,
  isValidPrUrl,
  isValidBranch,
  isSafePathSegment,
} from './git.mjs';
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
  SYSTEM_WIKI,
  WIKI_KICKOFF,
  SYSTEM_REGROUND,
  REGROUND_KICKOFF,
} from './claude.mjs';
import { runLiveWorker } from './live.mjs';
import { reapOrphanPreviews } from './preview.mjs';
import { preflight } from './preflight.mjs';
import { connectStream } from './stream.mjs';
import { ensureVault, syncVault } from './vault.mjs';
import {
  envQueryParams,
  handleRosterEnv,
  materializeInto,
  scrub as envScrub,
} from './env.mjs';

async function fetchRoster(haveIds) {
  const url = new URL(FLEET_URL);
  if (haveIds.length) url.searchParams.set('have', haveIds.join(','));
  // Env-sync identity + materialized version (the Settings "env vN" chip).
  try {
    for (const [k, v] of Object.entries(await envQueryParams())) {
      if (v) url.searchParams.set(k, v);
    }
  } catch {
    /* env identity is best-effort — the poll must never fail on it */
  }
  // An explicit User-Agent is required: Node's default ("node"/empty) trips
  // Cloudflare Bot Fight Mode (403). A descriptive product UA passes.
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${FLEET_TOKEN}`, 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(30_000), // a black-holed poll must not stall the loop
  });
  if (res.status === 401 || res.status === 403) {
    // Fleet credential revoked/expired — retrying can't recover; signal exit.
    const e = new Error(`fleet credential rejected (${res.status})`);
    e.auth = true;
    throw e;
  }
  if (!res.ok) throw new Error(`fleet poll failed (${res.status})`);
  const body = await res.json();
  // Validate the shape here so a malformed 200 (deploy hiccup, error envelope)
  // throws a NORMAL retryable error inside the loop's try/catch, instead of a
  // `roster.agents.map` TypeError escaping to top-level and killing the daemon.
  const data = body?.data;
  if (!data || !Array.isArray(data.agents)) {
    throw new Error('fleet poll returned an unexpected shape');
  }
  // Drop roster agents with an unsafe id BEFORE they're used as a path segment.
  data.agents = data.agents.filter((a) => {
    if (isSafePathSegment(a?.agentId)) return true;
    warn(`ignoring roster agent with an invalid id: ${JSON.stringify(a?.agentId)}`);
    return false;
  });
  return data; // { mcpUrl, leaseTtlSeconds, agents: [{agentId,name,token,reviewGate,hasWork}] }
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
      materializeInto(cwd); // reset wiped the env files (git clean -fd) — rewrite
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
  await preflight({ needGit: true });
  // Kill any preview dev-server/tunnel groups a previously-crashed daemon left
  // running (detached children survive an ungraceful exit) before we start fresh.
  reapOrphanPreviews((m) => info(m));

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
  let daemonAlive = true; // flipped false on shutdown so the stream stops reconnecting
  let stream = null; // push channel handle (set once the loop is set up)

  // Shutdown KEEPS the worktrees: in-flight local work survives Ctrl+C and
  // resumes in place on the next run (the task marker matches). Worktrees are
  // only removed when an agent is deleted from the roster, or by
  // `flowviant clean`.
  const teardown = () => {
    daemonAlive = false;
    try {
      stream?.close();
    } catch {
      /* best-effort */
    }
    // A mid-sweep wiki Claude must die with the daemon — orphaning it leaves it
    // burning quota, and a restarted daemon would start a SECOND sweep racing
    // it on the same vault dir + sync state.
    try {
      wikiChild?.kill('SIGKILL');
    } catch {
      /* best-effort */
    }
    for (const [, w] of workers) {
      w.state.alive = false;
      try {
        w.state.child?.kill('SIGKILL');
      } catch {
        /* best-effort */
      }
      // Stop the detached preview (dev server + cloudflared tunnel) — it's its
      // own process group and survives our exit, otherwise leaking a port-bound
      // server + a live tunnel serving a stale branch until reboot.
      try {
        w.state.stopPreview?.();
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
        signal: AbortSignal.timeout(30_000),
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
          // Refuse a PR URL that isn't an https github.com PR in THIS repo — a
          // bad/hostile server must not merge a PR in another repo the user's
          // gh can write to (and a leading '-' would be a gh flag).
          if (!isValidPrUrl(job.prUrl, originSlug(repoRoot))) {
            mergeAttempts.delete(job.id);
            await reportMergeOutcome(MERGE_FAILED_URL, {
              intentId: job.id,
              message: 'refused: PR URL is not a pull request in this repository',
            });
            warn(`merge REFUSED for "${job.title}": untrusted PR URL ${String(job.prUrl)}`);
            return;
          }
          try {
            execFileSync('gh', ['pr', 'merge', job.prUrl, '--squash', '--delete-branch'], {
              cwd: repoRoot,
              stdio: ['ignore', 'pipe', 'pipe'],
            });
            merged = true;
          } catch (e) {
            const err = e.stderr?.toString?.() || e.message || '';
            const line = err.split('\n')[0] || 'gh pr merge failed';
            // Only "already merged" is a real success; a CLOSED-without-merge PR
            // also matches "not open"/"closed" but nothing landed on main —
            // report it as a failure so the thread learns the truth.
            if (/already merged/i.test(err)) merged = true;
            else if (/not open|closed/i.test(err)) {
              failedReason = 'the PR was closed without merging';
            } else if (/conflict|not mergeable|CONFLICTING/i.test(err)) {
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
            // The code just landed — re-ground the living wiki for what shipped
            // (touched nodes re-read + a persistent feature-history node).
            // Direct enqueue = immediacy; the server's durable regroundJobs list
            // (created by merge-done above, cleared by our reground-done report)
            // is the restart-safe backstop — dedup'd here by groundedIntents.
            enqueueReground(job.id, job.prUrl, job.title);
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
                { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] }
              );
            } catch (e) {
              // Already closed/merged/missing = fine; anything else we still
              // report done — a restart must never wedge on stale remotes.
              const err = e.stderr?.toString?.() || e.message || '';
              warn(`cleanup for "${job.title}": ${err.split('\n')[0] || 'gh pr close failed'}`);
            }
          } else if (job.branch && isValidBranch(job.branch, repoRoot, baseRef)) {
            try {
              // Explicit refspec form so a leading '-' can't be a git flag.
              execFileSync('git', ['push', 'origin', `:refs/heads/${job.branch}`], {
                cwd: repoRoot,
                stdio: ['ignore', 'pipe', 'pipe'],
              });
            } catch {
              /* branch already gone — fine */
            }
          } else if (job.prUrl || job.branch) {
            warn(`cleanup REFUSED for "${job.title}": untrusted PR/branch value`);
          }
          await reportMergeOutcome(CLEANUP_DONE_URL, { intentId: job.id });
          ok(`${c.cyan('cleaned')} ${c.dim(`— ${job.title}`)}`);
        } finally {
          cleaning.delete(job.id);
        }
      })();
    }
  };

  // Living-wiki work runs ONE turn at a time in a dedicated repo worktree (off
  // the agents' checkouts). Claude READS the repo there and writes the markdown
  // VAULT (~/.flowviant/vaults/<projectId>) — plain files, no MCP tools; the
  // daemon hash-diff syncs the vault to the server after each turn. Two
  // triggers enqueue: a Regenerate click (full SWEEP, finalize-prunes) and a
  // successful merge (incremental RE-GROUND). One queue + runner serializes
  // them so they never collide on the worktree or the vault. Wiki work needs no
  // agent online.
  const wikiWt = join(baseDir, 'wiki');
  const REGROUND_DONE_URL = FLEET_URL.replace(/\/agents\/?$/, '/reground-done');
  const WIKI_VAULT_URL = FLEET_URL.replace(/\/agents\/?$/, '/wiki-vault');
  const WIKI_PROGRESS_URL = FLEET_URL.replace(/\/agents\/?$/, '/wiki-progress');
  const wikiQueue = [];
  let wikiBusy = false;
  let wikiChild = null; // the wiki turn's Claude process — tracked so teardown can kill it
  let lastSweepAt = null; // dedup: run each Regenerate request once
  const groundedIntents = new Set(); // dedup: re-ground each delivery once
  // The vault is keyed by the server project this fleet credential serves
  // (learned from the roster); until the first poll names it, fall back to a
  // repo-keyed dir so a stale-server daemon still works.
  let wikiProjectId = null;
  const vaultDirFor = () =>
    wikiProjectId && isSafePathSegment(wikiProjectId)
      ? join(homedir(), '.flowviant', 'vaults', wikiProjectId)
      : join(homedir(), '.flowviant', 'vaults', repoKey);

  // Stream what the wiki turn is doing to the app (the canvas renders the read
  // phase). Throttled to ~1/s — the FIRST activity of a run and the terminal
  // `done` frame force-send so the cover appears fast and clears cleanly.
  let lastProgressAt = 0;
  const postWikiProgress = async (body, force = false) => {
    const now = Date.now();
    if (!force && now - lastProgressAt < 600) return;
    lastProgressAt = now;
    // Uplink scrub: narration/labels can quote repo content, and repo content
    // can contain a synced secret — redact known values before anything leaves
    // this machine.
    const safe = {
      ...body,
      ...(typeof body.activity === 'string' ? { activity: envScrub(body.activity) } : {}),
      ...(Array.isArray(body.recent) ? { recent: body.recent.map((s) => envScrub(s)) } : {}),
    };
    try {
      await fetch(WIKI_PROGRESS_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${FLEET_TOKEN}`,
          'User-Agent': USER_AGENT,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(15_000),
        body: JSON.stringify(safe),
      });
    } catch {
      /* best-effort — a dropped frame is harmless, the next one supersedes it */
    }
  };

  const enqueueSweep = (job) => {
    if (!job || job.requestedAt === lastSweepAt) return;
    lastSweepAt = job.requestedAt;
    // A full sweep is expensive — never stack two. One queued sweep already
    // covers any newer Regenerate click (it reads the repo fresh when it runs).
    // A failed/partial sweep stays recoverable: re-clicking Regenerate always
    // refreshes requestedAt server-side, beating this dedup.
    if (wikiQueue.some((t) => t.type === 'sweep')) return;
    wikiQueue.push({ type: 'sweep' });
    void drainWiki();
  };
  const enqueueReground = (intentId, prUrl, title) => {
    if (!intentId || groundedIntents.has(intentId)) return;
    groundedIntents.add(intentId);
    wikiQueue.push({ type: 'reground', intentId, prUrl, title: title || 'a delivered task' });
    void drainWiki();
  };

  // Changed files of a (merged) PR, for the re-ground prompt. Capped so a huge
  // PR can't blow up the prompt. prUrl was already validated before the merge.
  // Returns null on a gh FAILURE (network/auth) — distinct from a PR that
  // genuinely changed nothing — so the caller can retry instead of silently
  // consuming the durable job with no re-ground run.
  const changedFilesForPr = (prUrl) => {
    try {
      const out = execFileSync('gh', ['pr', 'view', prUrl, '--json', 'files'], {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return (JSON.parse(out).files ?? []).map((f) => f.path).filter(Boolean).slice(0, 60);
    } catch {
      return null;
    }
  };
  const regroundAttempts = new Map(); // intentId -> gh-failure count

  async function drainWiki() {
    if (wikiBusy || wikiQueue.length === 0) return;
    wikiBusy = true;
    try {
      while (wikiQueue.length) {
        const task = wikiQueue.shift();
        // The vault is plain files — the turn needs no MCP server and no
        // cartographer token; the daemon itself syncs afterwards on the fleet
        // credential.
        const vaultDir = vaultDirFor();
        ensureVault(vaultDir);
        // Live progress for this turn: a rolling FEED of everything Claude does
        // (thinking, narration, reads, node writes), the file count, and the
        // phase — streamed to the app (throttled; each frame carries the whole
        // recent tail so a dropped POST loses nothing). elapsedSec is the
        // daemon's own clock.
        const mode = task.type === 'sweep' ? 'sweep' : 'reground';
        const startedAt = Date.now();
        let filesRead = 0;
        let phase = 'reading';
        const feed = [];
        const frame = (extra) => ({
          mode,
          phase,
          activity: feed[feed.length - 1] ?? '',
          recent: feed.slice(-24),
          filesRead,
          elapsedSec: Math.round((Date.now() - startedAt) / 1000),
          ...extra,
        });
        const onActivity = (a) => {
          if (a.kind === 'read') filesRead++;
          if (a.kind === 'write') phase = 'writing';
          // Collapse runs of bare "thinking…" so the feed doesn't fill with it.
          if (!(a.label === 'thinking…' && feed[feed.length - 1] === 'thinking…')) {
            feed.push(a.label);
            if (feed.length > 48) feed.shift();
          }
          void postWikiProgress(frame());
        };
        // Heartbeat: re-send the current frame every 5s even with no new stream
        // event, so the app's freshness window never lapses during a long
        // thinking block or slow tool (which emit nothing until they finish) —
        // otherwise the cover would flap back to the empty state mid-sweep.
        let heartbeat = null;
        try {
          // Immediate frame so the cover shows the daemon feed right away (the
          // "reading your code" phase), not a static message, while Claude warms up.
          feed.push('starting…');
          await postWikiProgress(frame(), true);
          heartbeat = setInterval(() => void postWikiProgress(frame(), true), 5000);
          if (!existsSync(wikiWt)) {
            try {
              git(['worktree', 'add', '--detach', wikiWt, baseRef], repoRoot);
            } catch {
              git(['worktree', 'prune'], repoRoot);
              git(['worktree', 'add', '--detach', wikiWt, baseRef], repoRoot);
            }
          }
          resetWorktree(wikiWt, baseRef);
          let sha = '';
          try {
            sha = git(['rev-parse', 'HEAD'], wikiWt);
          } catch {
            /* detached/no HEAD — still writes the map, just ungrounded */
          }
          // Sync the vault after the turn regardless of the sentinel: a died
          // sweep's partial pages still persist (merge, no prune) — only a
          // COMPLETED sweep finalizes, so an interrupted one can't erase pages.
          const runSync = async (finalize) => {
            try {
              const r = await syncVault({
                dir: vaultDir,
                url: WIKI_VAULT_URL,
                token: FLEET_TOKEN,
                userAgent: USER_AGENT,
                finalize,
                groundedAtSha: sha || undefined,
                // Powers the GitHub blob links behind every cited file path.
                repoFullName: originSlug(repoRoot) || undefined,
                warn,
                // Redact synced secrets a page may have quoted from the repo.
                scrub: envScrub,
              });
              if (r.skipped) note(`${c.cyan('wiki')} ${c.dim('— vault unchanged, nothing to sync')}`);
              else
                ok(
                  `${c.cyan('wiki')} ${c.dim(
                    `— synced ${r.uploaded} page${r.uploaded === 1 ? '' : 's'} (${r.pages} total${r.deleted ? `, ${r.deleted} removed` : ''})`
                  )}`
                );
            } catch (e) {
              warn(`wiki vault sync failed: ${e.message} — pages stay local; next turn retries`);
            }
          };
          if (task.type === 'sweep') {
            note(`${c.cyan('wiki')} ${c.dim('— regenerating: your Claude is reading the repo…')}`);
            const out = await runTurn({
              prompt: WIKI_KICKOFF(sha, vaultDir),
              resume: false,
              system: SYSTEM_WIKI(vaultDir),
              cwd: wikiWt,
              wikiPerm: true,
              label: c.cyan('[wiki]'),
              streamJson: true,
              onActivity,
              onSpawn: (ch) => {
                wikiChild = ch;
              },
            });
            const complete = sawSentinel(out, 'WIKI_DONE');
            if (complete) ok(`${c.cyan('wiki')} ${c.dim('— vault regenerated from your code.')}`);
            else
              warn('wiki sweep ended without WIKI_DONE — partial pages synced; retry from the app.');
            await runSync(complete);
          } else {
            const files = changedFilesForPr(task.prUrl);
            if (files === null) {
              // gh failed (network/auth) — retry via the durable job a couple
              // of times before consuming it, so a transient outage doesn't
              // silently drop the re-ground.
              const n = (regroundAttempts.get(task.intentId) ?? 0) + 1;
              regroundAttempts.set(task.intentId, n);
              if (n < 3) {
                warn(`wiki re-ground for "${task.title}": gh failed — will retry (${n}/3)`);
                groundedIntents.delete(task.intentId); // let the roster re-offer it
                continue;
              }
              warn(`wiki re-ground for "${task.title}": gh failed ${n} times — giving up (heals on the next full sweep)`);
            } else if (files.length === 0) {
              note(`${c.cyan('wiki')} ${c.dim(`— "${task.title}": no changed files to re-ground`)}`);
            } else {
              note(`${c.cyan('wiki')} ${c.dim(`— re-grounding after "${task.title}"…`)}`);
              const out = await runTurn({
                prompt: REGROUND_KICKOFF({ sha, title: task.title, files, vaultDir }),
                resume: false,
                system: SYSTEM_REGROUND(vaultDir),
                cwd: wikiWt,
                wikiPerm: true,
                label: c.cyan('[wiki]'),
                streamJson: true,
                onActivity,
                onSpawn: (ch) => {
                  wikiChild = ch;
                },
              });
              if (sawSentinel(out, 'REGROUND_DONE'))
                ok(`${c.cyan('wiki')} ${c.dim(`— vault updated for "${task.title}".`)}`);
              else warn(`wiki re-ground for "${task.title}" ended without REGROUND_DONE.`);
              await runSync(false);
            }
            // Consume the durable job: attempted = done (success or not — the
            // sync is idempotent and a failed turn heals on the next full
            // sweep), so a failing re-ground can't loop-burn quota. Only a
            // crash BEFORE this line leaves the job listed for a retry.
            regroundAttempts.delete(task.intentId);
            await reportMergeOutcome(REGROUND_DONE_URL, { intentId: task.intentId });
          }
        } catch (e) {
          warn(`wiki ${task.type} failed: ${e.message}`);
        } finally {
          wikiChild = null;
          if (heartbeat) clearInterval(heartbeat);
          // Terminal frame so the app cover clears promptly (don't wait for the
          // freshness window to lapse). force-sent past the throttle.
          await postWikiProgress(frame({ done: true }), true);
          // Safety net: the wiki turn is read-only on the repo by CONTRACT, but
          // permission enforcement is a curated tool list, not a path jail —
          // discard anything a confused turn wrote to the worktree so it can
          // never leak into a later turn or a push.
          try {
            resetWorktree(wikiWt, baseRef);
          } catch {
            /* best-effort */
          }
        }
      }
    } finally {
      wikiBusy = false;
    }
  }

  let connected = false; // log the first successful poll once
  let rosterSig = null; // last roster membership, to log changes only
  let idleBeatAt = 0; // throttle the "still alive" idle heartbeat
  let joinCount = 0; // for stable per-agent label colours

  // ── Push channel: a server wake short-circuits the reconcile sleep so a job is
  // picked up in ~a round trip instead of on the next poll. The socket only
  // nudges — we still fetch the roster below — so it's pure latency, and the
  // poll stays the fallback whenever the socket is down. `waitReconcile()`
  // resolves on either a wake or the RECONCILE_SECONDS timeout, whichever first.
  let wakeSignal = null; // { resolve, timer } while the loop is idling
  let pendingWake = false; // a wake that landed mid-reconcile — honored next wait
  const fireWake = () => {
    if (wakeSignal) {
      clearTimeout(wakeSignal.timer);
      const { resolve } = wakeSignal;
      wakeSignal = null;
      resolve();
    } else {
      pendingWake = true; // not idling right now; don't lose the wake
    }
  };
  const waitReconcile = () => {
    if (pendingWake) {
      pendingWake = false;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        wakeSignal = null;
        resolve();
      }, RECONCILE_SECONDS * 1000);
      wakeSignal = { resolve, timer };
    });
  };
  stream = connectStream({ onWake: () => fireWake(), isAlive: () => daemonAlive });

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
      // Name the scoped project so a mismatch (this daemon serves project A, but
      // you're viewing project B's wiki) is obvious instead of a silent no-op.
      if (roster.project) {
        note(
          `${c.cyan('project')} · ${c.bold(roster.project.name)} ${c.dim(`(${roster.project.id})`)}`
        );
        note(c.dim('  wiki + agents stream to THIS project — view its Code canvas in Flowviant.'));
      }
    }
    if (roster.mcpUrl) mcpUrl = roster.mcpUrl;
    if (roster.project?.id) wikiProjectId = roster.project.id; // keys the vault dir
    if (roster.leaseTtlSeconds) leaseTtlSeconds = roster.leaseTtlSeconds;
    // Keep the daemon current. Safe = no worker mid-task (true at startup, since
    // no workers are spawned yet). If it self-updates it re-execs into the new
    // version and this process becomes a proxy — stop the loop.
    if (roster.daemon) {
      // "No worker mid-task" must include the wiki runner: updating mid-sweep
      // re-execs the daemon, orphans the wiki Claude, and the fresh process
      // starts a second sweep racing it on the same vault.
      const safeToUpdate =
        !wikiBusy && [...workers.values()].every((w) => w.state.child == null);
      const updating = handleVersionSignal({
        latest: roster.daemon.latest,
        min: roster.daemon.min,
        autoUpdate: AUTO_UPDATE,
        safeToUpdate,
        teardown,
      });
      if (updating) return;
    }
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
        try {
          materializeInto(wt); // synced env into the fresh worktree
        } catch {
          /* best-effort */
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
          repoRoot, // for copying the repo's local env into the preview worktree

          getToken: (id) => tokenByAgent.get(id),
          getHasWork: (id) => hasWorkByAgent.get(id) ?? false,
          getMcpUrl: () => mcpUrl,
          isAlive: () => state.alive,
          onChild: (ch) => {
            state.child = ch;
          },
          // Hold the preview's stop fn so teardown/removal can kill the detached
          // dev-server + tunnel (they survive our exit otherwise).
          onPreview: (stop) => {
            state.stopPreview = stop;
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

    // Living-wiki work (runs under its own minted wiki token — no agent
    // needed). enqueueSweep queues a Regenerate; regroundJobs re-offers merged
    // deliveries whose re-ground never ran (e.g. we restarted between merge and
    // turn) until we report reground-done; the bare drain flushes anything
    // whose earlier mint failed.
    enqueueSweep(roster.codeMapJob);
    for (const j of roster.regroundJobs ?? []) enqueueReground(j.intentId, j.prUrl, j.title);
    void drainWiki();

    // Env sync tick: register/bootstrap/wrap/rotate/sync as the roster block
    // dictates (self-guarded — one operation at a time, errors retry next
    // poll). A fresh bundle rematerializes every AGENT worktree; the wiki
    // worktree NEVER gets env (the cartographer doesn't need secrets).
    void handleRosterEnv(roster.env, { projectId: roster.project?.id }).then(({ changed }) => {
      if (!changed) return;
      for (const [, w] of workers) {
        try {
          materializeInto(w.wt);
        } catch {
          /* best-effort */
        }
      }
    });

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
          w.state.stopPreview?.();
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
        mintedAt.delete(id); // was leaked on removal (finding 14)
      }
    }

    // Idle until the next poll deadline OR a push wake — whichever comes first.
    await waitReconcile();
  }
}
