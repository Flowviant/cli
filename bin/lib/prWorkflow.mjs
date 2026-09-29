/**
 * THE GITHUB PULL-REQUEST RULES both merge paths share — adopt only an OPEN PR
 * into the project's base, create one with `--fill`, merge with `--merge`, and
 * believe "merged" only once the tip is measured on base.
 *
 * ── WHY ONE FILE (SOLID audit 2026-09-26, F040) ──
 *
 * The session PR lane (`workPullRequests.mjs`) and the agent approve path
 * (`workAgentMerges.mjs`) each spelled these rules, forty lines apart in
 * spirit and two files apart in fact, and they had already drifted once: the
 * session copy adopted a PR into `staging` for months after the agent copy
 * learned to refuse it, and it went without `gh` timeouts until 0.77.1. What
 * is theirs stays theirs — which branch is pushed and how, the lease, the
 * sentences each settles with, the job and the report — and everything that
 * is a fact about GitHub lives here once:
 *
 *  - ADOPT ONLY AN OPEN PR. gh's branch finder falls back to the most recent
 *    MERGED/CLOSED PR when no open one exists, and adopting a dead PR turns
 *    every later delivery on a long-lived branch into a silent black hole.
 *  - …AND ONLY ONE THAT TARGETS THE PROJECT'S BASE. A PR somebody opened by
 *    hand into another branch would be merged INTO that branch. Refused only
 *    on a MEASURED mismatch: an absent or empty `baseRefName` adopts as
 *    before. (The agent copy refused an empty string; the session copy
 *    adopted it. GitHub never sends one, and "measured" is the rule both
 *    copies stated, so the session spelling won.)
 *  - `--fill` titles a created PR from the branch's own commits — no model
 *    call, nothing invented — and the base is `baseBranchName`, never a
 *    remote-tracking name gh 422s on.
 *  - `--merge`, never squash and never rebase: the cards' receipts are commit
 *    shas, and a squash rewrites them off base, orphaning every receipt and
 *    blinding the landed walk's trailer read. "Already merged" is a success.
 *  - VERIFY before claiming merged: modern gh exits 0 on an already-MERGED PR
 *    and on a merge queue it exits 0 after ENQUEUEING. The tip being an
 *    ancestor of base is the fact "merged" claims — measured after a fetch,
 *    with one short retry for the fetch racing GitHub's merge commit.
 *
 * EVERY `gh` CALL IS TIMED OUT. `execFileSync` blocks the daemon's whole event
 * loop, and the agent path runs inside the place writer lock — a `gh` that
 * hangs (an expired token prompting, a network black hole, a hung credential
 * helper) would stop every turn on the machine.
 *
 * `gh`, the fetch and the sleep are injectable so the rules are provable
 * without GitHub; nothing in the daemon passes them except the fetch.
 */

import { execFileSync } from 'node:child_process';
import { git } from './git.mjs';

/** gh's own first line of complaint, capped — the words a failure relays. */
export const ghFirstLine = (e) =>
  ((e?.stderr?.toString?.() || e?.message || 'failed').split('\n').find((l) => l.trim()) ||
    'failed')
    .slice(0, 400);

/** A pull request URL worth storing. Anything else gh printed is not one. */
export const PR_URL_RE = /^https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/\d+$/;

const runGh = (args, opts) => execFileSync('gh', args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });

/**
 * Is `gh` installed and signed in? null when it is; otherwise
 * `{ missing, error }` — `missing` when the binary is absent, so each caller
 * can say "not installed" and "not signed in" in its own words.
 */
export function ghReady({ gh = runGh } = {}) {
  try {
    gh(['auth', 'status'], { timeout: 20_000 });
    return null;
  } catch (e) {
    return { missing: e?.code === 'ENOENT', error: ghFirstLine(e) };
  }
}

/** The OPEN pull request for `head`, as `{ url, base }` — or null when there
 *  is none, or only a merged/closed one. `base` is null when gh did not say. */
export function findOpenPr(head, { cwd, gh = runGh } = {}) {
  try {
    const j = JSON.parse(gh(['pr', 'view', head, '--json', 'url,state,baseRefName'], { cwd, timeout: 30_000 }).toString());
    if (j?.state !== 'OPEN' || typeof j?.url !== 'string') return null;
    return { url: j.url.trim(), base: typeof j?.baseRefName === 'string' ? j.baseRefName : null };
  } catch {
    return null; // no PR for the branch at all
  }
}

/** The branch an open PR targets when it is MEASURED to be not `base`, else
 *  null — the one refusal condition for adopting it. */
export function prTargetsOtherBase(pr, base) {
  return pr && pr.base && pr.base !== base ? pr.base : null;
}

/**
 * THE OPEN PR FOR `head` INTO `base`: adopt one already open (a re-delivery,
 * or one somebody opened by hand), or create it. Answers
 *   `{ url, adopted }`   — url may be null if gh printed nothing usable
 *   `{ wrongBase }`      — an open PR targets another branch; nothing created
 *   `{ error }`          — gh's own words from a failed create
 */
export function ensureOpenPr(head, base, { cwd, gh = runGh } = {}) {
  const existing = findOpenPr(head, { cwd, gh });
  const wrongBase = prTargetsOtherBase(existing, base);
  if (wrongBase) return { wrongBase };
  if (existing?.url) return { url: existing.url, adopted: true };
  try {
    const out = gh(['pr', 'create', '--head', head, '--base', base, '--fill'], { cwd, timeout: 60_000 })
      .toString()
      .trim();
    return { url: out.split('\n').filter(Boolean).pop() ?? null, adopted: false };
  } catch (e) {
    return { error: ghFirstLine(e) };
  }
}

/**
 * Is `tip` on `baseRef` yet? Fetch, then ask git; once more after a short
 * pause if not, for the fetch racing GitHub's merge commit. An offline fetch
 * answers from what the box already has. A null tip is never on base.
 */
export async function tipReachedBase({ tip, baseRef, repoRoot, fetchOrigin, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), gitImpl = git }) {
  if (!tip) return false;
  const onBase = () => {
    try {
      gitImpl(['merge-base', '--is-ancestor', tip, baseRef()], repoRoot);
      return true;
    } catch {
      return false;
    }
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await sleep(2000);
    try {
      fetchOrigin();
    } catch {
      /* offline — the check below answers from what we have */
    }
    if (onBase()) return true;
  }
  return false;
}

/**
 * MERGE `head`'s PR with a merge commit and VERIFY the tip reached base.
 * Answers `{ ok: true }`, `{ error }` (gh refused, in its own words — an
 * "already merged" is not a refusal), or `{ notOnBase: true }` (gh said yes
 * and base does not have the tip: an older PR merged, or a queue holds it).
 * The push that must precede it is the caller's: GitHub merges the REMOTE tip.
 */
export async function mergeAndVerifyTip(head, { cwd, tip, baseRef, repoRoot, fetchOrigin, gh = runGh, sleep, gitImpl }) {
  try {
    gh(['pr', 'merge', head, '--merge'], { cwd, timeout: 120_000 });
  } catch (e) {
    const line = ghFirstLine(e);
    if (!/already merged/i.test(line)) return { error: line };
  }
  const landed = await tipReachedBase({ tip, baseRef, repoRoot, fetchOrigin, sleep, gitImpl });
  return landed ? { ok: true } : { notOnBase: true };
}
