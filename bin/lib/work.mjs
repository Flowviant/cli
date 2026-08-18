/**
 * Work sessions — the Workbench tabs, daemon side.
 *
 * A tab is a held Claude session with BUILD permissions in a PERSISTENT
 * worktree on its own `session/<id>` branch. Nothing here is detached and
 * nothing is ever reset — uncommitted state between turns IS the session, and
 * blowing it away would be closing the human's editor mid-thought. (Plan
 * worktrees are the deliberate opposite: reset at base every turn.)
 *
 * Everything the loop guarantees lives here: per-session turn/ship chains,
 * per-session work credentials, the settle-every-turn contract, the ship
 * executor, and worktree retirement. Split out of fleet.mjs mechanically —
 * the daemon's reconcile loop constructs one manager per run and feeds it
 * roster jobs; the only state it borrows from the loop is read through the
 * two getters (the MCP URL and the lease TTL can change with any poll).
 */

import { existsSync, rmSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { FLEET_URL, FLEET_TOKEN, USER_AGENT, REFRESH_BEFORE_SECONDS } from './config.mjs';
import { git, baseBranchName, isSafePathSegment } from './git.mjs';
import { c, note, ok, warn } from './ui.mjs';
import { mcpFor, runTurn } from './claude.mjs';
import { SYSTEM_WORK, WORK_TURN_KICKOFF } from './prompts.mjs';
import { materializeInto, scrub as envScrub } from './env.mjs';
import { detectRuntimes, pickRuntimeFor, RUNTIMES } from './runtimes.mjs';

export function createWorkManager({ repoRoot, baseDir, baseRef, getMcpUrl, getLeaseTtl }) {
  const WORK_TOKEN_URL = FLEET_URL.replace(/\/agents\/?$/, '/work-token');
  const WORK_DONE_URL = FLEET_URL.replace(/\/agents\/?$/, '/work-turn-done');
  const SHIP_DONE_URL = FLEET_URL.replace(/\/agents\/?$/, '/ship-done');
  const workAnswering = new Set(); // turn ids currently queued/running here
  const workAttempts = new Map(); // turn id -> completed runTurn attempts
  const MAX_WORK_TRIES = 3;
  const shipping = new Set(); // sessionIds with a ship queued/running here
  /**
   * Per-SESSION serialization, parallel ACROSS sessions: turns within one tab
   * must land in order (they share a directory and a context), but two tabs
   * are two terminals — the human opened both on purpose. Ship jobs ride the
   * SAME chain, never a separate one: a ship must not run git in a worktree
   * while that session's turn has a live CLI in it.
   */
  const workChains = new Map(); // sessionId -> settled-safe tail promise
  const chainFor = (sessionId, fn) => {
    const prev = workChains.get(sessionId) ?? Promise.resolve();
    // `.then(fn, fn)`, like withWikiLock: one rejected link must never wedge
    // every later turn of the tab.
    const run = prev.then(fn, fn);
    const stored = run.then(
      () => {},
      () => {}
    );
    workChains.set(sessionId, stored);
    // Release the entry when the chain drains, so the map cannot grow for the
    // process lifetime and `workChains.has()` means "busy right now".
    stored.then(() => {
      if (workChains.get(sessionId) === stored) workChains.delete(sessionId);
    });
    return run;
  };

  /**
   * EVERY turn settles — the work loop's prime contract. A pending turn nobody
   * answers holds one of the tab's slots until the server expires it (24h);
   * silence is the worst outcome. So a report that cannot be DELIVERED right
   * now is queued in memory and retried at the top of every poll, and a turn
   * whose finished answer sits in that queue is never re-run — a session turn
   * has side effects (edits, commits, cards), and a dropped 200 must not apply
   * them twice.
   */
  const pendingWorkReports = new Map(); // turnId -> work-turn-done body
  const pendingShipReports = new Map(); // sessionId -> ship-done body
  /** POST a settle body. 'ok' | 'terminal' (the server will never accept this
   *  body — 403 not this fleet's session, 404 unknown turn, 409 ship already
   *  settled — so retrying is spam, not delivery) | 'retry'. */
  const postSettle = async (url, body, terminalStatuses) => {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${FLEET_TOKEN}`,
          'User-Agent': USER_AGENT,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(30_000),
        body: JSON.stringify(body),
      });
      if (res.ok) return 'ok';
      if (terminalStatuses.includes(res.status)) return 'terminal';
      return 'retry';
    } catch {
      return 'retry';
    }
  };
  const settleWorkTurn = async (turnId, payload) => {
    const body = { turnId, ...payload };
    const r = await postSettle(WORK_DONE_URL, body, [403, 404]);
    if (r === 'retry') pendingWorkReports.set(turnId, body);
    else {
      pendingWorkReports.delete(turnId);
      workAttempts.delete(turnId);
    }
    return r;
  };
  const settleShip = async (sessionId, payload) => {
    const body = { sessionId, ...payload };
    const r = await postSettle(SHIP_DONE_URL, body, [403, 409]);
    if (r === 'retry') pendingShipReports.set(sessionId, body);
    else pendingShipReports.delete(sessionId);
    return r;
  };
  let flushingReports = false;
  const flushWorkReports = async () => {
    if (flushingReports) return;
    if (pendingWorkReports.size === 0 && pendingShipReports.size === 0) return;
    flushingReports = true;
    try {
      for (const [id, body] of [...pendingWorkReports]) {
        const r = await postSettle(WORK_DONE_URL, body, [403, 404]);
        if (r !== 'retry') {
          pendingWorkReports.delete(id);
          workAttempts.delete(id);
        }
      }
      for (const [id, body] of [...pendingShipReports]) {
        const r = await postSettle(SHIP_DONE_URL, body, [403, 409]);
        if (r !== 'retry') pendingShipReports.delete(id);
      }
    } finally {
      flushingReports = false;
    }
  };

  /**
   * The work credential, ONE PER SESSION. The server binds each minted token
   * to the sessionId in the mint body and the MCP layer refuses it for any
   * other session, so a process-wide token would fail every tab but the one
   * that minted it. Cached per session, re-minted near expiry (the endpoint
   * rotates on every mint; per-session chaining means no turn is in flight
   * for the session when its next turn mints). 404 means the server no longer
   * holds that session for this fleet — a fact for the turn to settle with,
   * not a retry.
   */
  const workTokens = new Map(); // sessionId -> { token, mintedAt }
  const mintWorkToken = async (sessionId, force = false) => {
    const cached = workTokens.get(sessionId);
    const freshEnoughS = getLeaseTtl() - REFRESH_BEFORE_SECONDS;
    if (cached && !force && (Date.now() - cached.mintedAt) / 1000 < freshEnoughS)
      return { token: cached.token };
    try {
      const res = await fetch(WORK_TOKEN_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${FLEET_TOKEN}`,
          'User-Agent': USER_AGENT,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(30_000),
        body: JSON.stringify({ sessionId }),
      });
      if (res.status === 404) return { gone: true };
      if (!res.ok) return null;
      const token = (await res.json().catch(() => null))?.data?.token ?? null;
      if (!token) return null;
      workTokens.set(sessionId, { token, mintedAt: Date.now() });
      return { token };
    } catch {
      return null;
    }
  };

  /**
   * This tab's worktree — its held context, expressed as a place, ON A BRANCH.
   *
   * Fresh: branch `session/<id>` off the current base. Existing: touched not at
   * all — no fetch-reset-clean like a plan directory, because the dirty state
   * is the point. If the directory was retired but the branch survives, the
   * worktree re-attaches to the branch and the committed work is still there.
   */
  const sessionWtFor = (sessionId) => {
    if (!isSafePathSegment(sessionId)) return null;
    const wt = join(baseDir, 'sessions', sessionId);
    const fresh = !existsSync(wt);
    if (fresh) {
      const branch = `session/${sessionId}`;
      try {
        git(['worktree', 'add', '-b', branch, wt, baseRef], repoRoot);
      } catch {
        git(['worktree', 'prune'], repoRoot);
        try {
          // The branch may already exist (a retired directory's work) — attach.
          git(['worktree', 'add', wt, branch], repoRoot);
        } catch {
          try {
            git(['worktree', 'add', '-b', branch, wt, baseRef], repoRoot);
          } catch {
            return null;
          }
        }
      }
      // Synced env into the fresh worktree, exactly like a task checkout gets
      // (worktreeFor): a tab builds and runs dev servers here, and without the
      // bundle every session build was missing its .env while dispatched runs
      // got theirs. Only on creation — a live directory's env belongs to the
      // session, same as a resumed task tree. Ship's dirty-check is safe by
      // construction: materializeInto writes ONLY gitignored paths (it refuses
      // otherwise), and ignored files never appear in `git status --porcelain`.
      // Best-effort, like everywhere else — the session still builds; paths
      // that need secrets may 500.
      try {
        materializeInto(wt);
      } catch {
        /* best-effort */
      }
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
  const sessionMetaPath = (wt, name) => {
    try {
      return join(git(['rev-parse', '--absolute-git-dir'], wt), name);
    } catch {
      return null;
    }
  };

  /**
   * WHICH CLI drives this session — picked ONCE, on the first turn, and pinned
   * in the worktree's meta dir. The held context belongs to the CLI that made
   * it: `--continue` under a different binary is a different brain wearing the
   * session's half-finished state (the dispatch path pins heldRuntime for the
   * same reason). If the pinned CLI has left the machine, the turn settles
   * honestly instead of substituting. A retired-and-reattached directory has
   * no marker and no held context either, so re-picking there is correct.
   * Returns { id } | { id: null } (nothing installed) | { missing: label }.
   */
  const sessionRuntime = (wt) => {
    const marker = sessionMetaPath(wt, 'flowviant-runtime');
    let pinned = null;
    if (marker && existsSync(marker)) {
      try {
        pinned = readFileSync(marker, 'utf8').trim() || null;
      } catch {
        /* unreadable marker — re-pin below */
      }
    }
    if (pinned && RUNTIMES[pinned]) {
      const installed = detectRuntimes().find((r) => r.id === pinned)?.installed;
      return installed ? { id: pinned } : { missing: RUNTIMES[pinned].label || pinned };
    }
    const id = pickRuntimeFor('build');
    if (!id) return { id: null };
    if (marker) {
      try {
        writeFileSync(marker, id);
      } catch {
        /* best-effort — an unpinnable session just re-picks next turn */
      }
    }
    return { id };
  };

  /**
   * The spawn lock: the pid of the CLI currently live in this worktree. A
   * restarted daemon must not put a second Claude into a directory the orphan
   * of its previous life is still editing — two CLIs appending to one held
   * conversation is exactly the incoherence workChains prevents in-process,
   * and the lock extends that guarantee across a restart. A dead pid is a
   * stale lock (removed here); a live one means "come back next poll".
   */
  const turnLockedByLivePid = (lockPath) => {
    if (!lockPath || !existsSync(lockPath)) return false;
    let pid = 0;
    try {
      pid = Number(readFileSync(lockPath, 'utf8').trim());
    } catch {
      /* unreadable — treat as stale */
    }
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
        return true; // signal 0 delivered — the process is alive
      } catch (e) {
        if (e.code === 'EPERM') return true; // alive, just not ours to signal
      }
    }
    try {
      rmSync(lockPath, { force: true }); // dead holder — clear the stale lock
    } catch {
      /* best-effort */
    }
    return false;
  };

  /**
   * Live session-turn CLI children. The daemon's teardown SIGTERMs them: an
   * orphaned CLI keeps editing the session worktree and burning quota after
   * the daemon is gone. Each child's pid-lock is deliberately LEFT IN PLACE —
   * a CLI can trap SIGTERM to finish an in-flight request and outlive this
   * loop by seconds, and removing the lock in the same tick handed the
   * restarted daemon a green light to spawn a second CLI into the same held
   * context. turnLockedByLivePid already covers both outcomes: it waits while
   * the pid lives and clears the lock once it is dead.
   */
  const workChildren = new Map(); // child process -> lockPath | null
  const shutdownWork = () => {
    for (const [ch] of workChildren) {
      try {
        ch.kill('SIGTERM');
      } catch {
        /* best-effort */
      }
    }
    workChildren.clear();
  };

  /**
   * Retire the worktrees of sessions the server says are CLOSED.
   *
   * `activeWorkSessions` on the roster is the list of this fleet's LIVE
   * sessions; a directory whose id is absent belongs to a tab its owner
   * closed, and the directory — never the branch: committed work survives on
   * `session/<id>`, and ship re-attaches to it — is returned to disk. NEVER
   * by count: the old cap-12 retirement destroyed live sessions on shared
   * machines. When the roster omits the field entirely (older server),
   * absence of signal is not a close — retire nothing.
   */
  const retireWorkSessions = (activeIds) => {
    if (!Array.isArray(activeIds)) return;
    const dir = join(baseDir, 'sessions');
    if (!existsSync(dir)) return;
    let ids;
    try {
      ids = readdirSync(dir);
    } catch {
      return;
    }
    const live = new Set(activeIds);
    let removed = 0;
    for (const id of ids) {
      if (live.has(id)) continue;
      if (workChains.has(id) || shipping.has(id)) continue; // still draining here
      const wt = join(dir, id);
      try {
        // Uncommitted work is the human's — a resource sweep does not outrank
        // it, closed tab or not. (The non-force remove would refuse anyway;
        // the explicit check keeps the intent legible.)
        if (git(['status', '--porcelain'], wt) !== '') continue;
        git(['worktree', 'remove', wt], repoRoot); // non-force; the branch survives
        workTokens.delete(id);
        removed++;
      } catch {
        /* not cleanly removable — leave it */
      }
    }
    if (removed) {
      try {
        git(['worktree', 'prune'], repoRoot);
      } catch {
        /* best effort */
      }
    }
  };

  const processWorkTurns = (jobs) => {
    for (const job of jobs ?? []) {
      if (!job || typeof job.id !== 'string' || !job.body || !job.sessionId) continue;
      if (workAnswering.has(job.id)) continue;
      // The turn already RAN and its answer sits in the delivery queue — never
      // run it again while the report is merely undelivered.
      if (pendingWorkReports.has(job.id)) continue;
      workAnswering.add(job.id);
      chainFor(job.sessionId, async () => {
        try {
          const tries = workAttempts.get(job.id) ?? 0;
          if (tries >= MAX_WORK_TRIES) {
            // Out of local tries: SETTLE, don't skip — a silently skipped turn
            // strands the tab for the server's whole 24h expiry window.
            await settleWorkTurn(job.id, {
              ok: false,
              answer: `the turn failed ${tries} times on this machine — check the daemon log, then send the message again`,
            });
            return;
          }
          note(
            `${c.cyan('tab')} ${c.dim(`— ${job.askedByName || 'the owner'} in "${job.sessionName || 'a session'}"`)}`
          );
          const dir = sessionWtFor(job.sessionId);
          if (!dir) {
            await settleWorkTurn(job.id, {
              ok: false,
              answer:
                'the session worktree could not be opened on the machine — check the daemon log',
            });
            return;
          }
          // A live CLI is ALREADY in this worktree — this daemon's previous
          // life, most likely; the lock outlives a restart. Leave the job
          // pending and look again next poll; spawning a second CLI would put
          // two Claudes in one held context. Costs no attempt: nothing ran.
          const lockPath = sessionMetaPath(dir.wt, 'flowviant-turn.lock');
          if (turnLockedByLivePid(lockPath)) {
            warn(
              `a turn is already running in "${job.sessionName || job.sessionId}" — waiting for it to finish`
            );
            return;
          }
          const rt = sessionRuntime(dir.wt);
          if (rt.missing) {
            await settleWorkTurn(job.id, {
              ok: false,
              answer: `this session runs on ${rt.missing}, which is no longer installed on the machine — reinstall it, or open a new tab`,
            });
            return;
          }
          if (!rt.id) {
            await settleWorkTurn(job.id, {
              ok: false,
              answer:
                'No coding CLI is installed on the machine — install Claude Code (or another supported CLI), then send the message again',
            });
            return;
          }
          let mint = await mintWorkToken(job.sessionId);
          if (!mint) mint = await mintWorkToken(job.sessionId, true); // one transient blip ≠ a dead turn
          if (mint?.gone) {
            await settleWorkTurn(job.id, {
              ok: false,
              answer:
                'Flowviant no longer offers this session to this machine — the tab may have been closed or moved',
            });
            return;
          }
          if (!mint?.token) {
            await settleWorkTurn(job.id, {
              ok: false,
              answer:
                'the machine could not mint a session credential from Flowviant — check its connection, then send the message again',
            });
            return;
          }
          // Resume iff a conversation is known to live in THIS directory: the
          // server's sessionRef is only ever a path some turn actually SPOKE
          // from (see the settle below), and it must match the directory we
          // just opened. Anything else starts fresh IN the existing worktree —
          // never a reset; the dirty state is the session.
          const resume = !dir.fresh && Boolean(job.sessionRef) && job.sessionRef === dir.wt;
          const mcp = mcpFor(rt.id, mint.token, getMcpUrl());
          // Attempts count RUNS: the infra refusals above consumed nothing and
          // settled on their own terms.
          workAttempts.set(job.id, tries + 1);
          let out;
          const spawned = []; // this turn's children, for the teardown registry
          try {
            const turnArgs = {
              prompt: WORK_TURN_KICKOFF({
                sessionId: job.sessionId,
                sessionName: job.sessionName,
                message: job.body,
                askedByName: job.askedByName,
              }),
              system: SYSTEM_WORK,
              cwd: dir.wt,
              mcpArgs: mcp.args,
              mcpEnv: mcp.env,
              runtime: rt.id,
              label: c.cyan('[tab]'),
              onSpawn: (ch) => {
                if (!ch) return;
                spawned.push(ch);
                workChildren.set(ch, lockPath ?? null);
                if (lockPath && ch.pid) {
                  try {
                    writeFileSync(lockPath, String(ch.pid));
                  } catch {
                    /* best-effort */
                  }
                }
              },
            };
            out = await runTurn({ ...turnArgs, resume });
            // A resume that produced NOTHING usually means the held
            // conversation is gone (a first turn that crashed before writing
            // state, a wiped CLI dir). Retry once fresh in the SAME worktree —
            // never reset — instead of bricking the tab forever.
            if (resume && !(out || '').trim()) out = await runTurn({ ...turnArgs, resume: false });
          } finally {
            for (const ch of spawned) workChildren.delete(ch);
            if (lockPath) {
              try {
                rmSync(lockPath, { force: true });
              } catch {
                /* best-effort */
              }
            }
            if (mcp.dir) rmSync(mcp.dir, { recursive: true, force: true });
          }
          const answer = (out || '').trim();
          // No output at all smells like a dead MCP credential (the lane
          // workers' no-sentinel case) — drop the cached token so the next
          // turn re-mints instead of failing the same way forever.
          if (!answer) workTokens.delete(job.sessionId);
          await settleWorkTurn(job.id, {
            ok: answer.length > 0,
            answer:
              answer.length > 0
                ? // Scrub: a reply can quote config or env-adjacent code.
                  envScrub(answer).slice(0, 16000)
                : 'the turn produced no output on the machine — its CLI may be signed out; try again',
            // Only a turn that actually SPOKE proves a conversation lives
            // here. Recording the path unconditionally is how a crashed first
            // turn used to brick resume for the session's whole life.
            ...(answer.length > 0 ? { sessionRef: dir.wt } : {}),
          });
          if (answer.length > 0) ok(`${c.cyan('tab')} ${c.dim('— replied in the session')}`);
          else warn('session turn produced no output — settled as failed');
        } catch (e) {
          await settleWorkTurn(job.id, {
            ok: false,
            // Scrub, like every string that leaves this machine: an exception
            // routinely quotes command output, and command output can quote a
            // synced secret.
            answer: envScrub(String(e?.message ?? 'the session turn failed')).slice(0, 2000),
          });
          warn(`session turn failed: ${e?.message ?? e}`);
        } finally {
          workAnswering.delete(job.id);
        }
      });
    }
  };

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
      // The SESSION's own chain, never a ship-wide one: a ship must not run
      // git in this worktree while a turn's CLI is live in it. `shipping`
      // (above) keeps overlapping polls from queueing the same job twice.
      chainFor(job.sessionId, async () => {
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
          const branch = `session/${job.sessionId}`;
          const wt = join(baseDir, 'sessions', job.sessionId);
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
            git(['fetch', 'origin', '--quiet'], repoRoot);
          } catch {
            /* offline fetch — merge against what we have */
          }
          const ancestorOfBase = (ref) => {
            try {
              git(['merge-base', '--is-ancestor', ref, baseRef], repoRoot);
              return true;
            } catch {
              return false;
            }
          };
          // The machine may have no git identity, and a merge COMMIT needs
          // one. Prefer the user's own config; fall back to the daemon's (the
          // same fallback checkpointWip uses) so a bare machine doesn't fail
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
          const mergeOutward = (tip, count) => {
            const tmp = join(baseDir, 'ship', job.sessionId);
            try {
              try {
                git(['worktree', 'remove', '--force', tmp], repoRoot);
              } catch {
                /* not there — fine */
              }
              git(['worktree', 'add', '--detach', tmp, baseRef], repoRoot);
              gitMerge(
                [
                  'merge',
                  '--no-ff',
                  tip,
                  '-m',
                  `ship(${job.sessionName || job.sessionId.slice(0, 8)}): ${count} commit${count === 1 ? '' : 's'}`,
                ],
                tmp
              );
              git(['push', 'origin', `HEAD:${baseBranchName(baseRef)}`], tmp);
            } finally {
              try {
                git(['worktree', 'remove', '--force', tmp], repoRoot);
                git(['worktree', 'prune'], repoRoot);
              } catch {
                /* best effort */
              }
            }
          };
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
              const m = git(['log', baseRef, '--merges', '--format=%H %P', '-n', '500'], repoRoot)
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
              note: `${baseBranchName(baseRef)} already contains this session's branch — nothing new to merge`,
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
            const commits = logCommits(`${baseRef}..${tip}`);
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
          const dir = sessionWtFor(job.sessionId);
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
          // What is checked out here must BE the session branch. Sessions may
          // create branches when asked — but then "ship" is ambiguous, and
          // folding+logging HEAD while merging the stale branch NAME once
          // shipped receipts for commits that never landed on main.
          let head = null;
          try {
            head = git(['symbolic-ref', '--short', 'HEAD'], dir.wt);
          } catch {
            /* detached */
          }
          if (head !== branch) {
            await done({
              ok: false,
              error: `the session is on ${head ? `branch '${head}'` : 'a detached HEAD'}, not its own '${branch}' — ask it to return to its session branch, then ship again`,
            });
            return;
          }
          // Fold main into the branch FIRST: conflicts land here, in the
          // session's own worktree, where the next turn can resolve them.
          try {
            gitMerge(['merge', '--no-edit', baseRef], dir.wt);
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
          const commits = logCommits(`${baseRef}..${tip}`);
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

  return { flushWorkReports, processWorkTurns, processShipJobs, retireWorkSessions, shutdownWork };
}
