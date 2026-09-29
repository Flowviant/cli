/**
 * AN AGENT'S BRANCH ON THE REMOTE — the argv this machine builds, and nothing
 * else (daemon 0.86.0).
 *
 * The owner's ask: "instead of guessing or having no control over what branch
 * the agents or flowviant is working on … flowviant should create a flowviant
 * branch", settled as one isolated branch per agent under one shared prefix.
 * Nothing about the agent's LOCAL branch changed — it is still
 * `session/a-<agentId>`, cut in its own worktree. What is new is that this
 * machine pushes it to `origin` under `flowviant/`, so the work is visible
 * where the team already looks and survives the box that cut it.
 *
 * ── WHY THIS IS A MODULE AND NOT FOUR STRING LITERALS IN work.mjs ──
 *
 * Every function here composes a REFSPEC out of a value the SERVER named, and
 * a refspec is the one place in this feature where a wrong string is
 * destructive rather than merely useless: `:refs/heads/main` is how you delete
 * somebody's base branch, and the delete argv is built from a ref the server
 * read back out of a machine's own report. So the shape check and the argv
 * construction live together, pure, and are tested for what they REFUSE as
 * much as for what they build. The server validates the same shape at the door
 * the value comes IN through (`PUBLISH_REF_RE`, agentPublish.ts); this is the
 * door it goes OUT by, and one place doing a check is one deploy away from
 * being zero places.
 *
 * A server-named ref is trusted exactly as `placeId` is trusted: a validated
 * SHAPE, never a path, never a value that reaches argv unread.
 */

import { isSafePathSegment } from './git.mjs';

/**
 * THE SHAPE A PUBLISHED REF MAY HAVE — the server's own `PUBLISH_REF_RE`,
 * spelled identically on purpose.
 *
 * The PREFIX is part of the shape rather than a convention. It is what keeps a
 * report claiming `published.ref = 'main'` from coming back later as
 * `git push origin :refs/heads/main` on the project's base branch. The tail is
 * a whitelist, so the characters git refuses in a ref (`~ ^ : ? * [ \`, a
 * space) cannot appear however the name was composed.
 *
 * Bounded at 80 rather than left open: the server cannot compose a longer one
 * (a 40-char slug, a hyphen and six hex), so a longer value did not come from
 * `publishTargetFor` and there is nothing to be gained by acting on it.
 */
export const PUBLISH_REF_RE = /^flowviant\/[A-Za-z0-9._-]{1,80}$/;

/** True for a ref this machine may put in argv. Anything else is dropped in
 *  silence by the callers — a refusal here is a feature not happening, never a
 *  turn failing. */
export function isPublishRef(ref) {
  return typeof ref === 'string' && PUBLISH_REF_RE.test(ref);
}

/** The local branch an agent works on. One definition, so a push, a fetch and
 *  the begun-guard's own `rev-parse` can never name three different branches. */
export function agentBranchRef(place) {
  return isSafePathSegment(place) ? `refs/heads/session/${place}` : null;
}

/** A sha this machine MEASURED, in the one form `rev-parse` prints. The lease
 *  below is built from nothing else: an unrecognised value is treated as no
 *  observation at all rather than interpolated into argv. */
const SHA_RE = /^[0-9a-f]{7,40}$/;
export function isSha(v) {
  return typeof v === 'string' && SHA_RE.test(v);
}

/**
 * PUSH THIS AGENT'S BRANCH TO ITS PUBLISHED NAME.
 *
 * THE LEASE IS EXPLICIT, AND THE BARE FORM IS A TRAP THIS DAEMON WALKS INTO
 * BY ITSELF. `--force-with-lease` with no value expects the REMOTE-TRACKING
 * ref (`refs/remotes/origin/flowviant/…`) — and the worktree sweep three
 * hundred lines away runs `git fetch origin --quiet` on its own beat, which
 * refreshes exactly that ref. So the bare form's expectation is refreshed to
 * whatever a rival box pushed moments ago, the "lease" passes, and the push
 * overwrites the rival's commits in silence: proven in a sandbox, where the
 * same push is `! [rejected] (stale info)` before the sweep's fetch and
 * `(forced update)` after it. `--force-with-lease=<ref>:<sha>` names what THIS
 * process last saw at that ref, which no background fetch can move.
 *
 * NO EXPECTATION MEANS NO FORCE AT ALL. A process that has neither pushed nor
 * fetched this ref has observed nothing, and a force flag with nothing behind
 * it is a bare `--force` wearing a safer name. Unforced, git creates the ref or
 * fast-forwards it — every ordinary case, including the stale-merge fold, which
 * MERGES base in and therefore leaves a descendant — and REFUSES a genuine
 * divergence, which is the failure the caller reports rather than work it
 * silently discards.
 *
 * Explicit `refs/heads/…` on BOTH sides: a short name lets git guess, and its
 * guess for an unqualified destination that does not exist yet depends on the
 * remote's own refs. A destination is being CREATED here most of the time.
 */
export function publishPushArgs(place, ref, expectedSha = null) {
  const src = agentBranchRef(place);
  if (!src || !isPublishRef(ref)) return null;
  const spec = `${src}:refs/heads/${ref}`;
  return isSha(expectedSha)
    ? ['push', `--force-with-lease=refs/heads/${ref}:${expectedSha}`, 'origin', spec]
    : ['push', 'origin', spec];
}

/**
 * FETCH A PUBLISHED BRANCH BACK INTO THE LOCAL NAME THIS MACHINE CONTINUES ON.
 *
 * NO LEADING `+`, and that is the whole safety of this call. The plus is git's
 * force flag for a refspec, and a forced fetch onto `refs/heads/session/<place>`
 * would overwrite a local branch holding commits this box has and the remote
 * does not — the unpushed tail of a turn that died before its publish. Without
 * it git refuses any non-fast-forward update, so the call can create the branch
 * (the only case its caller is in) and can fast-forward one, and can destroy
 * nothing.
 */
export function publishFetchArgs(ref, place) {
  const dst = agentBranchRef(place);
  if (!dst || !isPublishRef(ref)) return null;
  return ['fetch', 'origin', `refs/heads/${ref}:${dst}`];
}

/**
 * RETIRE A PUBLISHED REF once its work is on base.
 *
 * The colon-prefixed refspec is a delete, and it is the most destructive argv
 * this daemon can build — which is why it is composed only from a ref that
 * passed `isPublishRef`, and why the prefix is part of that test. Nothing here
 * decides WHEN: the server sends the ref on a merge job only for an agent whose
 * push it actually heard about, and the caller runs this after the merge landed.
 */
export function publishDeleteArgs(ref) {
  return isPublishRef(ref) ? ['push', 'origin', `:refs/heads/${ref}`] : null;
}

/**
 * WHY A PUSH DID NOT LAND, in git's own words — the DIAGNOSIS, not the head and
 * not the last thing printed.
 *
 * Neither end of git's stderr is the answer. The HEAD is `To <url>`, so a
 * first-line reader relays the remote's address and never the failure. The TAIL
 * is usually advice ("Please make sure you have the correct access rights / and
 * the repository exists."), which is true of every auth failure there has ever
 * been and says nothing about this one. What a person needs is the two lines
 * carrying a DIAGNOSTIC marker — `fatal:`, `error:`, `remote:`, a `!` rejection,
 * a denial — which is where git puts the reason before it starts advising.
 *
 * The tail is the fallback for output that carries no marker at all, because a
 * relay with nothing to relay must still say something.
 *
 * USERINFO IS STRIPPED. A remote URL can carry a token in `//user:token@host`,
 * and this string is stored server-side and rendered to the whole project. The
 * caller scrubs the machine's env values before this; neither check knows about
 * the other's, which is why both run.
 */
const DIAGNOSTIC_RE = /^(fatal:|error:|remote:|!)|\b(denied|rejected|refused)\b/i;
export function publishErrorText(raw) {
  const lines = String(raw ?? '')
    .replace(/\/\/[^/@\s]+@/g, '//')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const said = lines.filter((l) => DIAGNOSTIC_RE.test(l));
  const pick = (said.length ? said : lines).slice(-2).join(' ');
  return (pick || 'the push failed').slice(0, 300);
}
