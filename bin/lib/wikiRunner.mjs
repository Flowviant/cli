/**
 * THE LIVING-WIKI RUNNER — the queue, the admission-gated drain, and the one
 * cartographer CLI it runs at a time in the daemon's shared `wiki` worktree.
 *
 * Split out of fleet.mjs (SOLID audit 2026-09-26, F038). The wiki lane changes
 * for wiki reasons (sweep retry budgets, re-ground inputs, the progress feed,
 * the vault sync) and none of them are the reconcile loop's; the loop hands
 * each roster to `onRoster` and asks `busy()` / `liveTurns()` when it needs
 * to know whether this lane is working.
 *
 * Everything the lane needs from the daemon is passed in: the checkout and the
 * worktree home, the LIVE base ref (a getter — the roster can move it mid-run),
 * and the churn admission the other unattended lanes ask. `runTurn` and
 * `pickRuntimeFor` default to the real CLI driver and are injectable only so
 * the lane can be driven in a test without spending a model turn.
 *
 * Over the 500-line mark as ONE LIFECYCLE (queue → admission → turn → vault
 * sync → settle), not as debt. If it grows, the seam is the progress feed
 * (`postWikiProgress` / `postWikiAbandoned`), which changes for the canvas's
 * reasons rather than the lane's.
 */

import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { FLEET_URL, FLEET_TOKEN, USER_AGENT } from './config.mjs';
import { git, resetWorktree, originSlug, isSafePathSegment } from './git.mjs';
import { c, note, ok, warn } from './ui.mjs';
import { sawSentinel } from './claude.mjs';
import { runTurn as defaultRunTurn } from './runTurn.mjs';
import { SYSTEM_WIKI, WIKI_KICKOFF, SYSTEM_REGROUND, REGROUND_KICKOFF } from './prompts.mjs';
import { ensureVault, syncVault } from './vault.mjs';
import { scrub as envScrub } from './uplinkScrub.mjs';
import { RUNTIMES } from './runtimes.mjs';
import { pickRuntimeFor as defaultPickRuntimeFor } from './runtimeDetection.mjs';
import { recordMcpServers, recordSkills } from './runtimeCapabilities.mjs';
import { THINK_MARKER } from './runtimeEvents.mjs';
import { fleetEndpoint } from './fleetWire.mjs';
import { postToFleet } from './fleetPost.mjs';
import { addUsage } from './turnUsage.mjs';

export function createWikiRunner({
  repoRoot,
  baseDir,
  repoKey,
  getBaseRef,
  admit,
  runTurn = defaultRunTurn,
  pickRuntimeFor = defaultPickRuntimeFor,
}) {
  /**
   * Everything that reads or rewrites the shared `wikiWt` worktree takes this:
   * the wiki sweep, the post-merge re-ground, the plan check, and consults.
   *
   * They are one directory. The wiki queue hard-resets it (`checkout --detach`,
   * `reset --hard`, `clean -fd`) between tasks, which pulls the files out from
   * under anything else mid-read — and two Claude turns in one working tree is
   * incoherent even without the reset.
   */
  let wikiLock = Promise.resolve();
  const withWikiLock = (fn) => {
    const run = wikiLock.then(fn, fn);
    wikiLock = run.then(
      () => {},
      () => {}
    );
    return run;
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
  const REGROUND_DONE_URL = fleetEndpoint('reground-done', FLEET_URL);
  const WIKI_VAULT_URL = fleetEndpoint('wiki-vault', FLEET_URL);
  const WIKI_PROGRESS_URL = fleetEndpoint('wiki-progress', FLEET_URL);
  const WIKI_ABANDONED_URL = fleetEndpoint('wiki-abandoned', FLEET_URL);
  const wikiQueue = [];
  let wikiBusy = false;
  let wikiChild = null; // the wiki turn's Claude process — tracked so teardown can kill it
  let wikiHoldSaidAt = 0; // last time the drain said it was waiting on the box
  let lastSweepAt = null; // dedup: run each Regenerate request once
  // …UNLESS IT FAILED. A sweep that ends without WIKI_DONE never finalizes, so
  // the server's `regen_requested_at` stays set and the roster keeps offering
  // the same `requestedAt` — which this dedup then swallowed forever. The
  // console said "retry from the app", to a console nobody reads. Bounded the
  // same way the re-ground path is: a full sweep is an expensive model turn, so
  // a repo that fails one every time must not be able to loop-burn quota.
  let sweepAttempts = 0;
  // Which request the counter belongs to, so a NEW Regenerate click starts with
  // a full budget rather than inheriting an exhausted one.
  let sweepAttemptsFor = null;
  const MAX_SWEEP_ATTEMPTS = 3;
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

  /**
   * Tell the server this daemon has stopped retrying the pending sweep.
   *
   * The retry budget is a `let` in this process; `regen_requested_at` is a
   * durable column with a 24-hour TTL. Without this the two disagreed — the
   * daemon had permanently given up while every surface went on calling the
   * sweep queued, for the rest of the day. Best-effort: an older server 404s
   * once and the TTL is still the backstop it always was.
   */
  const postWikiAbandoned = async () => {
    try {
      await fetch(WIKI_ABANDONED_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${FLEET_TOKEN}`,
          'User-Agent': USER_AGENT,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(15_000),
        body: '{}',
      });
    } catch {
      /* best-effort — the request's own TTL still expires it */
    }
  };

  const enqueueSweep = (job) => {
    if (!job || job.requestedAt === lastSweepAt) return;
    if (job.requestedAt !== sweepAttemptsFor) {
      sweepAttemptsFor = job.requestedAt;
      sweepAttempts = 0;
    }
    lastSweepAt = job.requestedAt;
    // A full sweep is expensive — never stack two. One queued sweep already
    // covers any newer Regenerate click (it reads the repo fresh when it runs).
    // A failed/partial sweep stays recoverable: re-clicking Regenerate always
    // refreshes requestedAt server-side, beating this dedup.
    if (wikiQueue.some((t) => t.type === 'sweep')) return;
    wikiQueue.push({ type: 'sweep' });
    void drainWiki();
  };
  const enqueueReground = (intentId, prUrl, title, dirtiesPages, shas) => {
    if (!intentId || groundedIntents.has(intentId)) return;
    groundedIntents.add(intentId);
    wikiQueue.push({
      type: 'reground',
      intentId,
      prUrl,
      title: title || 'a delivered task',
      // What the PLAN thought this would invalidate. A hint, not the truth —
      // the turn still reads the real changed files; this catches pages whose
      // frontmatter file list has drifted, or that document a concept rather
      // than a directory.
      //
      // SANITIZED AT THE INTAKE, because every entry is server-supplied text
      // that ends up interpolated into a prompt and printed by the drain's
      // narration: a control byte can repaint the console it lands on, a
      // newline can break out of the prompt's own list framing, and an
      // unbounded array of unbounded strings is an unbounded prompt. This is
      // the belt at the intake; the prompt keeps its own fence at the
      // interpolation.
      dirtiesPages: (Array.isArray(dirtiesPages) ? dirtiesPages : [])
        .filter((p) => typeof p === 'string')
        .slice(0, 40)
        .map((p) =>
          p
            .replace(/[\u0000-\u001f\u007f]/g, ' ')
            .trim()
            .slice(0, 300)
        )
        .filter(Boolean),
      // THE COMMITS THAT SHIPPED — what changedFilesForShas resolves against.
      // Dropping this here was the whole 0.54.0/0.54.1 defect: the server sent
      // shas on every reground job, this function never stored them, and the
      // drain's `task.shas` was undefined on every job — so the re-ground
      // "revived" on 2026-08-22 retried three times against nothing and gave
      // up, on a console nobody reads, on every single ship.
      shas: Array.isArray(shas) ? shas : [],
    });
    void drainWiki();
  };

  // Changed files of a (merged) PR, for the re-ground prompt. Capped so a huge
  // PR can't blow up the prompt. prUrl was already validated before the merge.
  // WHICH FILES A SHIP CHANGED, read from the commits it landed.
  //
  // This asked `gh pr view <prUrl> --json files` until 2026-08-22, and `prUrl`
  // has been null by construction since dispatch was deleted on 2026-08-19 —
  // the server writes null and says so in a comment. Node threw on the null
  // argument, the catch below read it as "gh failed", and the re-ground retried
  // three times and gave up. Every post-ship re-ground for three months did
  // that silently, while the spec said ship re-grounds the wiki.
  //
  // Returns null when it learned NOTHING (no shas, or none of them resolvable),
  // which the caller still treats as retryable — distinct from a ship that
  // genuinely changed no files.
  const changedFilesForShas = (shas) => {
    if (!Array.isArray(shas) || shas.length === 0) return null;
    const files = new Set();
    for (const sha of shas.slice(0, 50)) {
      if (!/^[0-9a-f]{7,40}$/i.test(String(sha))) continue;
      try {
        const out = execFileSync(
          'git',
          ['show', '--name-only', '--pretty=format:', String(sha)],
          { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
        );
        for (const line of out.split('\n')) {
          const f = line.trim();
          if (f) files.add(f);
          if (files.size >= 60) break;
        }
      } catch {
        // One unreachable commit is not a failed re-ground — the ship merged
        // to main and the rest of the shas still name real files. Only an
        // EMPTY result is treated as "we learned nothing".
      }
      if (files.size >= 60) break;
    }
    return files.size ? [...files] : null;
  };
  const regroundAttempts = new Map(); // intentId -> gh-failure count

  async function drainWiki() {
    if (wikiBusy || wikiQueue.length === 0) return;
    /**
     * NOT WHILE THE BOX IS UNDER PRESSURE. A sweep is a CLI reading a whole
     * repository, which is the heaviest turn the daemon runs and the one
     * nobody is waiting on — so it is the first thing to yield.
     *
     * The queue is left INTACT: nothing is claimed, nothing is consumed, and
     * the reconcile loop calls this again on its next poll. The one thing that
     * must not happen is setting `wikiBusy` and returning, which would strand
     * the drain until a restart.
     */
    const hold = admit('churn');
    if (hold) {
      // Said at most every five minutes: this runs on every poll, and a queued
      // sweep can sit through a long stretch of pressure — a line every twenty
      // seconds would be the console restating one unchanged fact all evening.
      if (Date.now() - wikiHoldSaidAt > 5 * 60_000) {
        wikiHoldSaidAt = Date.now();
        note(`${c.cyan('wiki')} ${c.dim(`— holding off: ${hold.reason}`)}`);
      }
      return;
    }
    wikiHoldSaidAt = 0;
    wikiBusy = true;
    // Held for the WHOLE drain: this loop resets the worktree between tasks, and
    // a consult reading it mid-reset sees files vanish under it.
    return withWikiLock(async () => {
    try {
      while (wikiQueue.length) {
        const task = wikiQueue.shift();
        // The vault is plain files — the turn needs no MCP server and no
        // cartographer token; the daemon itself syncs afterwards on the fleet
        // credential.
        // Guard the mkdir: this runs OUTSIDE the per-task try below, so an
        // ENOSPC/EACCES here (disk full is an anticipated prod condition —
        // worktrees + vault history grow) would escape drainWiki as an unhandled
        // rejection and take down the whole daemon mid-work. Skip this sweep on
        // failure instead.
        let vaultDir;
        try {
          vaultDir = vaultDirFor();
          ensureVault(vaultDir);
        } catch (e) {
          warn(`wiki sweep skipped — vault dir unavailable: ${e?.message || e}`);
          continue;
        }
        // Live progress for this turn: a rolling FEED of everything Claude does
        // (thinking, narration, reads, node writes), the file count, and the
        // phase — streamed to the app (throttled; each frame carries the whole
        // recent tail so a dropped POST loses nothing). elapsedSec is the
        // daemon's own clock.
        const mode = task.type === 'sweep' ? 'sweep' : 'reground';
        const startedAt = Date.now();
        let filesRead = 0;
        let phase = 'reading';
        // Distinct vault pages this turn has written. Counted HERE, from the
        // stream, because it is the only place that knows mid-turn: the daemon
        // syncs the vault to the server once, AFTER the turn returns, so a
        // server-side count of "rows touched since the turn began" is zero for
        // the entire writing phase — which is exactly how long the bar needs it.
        // A Set, not a counter: pages get written once and then edited, and
        // three tool calls on one page are one page.
        const pagesSeen = new Set();
        const feed = [];
        const frame = (extra) => ({
          mode,
          phase,
          activity: feed[feed.length - 1] ?? '',
          recent: feed.slice(-24),
          filesRead,
          pagesWritten: pagesSeen.size,
          elapsedSec: Math.round((Date.now() - startedAt) / 1000),
          ...extra,
        });
        const onActivity = (a) => {
          if (a.kind === 'read') filesRead++;
          if (a.kind === 'write') {
            phase = 'writing';
            pagesSeen.add(a.path || a.label);
          }
          // Collapse runs of bare "thinking…" so the feed doesn't fill with it.
          // Keyed on the SHARED constant (runtimeEvents.mjs), not on the literal: the
          // labels being compared here are the ones claudeStream.mjs now builds from
          // that constant, so a reworded marker would leave this comparison
          // matching nothing and the 48-slot feed filling with the repeat — the
          // exact noise this line exists to stop, and silent, because a collapse
          // that stops collapsing fails no test.
          if (!(a.label === THINK_MARKER && feed[feed.length - 1] === THINK_MARKER)) {
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
        /**
         * Did THIS sweep finish? Read by the `finally` below, which owns the
         * retry decision for every way out of this block.
         *
         * It used to be decided inline on the one branch where the turn
         * returned without its sentinel — so the two OTHER ways a sweep fails,
         * `pickRuntimeFor` finding no CLI and the catch around the whole turn,
         * left the request pinned and never retried at all. Those are the
         * failures most worth retrying: a missing runtime is fixed by
         * installing one, and a thrown turn is exactly the transient case.
         */
        let sweepCompleted = false;
        /**
         * WHAT THIS TASK'S TURN SPENT, AS THE CLI COUNTED IT (2026-09-28),
         * tagged with the CLI. It rides the DONE frame only — the one frame a
         * task sends exactly once, which is what lets the server charge it
         * without a claim of its own; the throttled mid-turn frames stay a
         * readout. Null (and absent from the frame) when no CLI ran.
         */
        let usage = null;
        const onUsage = (rt) => (u) => {
          usage = addUsage(usage, { ...u, runtime: rt });
        };
        try {
          // Immediate frame so the cover shows the daemon feed right away (the
          // "reading your code" phase), not a static message, while Claude warms up.
          feed.push('starting…');
          await postWikiProgress(frame(), true);
          heartbeat = setInterval(() => void postWikiProgress(frame(), true), 5000);
          if (!existsSync(wikiWt)) {
            try {
              git(['worktree', 'add', '--detach', wikiWt, getBaseRef()], repoRoot);
            } catch {
              git(['worktree', 'prune'], repoRoot);
              git(['worktree', 'add', '--detach', wikiWt, getBaseRef()], repoRoot);
            }
          }
          resetWorktree(wikiWt, getBaseRef());
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
          // The cartographer needs to read the repo and write ONLY the vault —
          // a narrower promise than "build", so it is its own profile.
          const wikiRt = pickRuntimeFor('wiki');
          if (!wikiRt) {
            warn('wiki generation skipped — no installed CLI can run a vault-scoped turn');
            return;
          }
          const wikiLabel = RUNTIMES[wikiRt].label;
          if (task.type === 'sweep') {
            sweepAttempts++;
            note(`${c.cyan('wiki')} ${c.dim(`— regenerating: your ${wikiLabel} is reading the repo…`)}`);
            const out = await runTurn({
              prompt: WIKI_KICKOFF(sha, vaultDir),
              resume: false,
              system: SYSTEM_WIKI(vaultDir),
              cwd: wikiWt,
              profile: 'wiki',
              vaultDir,
              runtime: wikiRt,
              label: c.cyan('[wiki]'),
              streamJson: true,
              onActivity,
              onUsage: onUsage(wikiRt),
              // FREE SKILLS, off a turn that was running anyway. This stream is
              // already parsed and its init event already carries the CLI's own
              // resolved skill set — the same fact a tab turn teaches — so the
              // only thing missing was the handler. The wiki turn runs in a
              // detached worktree of THIS repo, so its `.claude/skills` and the
              // machine's personal ones resolve identically to a tab's.
              onInit: (i) => {
                recordSkills(i.skills);
                recordMcpServers(i.mcpServers);
              },
              onSpawn: (ch) => {
                wikiChild = ch;
              },
            });
            const complete = sawSentinel(out, 'WIKI_DONE');
            if (complete) {
              sweepCompleted = true;
              ok(`${c.cyan('wiki')} ${c.dim('— vault regenerated from your code.')}`);
            } else {
              warn('wiki sweep ended without WIKI_DONE — partial pages synced');
            }
            await runSync(complete);
          } else {
            const files = changedFilesForShas(task.shas);
            if (files === null) {
              // gh failed (network/auth) — retry via the durable job a couple
              // of times before consuming it, so a transient outage doesn't
              // silently drop the re-ground.
              const n = (regroundAttempts.get(task.intentId) ?? 0) + 1;
              regroundAttempts.set(task.intentId, n);
              if (n < 3) {
                warn(`wiki re-ground for "${task.title}": no changed files resolved — will retry (${n}/3)`);
                groundedIntents.delete(task.intentId); // let the roster re-offer it
                continue;
              }
              warn(`wiki re-ground for "${task.title}": could not resolve changed files ${n} times — giving up (heals on the next full sweep)`);
            } else if (files.length === 0) {
              note(`${c.cyan('wiki')} ${c.dim(`— "${task.title}": no changed files to re-ground`)}`);
            } else {
              note(`${c.cyan('wiki')} ${c.dim(`— re-grounding after "${task.title}"…`)}`);
              const out = await runTurn({
                prompt: REGROUND_KICKOFF({
                  sha,
                  title: task.title,
                  files,
                  vaultDir,
                  predictedPages: task.dirtiesPages ?? [],
                }),
                resume: false,
                system: SYSTEM_REGROUND(vaultDir),
                cwd: wikiWt,
                profile: 'wiki',
                vaultDir,
                runtime: wikiRt,
                label: c.cyan('[wiki]'),
                streamJson: true,
                onActivity,
                onUsage: onUsage(wikiRt),
                // Same free harvest as the sweep above.
                onInit: (i) => {
                  recordSkills(i.skills);
                  recordMcpServers(i.mcpServers);
                },
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
            await postToFleet(REGROUND_DONE_URL, { taskId: task.intentId });
            // The dedup was DAEMON-LIFETIME, which wedged a reopened card: its
            // second ship writes a fresh durable job, this Set still holds the
            // taskId, enqueueReground refuses it on every poll forever, and
            // the never-consumed job churns the wiki-writer lease until a
            // restart. The job is consumed now, so the guard has done its work;
            // a FUTURE ship of the same card is new work, not a duplicate.
            groundedIntents.delete(task.intentId);
          }
        } catch (e) {
          warn(`wiki ${task.type} failed: ${e.message}`);
        } finally {
          wikiChild = null;
          if (heartbeat) clearInterval(heartbeat);
          /**
           * THE RETRY DECISION, IN ONE PLACE, FOR EVERY WAY OUT OF THIS BLOCK.
           *
           * Deciding it inline on the no-sentinel branch covered one of the
           * three ways a sweep fails and silently declined the other two. Here
           * it covers the thrown turn and the no-runtime return as well, which
           * are the two most worth retrying.
           *
           * A successful sweep resets the budget. A failed one with budget left
           * clears `lastSweepAt` so the roster's next offer of the SAME request
           * is accepted — partial pages are synced without pruning either way,
           * so a retry resumes rather than starting over. A failed one with the
           * budget spent tells the SERVER, because the counter is process-local
           * and the request it bounds is durable for 24 hours.
           */
          if (task.type === 'sweep') {
            if (sweepCompleted) {
              sweepAttempts = 0;
            } else if (sweepAttempts < MAX_SWEEP_ATTEMPTS) {
              lastSweepAt = null;
              warn(`wiki sweep failed — retrying (${sweepAttempts}/${MAX_SWEEP_ATTEMPTS})`);
            } else {
              warn(
                `wiki sweep failed ${sweepAttempts} times — giving up on this request; press Regenerate to try again.`
              );
              await postWikiAbandoned();
            }
          }
          // Terminal frame so the app cover clears promptly (don't wait for the
          // freshness window to lapse). force-sent past the throttle.
          await postWikiProgress(frame({ done: true, ...(usage ? { usage } : {}) }), true);
          // Safety net: the wiki turn is read-only on the repo by CONTRACT, but
          // permission enforcement is a curated tool list, not a path jail —
          // discard anything a confused turn wrote to the worktree so it can
          // never leak into a later turn or a push.
          try {
            resetWorktree(wikiWt, getBaseRef());
          } catch {
            /* best-effort */
          }
        }
      }
    } finally {
      wikiBusy = false;
    }
    });
  }

  /** The roster's wiki work, taken each poll. */
  const onRoster = (roster) => {
    // Living-wiki work (runs under its own minted wiki token — no agent
    // needed). enqueueSweep queues a Regenerate; regroundJobs re-offers merged
    // deliveries whose re-ground never ran (e.g. we restarted between merge and
    // turn) until we report reground-done; the bare drain flushes anything
    // whose earlier mint failed.
    enqueueSweep(roster.codeMapJob);
    for (const j of roster.regroundJobs ?? []) {
      const rid = j && (j.taskId ?? j.intentId); // new name first, old as fallback
      if (!j || typeof rid !== 'string') continue; // a null element would throw + wedge the loop
      enqueueReground(rid, j.prUrl, j.title, j.dirtiesPages, j.shas);
    }
    void drainWiki();
  };

  return {
    onRoster,
    enqueueSweep,
    enqueueReground,
    drainWiki,
    /** The vault is keyed by the project the roster names (see `vaultDirFor`). */
    setProjectId: (id) => {
      wikiProjectId = id;
    },
    /** Whether this lane is working — one of `machineBusy`'s answers. */
    busy: () => wikiBusy,
    /**
     * The cartographer's share of the machine's live CLI count — what
     * fleet.mjs hands the work manager as `extraLiveTurns`.
     *
     * `wikiBusy` COUNTS, not just the live child, and that is the wiki lane's
     * version of the reservation `admission.mjs` describes: the drain sets the
     * flag the moment it is admitted and the CLI does not exist until several
     * awaits later, so counting the child alone left a hole exactly wide enough
     * for the other lanes to spend the slot this one had already taken. The
     * drain runs at most one CLI at a time, so the flag and the child are the
     * same one turn and this can never double-count.
     */
    liveTurns: () => (wikiBusy || wikiChild ? 1 : 0),
    /** Teardown: a mid-sweep cartographer dies with the daemon. */
    kill: () => {
      wikiChild?.kill('SIGKILL');
    },
  };
}
