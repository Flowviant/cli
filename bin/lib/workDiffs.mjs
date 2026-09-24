/** Commit diff requests and their bounded reports. */
import { FLEET_URL, FLEET_TOKEN, USER_AGENT } from './config.mjs';
import { git } from './git.mjs';

export function createWorkDiffs({ repoRoot }) {
  const DIFF_DONE_URL = FLEET_URL.replace(/\/agents\/?$/, '/diff-done');

  /**
   * COMMIT DIFFS, on request — the one PULL-shaped thing this daemon does.
   *
   * Everything else here is a push: the machine knows something and says it.
   * A patch cannot work that way, because most are never opened and pushing
   * every one would be storage and bandwidth for nothing. So the server leaves
   * a job on the roster and this drains it.
   *
   * RUN FROM THE REPO ROOT, never a session worktree. A tab can be closed and
   * its directory gone, but `session/<id>` outlives the tab and after a ship
   * the commit is on main — the root checkout can see all of it, and a
   * worktree can see only its own branch.
   *
   * Every failure is REPORTED rather than swallowed: "no such commit on this
   * machine" is a real answer, and a viewer spinning forever is the worst thing
   * this can do. The one thing never sent is a guess — an empty patch would
   * tell a reader the commit changed nothing.
   */
  const MAX_PATCH_BYTES = 256 * 1024;
  const servedDiffs = new Set();
  const postDiff = async (body) => {
    try {
      await fetch(DIFF_DONE_URL, {
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
      /* the row stays pending and expires; the next click re-requests */
    }
  };
  const processDiffJobs = (jobs) => {
    if (!Array.isArray(jobs) || jobs.length === 0) return;
    for (const job of jobs.slice(0, 5)) {
      const sha = String(job?.sha || '').toLowerCase();
      // A sha becomes a `git` argument. The server validates too; one place
      // doing this check is one deploy away from being zero places.
      if (!/^[0-9a-f]{7,64}$/.test(sha)) continue;
      // In-flight guard, not a cache: the server stops offering a sha the
      // moment it settles, so this only stops the SAME poll's job being
      // started twice while its `git show` is still running.
      if (servedDiffs.has(sha)) continue;
      servedDiffs.add(sha);
      void (async () => {
        try {
          let patch = '';
          const files = [];
          try {
            // `--format=` so the body is pure diff: the subject, author and
            // date already reached the card on the worktree sweep, and
            // repeating them inside the patch would put a second copy above
            // every hunk.
            patch = git(['show', '--patch', '--format=', sha], repoRoot);
          } catch (e) {
            await postDiff({ sha, error: String(e?.message || e).slice(0, 500) });
            return;
          }
          try {
            const raw = git(['show', '--numstat', '--format=', sha], repoRoot);
            for (const line of raw.split('\n')) {
              if (!line.trim()) continue;
              const [a, d, ...rest] = line.split('\t');
              const path = rest.join('\t');
              if (!path) continue;
              const binary = a === '-' || d === '-';
              files.push({
                path: path.slice(0, 300),
                added: binary ? 0 : Number(a) || 0,
                deleted: binary ? 0 : Number(d) || 0,
                ...(binary ? { binary: true } : {}),
              });
            }
          } catch {
            /* a header without counts still beats no diff */
          }
          const truncated = Buffer.byteLength(patch, 'utf8') > MAX_PATCH_BYTES;
          await postDiff({
            sha,
            // Cut on a LINE boundary: half a hunk header renders as garbage,
            // and the viewer says the patch was truncated either way.
            patch: truncated
              ? patch.slice(0, MAX_PATCH_BYTES).replace(/\n[^\n]*$/, '\n')
              : patch,
            files: files.slice(0, 200),
            truncated,
          });
        } finally {
          servedDiffs.delete(sha);
        }
      })();
    }
  };

  return { processDiffJobs };
}
