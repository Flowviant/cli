/**
 * WHETHER THIS BOX IS (STILL) THE PROJECT'S MACHINE — the holder watch, the
 * three roster signals that end a daemon (a commanded stop, a displacement, a
 * removal), and the stand-down choreography they share.
 *
 * Split out of fleet.mjs (SOLID audit 2026-09-26, F038). Everything here is a
 * decision the SERVER made and the daemon relays: the server arbitrates
 * holdership because it is the only party that can see both boxes, and every
 * signal's PRESENCE is the command. What the loop keeps is the ordering —
 * `obeyRosterCommands` runs before the holder observation and before the
 * version signal, for the reason each block below states.
 *
 * Pure or dependency-injected throughout, so every property can be proved
 * without a credential, a server or a second box (holder.test.mjs).
 */

import { safeName } from './credentials.mjs';
import { emitMachineEvent } from './daemonLogging.mjs';
import { note, warn } from './ui.mjs';
import { sleep } from './claude.mjs';

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
        // `machineListing.mjs` no longer respells anything). A terminal saying one
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
  if (removed) emitMachineEvent({ event: 'stopped', reason: 'removed' });
  else emitMachineEvent({ event: 'displaced', message: displacedTurnSentence(by) });
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

/**
 * THE THREE ROSTER SIGNALS THAT END THIS DAEMON, in their one order: a
 * commanded stop, then a displacement, then a removal. Returns true when the
 * daemon is going away (the loop returns), false when none was sent.
 *
 * Every dependency is injected so the choreography can be driven without a
 * process to kill; the loop passes standDownExit.mjs's `leave` as `exit`, so a
 * deploy in flight finishes and reports before the process goes.
 */
export async function obeyRosterCommands(
  roster,
  { settleAgentTurns, flushWorkReports, teardown, exit, log = { warn, note } }
) {
  // A COMMANDED STOP OUTRANKS AN UPDATE, and that ordering is the whole reason
  // this sits ABOVE the version signal rather than inside it. Both read the
  // same `roster.daemon` object, but `handleVersionSignal` can re-exec this
  // process into a newer build — so checked second, a machine somebody just
  // told to stop would come back up wearing a different version instead of
  // going away.
  const stopSignal = shouldStop(roster.daemon);
  if (stopSignal) {
    emitMachineEvent({ event: 'stopped', reason: stopSignal.reason ?? null });
    log.warn(
      stopSignal.reason
        ? `stopped by Flowviant — ${stopSignal.reason}`
        : 'stopped by Flowviant — no reason given.'
    );
    log.note('shutting down — stopping workers. Worktrees are kept: in-flight work resumes next run.');
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
    exit(0);
    return true;
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
      exit,
      log,
    });
    return true;
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
      exit,
      log,
    });
    return true;
  }
  return false;
}
