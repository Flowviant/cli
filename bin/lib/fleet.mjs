/**
 * Fleet daemon. Install ONCE with a fleet credential; manage everything from
 * Flowviant. The daemon polls GET /api/fleet/agents, reconciles one persistent
 * git worktree + worker loop per roster agent, rotates each worker's short-lived
 * MCP token, and only spawns Claude when the server says an agent has work.
 */

import {
  mkdirSync,
  existsSync,
  rmSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';
import {
  VERSION,
  FLEET_URL,
  FLEET_TOKEN,
  USER_AGENT,
  MCP_URL,
  SAFE,
  DAEMON_INSTANCE,
  MACHINE_HOST,
  PROCESS_STARTED_AT,
  POLL_SECONDS,
  MAX_CONCURRENT,
  IDLE_SECONDS,
  RECONCILE_SECONDS,
  REFRESH_BEFORE_SECONDS,
  LIVE,
  AUTO_UPDATE,
  CREDENTIAL,
  learnProjectId,
  storedCredentialInUse,
} from './config.mjs';
import { projectLabel, safeName, setStoredProjectName } from './credentials.mjs';
import { credentialRejected } from './authReject.mjs';
import { handleVersionSignal } from './update.mjs';
import {
  git,
  gitNetAsync,
  resetWorktree,
  repoRootOrDie,
  detectBaseRef,
  originSlug,
  baseBranchName,
  isValidPrUrl,
  isValidBranch,
  isSafePathSegment,
  excludeInWorktree,
} from './git.mjs';
import { c, info, note, ok, warn, fail } from './ui.mjs';
import { revertPatch, withPatchLock } from './patch.mjs';
import {
  sleep,
  mcpFor,
  runTurn,
  sawSentinel,
  blockedId,
  SYSTEM_WIKI,
  WIKI_KICKOFF,
  SYSTEM_REGROUND,
  REGROUND_KICKOFF,
} from './claude.mjs';
import { reapOrphanPreviews } from './preview.mjs';
import { acquireInstanceLock } from './instance.mjs';
import { preflight } from './preflight.mjs';
import { connectStream } from './stream.mjs';
import { ensureVault, syncVault } from './vault.mjs';
import { envQueryParams, myPubB64, scanEnvForScrub, scrub as envScrub } from './env.mjs';
import { sweepVaultArtefactsOnce } from './vaultArtefacts.mjs';
import { processDeployJobs, reportDeployConfig } from './deploy.mjs';
import { machineSnapshot } from './resources.mjs';
import {
  detectRuntimes,
  knownMcpServers,
  knownSkills,
  pickRuntimeFor,
  probeSkillsOnce,
  recordMcpServers,
  recordSkills,
  RUNTIMES,
  THINK_MARKER,
} from './runtimes.mjs';
import { createWorkManager } from './work.mjs';
import { createKnowledgeSync, knowledgeFetcher, FLOWVIANT_OWN_PATHS } from './knowledge.mjs';
import { effectiveMaxTurns, setServerMaxTurns } from './admission.mjs';
import { scanLocalSessions, ourConversationIds } from './localSessions.mjs';
import { repoState } from './repoState.mjs';
import { claudeAuthContext } from './claudeAuth.mjs';
import { readBaseTools, runnerToolCapabilities, toolReadout } from './projectTools.mjs';

/** Said once per process — see the catch around `envQueryParams` below. */
let warnedEnvIdentity = false;

/**
 * HAS THIS PROCESS ALREADY ASKED FOR THE MACHINE? (0.91.0)
 *
 * The owner's ruling on two boxes running one project: "it should kill the
 * first one and take over". So a daemon asks on the FIRST poll of its life and
 * never again, and this pair is the whole of that "never again".
 *
 * ONE ASK PER PROCESS IS THE SAFETY, NOT A POLITENESS. A param that kept asking
 * would be two boxes trading a machine back and forth every ten seconds. Asked
 * once, the story ends at the first exchange, because the box that loses
 * SETTLES ITS TURNS AND EXITS rather than restarting — and a process that has
 * exited sends no more first polls.
 *
 * THAT LAST SENTENCE IS TRUE OF THE PROCESS AND NOT OF THE UNIT, which is why
 * the server stopped relying on it (2026-09-19). Under `Restart=always`, pm2 or
 * docker, exit 0 is a relaunch and the relaunch's first poll is a genuine one.
 * `takeMachineHolderNow` refuses a take by the box it just displaced for the
 * length of the displaced window, so the ping-pong is bounded on the side that
 * can see both boxes. This module still keeps its half of the bargain.
 *
 * SPENT ON A DELIVERED POLL, NOT ON AN ATTEMPTED ONE, which is why this is two
 * functions instead of one consuming read. A daemon that starts while the wire
 * is down retries every ten seconds; spending the ask on the failed attempt
 * would mean the box you walked over to and started never takes the machine,
 * and nothing anywhere would say why.
 *
 * IT IS NOT THE DELETED FLAG COMING BACK. There is still nothing to type: the
 * terminal surface is `npx flowviant` and `npx flowviant login`, and what
 * claims here is starting the daemon, which is already one of those two.
 *
 * Exported so both properties can be proved without a server, a credential or a
 * second box — they are the contract, and nothing else in the file states them.
 */
/**
 * AND A RESTART IS NOT A PERSON (2026-09-19, the review).
 *
 * `update.mjs` re-execs the daemon with `FLOWVIANT_REEXEC='1'` after an
 * UNATTENDED auto-update, which is on by default. Born `false`, the new process
 * would then spend a fresh ask and TAKE THE PROJECT'S MACHINE — so a standby
 * sitting quietly on somebody's second computer would seize the machine off the
 * live holder in the middle of the night, settling its running turns as moved,
 * because npm published a patch. Nobody was at either keyboard, and nothing on
 * any surface would say why.
 *
 * The ask belongs to the GESTURE, not to the process: what claims a machine is
 * a person typing `npx flowviant`, and a re-exec is the same start continuing.
 * So a re-executed daemon is born with the ask already spent and behaves
 * exactly as it did before the update — it keeps the machine if it had it (arm
 * (a) stamps it), and stands by if it did not.
 */
let machineAskSpent = process.env.FLOWVIANT_REEXEC === '1';
export function machineAskPending() {
  return !machineAskSpent;
}
export function spendMachineAsk() {
  machineAskSpent = true;
}

async function fetchRoster(
  haveIds,
  livePreviewSessionIds = [],
  heldSessionIds = [],
  /** The churn ADMISSION verdict, taken by the caller from the same `admit`
   *  every unattended lane asks — see the `pr` param below for why it is the
   *  admission and not the pressure reading alone. Undefined where the caller
   *  has no admission to offer, which reads exactly like an older daemon. */
  churnHold = undefined,
  /** The checkout this daemon serves, for the `cp` report below. Passed in
   *  rather than re-derived: `repoRootOrDie` is resolved once at startup and
   *  running git on every poll to re-learn a constant would be a syscall for
   *  a readout. */
  repoRoot = null
) {
  const url = new URL(FLEET_URL);
  if (haveIds.length) url.searchParams.set('have', haveIds.join(','));
  // What this machine will run at once. The server grows lanes to meet waiting
  // work beneath this, instead of the user pre-sizing a pool by hand — only the
  // machine knows its cores, its RAM and whose Claude quota is being spent.
  // Older servers ignore the param, so sending it is always safe.
  url.searchParams.set('capacity', String(MAX_CONCURRENT));
  // WHICH DAEMON this machine runs, so the server can gate version-dependent
  // work — codex Workbench tabs are only created for machines whose daemon can
  // actually serve them (dv >= 0.46.0). The same source the self-update check
  // compares against the roster's daemon.latest (config.mjs VERSION, read off
  // our own package.json). Older servers ignore unknown params, so sending it
  // unconditionally is always safe.
  url.searchParams.set('dv', VERSION);
  // The permission posture this machine runs turns under — '1' when
  // FLOWVIANT_SAFE narrows the toolset, '0' when everything is granted. A
  // statement of configuration, not a request: the app SHOWS it in Settings
  // so a team can see whether the shared box runs wide open, and enforces
  // nothing (membership is the consent boundary). Older servers ignore it.
  url.searchParams.set('safe', SAFE ? '1' : '0');
  // WHICH PROCESS, so the server can lease preview work to exactly one of two
  // daemons on one credential. Older servers ignore unknown params.
  url.searchParams.set('di', DAEMON_INSTANCE);
  // WHICH BOX, by name, so the app can say "your machine is mac-mini" instead
  // of naming a public key. Display only: arbitration is keyed on `envpub`,
  // which is durable per box, while a hostname is neither unique nor stable.
  // Absent when the host has no readable name — an older daemon looks the same,
  // and both mean "nobody said", which is what the nameless fallback renders.
  if (MACHINE_HOST) url.searchParams.set('mh', MACHINE_HOST);
  /**
   * WHICH CHECKOUT, WHICH PROCESS, AND SINCE WHEN (0.91.0) — the three facts
   * that turn "a box polled" into a row somebody can act on.
   *
   * The owner could not answer a plain question about his own machines: "im not
   * sure if i have any duplicate or redundant daemons running". The hostname
   * alone cannot answer it either, because ONE box legitimately runs several
   * daemons — "i can have 1 daemon in one directory, 1 in another as a
   * differentiator of projects" — so `cp` is what makes two rows on one box
   * legible, and `pid` + `st` are what let somebody standing at that box find
   * the process and tell a long-lived daemon from one that has restarted nine
   * times since they last looked.
   *
   * DAEMON→SERVER REPORTS, so no floor: an older daemon sends none of these and
   * the server stores null, which reads as "it did not say" rather than as a
   * box with no checkout. Bounded here as well as at the boundary — a query
   * string is not a log, and this one is rendered into a terminal.
   */
  if (repoRoot) url.searchParams.set('cp', String(repoRoot).slice(0, 256));
  url.searchParams.set('pid', String(process.pid));
  url.searchParams.set('st', PROCESS_STARTED_AT);
  /**
   * THE FIRST POLL OF THIS PROCESS ASKS FOR THE MACHINE (`claim`, 0.91.0).
   *
   * The owner, on two boxes running one project: "it should kill the first one
   * and take over." Starting the daemon on the computer in front of you IS the
   * gesture — there is no flag, no env var and no third command, so the ruling
   * that deleted the old machine-moving flag ("i dont intend to run or do
   * anything in the terminal besides npx flowviant or npx flowviant login")
   * stands untouched.
   *
   * SENT ONCE PER PROCESS, and that is the safety rather than a politeness: see
   * `askForMachineOnce`. The server takes holdership there and then, the box it
   * displaces learns through the existing named-and-windowed `displaced` signal
   * and exits 0, and nothing restarts to ask again.
   *
   * AN OLDER SERVER IGNORES IT and the old standby behaviour stands, which is
   * why this needs no floor of its own — the server applies one (it will not
   * take a machine from a box too old to be told it lost it).
   */
  if (machineAskPending()) url.searchParams.set('claim', '1');
  // A poll reports what this box IS. Moving the project's machine onto it, when
  // this process has already spent its one ask above, is a gesture a person
  // makes in the app — and the daemon learns that outcome on its next poll like
  // every other holder fact.
  // Which shares this machine is still serving. It rides the poll rather than
  // taking an endpoint of its own: one beat, no floor, and the stale window is
  // the reconcile interval instead of minutes — which matters, because a share
  // the server still calls live is a 530 on somebody's phone. Always set, even
  // empty: '' means "serving none", absent would mean "an older daemon".
  url.searchParams.set('pv', livePreviewSessionIds.join(','));
  // The sessions this daemon holds a worktree for. Its LEASE on each renews
  // here — one beat, no extra endpoint, and the server can tell "this daemon is
  // still serving that tab" from "it went away" within a reconcile interval
  // instead of minutes. Always set, even empty: '' means "holding none".
  url.searchParams.set('ws', heldSessionIds.join(','));
  // WHICH CLIs this machine actually has, so the app can stop guessing.
  //
  // Until now every surface that listed Gemini or Codex said "not wired up yet"
  // and meant it literally: nothing had ever looked. That was the honest answer
  // while it was true, and it stops being honest the moment a second runtime can
  // run — an app that cannot tell "Codex is not installed" from "we never
  // checked" will confidently tell you the wrong one.
  //
  // A statement about this MACHINE and nothing else: no account, no quota, no
  // entitlement. Detection is cached after the first poll (one version probe per
  // CLI), so this costs a query param thereafter. Older servers ignore an
  // unknown param, so sending it is always safe.
  try {
    const drivable = detectRuntimes()
      .filter((r) => r.dispatchable)
      .map((r) => r.id);
    if (drivable.length) url.searchParams.set('runtimes', drivable.join(','));
  } catch {
    /* detection is best-effort — a probe must never fail the poll */
  }
  // WHAT THE CLI CAN BE ASKED FOR BY NAME, so the composer can autocomplete a
  // `/` the way the terminal does. Learned from the init event of a turn we
  // already ran (runtimes.mjs) — never probed, because spawning a CLI to fill a
  // dropdown would spend the operator's quota on an affordance.
  //
  // NOT SENT until a turn has taught us: absent means "no turn has run here
  // yet", and the app renders no menu rather than asserting this machine has no
  // skills. An empty report, though, IS a fact and is sent as such — hence the
  // null check rather than a truthiness check on the array.
  try {
    const skills = knownSkills();
    if (skills !== null) url.searchParams.set('skills', skills.join(','));
  } catch {
    /* best-effort — the poll must never fail on a readout */
  }
  // WHICH MCP SERVERS AND CONNECTORS THE CLI MOUNTED, AND HOW EACH STANDS
  // (0.97.0) — `[{n, s}]`, learned off the same init event as the skills, this
  // daemon's own `flowviant` server excluded AND every `connected` one with it:
  // only what needs something leaves the box (runtimes.mjs, recordMcpServers —
  // a teammate has no business reading which services the operator signed
  // into). The same three states: NOT SENT
  // until a turn (or the one probe) has taught us, `[]` sent as the fact it is.
  // The app names every server that is not connected — a connector that needs
  // a sign-in AT THIS BOX above all — under the serving machine's row. A
  // daemon→server report: an older server ignores the unknown param.
  try {
    const mcp = knownMcpServers();
    if (mcp !== null) url.searchParams.set('mcp', JSON.stringify(mcp));
  } catch {
    /* best-effort — the poll must never fail on a readout */
  }
  // THIS BOX'S IDENTITY — `envpub`, and since 2026-09-21 nothing else.
  //
  // It carried two more params while the secrets vault existed: `envv` (the
  // materialized bundle version) and `envskip` (the target files the
  // materializer refused to write, where the EMPTY STRING was a real report and
  // a truthiness filter here silently dropped it). Both died with the vault and
  // the server no longer reads either, so the loop's `!= null` has nothing left
  // to defend — it stays anyway, because it is the correct general shape for
  // forwarding a param map and re-deriving that lesson is how it was lost the
  // first time.
  //
  // `envpub` ITSELF IS UNCHANGED: same key, same base64, same keypair file. A
  // box upgrading into this release must stay the SAME box to holdership
  // arbitration and to the machine registry.
  try {
    for (const [k, v] of Object.entries(await envQueryParams())) {
      if (v != null) url.searchParams.set(k, v);
    }
  } catch (e) {
    /* env identity is best-effort — the poll must never fail on it */
    /**
     * …BUT IT IS NOT SILENT, because since 2026-09-14 losing it costs
     * something visible. `envpub` is how the server tells two computers apart,
     * so a poll without one is EXEMPT from arbitration — it is served in full,
     * which is right — and nothing stamps `holder_heard_at`, which is the
     * column presence is now read from. The app therefore says the machine is
     * offline while this daemon is sitting here answering turns, and before
     * this line the only evidence anywhere was a keypair file nobody looks at.
     *
     * Once per process: it is the same failure on every poll, and a reason
     * repeated every few seconds is a reason nobody reads.
     */
    if (!warnedEnvIdentity) {
      warnedEnvIdentity = true;
      console.warn(
        `[flowviant] could not read ${'~/.flowviant/env-keypair.json'} (${e?.message ?? e}).\n` +
          '  This machine cannot identify itself, so the app may show it as offline while it works.\n' +
          '  It has NOT been replaced — that file is what the project secrets are sealed to.'
      );
    }
  }
  /**
   * WHY THIS MACHINE IS NOT TAKING NEW WORK, in its own measured words.
   *
   * Three states, and the third is why this is a param and not a header:
   *   · a reason  — the churn ADMISSION refused; new unattended work is being
   *                 deferred, and the board can say so AT the agent that is
   *                 waiting instead of leaving it looking like a slow model.
   *   · `-`       — asked, and nothing is holding anything back. A POSITIVE
   *                 fact, which is what lets the server clear a stale reason
   *                 rather than letting one sit there being true-looking
   *                 forever.
   *   · absent    — an older daemon, or a poll with no admission to ask. The
   *                 reserved meaning, and the reason nothing is sent in that
   *                 case: silence must not be readable as "fine".
   *
   * `FLOWVIANT_NO_PRESSURE_GUARD` no longer silences the param, and should not:
   * it turns off the MEMORY AND LOAD half, and the concurrency half it does not
   * touch is still a true account of why nothing is starting. What the operator
   * asked for is a box that is not second-guessed about its own memory, not an
   * agent that sits still with no explanation.
   *
   * IT IS THE WHOLE ADMISSION, AND IT USED TO BE THE PRESSURE HALF ONLY. The
   * argument for narrowing it was that "four turns are running" is a capacity
   * statement — but the effect was worse than the thing it avoided: a machine
   * refusing every agent turn at its ceiling sent `pr=-`, which says MEASURED
   * AND FINE, so the server cleared any stored reason and the board fell
   * through to "nothing has polled this turn for 12m" over a daemon that was
   * polling every ten seconds and declining on purpose. The machine positively
   * asserted health at the one moment it was refusing.
   *
   * And CLAUDE.md already carves this exact shape out: queueing is said "AT THE
   * THING THAT IS WAITING, in the moment, never budgeted for in advance on a
   * global chip". The relayed sentence is `admission.mjs`'s, and it names
   * ACTIVITY — "the machine is already running 3 CLI turns" — never the
   * ceiling, never headroom, and never anywhere but on the row that is stalled.
   * That is the same shape as a CLI relaying that it hit its own limit.
   *
   * `URLSearchParams` does its own encoding; the slice is the belt against a
   * pathological reason.
   */
  try {
    if (churnHold !== undefined) {
      url.searchParams.set('pr', churnHold ? String(churnHold.reason).slice(0, 160) : '-');
      /**
       * …AND THE BOUND THE REFUSAL IS ABOUT (2026-09-17, `mt`).
       *
       * THIS AMENDS THE PARAGRAPH DIRECTLY ABOVE, which says the relayed
       * sentence "names ACTIVITY … never the ceiling, never headroom". That
       * rule was written to stop a capacity meter, and it succeeded so
       * completely that a machine which could only ever run ONE turn had no way
       * to say so — the owner, verbatim: "we should have ui indicating this on
       * the board view and a ui indicating or showing the agent as waiting or
       * queued as a result of that resource constraint. thats why i was
       * immediately confused. theres nothing telling me that i could only have
       * one agent on the board."
       *
       * So the ceiling crosses the wire, and the narrow shape that survives is
       * the same carve-out the sentence beside it already lives under: it is
       * shown in SETTINGS (beside the dial that sets it — a control with no
       * readout is not a control) and on the BOARD only while a real agent is
       * actually being deferred. Never a resting chip, and never headroom:
       * nothing anywhere subtracts this from the live count to advertise room.
       *
       * It rides the `pr` gate deliberately — this is the bound that admission
       * measured against, so a poll with no admission to ask has no effective
       * ceiling to report either, and absence keeps meaning "an older daemon".
       * `capacity` above is the DERIVED number and predates the dial; it is a
       * dispatch-era fossil the server ignores, and the two are not the same
       * fact.
       */
      url.searchParams.set('mt', String(effectiveMaxTurns()));
    }
  } catch {
    /* a readout — the poll must never fail on one */
  }
  // An explicit User-Agent is required: Node's default ("node"/empty) trips
  // Cloudflare Bot Fight Mode (403). A descriptive product UA passes.
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${FLEET_TOKEN}`, 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(30_000), // a black-holed poll must not stall the loop
  });
  if (res.status === 401 || res.status === 403) {
    // Revoked or expired — retrying can't recover, so signal exit. But ONLY on
    // the API's own refusal: an edge 403 (Cloudflare's bot checks, which this
    // very client class trips) is a retryable failure, and exiting on one took
    // a machine offline for good over a credential that was still valid.
    if (await credentialRejected(res)) {
      const e = new Error(`fleet credential rejected (${res.status})`);
      e.auth = true;
      throw e;
    }
    throw new Error(`fleet poll refused by something in front of the API (${res.status})`);
  }
  if (!res.ok) throw new Error(`fleet poll failed (${res.status})`);
  // THE ASK IS SPENT HERE AND NOWHERE ELSE — on a poll the server actually
  // answered. Spending it where the param is SET would lose the claim of a
  // daemon that started while the wire was down: it would retry, silently
  // without `claim`, and the box somebody walked over to and started would
  // never take the machine.
  spendMachineAsk();
  const body = await res.json();
  // Validate the shape here so a malformed 200 (deploy hiccup, error envelope)
  // throws a NORMAL retryable error inside the loop's try/catch, instead of a
  // `roster.agents.map` TypeError escaping to top-level and killing the daemon.
  const data = body?.data;
  if (!data || !Array.isArray(data.agents)) {
    throw new Error('fleet poll returned an unexpected shape');
  }
  // Drop roster agents with an unsafe id BEFORE they're used as a path segment.
  data.agents = data.agents.filter((a) => {
    if (isSafePathSegment(a?.agentId)) return true;
    warn(`ignoring roster agent with an invalid id: ${JSON.stringify(a?.agentId)}`);
    return false;
  });
  return data; // { mcpUrl, leaseTtlSeconds, agents: [{agentId,name,token,reviewGate,hasWork}] }
}

const RUN_DIFFSTAT_URL = FLEET_URL.replace(/\/agents\/?$/, '/run-diffstat');

/**
 * Post what a run has changed, every 20s, until the returned stop() is called.
 *
 * Daemon-side rather than an MCP tool the agent calls: the agent forgets, each
 * call costs tokens, and anything the agent reports about itself is downstream
 * of whatever it is currently reading. The daemon owns the worktree, so it can
 * just look.
 *
 * Posts when the numbers MOVED, and otherwise once every couple of minutes to
 * say the worktree is still being watched. Both halves are needed. Writing the
 * same row every 20s would make a wedged turn look busy; never re-writing it
 * makes a HEALTHY run look dead, because the reader treats a sample it has not
 * seen refreshed in three minutes as a daemon that stopped — and an agent that
 * finishes editing and then spends fifteen minutes running the test suite
 * produces exactly the same silence as one that died. REFRESH_MS sits well
 * inside that window so an idle-but-live worktree keeps its panel.
 */
const DIFFSTAT_REFRESH_MS = 120_000;


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
const LOCAL_SESSIONS_URL = FLEET_URL.replace(/\/agents\/?$/, '/local-sessions');
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
async function maybeReportLocalSessions({ repoRoot, excludeDirs, excludeIds }) {
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
const REPO_STATE_URL = FLEET_URL.replace(/\/agents\/?$/, '/repo-state');
const REPO_STATE_SCAN_MS = 60_000;
let repoStateUnsupported = false; // the server 404'd — quiet until restart
let repoStateScanAt = 0;
let repoStateSent = null; // last payload the server ACCEPTED, stringified
async function maybeReportRepoState({ repoRoot, baseRef }) {
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
 * below.
 */
export function envReportIsPermanent(status) {
  return status === 400 || status === 404 || status === 422;
}

const ENV_REPORT_URL = FLEET_URL.replace(/\/agents\/?$/, '/env-report');
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

const TOOLS_REPORT_URL = FLEET_URL.replace(/\/agents\/?$/, '/tools-report');
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
 * A STOP COMMANDED BY FLOWVIANT, read off the roster poll.
 *
 * The daemon is a PULL client — the /fleet/stream socket is a one-way wake
 * nudge with no server→daemon request path — so "stop this machine" can never
 * be a request the server makes of us. It rides the roster RESPONSE instead, on
 * the same `daemon` object the version signal already travels on, which is why
 * it needs no new endpoint and no version floor: an older daemon reads an
 * unknown key as nothing and keeps running, and fail-open is the safe direction
 * for a switch whose failure mode is "your machine went dark".
 *
 * The server decides whether a stop is LIVE — it stamps the credential and only
 * sends the key inside a short honor window — and the daemon does NOT re-derive
 * that. The key's PRESENCE is the command. Evaluating the same TTL on both
 * sides would make clock skew the arbiter of whether a machine may run, and get
 * it wrong in the direction that bricks the box: a relaunch that re-reads an
 * old timestamp and stops itself again, forever.
 *
 * Pure and exported so the decision can be proved without a credential or a
 * live server. `null` means keep running.
 */
export function shouldStop(rosterDaemon) {
  const stop = rosterDaemon?.stop;
  // An OBJECT, and not an array: `typeof [] === 'object'`, so the plain typeof
  // guard let `stop: []` — an empty list, which is how this codebase spells "no
  // jobs" on every other roster key — read as a live stop with no reason. A
  // switch that kills a machine gets the narrow test.
  if (!stop || typeof stop !== 'object' || Array.isArray(stop)) return null;
  // Re-sanitized HERE even though the server wrote it: this string is operator
  // prose typed into a SQL UPDATE and then printed straight to a terminal, so
  // control bytes would let a stop reason repaint the console it is being read
  // on, and an unbounded one would bury the line that matters. The WORDING is
  // untouched — the operator's own sentence is the whole point of the field,
  // and paraphrasing it would leave the person at the keyboard guessing.
  const reason = String(stop.reason ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
  return { stop: true, reason };
}

/**
 * HOW LONG AGO, in the words the standby sentence needs. Milliseconds in, one
 * short label out; anything that is not a finite, non-negative number renders
 * NOTHING and the caller drops the clause rather than printing "heard NaN ago".
 * The three-state rule applied to a duration: measured, or say nothing.
 */
export function agoLabel(ms) {
  // `typeof`, not `Number()`: `Number(null)` is 0, so a coercing guard turns
  // "the server said nothing" into "heard 0s ago" — a measurement nobody took,
  // printed at the one moment the person is deciding whether to wait.
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return null;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

/**
 * WHOSE MACHINE THIS IS — read off the roster, said once, and never a refusal.
 *
 * A project has ONE machine credential and `device/approve` hands every device
 * the same raw token, so two boxes running `npx flowviant` are two daemons that
 * both believe they are the machine. The old behaviour was a silent race: the
 * loser could not see the winner at all, and the moment the winner went quiet
 * long enough for a lease to lapse it cut a FRESH branch for an agent whose work
 * exists only on the other box's disk, then ran a CLI with no conversation
 * behind it. A confident, context-free redo of work somebody was mid-way
 * through.
 *
 * The server arbitrates (it is the only party that can see both boxes) and the
 * answer rides the poll RESPONSE as `holder`. This turns that answer into what
 * the person at the keyboard needs to know, and nothing more:
 *
 *   · ABSENT        -> this server does not arbitrate machines. Behave exactly
 *                      as every daemon before 0.84.0 did — zero new paths.
 *   · mine: true    -> we are the machine. Announce it only if we have been
 *                      inactive, so an ordinary daemon prints nothing new.
 *   · mine: false   -> GO INACTIVE. Keep polling quietly; the restricted roster
 *                      serves us nothing, the auto-handover makes this box the
 *                      machine when the holder dies, and the app is where a
 *                      person moves it sooner. Never exit: an inactive box that
 *                      quits is one somebody has to go and restart by hand.
 *
 * THE WORD A PERSON READS IS `inactive` (2026-09-21) — the owner replaced
 * "standing by" outright: *"no, it can [be] inactive instead"*. The server's
 * role enum says `inactive`, `flowviant machines` prints it, and so do the two
 * sentences below. The STATE NAME returned here is still `'standby'`, and that
 * is deliberate: it names the server's arbitration arm, it is what every gate
 * in this file branches on, and renaming an identifier to match a copy change
 * is how a rename becomes a behaviour change nobody reviewed.
 *
 * Printed ONCE PER DISTINCT HOLDER rather than per poll — a true sentence
 * restated every ten seconds is a scrolling console nobody reads, and the fact
 * only CHANGES when the holder does.
 *
 * Pure except for the injected `say`, so the whole decision can be proved
 * without a credential, a server or a second box.
 */
export function createHolderWatch({ say = () => {} } = {}) {
  let standbyKey = null; // the holder we last announced, or null while we serve
  return {
    /** Returns 'absent' | 'mine' | 'standby' — the state, for the caller's
     *  own gating and for tests that must not read the console. */
    observe(holder) {
      if (!holder || typeof holder !== 'object' || Array.isArray(holder)) {
        // An older server, or a poll it did not arbitrate. Silence, and not one
        // new path: this is the 0.83.0 daemon.
        return 'absent';
      }
      if (holder.mine === true) {
        /**
         * WE TOOK IT, AND THE SERVER SAID SO (0.91.0).
         *
         * Sent on the one poll that moved holdership and never again, so this
         * is news by construction — no key to remember, no window to judge.
         * RELAYED AND NEVER DERIVED: the box we displaced is named because the
         * server named it, and an unnamed one gets the nameless fallback the
         * rest of this file uses rather than a guess. The turns clause DROPS
         * WHOLE when the count is absent — "0 turns were running" is a
         * measurement nobody took, printed at the one moment somebody is
         * deciding whether they have just interrupted their own work.
         */
        const took = holder.took;
        if (took && typeof took === 'object' && !Array.isArray(took)) {
          standbyKey = null;
          // scrubbed before it reaches a terminal (2026-09-24, the audit) —
          // see printable.mjs.
          const from = safeName(took.from)?.slice(0, 64) ?? 'another machine';
          const turns = Number.isInteger(took.turns) && took.turns > 0 ? took.turns : null;
          say(
            `took this project's machine from ${from}` +
              (turns
                ? ` — ${turns} turn${turns === 1 ? '' : 's'} ${turns === 1 ? 'was' : 'were'} running there and ${turns === 1 ? 'was' : 'were'} settled as moved.`
                : '.')
          );
          return 'mine';
        }
        if (standbyKey !== null) {
          standbyKey = null;
          say('this machine now serves the project.');
        }
        return 'mine';
      }
      // The NAME is all the response carries about the other box, so it is also
      // the only thing "a distinct holder" can be keyed on. An unnamed holder
      // keys on the empty string, which is stable — one announcement, not one
      // per poll. Scrubbed before it reaches a terminal (2026-09-24, the
      // audit) — see printable.mjs.
      const name = safeName(holder.name)?.slice(0, 64) ?? null;
      const key = name ?? '';
      if (key !== standbyKey) {
        standbyKey = key;
        const ago = agoLabel(holder.heardAgo);
        // THE SENTENCE POINTS AT THE APP, NEVER AT A COMMAND. The owner's
        // ruling, verbatim: "i dont intend to run or do anything in the
        // terminal besides npx flowviant or npx flowviant login." So the
        // terminal surface is those two commands, full stop — this box waits
        // or a person moves the machine from project settings, and there is no
        // third thing to type here. An earlier cut of this sentence ended by
        // telling the person to re-run this daemon with a claim flag; that flag
        // is deleted, and the gesture is the app's — where the server can see
        // both boxes and every daemon learns the outcome on its next poll.
        //
        // The ago clause DROPS whole when unmeasured — agoLabel returns null
        // rather than a zero — because "heard 0s ago" is a measurement nobody
        // took, printed at the one moment the person is deciding whether to
        // wait.
        //
        // THE PROMISE IS GONE (0.91.0), and its absence is the honest half.
        // This sentence used to end "It moves here automatically once that
        // machine has been quiet 10 minutes", which was true while starting a
        // daemon did nothing but wait. Since 0.91.0 a process START asks for
        // the machine on its first poll — the owner's ruling, "it should kill
        // the first one and take over" — so reaching this branch at all means
        // the ask was REFUSED or never spent. Four ways: an older server that
        // does not honour it; a daemon this server will not hand a machine to;
        // an UNATTENDED RE-EXEC, which is born with the ask spent because a
        // restart is not a person; and — the one worth naming — a box this
        // credential DISPLACED inside the last ten minutes, which the server
        // refuses so that two supervised daemons cannot trade a machine back
        // and forth forever (see `takeMachineHolderNow`). In that last case the
        // right next move is a decision, not a wait, which is exactly what this
        // sentence already points at. Restating the staleness clock instead
        // would promise a handover on the one path where it is least likely to
        // be what happens. So the line relays the fact and points at the door,
        // which is the same door it always pointed at.
        //
        // THE WORD IS `inactive` (2026-09-21). It was "standing by" until the
        // owner replaced it — asked whether a box should keep saying that, he
        // answered *"no, it can [be] inactive instead"* — and the server's role
        // enum moved in the same pass (`serving` / `inactive`, which is why
        // `machines.mjs` no longer respells anything). A terminal saying one
        // word about this box while the app says another about the same box is
        // the confusion these readouts exist to end, so the two ends say the
        // same thing.
        //
        // THE POINTER SURVIVES THE REWORD. The sentence still ends at the app's
        // project settings rather than at "another machine is serving this
        // project", which the line's first half has already said — restating it
        // would spend the only clause the person can act on repeating a fact.
        say(
          `This project's machine is ${name ?? 'another machine'}${ago ? ` (heard ${ago} ago)` : ''}. ` +
            "This one is inactive — move it here from the app's project settings."
        );
      }
      return 'standby';
    },
  };
}

/** The sentence an in-flight agent turn is settled with when the machine moves
 *  out from under it. MEASURED, not inferred: the server named the box that
 *  took over, and an unnamed one says so rather than guessing. Scrubbed
 *  before it is relayed anywhere (2026-09-24, the audit) — see printable.mjs. */
export function displacedTurnSentence(by) {
  const name = safeName(by)?.slice(0, 64) ?? 'another machine';
  return `The project's machine moved to ${name} while this turn was running.`;
}

/**
 * …AND THE SENTENCE FOR THE OTHER WAY A BOX STOPS BEING THIS PROJECT'S
 * MACHINE (2026-09-21): it was REMOVED in the app.
 *
 * Kept apart from the displaced one rather than generalised into "the machine
 * is no longer this box", because the two are different facts and the person
 * reading a stuck turn needs the one that happened. A move names where the work
 * went and implies somebody will pick it up there; a removal names nothing,
 * because there is nowhere for it to have gone. Guessing between them — or
 * blurring them into one sentence that is true of both — is the product
 * inventing a state.
 *
 * It takes NO name: there is no box that took over. The PROJECT is named on the
 * console line instead, where it answers "removed from what".
 */
export function removedTurnSentence() {
  return 'This machine was removed from the project in the app while this turn was running.';
}

/**
 * THE MACHINE MOVED. STAND DOWN.
 *
 * The server sends `displaced` only when it is aimed at THIS box (it matches the
 * poll's own `envpub`) and only inside a short window, so there is nothing to
 * re-derive here and nothing to honour from last week — the same shape, and the
 * same reasoning, as the commanded stop above.
 *
 * Unlike the signal handlers this path is poll-response-driven, so it CAN await:
 * every in-flight agent turn is settled first, because a turn this daemon
 * abandons silently sits pending until the server's six-hour expiry while the
 * board shows an agent working on a machine that has gone. `nothing` is the
 * honest outcome and the sentence says what happened.
 *
 * EXIT 0, for the reason the two existing terminal paths (the commanded stop,
 * and the revoked credential above it) both document: under `Restart=on-failure`
 * a nonzero code has systemd relaunch this daemon immediately, where it would
 * poll, be told again that it is not the machine, and stand down again — a
 * restart loop fighting a decision somebody made on purpose.
 *
 * Every dependency is injected so the whole stand-down can be proved without a
 * server, a repo or a process to kill.
 */
export async function standDownDisplaced({
  by,
  kind = 'moved',
  project,
  settleAgentTurns,
  flushReports,
  teardown,
  exit,
  log = { warn: () => {}, note: () => {} },
}) {
  /** A bound on a wedged uplink, and never a reason to hang: the timer is
   *  unref'd, so the only thing that keeps this process alive is the work. */
  const bounded = (p, seconds) =>
    Promise.race([
      p,
      new Promise((resolve) => {
        const t = setTimeout(resolve, seconds * 1000);
        t.unref?.();
      }),
    ]);
  // Scrubbed before it reaches this box's own console (2026-09-24, the
  // audit) — see printable.mjs.
  const name = safeName(by)?.slice(0, 64) ?? null;
  /**
   * TWO KINDS, ONE CHOREOGRAPHY (2026-09-21).
   *
   * `moved` is the original: another box took the machine, and it is the
   * DEFAULT so the displaced call site reads exactly as it always did.
   * `removed` is the project saying this box is not its machine at all any
   * more — somebody pressed a button in the app — and the only thing that
   * differs is the WORDS. Everything below this point is the same, and it must
   * be: settle the turns first, flush the reports, tear down the detached
   * children, keep the worktrees, exit 0.
   *
   * The sentences are picked HERE rather than passed in, so the two cannot
   * drift and neither call site can invent a third.
   */
  const removed = kind === 'removed';
  const projectName = safeName(project)?.slice(0, 64) ?? 'this project';
  log.warn(
    removed
      ? `removed from ${projectName} in the app — stopping.`
      : name
        ? `this project's machine moved to ${name} — standing down.`
        : "this project's machine moved to another box — standing down."
  );
  // FIRST, and awaited: an unsettled turn is the one thing here that no later
  // poll from anybody can fix — this process holds the only copy of the fact
  // that it was running.
  try {
    await bounded(
      settleAgentTurns(removed ? removedTurnSentence() : displacedTurnSentence(by)),
      10
    );
  } catch {
    /* an unsettled turn expires server-side with words of its own */
  }
  // THEN the queued settles, bounded exactly as the commanded stop bounds them:
  // a queued report is a COMPLETED turn whose side effects already happened, and
  // dropping it re-runs the whole turn somewhere else.
  try {
    await bounded(flushReports(), 5);
  } catch {
    /* undelivered reports re-run; delivering them was best-effort */
  }
  // NOT optional, for the reason the commanded stop states: detached preview
  // tunnels survive this process by design, and a public hostname pointed into a
  // worktree on a box that no longer serves the project is the worst thing this
  // path can leave behind.
  teardown();
  log.note('worktrees are kept — the branches here are the only copy of this box\'s work.');
  exit(0);
}

// One roster agent's loop: persistent worktree, one intent per turn, reset to
// base between tasks (fresh conversation), resume in place while on a blocker.

export async function runFleetDaemon({ afterLock = null } = {}) {
  console.log('');
  console.log(`  ${c.bold(c.cyan('◣ flowviant'))}  ${c.dim(`machine daemon · v${VERSION}`)}`);
  console.log(`  ${c.dim('──────────────────────────────────────────────')}`);
  const repoRoot = repoRootOrDie();
  /**
   * WHERE SHIP LANDS. Detected at startup, then OVERRIDDEN by the roster when a
   * human has chosen one (`projects.baseBranch`).
   *
   * A `let` and a getter rather than a const, because the answer can change
   * while the daemon runs — and because the detected value itself is fragile:
   * with no `origin/HEAD` set, `detectBaseRef` falls back to
   * `origin/<whatever was checked out at startup>`, which froze for the life of
   * the process. A stored value is the fix; this is the wiring that lets it
   * reach the code that merges.
   */
  let baseRef = detectBaseRef(repoRoot);
  const getBaseRef = () => baseRef;
  /**
   * THE PROJECT'S KNOWLEDGE LIBRARY (0.94.0) — synced into THIS checkout's
   * `.flowviant/knowledge/` whenever the roster's manifest moves. One copy per
   * box, in the checkout, because every worktree on the box can read an
   * absolute path (knowledge.mjs says why a copy per worktree is wrong). The
   * exclude is written first so the library never shows as a change in the
   * operator's own `git status` or in a checkout tab's diffstat.
   */
  /** The roster's `artifactsAccepted`, latest poll — see `getArtifactsAccepted`
   *  on the work manager. False until a server says otherwise. */
  let artifactsAccepted = false;
  const knowledgeSync = createKnowledgeSync({
    checkoutDir: repoRoot,
    fetchFile: knowledgeFetcher({ fleetUrl: FLEET_URL, token: FLEET_TOKEN, userAgent: USER_AGENT }),
    onExclude: (dir) => excludeInWorktree(dir, FLOWVIANT_OWN_PATHS),
    log: (line) => note(c.dim(line)),
  });
  info(SAFE ? 'mode   · safe (restricted toolset)' : 'mode   · unattended (skips permission prompts)');
  // WHICH PROJECT, before anything connects — the roster names it again a few
  // seconds later with the server's word, but "which project is this daemon
  // about to serve" must not require a network round trip to answer. Only when
  // the credential came from the STORE: a --fleet/env token names no project
  // until the roster does.
  if (CREDENTIAL?.entry && storedCredentialInUse()) {
    info(`serves · ${projectLabel(CREDENTIAL.entry)} ${c.dim(`(${CREDENTIAL.entry.projectId.slice(0, 8)}…)`)}`);
  }
  info(`repo   · ${repoRoot}`);
  info(`base   · ${baseRef}`);
  info(`server · ${FLEET_URL}`);
  console.log('');

  // ONE DAEMON PER CREDENTIAL. Before preflight, before the preview reap,
  // before anything with a side effect — a second daemon must not so much as
  // install a CLI or clear a registry on its way to being refused. Keyed on the
  // credential rather than the repo, because two checkouts on one credential is
  // the SAME project served twice, and the worst version of this: their session
  // worktrees are in different directories, so the per-turn lock cannot even see
  // across them. See instance.mjs for why that lock is not enough on its own.
  // Same repo -> this run replaces whatever was serving it. Different repo ->
  // refused, and nothing is signalled. See instance.mjs's header for the rule.
  //
  // `--takeover` ARBITRATES PROCESSES ON THIS BOX and nothing more — which
  // daemon serves this repo. It says nothing about which BOX serves the
  // project: that is holdership, the server decides it because only the server
  // can see both boxes, and a person moves it from the app.
  const instance = acquireInstanceLock(FLEET_TOKEN, repoRoot, {
    takeover:
      process.argv.includes('--takeover') || process.argv.includes('--takeover-downgrade'),
    noTakeover:
      process.argv.includes('--no-takeover') || process.env.FLOWVIANT_NO_TAKEOVER === '1',
    allowDowngrade: process.argv.includes('--takeover-downgrade'),
    log: (m) => info(m),
  });
  if (!instance.ok) {
    const h = instance.holder;
    console.log('');
    // Two different refusals, because they are two different mistakes and the
    // fix is not the same. Same CREDENTIAL: one project is being served twice.
    // Same REPO under another credential: two daemons in one working tree,
    // which the credential-keyed lock cannot see on its own.
    if (instance.takeoverFailed) {
      fail(`could not replace the running daemon: ${instance.takeoverFailed}`);
    } else if (instance.sameRepo) {
      fail('a flowviant daemon is already running in this repo.');
    } else {
      fail('a flowviant daemon is already running for this credential.');
    }
    if (h?.pid) info(`holder · pid ${h.pid}${h.repoRoot ? ` in ${h.repoRoot}` : ''}`);
    // The two-checkouts case is the one nobody spots on their own: both tabs
    // look healthy, and the damage is doubled cards and doubled edits in a repo
    // you are not looking at. Name the other repo when it is a different one.
    if (!instance.sameRepo && h?.repoRoot && h.repoRoot !== repoRoot) {
      warn('that is a DIFFERENT checkout — one credential serves one project, so both would answer the same tabs.');
      // Not offered lightly: that daemon is serving other work, and this
      // command was run somewhere else. Replacing it is a decision, not a
      // restart, so it takes a word.
      note('run with --takeover to stop it and serve this repo instead.');
    }
    // WITHHELD when we could not identify the holder. ALLOW_MULTI runs this
    // daemon unguarded beside one we just admitted we cannot see, and in the
    // same repo that is two `git fetch`, two worktree sweeps, and one
    // `retireWorkSessions` deleting directories the other is serving. Offering
    // it as the way out of "I don't know what that process is" would be handing
    // someone the worst option at the moment they have the least information.
    if (!instance.unidentified) {
      note('or run this one with FLOWVIANT_ALLOW_MULTI=1 if you know what you are doing.');
    }
    console.log('');
    process.exit(1);
  }
  if (instance.unguarded)
    warn('could not take the single-instance lock (unwritable ~/.flowviant) — running unguarded');
  // The repo binding the start path's picker or confirm was answered with.
  // Persisted HERE, after the lock, so a refused start moves nothing: moving it
  // first stranded the daemon already serving that project's own checkout at
  // its next unattended restart. Best-effort — an unwritable store costs the
  // next start a question, never this one its machine.
  try {
    afterLock?.();
  } catch {
    /* the binding is asked again next time */
  }

  await preflight({ needGit: true });

  // FEED THE SCRUBBER BEFORE ANYTHING CAN POST, not on the first roster tick.
  //
  // What stood here warmed the VAULT's encrypted cache off the stored
  // credential's projectId, so a worktree created on the first poll after a
  // restart was not materialized against an empty bundle. The vault is deleted;
  // the ordering lesson survives and applies to the one thing that replaced it.
  // `scrub()` redacts the checkout's own `.env*` values out of everything this
  // daemon posts, and a redactor that has not read yet redacts nothing — so the
  // first read happens here, before the first poll, rather than on the 60s beat
  // that keeps it current. A daemon that starts, immediately answers a turn and
  // posts its stream must already know what to hide.
  //
  // Best-effort and unconditional: it reads files in a directory this process
  // is already standing in, needs no credential and names no project, so the
  // whole `--fleet`-overrides-the-store hazard the old warm had to reason
  // about does not exist here.
  try {
    scanEnvForScrub(repoRoot);
  } catch {
    /* an unreadable checkout redacts nothing — the 60s beat retries */
  }

  // Kill any preview dev-server/tunnel groups a previously-crashed daemon left
  // running (detached children survive an ungraceful exit) before we start fresh.
  reapOrphanPreviews((m) => info(m));

  // Persistent worktree home (0.9.0) — survives daemon restarts AND reboots,
  // so Ctrl+C mid-task never loses local work. Keyed per repo path.
  const repoKey = `${basename(repoRoot)}-${createHash('sha256').update(repoRoot).digest('hex').slice(0, 8)}`;
  const baseDir = join(homedir(), '.flowviant', 'worktrees', repoKey);
  mkdirSync(baseDir, { recursive: true });

  // WHAT THE DELETED VAULT LEFT ON THIS DISK — once, here, because this is the
  // first point at which both directories it wrote into are known. Deleting the
  // code that writes a file does not delete the file: the encrypted
  // `~/.flowviant/env-cache` and the PLAINTEXT `.env` files `materializeInto`
  // put in every worktree survive the upgrade on every box that ever ran a
  // daemon before this release. Only files carrying the vault's own header are
  // removed — see vaultArtefacts.mjs for why "no marker, no delete" is
  // absolute, and for the stated bound on the walk. Never throws, and silent
  // unless it actually removed something.
  sweepVaultArtefactsOnce({ roots: [repoRoot, baseDir], log: (m) => info(m) });

  // ONE CHECKOUT PER TASK, named after the task. Worktrees used to be
  // `agent-<agentId>` — a long-lived tree per lane, reset to base between
  // tasks — and that was the last thing a lane owned. Now a lane is a
  // credential and nothing more, which is what makes it disposable: the server
  // can hand any lane any task, and two tasks can never be in each other's
  // files even when one is mid-edit.
  const taskWorktreePath = (intentId) => join(baseDir, `task-${intentId}`);
  try {
    const kb = Number(execFileSync('du', ['-sk', baseDir], { encoding: 'utf8' }).split('\t')[0]);
    if (kb > 1024)
      info(
        `disk   · worktrees ${(kb / 1024 / 1024).toFixed(1)} GB at ~/.flowviant/worktrees — \`flowviant clean\` reclaims`
      );
  } catch {
    /* du unavailable (Windows) — skip the disk line */
  }

  // Reap long-dead task checkouts. Per-lane trees were self-limiting — N lanes,
  // N directories, reused forever. Per-task trees are not: every task ever
  // built leaves one behind, so without this the disk grows without bound and
  // `flowviant clean` becomes a chore rather than a convenience.
  //
  // Age, not state, is the test. The daemon has no list of which intents are
  // still open, and asking the server for one would put a delete behind a
  // network call that can fail — so anything untouched for a fortnight goes,
  // which is far beyond how long a task stays reviewable and far beyond any
  // pause a human takes mid-build. Runs at startup only: mid-run this would
  // race a worker that is quietly parked on a blocker.
  try {
    const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
    let reaped = 0;
    for (const name of readdirSync(baseDir)) {
      if (!name.startsWith('task-')) continue;
      const p = join(baseDir, name);
      try {
        if (statSync(p).mtimeMs > cutoff) continue;
        // Through git, so the worktree REGISTRATION goes too — an rm -rf leaves
        // a stale entry that blocks re-adding the same path later.
        git(['worktree', 'remove', '--force', p], repoRoot);
        reaped++;
      } catch {
        /* held, gone, or not ours — leave it for `flowviant clean` */
      }
    }
    if (reaped) info(`disk   · reclaimed ${reaped} task worktree${reaped === 1 ? '' : 's'} idle > 14d`);
  } catch {
    /* the worktree home may not exist yet on a first run */
  }
  const tokenByAgent = new Map(); // agentId -> latest worker token
  const mintedAt = new Map(); // agentId -> ms when we last got a fresh token
  const hasWorkByAgent = new Map(); // agentId -> server says it has claimable work
  // agentId -> the intent the server would hand this lane next: { intentId,
  // title, model, effort }. `--model`/`--effort` are fixed when Claude starts,
  // and by then nothing has been claimed — so the server names the task first
  // and the turn pins its claim to that id. Absent on older servers, in which
  // case the lane behaves exactly as it did before: generic kickoff, machine
  // defaults.
  const nextByAgent = new Map();
  let leaseTtlSeconds = 24 * 60 * 60; // updated from each roster response
  let mcpUrl = MCP_URL;
  // DEAD, and kept only because unpicking it is a rewire rather than a
  // deletion: nothing calls `workers.set` anywhere in this tree. It held
  // DISPATCH lanes, and the server has sent `agents: []` permanently since
  // 2026-08-19, so every loop below iterates nothing. Two `stopPreview` calls
  // hung off it until 2026-08-21 and read as live preview wiring; they were
  // deleted, not rewired. When the Workbench preview lands, its teardown is
  // keyed on sessionId and belongs beside retireWorkSessions in work.mjs —
  // NOT here.
  const workers = new Map(); // agentId -> { state, promise, wt, label }
  let daemonAlive = true; // flipped false on shutdown so the stream stops reconnecting
  let stream = null; // push channel handle (set once the loop is set up)
  let workShutdown = null; // kills live session-turn CLIs (set with the work manager below)

  // Shutdown KEEPS the worktrees: in-flight local work survives Ctrl+C and
  // resumes in place on the next run (the task marker matches). Worktrees are
  // only removed when an agent is deleted from the roster, or by
  // `flowviant clean`.
  const teardown = () => {
    daemonAlive = false;
    try {
      stream?.close();
    } catch {
      /* best-effort */
    }
    // A mid-sweep wiki Claude must die with the daemon — orphaning it leaves it
    // burning quota, and a restarted daemon would start a SECOND sweep racing
    // it on the same vault dir + sync state.
    try {
      wikiChild?.kill('SIGKILL');
    } catch {
      /* best-effort */
    }
    // Session-turn CLIs die with the daemon too: an orphan keeps editing the
    // session worktree and burning quota, and its live-pid lock would make the
    // restarted daemon skip that tab's turns for as long as it survived.
    try {
      workShutdown?.();
    } catch {
      /* best-effort */
    }
    for (const [, w] of workers) {
      w.state.alive = false;
      try {
        w.state.child?.kill('SIGKILL');
      } catch {
        /* best-effort */
      }
    }
    // Detached tunnels survive our exit by design, so leaving them would strand
    // a public hostname until the box rebooted.
    shutdownPreviews();
    // AND THE DEV SERVERS, on every path that reaches here — all four are a
    // stand-down: Ctrl-C, a service manager's SIGTERM, a revoked credential, a
    // commanded stop.
    //
    // A SAME-REPO TAKEOVER IS DELIBERATELY NOT DISTINGUISHED, and that is a
  };
  process.on('SIGINT', () => {
    console.log('');
    note('shutting down — stopping workers. Worktrees are kept: in-flight work resumes next run.');
    teardown();
    process.exit(130);
  });
  // A service manager stops the daemon with SIGTERM, not Ctrl+C. Without this
  // handler every child survived a `systemctl stop` — the exact orphaning the
  // teardown exists to prevent.
  process.on('SIGTERM', () => {
    console.log('');
    note('shutting down (SIGTERM) — stopping workers. Worktrees are kept: in-flight work resumes next run.');
    teardown();
    process.exit(143);
  });
  // Keep the daemon alive on a stray rejection. Many loops here are fire-and-
  // forget (`void drainWiki()`, dispatch, sync) and rely on their callees never
  // rejecting; Node ≥15 terminates the process on an unhandled rejection, which
  // would kill every in-flight agent worker over one transient error. Log and
  // survive instead — a wedged sub-task self-heals on the next poll.
  process.on('unhandledRejection', (reason) => {
    warn(`unhandled rejection (daemon kept alive): ${reason?.stack || reason}`);
  });

  // Merge jobs (Flowvy-commanded): approved PRs to squash-merge to main on the
  // user's own gh. `merging` guards against re-processing a job mid-flight.
  const MERGE_DONE_URL = FLEET_URL.replace(/\/agents\/?$/, '/merge-done');
  const MERGE_FAILED_URL = FLEET_URL.replace(/\/agents\/?$/, '/merge-failed');
  const merging = new Set();
  const mergeAttempts = new Map(); // job.id -> transient-failure count
  /** Returns whether the server actually accepted it. Callers that spend a
   *  Claude turn per attempt need to know: swallowing the failure silently made
   *  an unreachable endpoint look identical to a settled job, so the turn
   *  re-ran on every poll. */
  const reportMergeOutcome = async (url, body) => {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${FLEET_TOKEN}`,
          'User-Agent': USER_AGENT,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(30_000),
        body: JSON.stringify(body),
      });
      return res.ok;
    } catch {
      /* best-effort — the job reappears next poll if this failed */
      return false;
    }
  };
  /** Same POST, but hands back the parsed `data`. A compare-and-set answers in
   *  the BODY (`taken: false` is a perfectly successful 200), so reading only
   *  `res.ok` would tell a lane it won a race it actually lost. */
  const postForData = async (url, body) => {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${FLEET_TOKEN}`,
          'User-Agent': USER_AGENT,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(30_000),
        body: JSON.stringify(body),
      });
      if (!res.ok) return null;
      return (await res.json())?.data ?? null;
    } catch {
      return null;
    }
  };
  // Patch reverts: a patch landed straight in this checkout, and a human took it
  // back. The commits are HERE, not on the server, so the reverse-apply happens
  // here too — a revert, never a reset, because the owner has almost certainly
  // worked on top by now. Serialised through the same lock as applies.
  const PATCH_REVERT_DONE_URL = FLEET_URL.replace(/\/agents\/?$/, '/patch-revert-done');
  const reverting = new Set();
  const processPatchRevertJobs = (jobs) => {
    for (const job of jobs ?? []) {
      if (!job || typeof job.id !== 'string' || !Array.isArray(job.shas)) continue;
      if (reverting.has(job.id)) continue;
      reverting.add(job.id);
      (async () => {
        try {
          note(`${c.cyan('revert')} ${c.dim(`— ${job.title}`)}`);
          const res = await withPatchLock(() =>
            Promise.resolve(revertPatch({ repoRoot, shas: job.shas }))
          );
          if (res.ok) ok(`${c.dim('reverted')} ${job.title}`);
          else warn(`revert failed for "${job.title}": ${res.error}`);
          // ALWAYS report, success or not. Without this the flag stays set, the
          // roster re-serves the job every poll, and each pass reverts the
          // revert — the change flapping in and out of the owner's tree forever.
          await reportMergeOutcome(PATCH_REVERT_DONE_URL, {
            taskId: job.id,
            ok: res.ok,
            error: res.ok ? undefined : String(res.error ?? 'revert failed'),
          });
        } finally {
          reverting.delete(job.id);
        }
      })();
    }
  };


  /**
   * Everything that reads or rewrites the shared `wikiWt` worktree takes this:
   * the wiki sweep, the post-merge re-ground, the plan check, and consults.
   *
   * They are one directory. The wiki queue hard-resets it (`checkout --detach`,
   * `reset --hard`, `clean -fd`) between tasks, which pulls the files out from
   * under anything else mid-read — and two Claude turns in one working tree is
   * incoherent even without the reset.
   */
  let wikiLock = Promise.resolve();
  const withWikiLock = (fn) => {
    const run = wikiLock.then(fn, fn);
    wikiLock = run.then(
      () => {},
      () => {}
    );
    return run;
  };

  // Machine telemetry — what the box is doing with itself, for the admin view.
  const MACHINE_URL = FLEET_URL.replace(/\/agents\/?$/, '/machine');




  // ── Work sessions — the Workbench tabs ─────────────────────────────────────
  //
  // The whole machinery — per-session turn/ship chains, per-session work
  // tokens, the settle-every-turn contract, the ship executor, worktree
  // retirement — lives in work.mjs; this hands it the loop's mutable state.
  const {
    flushWorkReports,
    learnPlaces,
    processWorkTurns,
    processShipJobs,
    processDiffJobs,
    processKillJobs,
    processPrJobs,
    processAgentPlanJobs,
    processAgentTurnJobs,
    processAgentMergeJobs,
    freshenManualPlaces,
    heldSessionIds,
    processPreviewJobs,
    livePreviewIds,
    retirePreviews,
    shutdownPreviews,
    retireWorkSessions,
    reportWorktrees,
    shutdownWork,
    settleAgentTurns,
    workBusy,
    admit,
    liveTurns,
  } = createWorkManager({
    repoRoot,
    baseDir,
    getBaseRef,
    getMcpUrl: () => mcpUrl,
    getLeaseTtl: () => leaseTtlSeconds,
    /**
     * The cartographer is a CLI turn too, and it is the one this manager cannot
     * see — it lives in this closure, not in `workChildren`. Without it the
     * machine's ceiling would be a ceiling with a hole in it: a wiki sweep over
     * a large repo is one of the heaviest turns the daemon runs.
     *
     * Read lazily (it is only ever called from the reconcile loop, long after
     * `wikiChild` is declared below), for the same reason `onRepoChanged` is a
     * callback: work.mjs is imported BY this file and cannot import back.
     *
     * `wikiBusy` COUNTS, not just the live child, and that is the wiki lane's
     * version of the reservation `admission.mjs` describes: the drain sets the
     * flag the moment it is admitted and the CLI does not exist until several
     * awaits later, so counting the child alone left a hole exactly wide enough
     * for the other lanes to spend the slot this one had already taken. The
     * drain runs at most one CLI at a time, so the flag and the child are the
     * same one turn and this can never double-count.
     */
    extraLiveTurns: () => (wikiBusy || wikiChild ? 1 : 0),
    /**
     * Whether the server takes artifacts — the roster's own word, latest poll
     * (2026-09-22). Read lazily for the reason above: the roster loop that
     * writes it runs long after this manager is built.
     */
    getArtifactsAccepted: () => artifactsAccepted,
    /**
     * "THE REPO JUST CHANGED — look again."
     *
     * `maybeReportRepoState` is on its own 60s wall clock and nothing ever
     * reset it, so every Flowviant action that alters the branch/worktree
     * picture — a ship deleting the merged branch, retirement removing a
     * directory and pruning, a tab being cut — left the rail's Repository block
     * listing things that no longer exist for up to a minute. It is the same
     * rule the diffstat just learned: an action that changes what the machine
     * would measure must cause a new measurement.
     *
     * A callback rather than an export because work.mjs is imported BY this
     * file, so it cannot import back. Clearing the timestamp is enough — the
     * next reconcile does the scan, on the beat it already runs.
     */
    onRepoChanged: () => {
      repoStateScanAt = 0;
    },
  });
  workShutdown = shutdownWork; // teardown can now reach the live session CLIs

  const processMergeJobs = (jobs) => {
    for (const job of jobs ?? []) {
      if (!job || typeof job.id !== 'string') continue; // a null element would wedge the loop
      if (merging.has(job.id)) continue;
      merging.add(job.id);
      (async () => {
        try {
          note(`${c.cyan('merge')} ${c.dim(`— ${job.title}`)}`);
          let merged = false;
          let failedReason = null; // permanent — tell the thread, clear the flag
          // Refuse a PR URL that isn't an https github.com PR in THIS repo — a
          // bad/hostile server must not merge a PR in another repo the user's
          // gh can write to (and a leading '-' would be a gh flag).
          if (!isValidPrUrl(job.prUrl, originSlug(repoRoot))) {
            mergeAttempts.delete(job.id);
            await reportMergeOutcome(MERGE_FAILED_URL, {
              taskId: job.id,
              message: 'refused: PR URL is not a pull request in this repository',
            });
            warn(`merge REFUSED for "${job.title}": untrusted PR URL ${String(job.prUrl)}`);
            return;
          }
          // STACKED PR: it targets its blocker's branch so the review shows only
          // its own diff. The server holds this job until that blocker merged, so
          // by now the blocker's commits are in the base ref — re-point before
          // squashing, or the change lands in the blocker's branch and never
          // reaches the trunk while the card cheerfully says "Merged".
          if (job.retargetToBase) {
            try {
              // baseBranchName, not baseRef: `gh pr edit --base` needs a branch
              // that exists in the repo, and detectBaseRef hands back a
              // remote-tracking ref (origin/main) that GitHub 422s on.
              execFileSync('gh', ['pr', 'edit', job.prUrl, '--base', baseBranchName(baseRef)], {
                cwd: repoRoot,
                stdio: ['ignore', 'pipe', 'pipe'],
                timeout: 30_000,
              });
            } catch (e) {
              // Already targeting base is the common no-op; anything else is
              // reported rather than merged into the wrong place.
              const err = e.stderr?.toString?.() || e.message || '';
              if (!/no changes|already/i.test(err)) {
                mergeAttempts.delete(job.id);
                await reportMergeOutcome(MERGE_FAILED_URL, {
                  taskId: job.id,
                  message: `could not retarget the stacked PR onto ${baseBranchName(baseRef)} — merging it now would land in the branch below it, not ${baseBranchName(baseRef)}`,
                });
                warn(`merge held for "${job.title}": retarget failed — ${err.split('\n')[0]}`);
                return;
              }
            }
          }
          try {
            execFileSync('gh', ['pr', 'merge', job.prUrl, '--squash', '--delete-branch'], {
              cwd: repoRoot,
              stdio: ['ignore', 'pipe', 'pipe'],
              timeout: 120_000,
            });
            merged = true;
          } catch (e) {
            const err = e.stderr?.toString?.() || e.message || '';
            const line = err.split('\n')[0] || 'gh pr merge failed';
            // Only "already merged" is a real success; a CLOSED-without-merge PR
            // also matches "not open"/"closed" but nothing landed on main —
            // report it as a failure so the thread learns the truth.
            if (/already merged/i.test(err)) merged = true;
            else if (/not open|closed/i.test(err)) {
              failedReason = 'the PR was closed without merging';
            } else if (/conflict|not mergeable|CONFLICTING/i.test(err)) {
              // Permanent until a human/agent acts — don't spin on it.
              failedReason = `merge conflict with ${baseRef} — the branch needs a rebase`;
            } else {
              // Transient (auth hiccup, network, CI requirement): retry a few
              // polls, then surface it instead of silently looping forever.
              const n = (mergeAttempts.get(job.id) ?? 0) + 1;
              mergeAttempts.set(job.id, n);
              if (n >= 3) failedReason = line;
              else warn(`merge failed for "${job.title}": ${line} — will retry`);
            }
          }
          if (merged) {
            mergeAttempts.delete(job.id);
            await reportMergeOutcome(MERGE_DONE_URL, { taskId: job.id });
            ok(`${c.cyan('merged')} ${c.dim(`— ${job.title} → ${baseRef}`)}`);
            // The code just landed — re-ground the living wiki for what shipped
            // (touched nodes re-read + a persistent feature-history node).
            // Direct enqueue = immediacy; the server's durable regroundJobs list
            // (created by merge-done above, cleared by our reground-done report)
            // is the restart-safe backstop — dedup'd here by groundedIntents.
            enqueueReground(job.id, job.prUrl, job.title, job.dirtiesPages, job.shas);
          } else if (failedReason) {
            // Report into the thread (server narrates + re-arms the merge
            // button + notifies) — the job disappears from the roster.
            mergeAttempts.delete(job.id);
            await reportMergeOutcome(MERGE_FAILED_URL, {
              taskId: job.id,
              message: failedReason,
            });
            warn(`merge failed for "${job.title}": ${failedReason} — reported to the thread`);
          }
        } finally {
          merging.delete(job.id);
        }
      })();
    }
  };

  // Cleanup jobs (task restarts): close the abandoned PR + delete its remote
  // branch on the user's own gh, so a restart doesn't litter the repo.
  const CLEANUP_DONE_URL = FLEET_URL.replace(/\/agents\/?$/, '/cleanup-done');
  const cleaning = new Set();
  const processCleanupJobs = (jobs) => {
    for (const job of jobs ?? []) {
      if (!job || typeof job.id !== 'string') continue; // a null element would wedge the loop
      if (cleaning.has(job.id)) continue;
      cleaning.add(job.id);
      (async () => {
        try {
          note(`${c.cyan('cleanup')} ${c.dim(`— ${job.title} (restarted)`)}`);
          // Same guards as merge: only close a PR in THIS repo, only delete a
          // well-formed non-base branch. A bad server must not close a stranger's
          // PR or delete `main` (`--delete` with `main`) via a cleanup job.
          if (job.prUrl && isValidPrUrl(job.prUrl, originSlug(repoRoot))) {
            try {
              execFileSync(
                'gh',
                [
                  'pr',
                  'close',
                  job.prUrl,
                  '--comment',
                  'Task restarted in Flowviant — this attempt was discarded.',
                  '--delete-branch',
                ],
                { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 }
              );
            } catch (e) {
              // Already closed/merged/missing = fine; anything else we still
              // report done — a restart must never wedge on stale remotes.
              const err = e.stderr?.toString?.() || e.message || '';
              warn(`cleanup for "${job.title}": ${err.split('\n')[0] || 'gh pr close failed'}`);
            }
          } else if (job.branch && isValidBranch(job.branch, repoRoot, baseRef)) {
            try {
              // Explicit refspec form so a leading '-' can't be a git flag.
              // NETWORK call, so timed and non-interactive (2026-09-24, the
              // audit): a bare execFileSync here had no timeout and could
              // prompt on /dev/tty, freezing every poll and lease on the
              // machine behind this cleanup's own async loop.
              await gitNetAsync(['push', 'origin', `:refs/heads/${job.branch}`], repoRoot);
            } catch {
              /* branch already gone — fine */
            }
          } else if (job.prUrl || job.branch) {
            warn(`cleanup REFUSED for "${job.title}": untrusted PR/branch value`);
          }
          await reportMergeOutcome(CLEANUP_DONE_URL, { taskId: job.id });
          ok(`${c.cyan('cleaned')} ${c.dim(`— ${job.title}`)}`);
        } finally {
          cleaning.delete(job.id);
        }
      })();
    }
  };

  // Living-wiki work runs ONE turn at a time in a dedicated repo worktree (off
  // the agents' checkouts). Claude READS the repo there and writes the markdown
  // VAULT (~/.flowviant/vaults/<projectId>) — plain files, no MCP tools; the
  // daemon hash-diff syncs the vault to the server after each turn. Two
  // triggers enqueue: a Regenerate click (full SWEEP, finalize-prunes) and a
  // successful merge (incremental RE-GROUND). One queue + runner serializes
  // them so they never collide on the worktree or the vault. Wiki work needs no
  // agent online.
  const wikiWt = join(baseDir, 'wiki');
  const REGROUND_DONE_URL = FLEET_URL.replace(/\/agents\/?$/, '/reground-done');
  const WIKI_VAULT_URL = FLEET_URL.replace(/\/agents\/?$/, '/wiki-vault');
  const WIKI_PROGRESS_URL = FLEET_URL.replace(/\/agents\/?$/, '/wiki-progress');
  const WIKI_ABANDONED_URL = FLEET_URL.replace(/\/agents\/?$/, '/wiki-abandoned');
  const wikiQueue = [];
  let wikiBusy = false;
  let wikiChild = null; // the wiki turn's Claude process — tracked so teardown can kill it
  let wikiHoldSaidAt = 0; // last time the drain said it was waiting on the box
  let lastSweepAt = null; // dedup: run each Regenerate request once
  // …UNLESS IT FAILED. A sweep that ends without WIKI_DONE never finalizes, so
  // the server's `regen_requested_at` stays set and the roster keeps offering
  // the same `requestedAt` — which this dedup then swallowed forever. The
  // console said "retry from the app", to a console nobody reads. Bounded the
  // same way the re-ground path is: a full sweep is an expensive model turn, so
  // a repo that fails one every time must not be able to loop-burn quota.
  let sweepAttempts = 0;
  // Which request the counter belongs to, so a NEW Regenerate click starts with
  // a full budget rather than inheriting an exhausted one.
  let sweepAttemptsFor = null;
  const MAX_SWEEP_ATTEMPTS = 3;
  const groundedIntents = new Set(); // dedup: re-ground each delivery once
  // The vault is keyed by the server project this fleet credential serves
  // (learned from the roster); until the first poll names it, fall back to a
  // repo-keyed dir so a stale-server daemon still works.
  let wikiProjectId = null;
  const vaultDirFor = () =>
    wikiProjectId && isSafePathSegment(wikiProjectId)
      ? join(homedir(), '.flowviant', 'vaults', wikiProjectId)
      : join(homedir(), '.flowviant', 'vaults', repoKey);

  // Stream what the wiki turn is doing to the app (the canvas renders the read
  // phase). Throttled to ~1/s — the FIRST activity of a run and the terminal
  // `done` frame force-send so the cover appears fast and clears cleanly.
  let lastProgressAt = 0;
  const postWikiProgress = async (body, force = false) => {
    const now = Date.now();
    if (!force && now - lastProgressAt < 600) return;
    lastProgressAt = now;
    // Uplink scrub: narration/labels can quote repo content, and repo content
    // can contain a synced secret — redact known values before anything leaves
    // this machine.
    const safe = {
      ...body,
      ...(typeof body.activity === 'string' ? { activity: envScrub(body.activity) } : {}),
      ...(Array.isArray(body.recent) ? { recent: body.recent.map((s) => envScrub(s)) } : {}),
    };
    try {
      await fetch(WIKI_PROGRESS_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${FLEET_TOKEN}`,
          'User-Agent': USER_AGENT,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(15_000),
        body: JSON.stringify(safe),
      });
    } catch {
      /* best-effort — a dropped frame is harmless, the next one supersedes it */
    }
  };

  /**
   * Tell the server this daemon has stopped retrying the pending sweep.
   *
   * The retry budget is a `let` in this process; `regen_requested_at` is a
   * durable column with a 24-hour TTL. Without this the two disagreed — the
   * daemon had permanently given up while every surface went on calling the
   * sweep queued, for the rest of the day. Best-effort: an older server 404s
   * once and the TTL is still the backstop it always was.
   */
  const postWikiAbandoned = async () => {
    try {
      await fetch(WIKI_ABANDONED_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${FLEET_TOKEN}`,
          'User-Agent': USER_AGENT,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(15_000),
        body: '{}',
      });
    } catch {
      /* best-effort — the request's own TTL still expires it */
    }
  };

  const enqueueSweep = (job) => {
    if (!job || job.requestedAt === lastSweepAt) return;
    if (job.requestedAt !== sweepAttemptsFor) {
      sweepAttemptsFor = job.requestedAt;
      sweepAttempts = 0;
    }
    lastSweepAt = job.requestedAt;
    // A full sweep is expensive — never stack two. One queued sweep already
    // covers any newer Regenerate click (it reads the repo fresh when it runs).
    // A failed/partial sweep stays recoverable: re-clicking Regenerate always
    // refreshes requestedAt server-side, beating this dedup.
    if (wikiQueue.some((t) => t.type === 'sweep')) return;
    wikiQueue.push({ type: 'sweep' });
    void drainWiki();
  };
  const enqueueReground = (intentId, prUrl, title, dirtiesPages, shas) => {
    if (!intentId || groundedIntents.has(intentId)) return;
    groundedIntents.add(intentId);
    wikiQueue.push({
      type: 'reground',
      intentId,
      prUrl,
      title: title || 'a delivered task',
      // What the PLAN thought this would invalidate. A hint, not the truth —
      // the turn still reads the real changed files; this catches pages whose
      // frontmatter file list has drifted, or that document a concept rather
      // than a directory.
      //
      // SANITIZED AT THE INTAKE, because every entry is server-supplied text
      // that ends up interpolated into a prompt and printed by the drain's
      // narration: a control byte can repaint the console it lands on, a
      // newline can break out of the prompt's own list framing, and an
      // unbounded array of unbounded strings is an unbounded prompt. This is
      // the belt at the intake; the prompt keeps its own fence at the
      // interpolation.
      dirtiesPages: (Array.isArray(dirtiesPages) ? dirtiesPages : [])
        .filter((p) => typeof p === 'string')
        .slice(0, 40)
        .map((p) =>
          p
            .replace(/[\u0000-\u001f\u007f]/g, ' ')
            .trim()
            .slice(0, 300)
        )
        .filter(Boolean),
      // THE COMMITS THAT SHIPPED — what changedFilesForShas resolves against.
      // Dropping this here was the whole 0.54.0/0.54.1 defect: the server sent
      // shas on every reground job, this function never stored them, and the
      // drain's `task.shas` was undefined on every job — so the re-ground
      // "revived" on 2026-08-22 retried three times against nothing and gave
      // up, on a console nobody reads, on every single ship.
      shas: Array.isArray(shas) ? shas : [],
    });
    void drainWiki();
  };

  // Changed files of a (merged) PR, for the re-ground prompt. Capped so a huge
  // PR can't blow up the prompt. prUrl was already validated before the merge.
  // WHICH FILES A SHIP CHANGED, read from the commits it landed.
  //
  // This asked `gh pr view <prUrl> --json files` until 2026-08-22, and `prUrl`
  // has been null by construction since dispatch was deleted on 2026-08-19 —
  // the server writes null and says so in a comment. Node threw on the null
  // argument, the catch below read it as "gh failed", and the re-ground retried
  // three times and gave up. Every post-ship re-ground for three months did
  // that silently, while the spec said ship re-grounds the wiki.
  //
  // Returns null when it learned NOTHING (no shas, or none of them resolvable),
  // which the caller still treats as retryable — distinct from a ship that
  // genuinely changed no files.
  const changedFilesForShas = (shas) => {
    if (!Array.isArray(shas) || shas.length === 0) return null;
    const files = new Set();
    for (const sha of shas.slice(0, 50)) {
      if (!/^[0-9a-f]{7,40}$/i.test(String(sha))) continue;
      try {
        const out = execFileSync(
          'git',
          ['show', '--name-only', '--pretty=format:', String(sha)],
          { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
        );
        for (const line of out.split('\n')) {
          const f = line.trim();
          if (f) files.add(f);
          if (files.size >= 60) break;
        }
      } catch {
        // One unreachable commit is not a failed re-ground — the ship merged
        // to main and the rest of the shas still name real files. Only an
        // EMPTY result is treated as "we learned nothing".
      }
      if (files.size >= 60) break;
    }
    return files.size ? [...files] : null;
  };
  const regroundAttempts = new Map(); // intentId -> gh-failure count

  async function drainWiki() {
    if (wikiBusy || wikiQueue.length === 0) return;
    /**
     * NOT WHILE THE BOX IS UNDER PRESSURE. A sweep is a CLI reading a whole
     * repository, which is the heaviest turn the daemon runs and the one
     * nobody is waiting on — so it is the first thing to yield.
     *
     * The queue is left INTACT: nothing is claimed, nothing is consumed, and
     * the reconcile loop calls this again on its next poll. The one thing that
     * must not happen is setting `wikiBusy` and returning, which would strand
     * the drain until a restart.
     */
    const hold = admit('churn');
    if (hold) {
      // Said at most every five minutes: this runs on every poll, and a queued
      // sweep can sit through a long stretch of pressure — a line every twenty
      // seconds would be the console restating one unchanged fact all evening.
      if (Date.now() - wikiHoldSaidAt > 5 * 60_000) {
        wikiHoldSaidAt = Date.now();
        note(`${c.cyan('wiki')} ${c.dim(`— holding off: ${hold.reason}`)}`);
      }
      return;
    }
    wikiHoldSaidAt = 0;
    wikiBusy = true;
    // Held for the WHOLE drain: this loop resets the worktree between tasks, and
    // a consult reading it mid-reset sees files vanish under it.
    return withWikiLock(async () => {
    try {
      while (wikiQueue.length) {
        const task = wikiQueue.shift();
        // The vault is plain files — the turn needs no MCP server and no
        // cartographer token; the daemon itself syncs afterwards on the fleet
        // credential.
        // Guard the mkdir: this runs OUTSIDE the per-task try below, so an
        // ENOSPC/EACCES here (disk full is an anticipated prod condition —
        // worktrees + vault history grow) would escape drainWiki as an unhandled
        // rejection and take down the whole daemon mid-work. Skip this sweep on
        // failure instead.
        let vaultDir;
        try {
          vaultDir = vaultDirFor();
          ensureVault(vaultDir);
        } catch (e) {
          warn(`wiki sweep skipped — vault dir unavailable: ${e?.message || e}`);
          continue;
        }
        // Live progress for this turn: a rolling FEED of everything Claude does
        // (thinking, narration, reads, node writes), the file count, and the
        // phase — streamed to the app (throttled; each frame carries the whole
        // recent tail so a dropped POST loses nothing). elapsedSec is the
        // daemon's own clock.
        const mode = task.type === 'sweep' ? 'sweep' : 'reground';
        const startedAt = Date.now();
        let filesRead = 0;
        let phase = 'reading';
        // Distinct vault pages this turn has written. Counted HERE, from the
        // stream, because it is the only place that knows mid-turn: the daemon
        // syncs the vault to the server once, AFTER the turn returns, so a
        // server-side count of "rows touched since the turn began" is zero for
        // the entire writing phase — which is exactly how long the bar needs it.
        // A Set, not a counter: pages get written once and then edited, and
        // three tool calls on one page are one page.
        const pagesSeen = new Set();
        const feed = [];
        const frame = (extra) => ({
          mode,
          phase,
          activity: feed[feed.length - 1] ?? '',
          recent: feed.slice(-24),
          filesRead,
          pagesWritten: pagesSeen.size,
          elapsedSec: Math.round((Date.now() - startedAt) / 1000),
          ...extra,
        });
        const onActivity = (a) => {
          if (a.kind === 'read') filesRead++;
          if (a.kind === 'write') {
            phase = 'writing';
            pagesSeen.add(a.path || a.label);
          }
          // Collapse runs of bare "thinking…" so the feed doesn't fill with it.
          // Keyed on the SHARED constant (runtimes.mjs), not on the literal: the
          // labels being compared here are the ones claude.mjs now builds from
          // that constant, so a reworded marker would leave this comparison
          // matching nothing and the 48-slot feed filling with the repeat — the
          // exact noise this line exists to stop, and silent, because a collapse
          // that stops collapsing fails no test.
          if (!(a.label === THINK_MARKER && feed[feed.length - 1] === THINK_MARKER)) {
            feed.push(a.label);
            if (feed.length > 48) feed.shift();
          }
          void postWikiProgress(frame());
        };
        // Heartbeat: re-send the current frame every 5s even with no new stream
        // event, so the app's freshness window never lapses during a long
        // thinking block or slow tool (which emit nothing until they finish) —
        // otherwise the cover would flap back to the empty state mid-sweep.
        let heartbeat = null;
        /**
         * Did THIS sweep finish? Read by the `finally` below, which owns the
         * retry decision for every way out of this block.
         *
         * It used to be decided inline on the one branch where the turn
         * returned without its sentinel — so the two OTHER ways a sweep fails,
         * `pickRuntimeFor` finding no CLI and the catch around the whole turn,
         * left the request pinned and never retried at all. Those are the
         * failures most worth retrying: a missing runtime is fixed by
         * installing one, and a thrown turn is exactly the transient case.
         */
        let sweepCompleted = false;
        try {
          // Immediate frame so the cover shows the daemon feed right away (the
          // "reading your code" phase), not a static message, while Claude warms up.
          feed.push('starting…');
          await postWikiProgress(frame(), true);
          heartbeat = setInterval(() => void postWikiProgress(frame(), true), 5000);
          if (!existsSync(wikiWt)) {
            try {
              git(['worktree', 'add', '--detach', wikiWt, baseRef], repoRoot);
            } catch {
              git(['worktree', 'prune'], repoRoot);
              git(['worktree', 'add', '--detach', wikiWt, baseRef], repoRoot);
            }
          }
          resetWorktree(wikiWt, baseRef);
          let sha = '';
          try {
            sha = git(['rev-parse', 'HEAD'], wikiWt);
          } catch {
            /* detached/no HEAD — still writes the map, just ungrounded */
          }
          // Sync the vault after the turn regardless of the sentinel: a died
          // sweep's partial pages still persist (merge, no prune) — only a
          // COMPLETED sweep finalizes, so an interrupted one can't erase pages.
          const runSync = async (finalize) => {
            try {
              const r = await syncVault({
                dir: vaultDir,
                url: WIKI_VAULT_URL,
                token: FLEET_TOKEN,
                userAgent: USER_AGENT,
                finalize,
                groundedAtSha: sha || undefined,
                // Powers the GitHub blob links behind every cited file path.
                repoFullName: originSlug(repoRoot) || undefined,
                warn,
                // Redact synced secrets a page may have quoted from the repo.
                scrub: envScrub,
              });
              if (r.skipped) note(`${c.cyan('wiki')} ${c.dim('— vault unchanged, nothing to sync')}`);
              else
                ok(
                  `${c.cyan('wiki')} ${c.dim(
                    `— synced ${r.uploaded} page${r.uploaded === 1 ? '' : 's'} (${r.pages} total${r.deleted ? `, ${r.deleted} removed` : ''})`
                  )}`
                );
            } catch (e) {
              warn(`wiki vault sync failed: ${e.message} — pages stay local; next turn retries`);
            }
          };
          // The cartographer needs to read the repo and write ONLY the vault —
          // a narrower promise than "build", so it is its own profile.
          const wikiRt = pickRuntimeFor('wiki');
          if (!wikiRt) {
            warn('wiki generation skipped — no installed CLI can run a vault-scoped turn');
            return;
          }
          const wikiLabel = RUNTIMES[wikiRt].label;
          if (task.type === 'sweep') {
            sweepAttempts++;
            note(`${c.cyan('wiki')} ${c.dim(`— regenerating: your ${wikiLabel} is reading the repo…`)}`);
            const out = await runTurn({
              prompt: WIKI_KICKOFF(sha, vaultDir),
              resume: false,
              system: SYSTEM_WIKI(vaultDir),
              cwd: wikiWt,
              wikiPerm: true,
              vaultDir,
              runtime: wikiRt,
              label: c.cyan('[wiki]'),
              streamJson: true,
              onActivity,
              // FREE SKILLS, off a turn that was running anyway. This stream is
              // already parsed and its init event already carries the CLI's own
              // resolved skill set — the same fact a tab turn teaches — so the
              // only thing missing was the handler. The wiki turn runs in a
              // detached worktree of THIS repo, so its `.claude/skills` and the
              // machine's personal ones resolve identically to a tab's.
              onInit: (i) => {
                recordSkills(i.skills);
                recordMcpServers(i.mcpServers);
              },
              onSpawn: (ch) => {
                wikiChild = ch;
              },
            });
            const complete = sawSentinel(out, 'WIKI_DONE');
            if (complete) {
              sweepCompleted = true;
              ok(`${c.cyan('wiki')} ${c.dim('— vault regenerated from your code.')}`);
            } else {
              warn('wiki sweep ended without WIKI_DONE — partial pages synced');
            }
            await runSync(complete);
          } else {
            const files = changedFilesForShas(task.shas);
            if (files === null) {
              // gh failed (network/auth) — retry via the durable job a couple
              // of times before consuming it, so a transient outage doesn't
              // silently drop the re-ground.
              const n = (regroundAttempts.get(task.intentId) ?? 0) + 1;
              regroundAttempts.set(task.intentId, n);
              if (n < 3) {
                warn(`wiki re-ground for "${task.title}": no changed files resolved — will retry (${n}/3)`);
                groundedIntents.delete(task.intentId); // let the roster re-offer it
                continue;
              }
              warn(`wiki re-ground for "${task.title}": could not resolve changed files ${n} times — giving up (heals on the next full sweep)`);
            } else if (files.length === 0) {
              note(`${c.cyan('wiki')} ${c.dim(`— "${task.title}": no changed files to re-ground`)}`);
            } else {
              note(`${c.cyan('wiki')} ${c.dim(`— re-grounding after "${task.title}"…`)}`);
              const out = await runTurn({
                prompt: REGROUND_KICKOFF({
                  sha,
                  title: task.title,
                  files,
                  vaultDir,
                  predictedPages: task.dirtiesPages ?? [],
                }),
                resume: false,
                system: SYSTEM_REGROUND(vaultDir),
                cwd: wikiWt,
                wikiPerm: true,
                vaultDir,
                runtime: wikiRt,
                label: c.cyan('[wiki]'),
                streamJson: true,
                onActivity,
                // Same free harvest as the sweep above.
                onInit: (i) => {
                  recordSkills(i.skills);
                  recordMcpServers(i.mcpServers);
                },
                onSpawn: (ch) => {
                  wikiChild = ch;
                },
              });
              if (sawSentinel(out, 'REGROUND_DONE'))
                ok(`${c.cyan('wiki')} ${c.dim(`— vault updated for "${task.title}".`)}`);
              else warn(`wiki re-ground for "${task.title}" ended without REGROUND_DONE.`);
              await runSync(false);
            }
            // Consume the durable job: attempted = done (success or not — the
            // sync is idempotent and a failed turn heals on the next full
            // sweep), so a failing re-ground can't loop-burn quota. Only a
            // crash BEFORE this line leaves the job listed for a retry.
            regroundAttempts.delete(task.intentId);
            await reportMergeOutcome(REGROUND_DONE_URL, { taskId: task.intentId });
            // The dedup was DAEMON-LIFETIME, which wedged a reopened card: its
            // second ship writes a fresh durable job, this Set still holds the
            // taskId, enqueueReground refuses it on every poll forever, and
            // the never-consumed job churns the wiki-writer lease until a
            // restart. The job is consumed now, so the guard has done its work;
            // a FUTURE ship of the same card is new work, not a duplicate.
            groundedIntents.delete(task.intentId);
          }
        } catch (e) {
          warn(`wiki ${task.type} failed: ${e.message}`);
        } finally {
          wikiChild = null;
          if (heartbeat) clearInterval(heartbeat);
          /**
           * THE RETRY DECISION, IN ONE PLACE, FOR EVERY WAY OUT OF THIS BLOCK.
           *
           * Deciding it inline on the no-sentinel branch covered one of the
           * three ways a sweep fails and silently declined the other two. Here
           * it covers the thrown turn and the no-runtime return as well, which
           * are the two most worth retrying.
           *
           * A successful sweep resets the budget. A failed one with budget left
           * clears `lastSweepAt` so the roster's next offer of the SAME request
           * is accepted — partial pages are synced without pruning either way,
           * so a retry resumes rather than starting over. A failed one with the
           * budget spent tells the SERVER, because the counter is process-local
           * and the request it bounds is durable for 24 hours.
           */
          if (task.type === 'sweep') {
            if (sweepCompleted) {
              sweepAttempts = 0;
            } else if (sweepAttempts < MAX_SWEEP_ATTEMPTS) {
              lastSweepAt = null;
              warn(`wiki sweep failed — retrying (${sweepAttempts}/${MAX_SWEEP_ATTEMPTS})`);
            } else {
              warn(
                `wiki sweep failed ${sweepAttempts} times — giving up on this request; press Regenerate to try again.`
              );
              await postWikiAbandoned();
            }
          }
          // Terminal frame so the app cover clears promptly (don't wait for the
          // freshness window to lapse). force-sent past the throttle.
          await postWikiProgress(frame({ done: true }), true);
          // Safety net: the wiki turn is read-only on the repo by CONTRACT, but
          // permission enforcement is a curated tool list, not a path jail —
          // discard anything a confused turn wrote to the worktree so it can
          // never leak into a later turn or a push.
          try {
            resetWorktree(wikiWt, baseRef);
          } catch {
            /* best-effort */
          }
        }
      }
    } finally {
      wikiBusy = false;
    }
    });
  }

  let connected = false; // log the first successful poll once
  let rosterSig = null; // last roster membership, to log changes only
  let idleBeatAt = 0; // throttle the "still alive" idle heartbeat
  let cappedWarned = false; // say once, not every reconcile, why extra lanes idle
  // WHOSE MACHINE THIS IS, as of the last poll the server arbitrated. 'absent'
  // is the reserved meaning — an older server, or a poll with no envpub — and
  // everything downstream of it must read exactly as it did before 0.84.0.
  const holderWatch = createHolderWatch({ say: (m) => note(m) });
  let holderState = 'absent';

  // ── Push channel: a server wake short-circuits the reconcile sleep so a job is
  // picked up in ~a round trip instead of on the next poll. The socket only
  // nudges — we still fetch the roster below — so it's pure latency, and the
  // poll stays the fallback whenever the socket is down. `waitReconcile()`
  // resolves on either a wake or the RECONCILE_SECONDS timeout, whichever first.
  let wakeSignal = null; // { resolve, timer } while the loop is idling
  let pendingWake = false; // a wake that landed mid-reconcile — honored next wait
  const fireWake = () => {
    if (wakeSignal) {
      clearTimeout(wakeSignal.timer);
      const { resolve } = wakeSignal;
      wakeSignal = null;
      resolve();
    } else {
      pendingWake = true; // not idling right now; don't lose the wake
    }
  };
  const waitReconcile = () => {
    if (pendingWake) {
      pendingWake = false;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        wakeSignal = null;
        resolve();
      }, RECONCILE_SECONDS * 1000);
      wakeSignal = { resolve, timer };
    });
  };
  stream = connectStream({ onWake: () => fireWake(), isAlive: () => daemonAlive });

  // Which agents to tell the server we already hold a good token for. We keep
  // our token (omit a re-mint) UNLESS it's near expiry AND the worker is idle
  // (no child mid-turn) — then we drop it from `have` to force a fresh token,
  // safely between turns so we never swap a credential out from under a run.
  const buildHave = () =>
    [...tokenByAgent.keys()].filter((id) => {
      const ageS = (Date.now() - (mintedAt.get(id) ?? 0)) / 1000;
      const nearExpiry = ageS > leaseTtlSeconds - REFRESH_BEFORE_SECONDS;
      const midTurn = workers.get(id)?.state.child != null;
      return !nearExpiry || midTurn;
    });

  // Reconcile loop: poll roster, start new workers, stop removed ones.
  for (;;) {
    let roster;
    try {
      // The churn admission, asked ONCE here and relayed as `pr`: the same
      // question every unattended lane asks a few lines later, so what the
      // board is told and what the machine then does cannot disagree.
      roster = await fetchRoster(
        buildHave(),
        livePreviewIds(),
        heldSessionIds(),
        admit('churn'),
        repoRoot
      );
    } catch (e) {
      if (e.auth) {
        fail(`${e.message} — credential revoked or invalid. Shutting down.`);
        teardown();
        // EXIT 0, for the same reason the commanded-stop path does: a revoked
        // credential is a terminal, asked-for-by-someone state, and a relaunch
        // can never fix it. Under `Restart=on-failure` a nonzero code has
        // systemd relaunch the daemon immediately — a restart loop hammering
        // dead-credential polls, fighting the Disconnect that revoked it, and
        // ending in a unit that reads as a crash rather than a kill.
        process.exit(0);
      }
      warn(`roster poll failed: ${e.message} — retrying in ${RECONCILE_SECONDS}s`);
      await sleep(RECONCILE_SECONDS);
      continue;
    }
    if (!connected) {
      connected = true;
      ok('Connected to Flowviant — watching your roster.');
      // Name the scoped project so a mismatch (this daemon serves project A, but
      // you're viewing project B's wiki) is obvious instead of a silent no-op.
      if (roster.project) {
        note(
          `${c.cyan('project')} · ${c.bold(projectLabel({ name: roster.project.name, projectId: roster.project.id }))} ${c.dim(`(${safeName(roster.project.id) ?? ''})`)}`
        );
        note(c.dim('  wiki + agents stream to THIS project — view its Code canvas in Flowviant.'));
        // Remember the NAME beside the stored credential, so the picker and
        // `flowviant projects` can say "skadooble" instead of an id — a
        // credential saved before the server sent names backfills here. No-op
        // for a --fleet/env token (nothing stored to annotate).
        setStoredProjectName(roster.project.id, roster.project.name);
      }
      /**
       * WHAT ELSE IS SERVING THIS PROJECT — said ONCE, right after the first
       * poll lands, and never again (0.91.0).
       *
       * The owner could not answer a plain question about his own setup: "im
       * not sure if i have any duplicate or redundant daemons running". This is
       * the half of the answer that belongs in the terminal you just typed
       * into, because that is where you are standing when the question occurs
       * to you — the app's Home is where the whole account's answer lives.
       *
       * A RELAY, and it withholds nothing on failure: an older server has no
       * boxes route and 404s, which prints NOTHING rather than a complaint
       * about a feature nobody asked for. Fire-and-forget and never awaited on
       * the poll path — a listing must never delay a roster tick.
       */
      void (async () => {
        try {
          const { boxesUrlFrom, fetchBoxesFor, otherBoxesLine } = await import('./machines.mjs');
          const res = await fetchBoxesFor(
            { fleetToken: FLEET_TOKEN },
            { url: boxesUrlFrom(FLEET_URL), envpub: myPubB64() ?? undefined }
          );
          if (!res.boxes) return;
          const line = otherBoxesLine(res.boxes, res.me);
          if (line) note(line);
        } catch {
          /* a readout — it must never disturb the daemon that produced it */
        }
      })();
    }
    if (roster.mcpUrl) mcpUrl = roster.mcpUrl;
    /**
     * HOW MANY TURNS THE APP SAYS THIS MACHINE MAY RUN (2026-09-17).
     *
     * Set on EVERY poll, including the ones that carry no key — absence is how
     * "Auto" is spelled and how an older server looks, and both mean the
     * derivation stands. Leaving a previous value in place on an absent key
     * would make turning the dial back to Auto unspellable, which is the
     * learn-only bug `listSessionPlaces` already paid for once.
     *
     * HERE, ABOVE EVERY LANE, so a number that arrived on this poll binds the
     * spawns this same reconcile is about to decide. The `mt` the NEXT poll
     * reports is therefore the value that was actually in force.
     */
    setServerMaxTurns(roster.maxTurns);
    if (roster.project?.id) wikiProjectId = roster.project.id; // keys the vault dir
    // The server's word on which project this token serves — settles the env
    // report's salt for a token that came from --fleet or the environment.
    learnProjectId(roster.project?.id);
    if (roster.leaseTtlSeconds) leaseTtlSeconds = roster.leaseTtlSeconds;
    // A COMMANDED STOP OUTRANKS AN UPDATE, and that ordering is the whole reason
    // this sits ABOVE the version signal rather than inside it. Both read the
    // same `roster.daemon` object, but `handleVersionSignal` can re-exec this
    // process into a newer build — so checked second, a machine somebody just
    // told to stop would come back up wearing a different version instead of
    // going away.
    const stopSignal = shouldStop(roster.daemon);
    if (stopSignal) {
      warn(
        stopSignal.reason
          ? `stopped by Flowviant — ${stopSignal.reason}`
          : 'stopped by Flowviant — no reason given.'
      );
      note('shutting down — stopping workers. Worktrees are kept: in-flight work resumes next run.');
      // FLUSH the settle queue first, bounded: a queued-but-undelivered report
      // is a COMPLETED turn whose side effects already happened, and dropping
      // it re-runs the whole turn on the next start — quota spent twice and
      // every card write doubled. This path is async (unlike the signal
      // handlers, which cannot await), so the stop can afford five seconds of
      // delivery before it obeys.
      try {
        await Promise.race([flushWorkReports(), sleep(5)]);
      } catch {
        /* undelivered reports re-run; delivering them was best-effort */
      }
      // teardown() is NOT optional on this path. Detached preview tunnels
      // survive this process BY DESIGN, so exiting without it strands a public
      // hostname pointed into a worktree until somebody reboots the box — which
      // is precisely the state a remote stop is usually being used to end. It
      // also kills the session CLIs and the wiki Claude, which would otherwise
      // keep editing worktrees and burning quota for a machine nobody is
      // watching any more.
      teardown();
      // EXIT 0, and this is load-bearing: the stop was ASKED FOR, so it is not
      // a failure. Under `Restart=on-failure` a nonzero code has systemd
      // relaunch the daemon immediately, fighting the very command that stopped
      // it; exit 0 reads as "the job is done" and leaves it down. The server's
      // honor window is what makes the other half work — a deliberate relaunch
      // minutes later comes up clean instead of stopping itself forever.
      process.exit(0);
    }
    /**
     * THE MACHINE MOVED OUT FROM UNDER US — checked BEFORE the version signal
     * for the reason the stop above is: `handleVersionSignal` can re-exec this
     * process, and a box that has just been displaced coming back up wearing a
     * newer version is the one outcome nobody asked for.
     *
     * The key's PRESENCE is the command, exactly as it is for a stop: the server
     * sends it only when it names THIS box's `envpub` and only inside its own
     * window, so there is no TTL to re-evaluate here and no way for a relaunch
     * to obey a displacement aimed at somebody else.
     */
    if (roster.displaced && typeof roster.displaced === 'object' && !Array.isArray(roster.displaced)) {
      await standDownDisplaced({
        by: roster.displaced.by,
        settleAgentTurns,
        flushReports: flushWorkReports,
        teardown,
        exit: (code) => process.exit(code),
        log: { warn, note },
      });
      return;
    }
    /**
     * REMOVED FROM THE PROJECT IN THE APP — the second way this box stops being
     * this project's machine, and it goes through the same door for the same
     * reason (2026-09-21).
     *
     * IMMEDIATELY AFTER THE DISPLACEMENT, AND BEFORE THE VERSION SIGNAL, which
     * is the ordering the stop and the displacement above both document:
     * `handleVersionSignal` can RE-EXEC this process, and a box that was just
     * removed coming back up wearing a newer version is the one outcome nobody
     * asked for. The two removal-shaped signals sit together so a reader cannot
     * find one without the other.
     *
     * THE KEY'S PRESENCE IS THE COMMAND, exactly as it is for a stop and a
     * displacement: the server sends it only when it names THIS box and only
     * inside its own window, so there is no TTL to re-evaluate here and no way
     * for a relaunch to obey a removal aimed at somebody else.
     *
     * The choreography is identical — settle every in-flight turn, flush the
     * queued reports, tear down the detached children, keep the worktrees,
     * exit 0 — and only the sentences differ. Exit 0 for the reason every
     * terminal path here states: this was ASKED FOR, so under
     * `Restart=on-failure` a nonzero code would relaunch the daemon straight
     * into being removed again.
     */
    if (roster.standDown && typeof roster.standDown === 'object' && !Array.isArray(roster.standDown)) {
      await standDownDisplaced({
        kind: 'removed',
        // The project's NAME rather than the box that took over, because no box
        // took over. Falls back to "this project" inside — an unnamed project
        // says so rather than being guessed at.
        project: safeName(roster.standDown.project) ?? safeName(roster.project?.name) ?? undefined,
        settleAgentTurns,
        flushReports: flushWorkReports,
        teardown,
        exit: (code) => process.exit(code),
        log: { warn, note },
      });
      return;
    }
    /**
     * WHOSE MACHINE THIS IS. Absent = a server that does not arbitrate, and then
     * this is a no-op and the daemon behaves exactly as 0.83.0 did.
     *
     * A standby keeps polling and keeps everything the restricted roster still
     * drives — its `activeWorkSessions` is credential-scoped and correct, so the
     * sweep below is unchanged behaviour and must not be skipped, or a standby
     * would start deleting worktrees it cannot see the tabs for.
     */
    holderState = holderWatch.observe(roster.holder);
    // Keep the daemon current. Safe = no worker mid-task (true at startup, since
    // no workers are spawned yet). If it self-updates it re-execs into the new
    // version and this process becomes a proxy — stop the loop.
    if (roster.daemon) {
      // "No worker mid-task" must include the wiki runner: updating mid-sweep
      // re-execs the daemon, orphans the wiki Claude, and the fresh process
      // starts a second sweep racing it on the same vault. And it must include
      // SESSION work (workBusy — turns, ships, undelivered settle reports):
      // dispatch workers' children say nothing about the Workbench tabs, and a
      // re-exec mid-turn SIGTERMs the tab's CLI and settles a partial answer.
      const safeToUpdate =
        !wikiBusy &&
        !workBusy() &&
        [...workers.values()].every((w) => w.state.child == null);
      const updating = handleVersionSignal({
        latest: roster.daemon.latest,
        min: roster.daemon.min,
        autoUpdate: AUTO_UPDATE,
        safeToUpdate,
        teardown,
      });
      if (updating) return;
    }
    // Settle any turn/ship answers whose earlier report POST failed BEFORE
    // taking new work — the skip-if-pending guards make the ordering safe, but
    // delivering first keeps the tab honest a poll sooner.
    void flushWorkReports();
    processMergeJobs(roster.mergeJobs);
    processPatchRevertJobs(roster.patchRevertJobs);
    // WHERE each live tab works, BEFORE anything measures one: the sweep below
    // and every preview check ask `placeOf`, and a tab nobody has typed into
    // yet has taught it nothing.
    learnPlaces(roster.sessionPlaces);
    processWorkTurns(roster.workTurnJobs);
    // The roster's live-session list rides along: an ENDED session's ship
    // must not be refused by checks whose remedies need a live tab.
    processShipJobs(roster.shipJobs, roster.activeWorkSessions);
    // AFTER the work/ship intake: retirement is the server saying which
    // sessions are LIVE, and the guards above (chains, shipping) are populated
    // by the intake this same tick.
    // BEFORE retirement, and the order is load-bearing: `git worktree remove`
    // under a running dev server leaves it serving bytes from open file handles
    // in a directory that no longer exists — a human is shown the wrong thing
    // and nothing errors anywhere.
    retirePreviews(roster.activeWorkSessions);
    // THEN the process the tunnel pointed at, and only then the worktree. A
    // viewer must not see a 502 from a gate whose origin vanished, and
    // `retireWorkSessions`'s dirty check inspects only TRACKED files — so
    // `git worktree remove` would happily pull the directory out from under a
    // running node process, which then serves bytes from open file handles in
    // a directory that no longer exists, with no error anywhere.
    /**
     * WHERE SHIP LANDS, if a human has chosen. Absence means "you decide" —
     * the state every daemon was in before this existed, and what an
     * unconfigured project still means — so it must NOT clear a detection.
     * Announced on change, because a silent switch of merge target is the one
     * thing worse than not offering the choice at all.
     */
    if (typeof roster.baseBranch === 'string' && roster.baseBranch.trim()) {
      const want = `origin/${baseBranchName(roster.baseBranch.trim())}`;
      if (want !== baseRef) {
        note(`base   · ${want} ${c.dim('(set for this project)')}`);
        baseRef = want;
      }
    }
    // A session another daemon on this credential is serving is NOT a closed
    // tab. Without this the daemon that lost the lease removes the worktree the
    // winner is working in — absence would mean "somebody else won" instead of
    // "the tab closed".
    retireWorkSessions(roster.activeWorkSessions, roster.sessionsHeldElsewhere);
    // Diffs somebody has open and is waiting on. Project-scoped rather than
    // per-session: `git show` runs from the repo ROOT, which can see a closed
    // tab's branch and a shipped commit on main alike.
    processDiffJobs(roster.diffJobs);
    // The knowledge library: synced when its rev moves, left ALONE when the key
    // is absent (an older server, or a project that never had one). Never
    // awaited — a fifty-megabyte library must not hold a roster tick, and the
    // sync serialises itself. The next turn to spawn after it lands reads it.
    void knowledgeSync.onRoster(roster.knowledge);
    // ARTIFACTS (0.94.0): the server's own word on whether it can show one,
    // re-read every poll. Absent is an older server and means false — the turn
    // prompts then say nothing about a panel nobody can draw.
    artifactsAccepted = roster.artifactsAccepted === true;
    // Shares to open or tear down. CLAIMED before acted on — two daemons on one
    // credential are both handed this array, and both opening a tunnel strands
    // a public hostname nobody can settle.
    processPreviewJobs(roster.previewJobs);
    // One measured process a human asked to stop. Claimed before acted on for
    // the same reason a share is, and re-verified against the kernel inside —
    // the pid on this job is a request, never an authority, because pids are
    // recycled and the row the browser clicked is up to a sweep old.
    processKillJobs(roster.killJobs);
    // PR-mode work (push + open, or merge) — leased like a kill: two daemons
    // pushing one branch would open two PRs. Runs under the operator's own
    // `gh` credential; a settle never closes a card (done is observed by the
    // landed walk when the merge reaches base).
    processPrJobs(roster.prJobs);
    // A Deploy press waiting for a plan. AFTER the job lanes above and before
    // the worktree report, for no reason other than that it reads directories
    // those lanes may still be writing — it measures, so a stale read is a
    // slightly worse hint and never a wrong action.
    processAgentPlanJobs(roster.agentPlanJobs);
    // …and an agent's next card. After the plan jobs because a press becoming
    // agents is the thing that produces these.
    processAgentTurnJobs(roster.agentTurnJobs);
    // …and a branch somebody approved. After the turns: a merge takes the
    // place's WRITER lock, and writer preference means it goes ahead of any
    // reader queued behind it anyway.
    processAgentMergeJobs(roster.agentMergeJobs);
    // Catch each person's manual worktree up to base while it is clean. Silent,
    // fast-forward only, and it never touches an agent's branch.
    freshenManualPlaces();
    // …and what the SURVIVING ones hold: branch, ahead-of-base, diffstat.
    // Throttled inside, never awaited — a `git status` the human cannot run
    // themselves from a browser, relayed. After retirement so a directory that
    // just went away is not reported as a place.
    reportWorktrees(roster.activeWorkSessions);
    // Terminal-session presence, throttled + dedup'd inside; never awaited —
    // the daemon's own worktrees are carved out (a session the daemon spawned
    // is already a tab, not something to offer adopting).
    void maybeReportLocalSessions({
      repoRoot,
      excludeDirs: [baseDir],
      // …and our OWN tabs' conversations. Only the CHECKOUT needs this: every
      // other place is under `baseDir` and already fenced by directory, while
      // the operator's tabs share the checkout with real terminal sessions and
      // cannot be. See `ourConversationIds`.
      excludeIds: ourConversationIds(repoRoot),
    });
    // …and the repo itself: every worktree and every branch, ours and not.
    // Never awaited, throttled inside, and silent on an older server.
    void maybeReportRepoState({ repoRoot, baseRef });
    // WHAT `/` CAN OFFER, on a machine no turn has taught yet. One-shot and
    // self-cancelling (it returns immediately if a turn has already reported),
    // never awaited, and it lands in the cache that the NEXT poll reads — so
    // nothing here waits on a child process. In the loop rather than at
    // startup on purpose: a daemon that has been up since before this release
    // gets measured too, without needing a restart to earn its own menu.
    probeSkillsOnce(repoRoot);
    processCleanupJobs(roster.cleanupJobs);
    const rosterIds = new Set(roster.agents.map((a) => a.agentId));

    // Announce roster size only when it changes (not every poll).
    const sig = [...rosterIds].sort().join(',');
    if (sig !== rosterSig) {
      rosterSig = sig;
      // `agents` is permanently [] — the lanes it counted died with dispatch
      // and the array survives only as wire compat, so this runs once, on the
      // first poll. It used to point at the Cockpit, a surface deleted
      // 2026-08-04 that now redirects to the Board. Say what is actually true
      // instead: the machine is up, and work starts in a tab.
      // …unless another box holds the machine. A standby IS connected and IS
      // polling, and saying "machine online" over a daemon the server hands
      // nothing would contradict the standby line printed a moment earlier.
      if (holderState !== 'standby')
        info('Machine online. Open a tab in Flowviant → Workbench to start working.');
    }
    // Heartbeat so a quiet daemon visibly stays alive. Gated on REAL work —
    // `rosterIds` is built from `roster.agents`, which the server sends
    // permanently empty, so gating on it printed "waiting" once a minute even
    // while a tab's turn was running. `workBusy()` is the honest question: are
    // there session turns, ships or unsettled reports in flight?
    if (!workBusy() && Date.now() - idleBeatAt > 60_000) {
      idleBeatAt = Date.now();
      // `inactive`, the owner's own word for this state since 2026-09-21 — the
      // same word the app's machines list and `flowviant machines` print for
      // this box. The internal state is still called `standby` because it names
      // the SERVER'S arbitration arm rather than anything a person reads; what
      // a person reads is this sentence.
      info(
        holderState === 'standby'
          ? 'inactive — another machine is serving this project.'
          : 'machine online — nothing running right now.'
      );
    }

    // Living-wiki work (runs under its own minted wiki token — no agent
    // needed). enqueueSweep queues a Regenerate; regroundJobs re-offers merged
    // deliveries whose re-ground never ran (e.g. we restarted between merge and
    // turn) until we report reground-done; the bare drain flushes anything
    // whose earlier mint failed.
    enqueueSweep(roster.codeMapJob);
    for (const j of roster.regroundJobs ?? []) {
      const rid = j && (j.taskId ?? j.intentId); // new name first, old as fallback
      if (!j || typeof rid !== 'string') continue; // a null element would throw + wedge the loop
      enqueueReground(rid, j.prUrl, j.title, j.dirtiesPages, j.shas);
    }
    void drainWiki();

    // WHAT IS IN THIS BOX'S ENV, by name, on its own 60s beat. Never awaited,
    // throttled and deduped inside, and silent forever on an older server.
    // This is what replaced the vault's sync tick — see `maybeReportEnv`.
    void maybeReportEnv(repoRoot);
    void maybeReportTools(repoRoot, getBaseRef());

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
    void reportMergeOutcome(
      MACHINE_URL,
      machineSnapshot({
        worktreeDir: baseDir,
        tasks: liveTurns().map((t) => ({ intentId: t.id, pid: t.pid })),
      })
    );

    // Deploy: a daemon on a project with deploy ALLOWED reports its
    // .flowviant/deploy.json and runs queued deploy jobs (the server only sends
    // deployJobs to such projects). Config report is cheap + dedup'd; jobs are
    // single-flight.
    //
    // `roster.deployAllowed`, a top-level boolean the server sends only when
    // TRUE — it used to be `roster.env.deployAuthorized`, read off the vault's
    // own roster block. The fact never belonged there: since migration 0096 the
    // answer comes from the PROJECT row (`projects.deploy_allowed`, owner-only,
    // off by default), not from a per-device column on an enrolled daemon —
    // "every device on a project shares one credential, so a boundary between
    // them is not a boundary". The vault's block is gone; the switch is not, and
    // this is where it now arrives. Absence reads as NOT allowed, which is the
    // withholding direction and the right one for an irreversible act.
    if (roster.deployAllowed) {
      // The BASE branch's copy, not the working tree's — see readDeployConfig.
      // Reporting the working tree would advertise targets the runner will not
      // find, which is the same lie in the other direction.
      void reportDeployConfig(repoRoot, getBaseRef());
      processDeployJobs(roster.deployJobs, { repoRoot, baseRef: getBaseRef(), myPubB64 });
    }

    // Stop workers whose agent left the roster (removed in the app).
    for (const [id, w] of [...workers]) {
      if (!rosterIds.has(id)) {
        warn(`${w.label} removed — stopping it now.`);
        w.state.alive = false;
        // Immediate teardown (Q6=B): kill the in-flight Claude process now; its
        // task was already requeued server-side on removal.
        try {
          w.state.child?.kill('SIGKILL');
        } catch {
          /* best-effort */
        }
        // Only poll mode's per-lane tree dies with the lane. A live lane owns no
        // checkout: the task it was building has its own, which must SURVIVE —
        // removing a lane requeues its task, and the next lane to pick that task
        // up resumes in that same directory rather than starting over.
        if (w.wt) {
          try {
            git(['worktree', 'remove', '--force', w.wt], repoRoot);
          } catch {
            /* best-effort */
          }
        }
        workers.delete(id);
        tokenByAgent.delete(id);
        hasWorkByAgent.delete(id);
        nextByAgent.delete(id);
        mintedAt.delete(id); // was leaked on removal (finding 14)
      }
    }

    // Idle until the next poll deadline OR a push wake — whichever comes first.
    await waitReconcile();
  }
}
