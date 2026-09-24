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
import { git, gitRaw, splitNul } from './git.mjs';

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
/** A trailer line is short; one past this is not a trailer, and is never fed
 *  to a pattern at all. */
const MAX_TRAILER_LINE = 2000;

export function taskIdsFromMessage(body) {
  const ids = [];
  for (const rawLine of String(body || '').split('\n')) {
    // LINEAR, NEVER BACKTRACKING (audit 2026-09-24). This was
    // `/^\s*Flowviant-Task\s*:\s*(.+?)\s*$/i`, whose lazy group against a
    // trailing `\s*$` is QUADRATIC in the line: `Flowviant-Task: a` + 900k
    // spaces + `b` — one commit any agent can write — held the daemon's event
    // loop for minutes on every 60s sweep (and the landed observer re-parses
    // it after a restart), so the machine read as offline. A length cap first,
    // then an anchored prefix with no ambiguity, then plain string work.
    if (rawLine.length > MAX_TRAILER_LINE) continue;
    const line = rawLine.trim();
    const m = /^Flowviant-Task[ \t]*:/i.exec(line);
    if (!m) continue;
    for (const raw of line.slice(m[0].length).split(/[\s,]+/)) {
      if (!raw || raw.length > 80) continue; // an id is at most 64
      const id = raw.replace(/^[#<]+|[>,.]+$/g, '');
      if (id && id.length <= 64 && /^[A-Za-z0-9_-]+$/.test(id) && !ids.includes(id)) {
        ids.push(id);
      }
    }
  }
  return ids;
}

/**
 * The %x1e/%x1f record delimiters, removed from any field that survives
 * parsing. Splitting alone is not enough: git PRESERVES both bytes in a commit
 * body, so a surviving field can still carry a fragment of a forged record,
 * and a stripped field can never re-assemble one downstream.
 */
export const stripDelims = (s) => String(s ?? '').replace(/[\x1e\x1f]/g, '');

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
 *
 * THE SHA LIST COMES FROM REV-LIST, NEVER FROM THE FORMATTED LOG. The %x1e and
 * %x1f delimiters are formatting, not a fence: git preserves both bytes inside
 * a commit BODY (verified empirically), so a crafted message can fabricate
 * whole records — a self-named sha carrying task ids, exactly the receipt this
 * product refuses to let an agent write about itself. rev-list prints nothing
 * an author controls, so its output is the set of commits that exist: a parsed
 * record whose sha is not in that set is a forgery and is dropped, a repeated
 * sha is the same forgery wearing a real commit's name, and the delimiter
 * bytes are stripped from every surviving field.
 */
/**
 * ONE COMMIT'S OWN RECORD, asked for BY SHA (audit 2026-09-24).
 *
 * The batched log above (`%H%x1f…%B%x1e` over the whole range) could be forged
 * even with the rev-list set as authority: `git log` is newest first, so a
 * commit whose body carried a fabricated record NAMING AN OLDER REAL SHA was
 * parsed before that commit's own record, the "first record wins" rule kept the
 * forgery, and the real one was dropped as a repeat — re-attributing somebody
 * else's commit to other cards under a forged author and suppressing its real
 * trailer. Asking git for one sha at a time makes the association structural:
 * whatever this record says, it is about the sha we named, so a body can only
 * ever speak for its own commit — which is what a trailer is.
 *
 * The body is the LAST field, so a NUL inside it (git refuses one in a message;
 * a hand-built object might not) is body; the numstat follows it. Returns null
 * when git will not answer.
 */
export function commitRecord(sha, cwd, { numstat = false } = {}) {
  let out;
  try {
    out = gitRaw(
      [
        'show',
        '--no-color',
        ...(numstat ? ['--numstat'] : ['-s']),
        '--format=%an%x00%aI%x00%B%x00',
        sha,
        '--',
      ],
      cwd
    );
  } catch {
    return null;
  }
  const parts = out.split('\0');
  if (parts.length < 4) return null;
  const author = parts[0];
  const at = parts[1];
  const body = parts.slice(2, -1).join('\n');
  // %s is the subject PARAGRAPH with its newlines folded, derived here from
  // the body rather than asked for as a field a message could shift.
  const subject = body.split(/\n[ \t]*\n/)[0].replace(/\s*\n\s*/g, ' ').trim();
  let additions = 0;
  let deletions = 0;
  if (numstat) {
    for (const l of parts[parts.length - 1].split('\n')) {
      if (!l.trim()) continue;
      const [a, d] = l.split('\t');
      if (a === '-' || d === '-') continue; // binary
      additions += Number(a) || 0;
      deletions += Number(d) || 0;
    }
  }
  return { sha, subject, author, at, body, additions, deletions };
}

function branchCommits(wt, base) {
  if (!base) return [];
  const out = [];
  try {
    const real = git(['rev-list', '--no-merges', '-n', String(MAX_COMMITS), `${base}..HEAD`], wt)
      .split('\n')
      .filter((x) => /^[0-9a-f]{40,64}$/.test(x));
    if (real.length === 0) return [];
    // One cheap look first: git's own grep names the commits whose message
    // mentions the trailer at all, so a branch that never uses it pays one
    // exec per sweep rather than one per commit, and no body is ever pulled
    // through a pipe just to be searched. Only a HINT — each named commit is
    // then read as itself below, and a sha outside the rev-list set is ignored.
    const named = new Set(
      git(
        ['log', '--no-merges', '-i', '--grep=flowviant-task', '--format=%H', `${base}..HEAD`],
        wt
      )
        .split('\n')
        .filter(Boolean)
    );
    for (const sha of real) {
      if (!named.has(sha)) continue;
      // A commit we cannot stat (a numstat past the pipe's buffer) still names
      // its cards — send it with zero counts rather than drop it, as before.
      const rec = commitRecord(sha, wt, { numstat: true }) ?? commitRecord(sha, wt);
      if (!rec) continue;
      const taskIds = taskIdsFromMessage(stripDelims(rec.body));
      if (taskIds.length === 0) continue;
      out.push({
        // Clamped to the server's zod caps, same rule as everything else in
        // this file: one over-cap string 400s the whole batch.
        sha: sha.slice(0, 64),
        subject: stripDelims(rec.subject).slice(0, 200),
        author: stripDelims(rec.author).slice(0, 80),
        at: stripDelims(rec.at).slice(0, 40),
        additions: rec.additions,
        deletions: rec.deletions,
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
  // ref) is exactly "everything this session did", committed or not. `-z`, for
  // the reason gitRaw exists: git's LINE-based output C-quotes any path that
  // is not plain ASCII, so an accented filename arrives as "n\303\251w.txt" —
  // a string that is not the path and reads as escaped garbage in the rail.
  try {
    // `--numstat -z` frames a normal change as one field, "added\tdeleted\tpath",
    // but a RENAME as three: "added\tdeleted\t" (empty path), then the old path,
    // then the new one. An empty path is therefore the rename marker and the
    // next two fields belong to it — read line-wise, a rename would report a
    // file literally named "old => new".
    const fields = splitNul(gitRaw(['diff', '--numstat', '-z', base || 'HEAD', '--'], wt));
    for (let i = 0; i < fields.length; i++) {
      const [a, d, ...rest] = fields[i].split('\t');
      let path = rest.join('\t');
      if (!path) {
        path = fields[i + 2] ?? fields[i + 1]; // the post-rename name is what exists now
        i += 2;
        if (!path) continue;
      }
      const binary = a === '-' || d === '-';
      push(path, binary ? 0 : Number(a) || 0, binary ? 0 : Number(d) || 0, binary);
    }
  } catch {
    /* report what we have */
  }

  // Untracked, minus everything gitignored — new files are the most visible
  // work a session does and they would otherwise show as nothing at all. `-z`
  // here is not cosmetic: a C-quoted untracked name fails the statSync below,
  // and the catch swallowed the row — a session's brand-new `café.txt` simply
  // vanished from the rail.
  try {
    const others = splitNul(gitRaw(['ls-files', '--others', '--exclude-standard', '-z'], wt));
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
