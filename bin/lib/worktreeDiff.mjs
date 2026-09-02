/**
 * What a session's worktree actually holds, measured — not guessed.
 *
 * A Workbench tab IS a directory on this machine, on its own `session/<id>`
 * branch, and the human driving it from a browser cannot run `git status` in
 * it. So the daemon runs it for them: the branch, how far ahead of base it is,
 * and the per-file diffstat — the same numbers `git diff --stat` prints in that
 * directory, relayed rather than interpreted.
 *
 * Measured against the MERGE-BASE with the project's base ref, and against the
 * WORKING TREE rather than HEAD, so one number answers the question a human
 * actually asks ("what has this session changed?") with committed and
 * uncommitted work in the same total. Untracked files count too: git calls them
 * nothing until they are added, and a human calls them new work.
 *
 * It also carries THIS BRANCH'S OWN COMMITS and the cards they name — see
 * `branchCommits` below. That rides here rather than on a route of its own
 * because this sweep is already standing in the right directory on the right
 * beat, and a second endpoint would be a second poll for a fact this one is
 * next to.
 *
 * Everything here is best-effort and read-only. A worktree mid-rebase, a
 * deleted directory, a file that vanished between listing and reading — each
 * degrades to a smaller answer, never to a thrown error. Nothing about a
 * readout is worth failing a turn over.
 */

import { existsSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { git } from './git.mjs';

/** Rows reported. The rail shows a handful; the totals below cover the rest. */
const MAX_FILES = 20;
/** Untracked paths we are willing to open. A stray build directory that isn't
 *  gitignored must not turn a 60-second sweep into a disk crawl. */
const MAX_UNTRACKED_SCAN = 200;
/** Past this we call a file binary rather than counting its lines. */
const MAX_COUNT_BYTES = 512 * 1024;
/** Commits reported per sweep. The server caps each CARD at 50; this is the
 *  branch-wide bound, and a session branch past it is carrying an afternoon
 *  nobody is going to read commit-by-commit. */
const MAX_COMMITS = 50;

/**
 * WHICH CARDS A COMMIT NAMES.
 *
 * The convention is a git TRAILER — `Flowviant-Task: <id>` on its own line at
 * the foot of the message, the same shape as `Co-authored-by:` and `Signed-off-
 * by:`. Chosen over another MCP call for three reasons: it costs no write
 * budget, it works on agy tabs which cannot mount MCP at all, and the commit IS
 * the evidence rather than an assertion about it.
 *
 * Case-insensitive on the key and tolerant of several ids on one line, because
 * a person or an agent writing this by hand will do both. Anything that is not
 * a plausible id is dropped here rather than shipped: the server drops unknown
 * ids too, but a readout should not spend a request on obvious noise.
 */
export function taskIdsFromMessage(body) {
  const ids = [];
  for (const line of String(body || '').split('\n')) {
    const m = line.match(/^\s*Flowviant-Task\s*:\s*(.+?)\s*$/i);
    if (!m) continue;
    for (const raw of m[1].split(/[\s,]+/)) {
      const id = raw.replace(/^[#<]+|[>,.]+$/g, '');
      if (id && id.length <= 64 && /^[A-Za-z0-9_-]+$/.test(id) && !ids.includes(id)) {
        ids.push(id);
      }
    }
  }
  return ids;
}

/**
 * The commits this branch has that base does not, with the cards they name.
 *
 * Only commits carrying a trailer are RETURNED: an untrailered commit belongs
 * to no card, and ship-time reconciliation already turns those into a bundle so
 * nothing shipped is invisible. Sending them anyway would be a payload the
 * server drops on every sweep.
 *
 * `--no-merges`, because a merge commit describes a range rather than doing
 * work, and its trailer (if it has one) would double-book the range's own
 * commits.
 */
function branchCommits(wt, base) {
  if (!base) return [];
  const out = [];
  try {
    // %x1e between records, %x1f between fields — a subject and a body can
    // contain anything a person can type, so the delimiters must be bytes they
    // cannot.
    const raw = git(
      [
        'log',
        '--no-merges',
        '-n',
        String(MAX_COMMITS),
        '--format=%H%x1f%s%x1f%an%x1f%aI%x1f%B%x1e',
        `${base}..HEAD`,
      ],
      wt
    );
    for (const rec of raw.split('\x1e')) {
      const line = rec.replace(/^\n+/, '');
      if (!line.trim()) continue;
      const [sha, subject, author, at, body] = line.split('\x1f');
      if (!sha) continue;
      const taskIds = taskIdsFromMessage(body);
      if (taskIds.length === 0) continue;
      let additions = 0;
      let deletions = 0;
      try {
        const stat = git(['show', '--numstat', '--format=', sha], wt);
        for (const l of stat.split('\n')) {
          if (!l.trim()) continue;
          const [a, d] = l.split('\t');
          if (a === '-' || d === '-') continue; // binary
          additions += Number(a) || 0;
          deletions += Number(d) || 0;
        }
      } catch {
        /* a commit we cannot stat still names its cards — send it anyway */
      }
      out.push({
        // Clamped to the server's zod caps, same rule as everything else in
        // this file: one over-cap string 400s the whole batch.
        sha: sha.slice(0, 64),
        subject: (subject ?? '').slice(0, 200),
        author: (author ?? '').slice(0, 80),
        at: (at ?? '').slice(0, 40),
        additions,
        deletions,
        taskIds: taskIds.slice(0, 8),
      });
    }
  } catch {
    /* no base, unborn branch, or a repo mid-rebase — report no commits */
  }
  // Oldest first, so a card's list reads in the order the work happened.
  return out.reverse();
}

/** Lines in a buffer, the way a diff counts them: a trailing newline does not
 *  add a line, and a NUL byte anywhere means we are not looking at text. */
function countLines(buf) {
  if (buf.includes(0)) return null; // binary — git's own heuristic
  const s = buf.toString('utf8');
  if (s === '') return 0;
  const n = s.split('\n').length;
  return s.endsWith('\n') ? n - 1 : n;
}

/**
 * @param {string} wt   the worktree directory
 * @param {string} baseRef  the project's base ref (e.g. `origin/main`)
 * @returns {null | {branch:string, path:string, ahead:number, behind:number,
 *   baseLabel:string, baseCommits:{sha:string, subject:string, author:string}[],
 *   dirty:boolean, additions:number, deletions:number, fileCount:number,
 *   truncated:number,
 *   files:{path:string, added:number, deleted:number, binary?:boolean}[],
 *   commits:{sha:string, subject:string, author:string, at:string,
 *     additions:number, deletions:number, taskIds:string[]}[]}}
 */
export function worktreeDiff(wt, baseRef) {
  if (!wt || !existsSync(wt)) return null;
  let branch = '';
  try {
    branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], wt);
  } catch {
    return null; // not a worktree (or not readable) — report nothing, not zeros
  }
  // The commit HEAD names, for the strip's branch chip. Best-effort: an
  // unborn branch (fresh repo, no commit yet) has a name and no sha, and the
  // report simply omits the key — absent must never become an empty string,
  // which would render as a blank chip.
  let headSha = '';
  try {
    headSha = git(['rev-parse', 'HEAD'], wt);
  } catch {
    /* unborn HEAD — no sha to report */
  }
  let base = '';
  try {
    base = git(['merge-base', 'HEAD', baseRef], wt);
  } catch {
    /* a branch with no common ancestor (or an unfetched base) — fall back to
       HEAD below, which still reports the uncommitted half honestly */
  }

  const files = [];
  let additions = 0;
  let deletions = 0;
  const push = (path, added, deleted, binary = false) => {
    if (!path) return;
    // Clamped to the server's zod cap (file path ≤ 300 — see the caps at the
    // return, below): one over-cap string would 400 the whole report batch,
    // and a readout must degrade to a shorter label, never to silence.
    path = path.slice(0, 300);
    files.push(binary ? { path, added, deleted, binary } : { path, added, deleted });
    additions += added;
    deletions += deleted;
  };

  // Tracked: working tree vs base. `git diff <base>` (no --cached, no second
  // ref) is exactly "everything this session did", committed or not.
  try {
    const raw = git(['diff', '--numstat', base || 'HEAD'], wt);
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      const [a, d, ...rest] = line.split('\t');
      const path = rest.join('\t');
      const binary = a === '-' || d === '-';
      push(path, binary ? 0 : Number(a) || 0, binary ? 0 : Number(d) || 0, binary);
    }
  } catch {
    /* report what we have */
  }

  // Untracked, minus everything gitignored — new files are the most visible
  // work a session does and they would otherwise show as nothing at all.
  try {
    const others = git(['ls-files', '--others', '--exclude-standard'], wt)
      .split('\n')
      .filter(Boolean);
    for (const path of others.slice(0, MAX_UNTRACKED_SCAN)) {
      try {
        const full = join(wt, path);
        const st = statSync(full);
        if (!st.isFile()) continue;
        if (st.size > MAX_COUNT_BYTES) {
          push(path, 0, 0, true);
          continue;
        }
        const lines = countLines(readFileSync(full));
        if (lines === null) push(path, 0, 0, true);
        else push(path, lines, 0);
      } catch {
        /* vanished between listing and reading — it wasn't there to report */
      }
    }
  } catch {
    /* report what we have */
  }

  let ahead = 0;
  try {
    if (base) ahead = Number(git(['rev-list', '--count', `${base}..HEAD`], wt)) || 0;
  } catch {
    /* leave at 0 */
  }
  // WHAT LANDED WHILE YOU WERE WORKING. Not the branch's own history — the
  // commits on BASE that this worktree doesn't have, which is the thing a
  // person cannot see from inside their own session and the reason they end up
  // rebasing onto a surprise. Freshness is the caller's job: these are only as
  // current as the last fetch (reportWorktrees throttles one).
  let behind = 0;
  const baseCommits = [];
  try {
    behind = Number(git(['rev-list', '--count', `HEAD..${baseRef}`], wt)) || 0;
    if (behind > 0) {
      // %x1f is the unit separator — a subject can contain anything a person
      // can type, tabs and pipes included, so the delimiter must be one that
      // cannot appear in it.
      const raw = git(
        ['log', '-n', '3', '--format=%h%x1f%s%x1f%an', `HEAD..${baseRef}`],
        wt
      );
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        const [sha, subject, author] = line.split('\x1f');
        // Same clamp-to-the-server's-caps rule as the file paths: a subject or
        // author name is whatever a person typed, and git puts no bound on it.
        if (sha)
          baseCommits.push({
            sha,
            subject: (subject ?? '').slice(0, 200),
            author: (author ?? '').slice(0, 80),
          });
      }
    }
  } catch {
    /* an unfetched or missing base — say nothing rather than "you're current" */
  }
  let dirty = false;
  try {
    dirty = git(['status', '--porcelain'], wt) !== '';
  } catch {
    /* leave at false */
  }

  // Biggest first: with a 20-row cap, the rows that survive should be the ones
  // worth looking at. Ties break by path so the list doesn't shuffle per sweep.
  files.sort(
    (x, y) => y.added + y.deleted - (x.added + x.deleted) || (x.path < y.path ? -1 : 1)
  );
  // Every string here is clamped to the server's own zod caps (branch ≤ 200,
  // baseLabel ≤ 120, subject ≤ 200, author ≤ 80, file path ≤ 300): the report
  // rides in a BATCH, so a single over-cap string — a generated branch name, a
  // pathological commit subject — would 400 every session's readout at once.
  return {
    branch: branch.slice(0, 200),
    ...(headSha ? { headSha: headSha.slice(0, 64) } : {}),
    path: wt,
    ahead,
    behind,
    baseLabel: String(baseRef).replace(/^origin\//, '').slice(0, 120),
    baseCommits,
    dirty,
    additions,
    deletions,
    fileCount: files.length,
    truncated: Math.max(0, files.length - MAX_FILES),
    files: files.slice(0, MAX_FILES),
    commits: branchCommits(wt, base),
  };
}
