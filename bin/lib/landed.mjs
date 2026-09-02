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

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { git, baseBranchName } from './git.mjs';
import { taskIdsFromMessage } from './worktreeDiff.mjs';
import { warn } from './ui.mjs';
import { FLEET_URL, FLEET_TOKEN, USER_AGENT } from './config.mjs';

const LANDED_URL = FLEET_URL.replace(/\/agents\/?$/, '/base-landed');
/** The server accepts 50 per report. A bigger range walks OLDEST-FIRST in
 *  batches: the persisted tip advances to the last commit actually reported,
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

  /** New non-merge commits in from..to, OLDEST FIRST. `--no-merges` for the
   *  same reason branchCommits keeps it: a merge commit describes a range
   *  rather than doing work, and its constituents are walked as themselves. */
  const walk = (from, to) => {
    const raw = git(
      ['log', '--reverse', '--no-merges', '--format=%H%x1f%s%x1f%B%x1e', `${from}..${to}`],
      repoRoot
    );
    const out = [];
    for (const rec of raw.split('\x1e')) {
      const line = rec.replace(/^\n+/, '');
      if (!line.trim()) continue;
      const [sha, subject, body] = line.split('\x1f');
      if (!SHA_RE.test(sha || '')) continue;
      out.push({
        sha,
        subject: String(subject || '').slice(0, 200),
        taskIds: taskIdsFromMessage(body).slice(0, 8),
      });
    }
    return out;
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
    let all;
    try {
      all = walk(st.tip, ref);
    } catch {
      // The old tip is no longer answerable (force-push, gc) — reseed and
      // report nothing rather than guess at a range.
      writeState({ ref, tip });
      return;
    }
    // Oldest-first BATCH: a range past the server's cap advances the tip only
    // to the last commit reported, so the remainder rides the next beat —
    // nothing is skipped forever. (A range of nothing but merge commits still
    // reports, tip-only: the tip moving is the fact deploy-on-merge rides.)
    const commits = all.slice(0, MAX_COMMITS);
    const reportedTip = all.length > MAX_COMMITS ? commits[commits.length - 1].sha : tip;
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
      } else if (res.status >= 400 && res.status < 500) {
        // A persistent 4xx (deploy skew, a payload this server refuses) would
        // otherwise re-send the same poison range on every beat forever.
        // Drop the range — the closes it carried re-run at the next REAL tip
        // move only if their cards are still open, which is the idempotent
        // half; the honest cost is stated out loud.
        writeState({ ref, tip });
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
