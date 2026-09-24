/**
 * THE LANDED OBSERVER — what arrived on base, whichever road it took.
 *
 * The daemon already fetches origin on a throttled beat (the worktree sweep)
 * and moves the local base ref itself on a ship push. This module watches the
 * base tip across those moments and, when it moves, walks the NEW commits and
 * reports them to /fleet/base-landed: sha, subject, and any `Flowviant-Task:`
 * trailer ids. The server closes what those commits name (a trailer from any
 * live status, a delivered card's receipt sha) — done is OBSERVED, and this is
 * the observation that covers a hand push, a PR merged on GitHub, and a
 * teammate's ship, none of which pass through /fleet/ship-done.
 *
 * A daemon→server REPORT, so there is no version floor and the delivery
 * discipline is repo-state's: a 404 (older server) goes quiet until restart,
 * and the observed tip is persisted ONLY when the server accepted the report —
 * a failed POST re-walks the same range on the next beat, which is free
 * because the server skips done cards.
 *
 * FIRST SIGHT SEEDS, NEVER WALKS. A fresh install (or a base-ref change) has
 * no honest "since when", and walking history would close every trailered card
 * ever merged. The tip is recorded and observation starts from there. The same
 * rule covers a range the repo can no longer answer (force-push, gc): reseed,
 * report nothing — ignorance is never turned into a state.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { git, baseBranchName } from './git.mjs';
import { stripDelims, taskIdsFromMessage } from './worktreeDiff.mjs';
import { warn } from './ui.mjs';
import { FLEET_URL, FLEET_TOKEN, USER_AGENT } from './config.mjs';

const LANDED_URL = FLEET_URL.replace(/\/agents\/?$/, '/base-landed');
/** The server accepts 50 per report. A bigger range walks OLDEST-FIRST in
 *  batches: the persisted tip advances to the last commit actually walked,
 *  so the remainder is picked up on the next beat rather than skipped forever
 *  — a trailered card in commit 51 of a big catch-up still closes. */
const MAX_COMMITS = 50;
const SHA_RE = /^[0-9a-f]{7,64}$/i;

export function createLandedObserver({ repoRoot, baseRef }) {
  // Keyed like the worktree base dir: one state file per checkout, so two
  // repos on one box never share a tip.
  const key = createHash('sha256').update(String(repoRoot)).digest('hex').slice(0, 8);
  const stateFile = join(homedir(), '.flowviant', `landed-${key}.json`);
  let unsupported = false; // 404 once → an older server; quiet until restart
  let inFlight = false;

  const readState = () => {
    try {
      const s = JSON.parse(readFileSync(stateFile, 'utf8'));
      return s && typeof s.ref === 'string' && typeof s.tip === 'string' ? s : null;
    } catch {
      return null;
    }
  };
  const writeState = (s) => {
    try {
      mkdirSync(join(homedir(), '.flowviant'), { recursive: true });
      writeFileSync(stateFile, JSON.stringify(s));
    } catch {
      /* a box that cannot persist just re-observes from the next seed */
    }
  };

  const tipOf = (ref) => {
    try {
      const t = git(['rev-parse', ref], repoRoot);
      return SHA_RE.test(t) ? t : null;
    } catch {
      return null;
    }
  };

  /** git with the buffer the WALK needs. git.mjs's call takes execFileSync's
   *  default 1MiB cap, and a catch-up range's `%B` bodies blew through it —
   *  the throw landed in the reseed catch below, which skipped the whole range
   *  and silently lost every trailer in it. 8MB is repoState's number for the
   *  same reason; rev-list output at 41 bytes a commit clears ~200k commits
   *  before it matters. */
  const gitWide = (args) =>
    execFileSync('git', args, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 8 * 1024 * 1024,
    }).trim();

  /** New non-merge commits in from..to, OLDEST FIRST — the next batch of at
   *  most MAX_COMMITS, plus the tip the state should advance to when the range
   *  held more. `--no-merges` for the same reason branchCommits keeps it: a
   *  merge commit describes a range rather than doing work, and its
   *  constituents are walked as themselves.
   *
   *  THE SHA LIST COMES FROM REV-LIST, NEVER FROM THE FORMATTED LOG. Git
   *  preserves the 0x1e/0x1f delimiter bytes inside a commit BODY (verified
   *  empirically), so a crafted message can fabricate whole records — an
   *  arbitrary sha plus Flowviant-Task ids that /fleet/base-landed would close
   *  cards on. rev-list prints nothing an author controls, so its output is
   *  the set of commits that exist: a parsed record whose sha is not in the
   *  batch is a forgery and is dropped, a repeated sha is the same forgery
   *  wearing a real commit's name, and the delimiter bytes are stripped from
   *  every surviving field.
   *
   *  BOUNDING THE BODY FETCH TO THE BATCH is what makes the header's batching
   *  contract true at any range size: `%B` over the whole range grows without
   *  bound, so the formatted log runs over exactly the shas being reported
   *  this beat (`--no-walk=unsorted` shows precisely the commits named, in
   *  argv order — measured). */
  const walk = (from, to) => {
    const shas = gitWide(['rev-list', '--reverse', '--no-merges', `${from}..${to}`])
      .split('\n')
      .filter((s) => SHA_RE.test(s));
    const batch = shas.slice(0, MAX_COMMITS);
    const tipAfter = shas.length > MAX_COMMITS ? batch[batch.length - 1] : null;
    if (batch.length === 0) return { commits: [], tipAfter };
    const real = new Set(batch);
    const raw = gitWide(['log', '--no-walk=unsorted', '--format=%H%x1f%s%x1f%B%x1e', ...batch]);
    const out = [];
    for (const rec of raw.split('\x1e')) {
      const line = rec.replace(/^\n+/, '');
      if (!line.trim()) continue;
      const [sha, subject, ...bodyParts] = line.split('\x1f');
      if (!real.has(sha)) continue;
      real.delete(sha);
      out.push({
        sha,
        subject: stripDelims(subject).slice(0, 200),
        taskIds: taskIdsFromMessage(stripDelims(bodyParts.join('\n'))).slice(0, 8),
      });
    }
    return { commits: out, tipAfter };
  };

  /** Look at the base tip; if it moved, report the range. Call after anything
   *  that may have moved origin/<base> — the sweep's fetch, a ship's push, a
   *  PR merge this daemon performed. Never throws, never awaited by a turn. */
  const observe = async () => {
    if (unsupported || inFlight) return;
    const ref = baseRef();
    if (!ref) return;
    const tip = tipOf(ref);
    if (!tip) return;
    const st = readState();
    if (!st || st.ref !== ref) {
      writeState({ ref, tip });
      return;
    }
    if (st.tip === tip) return;
    let walked;
    try {
      walked = walk(st.tip, ref);
    } catch {
      // Two failures land here and only one may reseed. Probe the range
      // directly: if rev-list cannot COUNT it, the old tip is genuinely gone
      // (force-push, gc) and observation reseeds at the new one — ignorance is
      // never turned into a state. Anything else (a transient spawn failure,
      // an over-buffer) keeps the stored tip so the next beat retries the same
      // range; reseeding on those was what skipped a whole catch-up range and
      // permanently lost every trailer in it.
      try {
        git(['rev-list', '--count', `${st.tip}..${ref}`], repoRoot);
      } catch {
        writeState({ ref, tip });
      }
      return;
    }
    // Oldest-first BATCH: a range past the server's cap advances the tip only
    // to the last commit walked, so the remainder rides the next beat —
    // nothing is skipped forever. (A range of nothing but merge commits still
    // reports, tip-only: the tip moving is the fact deploy-on-merge rides.)
    const commits = walked.commits;
    const reportedTip = walked.tipAfter ?? tip;
    inFlight = true;
    try {
      const res = await fetch(LANDED_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${FLEET_TOKEN}`,
          'User-Agent': USER_AGENT,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(20_000),
        body: JSON.stringify({ base: baseBranchName(ref), tip: reportedTip, commits }),
      });
      if (res.status === 404) {
        unsupported = true;
        return;
      }
      if (res.ok) {
        // Persist ONLY an accepted report — a 5xx (the server could not close
        // the cards) or a network failure leaves the tip where it was, so the
        // next beat re-walks the same range and the close re-runs, idempotently.
        writeState({ ref, tip: reportedTip });
        // Deploy-on-merge refusals are computed server-side and would
        // otherwise vanish — an onMerge:'prod' (or a target with no
        // commands[env]) must not be quietly inert.
        const j = await res.json().catch(() => null);
        for (const r of j?.data?.deployRefused ?? []) {
          warn(`deploy-on-merge refused for target "${r?.targetId}": ${r?.reason}`);
        }
      } else if (res.status === 408 || res.status === 429) {
        // A TIMEOUT OR A RATE LIMIT IS "NOT NOW", NOT "NEVER". Both used to
        // land in the drop below, so one 429 — a busy operator IP past the
        // limiter — skipped the range for good: its trailers and receipt shas
        // never closed their cards (in PR mode the observer is the ONLY road
        // to Done) and deploy-on-merge for that tip was never queued. Keep the
        // stored tip, exactly as a 5xx does; the next beat re-walks it.
      } else if (res.status >= 400 && res.status < 500) {
        // A persistent 4xx (deploy skew, a payload this server refuses) would
        // otherwise re-send the same poison range on every beat forever.
        // Drop THIS BATCH — to `reportedTip`, the last commit it carried, never
        // the full tip: a range past the cap has a remainder this batch never
        // sent, and advancing to the tip discarded that too. The closes it
        // carried re-run at the next REAL tip move only if their cards are
        // still open, which is the idempotent half; the honest cost is stated
        // out loud.
        writeState({ ref, tip: reportedTip });
        warn(`base-landed report refused (${res.status}) — skipped ${commits.length} commit(s)`);
      }
    } catch {
      /* offline — the next fetch beat retries */
    } finally {
      inFlight = false;
    }
  };

  return { observe };
}
