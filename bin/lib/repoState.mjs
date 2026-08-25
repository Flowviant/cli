/**
 * EVERY WORKTREE AND EVERY BRANCH ON THIS MACHINE — including the ones
 * Flowviant did not make.
 *
 * WHY THIS EXISTS, in the user's words: "can we show all branches or worktrees
 * so we know if claude is polluting the branches or worktrees or not". The
 * Workbench already reports the branch a TAB is standing on, but only for
 * sessions the server knows about — so a branch your Claude cut mid-turn, a
 * worktree left behind by a crash, or anything you made yourself at the
 * keyboard was invisible from the browser. That is the same gap the Changes
 * block was built to close, one level up: a browser has no `git branch` to run,
 * so the machine runs it.
 *
 * IT IS A RELAY, NOT A JUDGEMENT. Nothing here decides what "pollution" is —
 * it reports what git says and marks which refs Flowviant itself created
 * (`session/<id>`), because that is a FACT about who made them and it is the
 * distinction the question is actually asking about. No cleanup, no warnings,
 * no "you have too many branches": the surface counts what is there, and a
 * person decides.
 *
 * BOUNDED AT THE MACHINE, like every other report in this daemon. A repo with
 * eight hundred branches must not put eight hundred rows on the wire every
 * minute; the newest are kept, the rest are counted, and the caller says so
 * rather than letting a short list read as the whole repo.
 *
 * DETERMINISTIC ORDER, for the same reason `recordSkills` sorts: the report is
 * dedupe-compared against the last one that was accepted, and an unstable order
 * would post a "change" every single minute forever.
 *
 * NOTHING HERE THROWS. It runs inside the poll loop's best-effort tail, and a
 * repo mid-rebase or an unborn HEAD is a field to omit, not an error to raise.
 */

import { execFileSync } from 'node:child_process';
import { listenersIn, listenersSupported } from './listeners.mjs';

/** Same cap the session diffstat uses: enough to see the shape, small enough
 *  that one machine cannot flood a row. */
const MAX_BRANCHES = 60;
const MAX_WORKTREES = 40;

function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 10_000,
    maxBuffer: 8 * 1024 * 1024,
  }).trim();
}

/** A ref Flowviant itself cut for a tab. The ONLY thing that makes a branch
 *  "ours", and the distinction the whole report exists to draw. */
export function isSessionBranch(name) {
  return /^session\//.test(name);
}

/**
 * `git worktree list --porcelain` → rows. The porcelain form is parsed rather
 * than the human one because the human one aligns columns with spaces and a
 * path containing a space silently splits into the wrong fields.
 */
function readWorktrees(repoRoot) {
  let out;
  try {
    out = git(['worktree', 'list', '--porcelain'], repoRoot);
  } catch {
    return null; // not a git repo, or git is unhappy — say nothing
  }
  const rows = [];
  let cur = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (cur) rows.push(cur);
      cur = { path: line.slice(9), branch: null, detached: false, locked: false, prunable: false };
    } else if (!cur) {
      continue;
    } else if (line.startsWith('branch ')) {
      cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
    } else if (line === 'detached') {
      cur.detached = true;
    } else if (line.startsWith('locked')) {
      cur.locked = true;
    } else if (line.startsWith('prunable')) {
      // A directory git still lists but that is gone from disk — exactly the
      // "left behind" case somebody looking for mess wants to see.
      cur.prunable = true;
    }
  }
  if (cur) rows.push(cur);
  return rows;
}

/**
 * Local branches with their distance from base.
 *
 * `for-each-ref` does the whole thing in ONE process — a `rev-list` per branch
 * would be sixty spawns a minute on a busy repo. `%(ahead-behind:<ref>)` needs
 * git 2.41+; when it is missing the counts are simply absent and the surface
 * shows names without numbers, which is still the answer to "what is here".
 */
function readBranches(repoRoot, baseRef) {
  const fmt = '%(refname:short)%09%(committerdate:unix)%09%(ahead-behind:' + baseRef + ')';
  let out;
  try {
    out = git(['for-each-ref', '--sort=-committerdate', `--format=${fmt}`, 'refs/heads'], repoRoot);
  } catch {
    // No ahead-behind on this git. Names and dates still answer most of it.
    try {
      out = git(
        ['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)%09%(committerdate:unix)', 'refs/heads'],
        repoRoot
      );
    } catch {
      return null;
    }
  }
  const rows = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const [name, when, ab] = line.split('\t');
    if (!name) continue;
    const row = { name, at: Number(when) || 0, session: isSessionBranch(name) };
    // `ahead-behind` prints "N M" — ahead of base, behind base, in that order.
    if (ab) {
      const [a, b] = ab.trim().split(/\s+/).map((n) => parseInt(n, 10));
      if (Number.isFinite(a)) row.ahead = a;
      if (Number.isFinite(b)) row.behind = b;
    }
    rows.push(row);
  }
  return rows;
}

/**
 * The whole picture, or null if this is not a repo we can read.
 *
 * `truncated` is not decoration: a list silently cut at sixty reads as the
 * whole repo, and the one question this report exists to answer is "how much is
 * in here". Same rule the session diffstat's own `truncated` keeps.
 */
export function repoState(repoRoot, baseRef) {
  const worktrees = readWorktrees(repoRoot);
  const branches = readBranches(repoRoot, baseRef);
  if (!worktrees && !branches) return null;
  /**
   * WHAT IS LISTENING IN THE CHECKOUT ITSELF.
   *
   * `listenersIn` has always taken any directory, and had only ever been asked
   * about SESSION WORKTREES — so somebody running `npm run dev` in their normal
   * checkout, which is what "just testing or playing around in dev" actually
   * looks like, was invisible to every surface in the product. The measurement
   * was there; nobody was pointing it at the repo.
   *
   * THE ATTRIBUTION RULE IS UNCHANGED, and it is the reason this widens to the
   * repo root and no further: a port is attributed by the CWD OF THE PROCESS
   * HOLDING THE SOCKET, so this reports servers running inside THIS PROJECT'S
   * checkout and nothing else. Postgres on 5432 has its own cwd and does not
   * appear here — which is the whole point, and why "just show every port on
   * the box" is not what this does.
   *
   * Reported, not offered: this is a readout of what is up. Sharing one is a
   * separate act with its own gates (see previewJobs).
   */
  const listening = listenersIn(repoRoot);
  const wt = worktrees ?? [];
  const br = branches ?? [];
  return {
    base: baseRef,
    worktrees: wt.slice(0, MAX_WORKTREES),
    worktreesTotal: wt.length,
    // Newest first (for-each-ref already sorted), so a truncated list is the
    // part somebody is actually working in.
    branches: br.slice(0, MAX_BRANCHES),
    branchesTotal: br.length,
    sessionBranches: br.filter((b) => b.session).length,
    listening,
    // "Nothing is listening" and "this machine cannot look" (Windows, a failed
    // scan) are the same empty array without this — and the second must never
    // render as the first. Same field, same reason, as the session report.
    listeningSupported: listenersSupported(),
  };
}
