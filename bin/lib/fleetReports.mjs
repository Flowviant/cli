/**
 * WHAT THIS MACHINE REPORTS ABOUT ITSELF, off the roster's beat — terminal
 * sessions, the repo's branches and worktrees (with the CLI's credential
 * context), the checkout's env by name, repo tool readiness, and the machine
 * telemetry snapshot.
 *
 * Split out of fleet.mjs (SOLID audit 2026-09-26, F038). Each lane is its own
 * throttle, its own dedup against the last ACCEPTED payload, and its own
 * "the server refused for good — quiet until restart" flag; all of that is
 * module state, and none of it is the reconcile loop's business. The loop
 * fires each one and forgets it (`void`), which is the one contract they all
 * keep: a readout must never throw into, or delay, the poll.
 *
 * Every lane is a DAEMON→SERVER report, so none needs a floor: an older server
 * 404s once and the lane goes quiet; an older daemon simply never posts.
 */

import { FLEET_URL, FLEET_TOKEN, USER_AGENT } from './config.mjs';
import { fleetEndpoint } from './fleetWire.mjs';
import { postToFleet } from './fleetPost.mjs';
import { myPubB64 } from './boxIdentity.mjs';
import { scanEnvForScrub } from './env.mjs';
import { machineSnapshot } from './resources.mjs';
import { detectRuntimes } from './runtimeDetection.mjs';
import { scanLocalSessions } from './localSessions.mjs';
import { repoState } from './repoState.mjs';
import { claudeAuthContext } from './claudeAuth.mjs';
import { readBaseTools, toolReadout } from './projectTools.mjs';
import { runnerToolCapabilities } from './projectToolRuntimes.mjs';

/**
 * Terminal-session presence: tell the server which Claude sessions exist in
 * this repo (localSessions.mjs reads them off Claude's own on-disk state), so
 * the Workbench can offer "adopt this terminal session as a tab". Best-effort
 * in exactly the way the env/runtimes blocks are — a presence report that can
 * fail a poll is worse than no presence at all — with three quiet economies:
 * the scan runs at most once a minute (the reconcile loop ticks far faster), a
 * report identical to the last DELIVERED one is not re-sent, and a 404 means
 * an older server that has never heard of the endpoint, after which this
 * process stops asking (a deploy that adds it also restarts nothing on this
 * machine, so silence-until-restart costs one daemon restart, not a feature).
 */
const LOCAL_SESSIONS_URL = fleetEndpoint('local-sessions', FLEET_URL);
const LOCAL_SESSIONS_SCAN_MS = 60_000;
// The web hides a report older than 10 minutes (presence must not linger as
// fact after the machine dies), so an UNCHANGED report is re-sent inside that
// window anyway — the re-send is the machine's heartbeat on this fact, and
// suppressing it entirely would blank the strip while everything still holds.
const LOCAL_SESSIONS_RESEND_MS = 5 * 60_000;
let localSessionsUnsupported = false; // the server 404'd — quiet until restart
let localSessionsScanAt = 0;
let localSessionsSent = null; // last payload the server ACCEPTED, stringified
let localSessionsSentAt = 0;
export async function maybeReportLocalSessions({ repoRoot, excludeDirs, excludeIds }) {
  if (localSessionsUnsupported) return;
  if (Date.now() - localSessionsScanAt < LOCAL_SESSIONS_SCAN_MS) return;
  localSessionsScanAt = Date.now();
  let payload;
  try {
    // scanLocalSessions orders deterministically, so this string only changes
    // when the facts on disk do — the dedup below compares whole payloads.
    payload = JSON.stringify({
      sessions: scanLocalSessions({ repoRoot, excludeDirs, excludeIds }),
    });
  } catch {
    return; // presence must never throw into the poll loop
  }
  if (payload === localSessionsSent && Date.now() - localSessionsSentAt < LOCAL_SESSIONS_RESEND_MS)
    return;
  try {
    const res = await fetch(LOCAL_SESSIONS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${FLEET_TOKEN}`,
        'User-Agent': USER_AGENT,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(15_000),
      body: payload,
    });
    if (res.status === 404) {
      localSessionsUnsupported = true; // older server — it REPLACED nothing here
      return;
    }
    // Only an accepted report counts as sent; anything else forgets the
    // last-sent payload so the next pass retries instead of dedup-suppressing
    // a report the server never received.
    localSessionsSent = res.ok ? payload : null;
    localSessionsSentAt = res.ok ? Date.now() : 0;
  } catch {
    localSessionsSent = null;
    localSessionsSentAt = 0;
  }
}

/**
 * EVERY BRANCH AND WORKTREE ON THIS MACHINE, pushed on the same beat as
 * presence — the answer to "is my Claude leaving a mess in here?".
 *
 * Same three economies as the presence report above and for the same reasons:
 * scanned at most once a minute, not re-sent while identical (repoState orders
 * deterministically so the string only moves when the repo does), and silent
 * for the rest of the process once an older server 404s.
 *
 * ONE DIFFERENCE, deliberate: there is no re-send heartbeat window. Presence
 * expires in the UI because a session that ENDED must stop reading as live;
 * a branch list is not presence — a branch that existed a minute ago still
 * exists — so re-posting an unchanged list would be a write per machine per
 * five minutes to say nothing at all.
 */
const REPO_STATE_URL = fleetEndpoint('repo-state', FLEET_URL);
const REPO_STATE_SCAN_MS = 60_000;
let repoStateUnsupported = false; // the server 404'd — quiet until restart
let repoStateScanAt = 0;
let repoStateSent = null; // last payload the server ACCEPTED, stringified
export async function maybeReportRepoState({ repoRoot, baseRef }) {
  if (repoStateUnsupported) return;
  if (Date.now() - repoStateScanAt < REPO_STATE_SCAN_MS) return;
  repoStateScanAt = Date.now();
  let payload;
  try {
    // The PARAM, and nothing else: this function sits at MODULE scope, where
    // runFleetDaemon's `getBaseRef` closure does not exist. An earlier version
    // reached for it anyway, the ReferenceError landed in the catch below —
    // written for an unreadable repo, silent by design — and this endpoint was
    // never once posted to. The caller reads the loop's live `baseRef` at call
    // time, so the value here is always current.
    const state = repoState(repoRoot, baseRef);
    if (!state) return; // not readable — say nothing rather than say "none"
    /**
     * WHICH CREDENTIAL THIS MACHINE'S CLI RESOLVES, on the same beat.
     *
     * It rides this report rather than getting an endpoint of its own because
     * it is the same KIND of fact — something only the machine can see, pushed
     * because a pull client can never be asked — and it inherits this
     * function's three economies for free: scanned once a minute, deduped
     * against the last ACCEPTED payload, and silent forever once an older
     * server 404s.
     *
     * The dedup keeps it cheap: `claudeAuthContext` is presence plus two dates,
     * so the string is stable across scans and only moves when something about
     * the credential actually moves. It DOES move when the CLI refreshes its
     * access token — that stamp is carried for diagnostics — which costs a
     * write roughly twice a day and is the whole of the extra traffic. The
     * WARNING is built on the 22-day refresh clock instead, so a note never
     * fires on the ~12h cycle.
     *
     * NO VERSION FLOOR, and none is possible to need: this is a daemon→server
     * report, and an older SERVER strips the unknown key in its zod parse and
     * stores the rest exactly as before.
     */
    payload = JSON.stringify({ ...state, auth: claudeAuthContext() });
  } catch {
    return; // a readout must never throw into the poll loop
  }
  if (payload === repoStateSent) return;
  try {
    const res = await fetch(REPO_STATE_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${FLEET_TOKEN}`,
        'User-Agent': USER_AGENT,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(15_000),
      body: payload,
    });
    if (res.status === 404) {
      repoStateUnsupported = true; // older server — nothing was replaced here
      return;
    }
    // Only an ACCEPTED report counts: anything else forgets it so the next
    // pass retries rather than dedup-suppressing a report nobody received.
    repoStateSent = res.ok ? payload : null;
  } catch {
    repoStateSent = null;
  }
}

/**
 * WHAT IS IN THIS BOX'S ENVIRONMENT, BY NAME (2026-09-21) — the one readout the
 * deleted secrets vault was genuinely wanted for.
 *
 * The owner, on the vault: *"no i dont want it. unless its needed where i want
 * to show the env of each of the machines (for comparison)."* So the custody
 * went and the comparison stayed, rebuilt as a plain report: for each `.env*`
 * file in the CHECKOUT ROOT, the variable NAMES and an 8-hex VALUE FINGERPRINT.
 * **The value never leaves the box.** Two machines holding the same fingerprint
 * for `DATABASE_URL` agree; two different fingerprints is the whole answer to
 * "why does it work over there", and neither requires Flowviant to hold a
 * secret, seal a key, or own a recovery code.
 *
 * ONE POST PER BOX PER CHANGE. The report is hashed and compared against the
 * last one the server ACCEPTED, so a box whose env is stable posts exactly once
 * per daemon and then never again — the same economy `maybeReportRepoState`
 * keeps next door, and for the same reason: an env file is not PRESENCE, so
 * re-posting an unchanged list would be a write per machine per minute to say
 * nothing.
 *
 * A PERMANENT 4xx IS TREATED AS DELIVERED, which is the `/fleet/agent-trace`
 * precedent stated there: an older SERVER 404s every batch, and a daemon that
 * held them would keep re-posting a body nobody will ever read. Which statuses
 * count as permanent is `envReportIsPermanent`, and it is a SHORT list for the
 * reason stated there; everything else forgets the dedup so the next beat tries
 * again.
 *
 * THE TOTALS RIDE BESIDE THE CAPPED LIST (2026-09-21, the review). The report
 * is bounded at eight files and two hundred variables, and a list silently cut
 * at a cap reads as the whole directory — so `filesTotal` and `varsTotal` (the
 * numbers BEFORE the caps) go on the wire beside it and the app can say "N more
 * not shown". Same rule `repoState` already keeps for branches and worktrees.
 * Both are optional on the server, so an older server parsing only `files` is
 * unaffected and needs no floor.
 *
 * NO VERSION FLOOR, and none is possible to need: it is a daemon→server report
 * on a NEW endpoint, so an older server answers 404 once and is never asked
 * again, and an older daemon simply never posts. The report's presence IS the
 * capability.
 *
 * IT ALSO FEEDS THE SCRUBBER, on every scan and whether or not anything is
 * posted (`scanEnvForScrub`). That is the half that must not be skipped: with
 * the vault gone these files are what `scrub()` redacts out of turn streams,
 * tool events, traces and deploy logs, and the dedup above is about the WIRE,
 * never about what this box knows to hide.
 */
/**
 * WHICH REFUSAL IS FINAL — pure, exported, and deliberately a SHORT list
 * (2026-09-21, the review).
 *
 * The first cut treated EVERY 4xx as permanent, which quietly turned one bad
 * minute into a dead lane for the life of the process. A 429 is a rate limit
 * and says "later", not "never". A 401 or 403 during a credential blip — a
 * rotation, a clock skew, a roster the box is momentarily not the holder of —
 * is transient by construction. A 408 is a timeout wearing a 4xx. Every one of
 * those stopped env reporting until somebody restarted the daemon, with NO
 * sign anywhere that it had stopped: the report is deduped and silent by
 * design, so "posted once and never again" is indistinguishable from "working
 * normally on a box whose env has not changed". A lane that can die invisibly
 * must not die for a reason that will pass.
 *
 * So permanent means exactly three things, and each of them is a fact about
 * the REQUEST rather than about the moment: 404, the route does not exist (an
 * older server — the `/fleet/agent-trace` precedent this lane is built on);
 * 400 and 422, the server will never accept this shape. Retrying any of those
 * forever is the daemon arguing with a decision already made.
 *
 * Pure and exported so the decision can be proved without a credential, a
 * server or a poll — the same shape `shouldStop` and `createHolderWatch` keep
 * in holder.mjs.
 */
export function envReportIsPermanent(status) {
  return status === 400 || status === 404 || status === 422;
}

const ENV_REPORT_URL = fleetEndpoint('env-report', FLEET_URL);
const ENV_REPORT_SCAN_MS = 60_000;
let envReportUnsupported = false; // the server refused permanently — quiet until restart
let envReportScanAt = 0;
let envReportSent = null; // the last report the server ACCEPTED, stringified
/**
 * Returns a one-word VERDICT — 'throttled' | 'scan-failed' | 'quiet' |
 * 'deduped' | 'accepted' | 'retry' | 'stopped'. The daemon ignores it (the
 * caller is a bare `void`); it exists so the lane's decisions can be driven
 * against a real HTTP server in a test rather than pinned as source text. A
 * readout whose only proof is that its source LOOKS right is the inert-pin
 * class this repo has caught five times.
 */
export async function maybeReportEnv(repoRoot) {
  if (Date.now() - envReportScanAt < ENV_REPORT_SCAN_MS) return 'throttled';
  envReportScanAt = Date.now();
  let report;
  try {
    // The SCAN happens even when the POST cannot — see the docblock: the
    // scrubber has no dedup and must reflect the newest read every time.
    report = scanEnvForScrub(repoRoot);
  } catch {
    return 'scan-failed'; // a readout must never throw into the poll loop
  }
  if (envReportUnsupported) return 'quiet';
  const payload = JSON.stringify({
    pubkey: myPubB64(),
    files: report.files,
    filesTotal: report.filesTotal,
    varsTotal: report.varsTotal,
  });
  if (payload === envReportSent) return 'deduped';
  try {
    const res = await fetch(ENV_REPORT_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${FLEET_TOKEN}`,
        'User-Agent': USER_AGENT,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(15_000),
      body: payload,
    });
    // Only a refusal that cannot change stops the lane — see
    // `envReportIsPermanent`. A 429 or a 401 during a credential blip is a
    // "later", and treating it as a "never" killed env reporting for the life
    // of the process with nothing anywhere saying so.
    if (envReportIsPermanent(res.status)) {
      envReportUnsupported = true;
      return 'stopped';
    }
    // Only an ACCEPTED report counts, the rule `maybeReportRepoState` keeps:
    // anything else forgets it so the next pass retries rather than
    // dedup-suppressing a report nobody received.
    envReportSent = res.ok ? payload : null;
    return res.ok ? 'accepted' : 'retry';
  } catch {
    envReportSent = null;
    return 'retry';
  }
}

const TOOLS_REPORT_URL = fleetEndpoint('tools-report', FLEET_URL);
let toolsReportSent = null;
let toolsReportUnsupported = false;
let toolsReportAt = 0;
/** Repo tool readiness is a per-box daemon report. Never include env values. */
export async function maybeReportTools(repoRoot, baseRef) {
  if (Date.now() - toolsReportAt < 60_000) return;
  toolsReportAt = Date.now();
  if (toolsReportUnsupported) return;
  const pubkey = myPubB64();
  if (!pubkey) return;
  let payload;
  try {
    const snapshot = readBaseTools(repoRoot, baseRef);
    const installed = detectRuntimes().filter((r) => r.installed);
    const runner = installed.find((r) => runnerToolCapabilities(r.id).mcp)?.id ?? installed[0]?.id ?? 'none';
    payload = JSON.stringify({ pubkey, tools: toolReadout(snapshot, runner) });
  } catch { return; }
  if (payload === toolsReportSent) return;
  try {
    const res = await fetch(TOOLS_REPORT_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${FLEET_TOKEN}`, 'User-Agent': USER_AGENT, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(15_000), body: payload,
    });
    if (envReportIsPermanent(res.status)) toolsReportUnsupported = true;
    toolsReportSent = res.ok ? payload : null;
  } catch { toolsReportSent = null; }
}

/**
 * "THE REPO JUST CHANGED — look again." Clears the repo-state throttle so the
 * next reconcile rescans on the beat it already runs; the work manager calls
 * it (through fleet.mjs's `onRepoChanged`) after a ship, a retirement or a cut.
 */
export function repoStateChanged() {
  repoStateScanAt = 0;
}

const MACHINE_URL = fleetEndpoint('machine', FLEET_URL);

/**
 * Machine telemetry — what the box is doing with itself, for the admin view.
 * `liveTurns` is the work manager's live registry, passed in by the loop.
 */
export function reportMachine({ worktreeDir, liveTurns }) {
  // Tell the app what this machine is doing with itself. Every reconcile,
  // best-effort, and never awaited — telemetry that can delay a dispatch is
  // worse than no telemetry.
  //
  // The one thing Flowviant could never answer about a task was "why is it
  // slow", because the box was somebody's laptop and only they could look at
  // it. Centralising is supposed to make one machine easier to manage than N
  // laptops; that is only true if the machine is visible. Per-task RSS is the
  // load-bearing part — "the box is full" is not actionable, "this task is
  // holding 9GB" is.
  //
  // …AND IT HAD NEVER BEEN POPULATED ONCE (fixed 2026-09-14). This read the
  // dispatch-era `workers` map, which nothing has `.set()` since the lane was
  // deleted on 2026-08-19 — so the list was permanently empty, the server
  // stored an empty array every poll, and the column its own handler calls
  // the load-bearing half of this report was blank on every machine that has
  // ever run. The same shape as the env rotation two blocks up, which
  // iterated the same dead map and reached no worktree at all.
  //
  // `liveTurns()` is the live registry: every CLI child this daemon is
  // holding, with the session or agent id it serves. Bounded inside the
  // snapshot, because each row costs a /proc tree walk.
  void postToFleet(
    MACHINE_URL,
    machineSnapshot({
      worktreeDir,
      tasks: liveTurns().map((t) => ({ intentId: t.id, pid: t.pid })),
    })
  );
}
