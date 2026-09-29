/**
 * PUBLISHING AN AGENT'S BRANCH — the push to the name the server gave it, the
 * fetch that brings a published branch back to a box that lost it, and the
 * two process-local records (what this machine pushed; what it has seen at
 * the remote ref) that the push's lease and the worktree report read.
 *
 * Split out of work.mjs (2026-09-26, SOLID F037). The argv shapes are
 * agentPublish.mjs's (pure, tested there); this module owns the STATE and the
 * network calls. The agent lane pushes after a settle and fetches at the
 * begun-guard, the sweep keeps a published branch current, the merge lane
 * retires the ref — all through the maps and two functions returned here.
 */
import { git } from './git.mjs';
import { publishPushArgs, publishFetchArgs, publishErrorText } from './agentPublish.mjs';
import { scrub as envScrub } from './uplinkScrub.mjs';

export function createWorkAgentPublish({ repoRoot, gitNet }) {
  // ── PUBLISHING AN AGENT'S BRANCH ───────────────────────────────────────────
  //
  // The server names the target (`agentTurnJobs[].publishTo`) and this machine
  // pushes to it. Two laws hold the whole lane up:
  //
  // A PUSH NEVER BLOCKS OR FAILS A TURN. It is tail work after the settle, it
  // is try/catch'd like every sweep, and a failure is REPORTED in git's own
  // words rather than thrown. An agent whose remote push fails has still done
  // its work, still committed it, and still settled.
  //
  // THE SERVER LEARNS OF A PUSH ONLY BY BEING TOLD. Nothing here composes a
  // name: an absent `publishTo` is a project that has publishing off, or a
  // server older than this daemon, and in both the honest behaviour is to push
  // nothing and report nothing. Absence keeps one meaning.
  /**
   * WHAT THIS MACHINE LAST DID WITH EACH AGENT'S BRANCH, by place —
   * `{ ref, sha }` for a push that landed, `{ ref, error, at, tried }` for one
   * that did not. Mutually exclusive by construction, which is what makes the
   * report's two keys mutually exclusive without a second rule.
   *
   * Process-local on purpose: it is a record of what THIS daemon pushed, so a
   * restart re-pushes once and re-reports — a push of the same sha to the same
   * ref is a no-op at the remote, and re-learning beats trusting a file about
   * something a rebase can invalidate.
   */
  const agentPublished = new Map();
  /**
   * WHAT THIS PROCESS HAS SEEN AT EACH AGENT'S REMOTE REF — `{ ref, sha }`, and
   * the ONLY input to the push's lease.
   *
   * It is deliberately NOT `agentPublished`: that map is the REPORT record (what
   * this machine pushed, and what the server may be told), while this one is an
   * observation of the REMOTE's own position, which a box also gets by FETCHING
   * a ref it never pushed. A box that fetch-continues an agent has seen the ref
   * and must be able to lease against it; a box that has seen nothing pushes
   * with no force flag at all.
   *
   * Process-local for the same reason the record beside it is: a restart has
   * observed nothing, and an unforced push is the honest thing to do about that
   * — it lands, or it refuses and says so.
   */
  const agentRemoteAt = new Map();
  /** A failed push retries on the next sweep, but not FOREVER at sweep cadence:
   *  a remote that refuses (no credentials on this box, a protected prefix)
   *  would otherwise cost a blocking network call per agent per minute for the
   *  life of the daemon. A moved branch always retries immediately — the
   *  throttle is on repeating the SAME attempt, never on new work. */
  const PUBLISH_RETRY_MS = 5 * 60_000;
  /** The tip of an agent's local branch, or null when this box does not hold it
   *  — which is a perfectly ordinary state (the begun-guard's whole subject) and
   *  means there is nothing to publish, never that a push failed. */
  const agentBranchSha = (place) => {
    try {
      return (
        git(['rev-parse', '--verify', '--quiet', `refs/heads/session/${place}`], repoRoot) || null
      );
    } catch {
      return null;
    }
  };
  /**
   * PUSH ONE AGENT'S BRANCH TO THE NAME THE SERVER GAVE IT.
   *
   * Returns TRUE when the recorded state CHANGED, because the caller's next act
   * is a worktree report and a report that says what the last one said is a
   * write per minute restating a fact. The rule this serves is the one every
   * settle keeps: an action that changes what the machine would measure must
   * cause a new measurement — and only then.
   *
   * Never throws.
   */
  const publishAgentBranch = async (place, target) => {
    const sha = agentBranchSha(place);
    if (!sha) return false;
    const prev = agentPublished.get(place);
    if (prev?.ref === target && prev.sha === sha) return false; // already there
    if (
      prev?.ref === target &&
      prev.error &&
      prev.tried === sha &&
      Date.now() - (prev.at ?? 0) < PUBLISH_RETRY_MS
    )
      return false; // the same attempt failed moments ago
    // THE LEASE IS THIS PROCESS'S OWN LAST SIGHTING of that ref, and nothing
    // else — never git's remote-tracking ref, which this daemon's own sweep
    // fetch refreshes (the argument is in `publishPushArgs`). An expectation
    // recorded against a DIFFERENT ref is no expectation for this one.
    const seen = agentRemoteAt.get(place);
    // A ref that is not the server's shape never reaches argv. Silent, because
    // a refusal here is a feature not happening on this turn, not a failure of
    // it — and a `publishError` about a value we declined to use would be this
    // machine reporting on a push it never attempted.
    const args = publishPushArgs(place, target, seen?.ref === target ? seen.sha : null);
    if (!args) return false;
    try {
      gitNet(args, 60_000);
      agentPublished.set(place, { ref: target, sha });
      agentRemoteAt.set(place, { ref: target, sha });
      return true;
    } catch (e) {
      const error = publishErrorText(envScrub(e?.stderr?.toString?.() || e?.message || ''));
      agentPublished.set(place, { ref: target, error, at: Date.now(), tried: sha });
      // A repeat of a failure already reported is not news; the server's stored
      // sentence is already this one.
      return !(prev?.error === error && prev.ref === target);
    }
  };
  /**
   * BRING A PUBLISHED BRANCH BACK DOWN — the other half of the durability
   * promise, and the only thing that lets an agent's work outlive its box.
   *
   * Reached from ONE place: the begun-guard's refusal arm, where this machine
   * has just MEASURED that it holds neither the agent's worktree nor its branch.
   * The server only sends `publishedRef` when it heard about a real push, so
   * this is not a guess at a remote branch — it is a fetch of one a machine
   * reported writing.
   *
   * ── WHAT IT RECOVERS, AND WHAT IT CANNOT ──
   *
   * COMMITS COME BACK. The CONVERSATION DOES NOT: the CLI's held context lives
   * in the box that ran it and nothing here transports it. The turn kickoff
   * re-prompts from the card, which is the honest continuation — an agent that
   * picks up its own commits and re-reads its own card, never one that remembers
   * the argument. Nothing this returns may be phrased as if it did.
   *
   * THREE ANSWERS, because two would lie. `null` is "there was nothing to try"
   * (no ref, or one whose shape this machine will not put in argv), and it must
   * leave the existing refusal EXACTLY as it was — a sentence about a fetch
   * nobody attempted is worse than the plain refusal. `{ ok: false, why }` is a
   * measured failure, relayed in git's own words. `{ ok: true }` is only ever
   * returned after re-reading the ref: a fetch that exits 0 having created
   * nothing would otherwise walk straight into `placeWtFor` cutting a fresh
   * branch off base — the context-free redo the guard above exists to prevent,
   * wearing this feature's name.
   */
  const fetchPublishedBranch = (place, ref) => {
    const args = publishFetchArgs(ref, place);
    if (!args) return null;
    try {
      gitNet(args, 120_000);
    } catch (e) {
      return {
        ok: false,
        why: publishErrorText(envScrub(e?.stderr?.toString?.() || e?.message || '')),
      };
    }
    const sha = agentBranchSha(place);
    if (!sha) return { ok: false, why: 'the fetch reported nothing and left no local branch' };
    // WHAT THIS PROCESS HAS NOW SEEN AT THAT REMOTE REF. A fetch is an
    // observation of the remote's own position, and for a box that continues an
    // agent it never started it is the ONLY one it will ever have — without it
    // this box's first push would carry no lease and would have to go unforced.
    // It is not a `publishAgentBranch` record: this machine pushed nothing, so
    // the server is told nothing.
    agentRemoteAt.set(place, { ref, sha });
    return { ok: true };
  };

  return { agentPublished, agentRemoteAt, publishAgentBranch, fetchPublishedBranch };
}
