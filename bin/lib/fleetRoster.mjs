/**
 * THE ROSTER POLL — what this box tells the server on every beat, and what the
 * first answered poll tells the person at the keyboard.
 *
 * Split out of fleet.mjs (SOLID audit 2026-09-26, F038). `fetchRoster` builds
 * the poll's query string (the box's identity, its CLIs, the admission verdict,
 * the one machine ask) and validates the answer's shape; the loop in fleet.mjs
 * decides what to DO with the answer. They change for different reasons — a
 * new daemon→server param lands here and nowhere else, a new roster key lands
 * in the loop — so they live apart.
 *
 * Every param here is a DAEMON→SERVER report and needs no floor (the report's
 * presence is the capability); absence keeps meaning "an older daemon".
 */

import {
  VERSION,
  FLEET_URL,
  FLEET_TOKEN,
  USER_AGENT,
  SAFE,
  DAEMON_INSTANCE,
  MACHINE_HOST,
  PROCESS_STARTED_AT,
  MAX_CONCURRENT,
} from './config.mjs';
import { projectLabel, safeName, setStoredProjectName } from './credentials.mjs';
import { credentialRejected } from './authReject.mjs';
import { isSafePathSegment } from './git.mjs';
import { c, note, warn } from './ui.mjs';
import { envQueryParams, myPubB64 } from './boxIdentity.mjs';
import { detectRuntimes, runtimesReport } from './runtimeDetection.mjs';
import { knownMcpServers, knownSkills } from './runtimeCapabilities.mjs';
import { effectiveMaxTurns } from './admission.mjs';
import { runtimeOfferings } from './runtimeOfferings.mjs';
import { RUNTIME_LIMITS_PARAM_MAX, runtimeLimitsReport } from './runtimeLimits.mjs';

let warnedEnvIdentity = false;

/**
 * HOW LONG THE POLL'S URL MAY GROW BEFORE AN OPTIONAL READOUT STAYS HOME.
 * The runtime offerings and the plan-limit report are each added only while
 * the whole URL stays under this; the identity and admission params after
 * them are short and always ride.
 */
const POLL_URL_BUDGET = 14_000;

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


export async function fetchRoster(
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
  repoRoot = null,
  baseRef = null
) {
  const url = new URL(FLEET_URL);
  // No `have`: it named the dispatch-era lanes' held tokens, and nothing has
  // held one since 2026-08-19 — the param was built empty, so never sent.
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
  //
  // ALWAYS SENT once detection ran, even EMPTY: '' is "looked and can drive
  // none", which is how an uninstalled last CLI stops being advertised; only a
  // detection that threw leaves the param absent (see `runtimesReport`).
  try {
    url.searchParams.set('runtimes', runtimesReport(detectRuntimes()));
  } catch {
    /* detection is best-effort — a probe must never fail the poll */
  }
  // WHAT THE CLI CAN BE ASKED FOR BY NAME, so the composer can autocomplete a
  // `/` the way the terminal does. Learned from the init event of a turn we
  // already ran (runtimeCapabilities.mjs) — never probed, because spawning a CLI to fill a
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
  // only what needs something leaves the box (runtimeCapabilities.mjs, recordMcpServers —
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
  if (repoRoot && baseRef) {
    try {
      const offerings = detectRuntimes().some((rt) => rt.id === 'codex' && rt.installed)
        ? runtimeOfferings(repoRoot, baseRef) : {};
      for (const [param, report] of Object.entries(offerings)) {
        if (Object.keys(report).length) {
          const payload = JSON.stringify(report);
          if (payload.length <= 8_000 && url.toString().length + encodeURIComponent(payload).length <= POLL_URL_BUDGET) url.searchParams.set(param, payload);
        }
      }
    } catch { /* local readouts never fail the poll */ }
  }
  /**
   * HOW CLOSE EACH CLI'S PLAN IS TO ITS LIMIT (`rtl`, 0.109.0) — the vendor's
   * own numbers, learned off turns this daemon already ran (runtimeLimits.mjs):
   * `{claude?, codex?}`, each `{plan, status, at, windows: [{id, minutes,
   * usedPct, resetsAt, at}]}`.
   *
   * A DAEMON→SERVER REPORT, so no floor, and the three states the other
   * learned readouts keep: NOT SENT until something was learned (absent is
   * "nothing learned yet" as much as "an older daemon"), a report once one
   * was. Bounded twice — the report's own byte cap, the app's
   * `RUNTIME_LIMITS_PARAM_MAX`, and the URL budget, where it is the readout
   * that stays home first: nothing else on the poll yields to it.
   */
  try {
    const limits = runtimeLimitsReport();
    if (limits) {
      const payload = JSON.stringify(limits);
      if (
        Buffer.byteLength(payload, 'utf8') <= RUNTIME_LIMITS_PARAM_MAX &&
        url.toString().length + encodeURIComponent(payload).length + 5 <= POLL_URL_BUDGET
      )
        url.searchParams.set('rtl', payload);
    }
  } catch {
    /* a readout — the poll must never fail on one */
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
  return data; // { mcpUrl, leaseTtlSeconds, agents: [] (a wire fossil), …the lanes' keys }
}

/**
 * THE FIRST ANSWERED POLL, said to the terminal once — which project this
 * daemon serves, and what else is serving it. The loop calls this exactly once
 * per process, on the first roster that lands.
 */
export function announceFirstPoll(roster) {
  // Name the scoped project so a mismatch (this daemon serves project A, but
  // you're viewing project B's wiki) is obvious instead of a silent no-op.
  if (roster.project) {
    note(
      `${c.cyan('project')} · ${c.bold(projectLabel({ name: roster.project.name, projectId: roster.project.id }))} ${c.dim(`(${safeName(roster.project.id) ?? ''})`)}`
    );
    note(c.dim('  wiki + agents stream to THIS project — view its Code canvas in Flowviant.'));
    // Remember the NAME beside the stored credential, so the picker and
    // `flowviant projects` can say "contoso" instead of an id — a
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
      const { boxesUrlFrom, fetchBoxesFor } = await import('./machines.mjs');
      const { otherBoxesLine } = await import('./machineListing.mjs');
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
