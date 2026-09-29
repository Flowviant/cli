/**
 * THE DAEMON'S START, BEFORE THE FIRST POLL — the single-instance lock (and
 * its refusal in words), the per-repo worktree home with its disk line and its
 * fortnight reap, and the process signal handlers that run the teardown.
 *
 * Split out of fleet.mjs (SOLID audit 2026-09-26, F038). These run once per
 * process, in the order `runFleetDaemon` calls them, and change for local
 * reasons (how two daemons on one box are told apart, where worktrees live,
 * how long an idle one is kept) that are nothing to do with the roster loop.
 */

import { mkdirSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';
import { FLEET_TOKEN } from './config.mjs';
import { git } from './git.mjs';
import { info, note, warn, fail } from './ui.mjs';
import { acquireInstanceLock } from './instance.mjs';
import { emitMachineEvent } from './daemonLogging.mjs';

/** Takes the lock, or says why not and exits 1. Returns only on success. */
export function takeInstanceLockOrExit(repoRoot) {
  // ONE DAEMON PER CREDENTIAL. Before preflight, before the preview reap,
  // before anything with a side effect — a second daemon must not so much as
  // install a CLI or clear a registry on its way to being refused. Keyed on the
  // credential rather than the repo, because two checkouts on one credential is
  // the SAME project served twice, and the worst version of this: their session
  // worktrees are in different directories, so the per-turn lock cannot even see
  // across them. See instance.mjs for why that lock is not enough on its own.
  // Same repo -> this run replaces whatever was serving it. Different repo ->
  // refused, and nothing is signalled. See instance.mjs's header for the rule.
  //
  // `--takeover` ARBITRATES PROCESSES ON THIS BOX and nothing more — which
  // daemon serves this repo. It says nothing about which BOX serves the
  // project: that is holdership, the server decides it because only the server
  // can see both boxes, and a person moves it from the app.
  const instance = acquireInstanceLock(FLEET_TOKEN, repoRoot, {
    takeover:
      process.argv.includes('--takeover') || process.argv.includes('--takeover-downgrade'),
    noTakeover:
      process.argv.includes('--no-takeover') || process.env.FLOWVIANT_NO_TAKEOVER === '1',
    allowDowngrade: process.argv.includes('--takeover-downgrade'),
    log: (m) => info(m),
  });
  if (!instance.ok) {
    const h = instance.holder;
    console.log('');
    // Two different refusals, because they are two different mistakes and the
    // fix is not the same. Same CREDENTIAL: one project is being served twice.
    // Same REPO under another credential: two daemons in one working tree,
    // which the credential-keyed lock cannot see on its own.
    if (instance.takeoverFailed) {
      fail(`could not replace the running daemon: ${instance.takeoverFailed}`);
    } else if (instance.sameRepo) {
      fail('a flowviant daemon is already running in this repo.');
    } else {
      fail('a flowviant daemon is already running for this credential.');
    }
    if (h?.pid) info(`holder · pid ${h.pid}${h.repoRoot ? ` in ${h.repoRoot}` : ''}`);
    // The two-checkouts case is the one nobody spots on their own: both tabs
    // look healthy, and the damage is doubled cards and doubled edits in a repo
    // you are not looking at. Name the other repo when it is a different one.
    if (!instance.sameRepo && h?.repoRoot && h.repoRoot !== repoRoot) {
      warn('that is a DIFFERENT checkout — one credential serves one project, so both would answer the same tabs.');
      // Not offered lightly: that daemon is serving other work, and this
      // command was run somewhere else. Replacing it is a decision, not a
      // restart, so it takes a word.
      note('run with --takeover to stop it and serve this repo instead.');
    }
    // WITHHELD when we could not identify the holder. ALLOW_MULTI runs this
    // daemon unguarded beside one we just admitted we cannot see, and in the
    // same repo that is two `git fetch`, two worktree sweeps, and one
    // `retireWorkSessions` deleting directories the other is serving. Offering
    // it as the way out of "I don't know what that process is" would be handing
    // someone the worst option at the moment they have the least information.
    if (!instance.unidentified) {
      note('or run this one with FLOWVIANT_ALLOW_MULTI=1 if you know what you are doing.');
    }
    console.log('');
    process.exit(1);
  }
  if (instance.unguarded)
    warn('could not take the single-instance lock (unwritable ~/.flowviant) — running unguarded');
}

/**
 * The persistent worktree home for this checkout, created if missing.
 */
export function worktreeHome(repoRoot) {
  // Persistent worktree home (0.9.0) — survives daemon restarts AND reboots,
  // so Ctrl+C mid-task never loses local work. Keyed per repo path.
  const repoKey = `${basename(repoRoot)}-${createHash('sha256').update(repoRoot).digest('hex').slice(0, 8)}`;
  const baseDir = join(homedir(), '.flowviant', 'worktrees', repoKey);
  mkdirSync(baseDir, { recursive: true });
  return { repoKey, baseDir };
}

/** The disk line and the startup reap of long-idle task checkouts. */
export function tidyWorktreeHome(baseDir, repoRoot) {
  // ONE CHECKOUT PER TASK, named after the task. Worktrees used to be
  // `agent-<agentId>` — a long-lived tree per lane, reset to base between
  // tasks — and that was the last thing a lane owned. Now a lane is a
  // credential and nothing more, which is what makes it disposable: the server
  // can hand any lane any task, and two tasks can never be in each other's
  // files even when one is mid-edit.
  try {
    const kb = Number(execFileSync('du', ['-sk', baseDir], { encoding: 'utf8' }).split('\t')[0]);
    if (kb > 1024)
      info(
        `disk   · worktrees ${(kb / 1024 / 1024).toFixed(1)} GB at ~/.flowviant/worktrees — \`flowviant clean\` reclaims`
      );
  } catch {
    /* du unavailable (Windows) — skip the disk line */
  }

  // Reap long-dead task checkouts. Per-lane trees were self-limiting — N lanes,
  // N directories, reused forever. Per-task trees are not: every task ever
  // built leaves one behind, so without this the disk grows without bound and
  // `flowviant clean` becomes a chore rather than a convenience.
  //
  // Age, not state, is the test. The daemon has no list of which intents are
  // still open, and asking the server for one would put a delete behind a
  // network call that can fail — so anything untouched for a fortnight goes,
  // which is far beyond how long a task stays reviewable and far beyond any
  // pause a human takes mid-build. Runs at startup only: mid-run this would
  // race a worker that is quietly parked on a blocker.
  try {
    const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
    let reaped = 0;
    for (const name of readdirSync(baseDir)) {
      if (!name.startsWith('task-')) continue;
      const p = join(baseDir, name);
      try {
        if (statSync(p).mtimeMs > cutoff) continue;
        // Through git, so the worktree REGISTRATION goes too — an rm -rf leaves
        // a stale entry that blocks re-adding the same path later.
        git(['worktree', 'remove', '--force', p], repoRoot);
        reaped++;
      } catch {
        /* held, gone, or not ours — leave it for `flowviant clean` */
      }
    }
    if (reaped) info(`disk   · reclaimed ${reaped} task worktree${reaped === 1 ? '' : 's'} idle > 14d`);
  } catch {
    /* the worktree home may not exist yet on a first run */
  }
}

/**
 * Ctrl+C, a service manager's SIGTERM, and a stray rejection.
 *
 * `leave` is standDownExit.mjs's: it exits at once when no deploy is in
 * flight, and otherwise waits for the deploys to finish and report (ruling
 * 2026-09-26). The teardown runs once. A signal arriving while it waits goes
 * to `leave` with its NAME, because only a person at the terminal can insist:
 * a second Ctrl+C leaves now, a SIGTERM asking again changes nothing.
 */
export function installSignalHandlers(teardown, leave) {
  // REQUIRED, with no `process.exit` fallback: a caller that forgot it would
  // get the exit that skips the drain, and nothing would say so.
  if (typeof leave !== 'function') throw new TypeError('installSignalHandlers needs standDownExit.mjs\'s `leave`');
  const onSignal = (code, words, signal) => {
    if (leave.leaving?.()) {
      void leave(code, { signal });
      return;
    }
    emitMachineEvent({ event: 'stopped', reason: 'signal' });
    console.log('');
    note(words);
    teardown();
    void leave(code, { signal });
  };
  process.on('SIGINT', () =>
    onSignal(130, 'shutting down — stopping workers. Worktrees are kept: in-flight work resumes next run.', 'SIGINT')
  );
  // A service manager stops the daemon with SIGTERM, not Ctrl+C. Without this
  // handler every child survived a `systemctl stop` — the exact orphaning the
  // teardown exists to prevent.
  process.on('SIGTERM', () =>
    onSignal(
      143,
      'shutting down (SIGTERM) — stopping workers. Worktrees are kept: in-flight work resumes next run.',
      'SIGTERM'
    )
  );
  // Keep the daemon alive on a stray rejection. Many loops here are fire-and-
  // forget (`void drainWiki()`, dispatch, sync) and rely on their callees never
  // rejecting; Node ≥15 terminates the process on an unhandled rejection, which
  // would kill every in-flight agent worker over one transient error. Log and
  // survive instead — a wedged sub-task self-heals on the next poll.
  process.on('unhandledRejection', (reason) => {
    warn(`unhandled rejection (daemon kept alive): ${reason?.stack || reason}`);
  });
}
