/** Agent review entry, project checks, and read-only pre-review turns. */
import { readFileSync, lstatSync, rmSync, readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { FLEET_URL, FLEET_TOKEN, USER_AGENT } from './config.mjs';
import { git } from './git.mjs';
import { parsePrecheck } from './agentPlan.mjs';
import { readStash } from './agentCards.mjs';
import { c, note, warn } from './ui.mjs';
import { runTurn } from './claude.mjs';
import { SYSTEM_PRECHECK, AGENT_PRECHECK_KICKOFF } from './prompts.mjs';
import { ARTIFACT_DIR, artifactTypeFor } from './artifacts.mjs';
import { scrub as envScrub } from './env.mjs';
import { pickRuntimeFor, removeProbeTranscript } from './runtimes.mjs';
import { taskIdsFromMessage } from './worktreeDiff.mjs';

/**
 * CLEAR THE ARTIFACTS DIRECTORY OF ANYTHING THAT IS NOT AN ARTIFACT, BEFORE
 * THE PROJECT'S CHECK RUNS OVER THE WORKTREE (2026-09-24).
 *
 * A design or research turn may write under `.flowviant/artifacts/` and
 * nowhere else — that posture's whole safety claim is that such a card
 * changes no repository file. But the check is the repo's own command, run
 * unattended in the same worktree the moment the queue empties, and a test
 * runner's DEFAULT discovery reaches into that directory: vitest collected and
 * ran `.flowviant/artifacts/pwn.test.js` with no include override. So a card
 * steered by text it read could plant a test and have the machine execute it,
 * before any person looked — and the directory is git-excluded, so the file
 * never appears in the diff a reviewer reads.
 *
 * What an artifact IS is already a closed list (`ARTIFACT_TYPES`), and the
 * scan only ever shows TOP-LEVEL regular files: anything else there is
 * nothing the product will show, so removing it before the check costs
 * nothing a person could see. Symlinks and subdirectories go whole; a
 * `.flowviant` that is not a real directory is left alone (that is the
 * repository's own content, not something a turn wrote). Returns the names
 * removed, for the log line.
 */
export function clearNonArtifacts(wt) {
  const removed = [];
  try {
    const parent = lstatSync(join(wt, '.flowviant'));
    if (parent.isSymbolicLink() || !parent.isDirectory()) return removed;
    const dir = join(wt, ARTIFACT_DIR);
    const st = lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) {
      rmSync(dir, { force: true, recursive: false });
      removed.push(ARTIFACT_DIR);
      return removed;
    }
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      let e;
      try {
        e = lstatSync(p);
      } catch {
        continue; // vanished between the list and the stat
      }
      const keep = e.isFile() && !name.startsWith('.') && artifactTypeFor(name) !== null;
      if (keep) continue;
      try {
        rmSync(p, { recursive: true, force: true });
        removed.push(name);
      } catch {
        /* best-effort — reported by omission */
      }
    }
  } catch {
    /* no artifacts directory — the ordinary case */
  }
  return removed;
}

/**
 * THE ENVIRONMENT THE PROJECT'S CHECK RUNS UNDER: the daemon's own, minus the
 * machine credential — the same rule `cliEnv` (claude.mjs) applies to a turn,
 * repeated here rather than imported so the check never depends on the CLI
 * module's spawn helpers. Nothing a check runs needs the credential the daemon
 * authenticates with; everything else is what the agent's own turn saw when it
 * ran the same tests.
 */
const CHECK_DROPPED_ENV = ['FLOWVIANT_MACHINE_TOKEN', 'FLOWVIANT_FLEET'];
export function checkEnv(env = process.env) {
  const out = { ...env };
  for (const k of CHECK_DROPPED_ENV) delete out[k];
  return out;
}

/**
 * DID THE ACCOUNT HIT A LIMIT?
 *
 * Deliberately a LITERAL MATCH on the few sentences the CLIs actually print,
 * and the matched line is relayed VERBATIM. It is a trigger, not a
 * classifier: nothing here decides what an error "means" or writes a sentence
 * of its own, because the product's own rule is that it relays and never
 * infers. The honest limit is that a phrasing nobody listed reads as an
 * ordinary failed turn — which lands the agent in Stuck with the CLI's words
 * attached, and is a perfectly survivable second-best.
 */
const LIMIT_PHRASES = [
  /usage limit reached/i,
  /rate limit/i,
  /you've reached your .* limit/i,
  /quota exceeded/i,
  /insufficient_quota/i,
];
export const limitLine = (text) => {
  for (const line of String(text ?? '').split('\n')) {
    const t = line.trim();
    if (t && LIMIT_PHRASES.some((re) => re.test(t))) return envScrub(t).slice(0, 300);
  }
  return null;
};

export function createWorkAgentReview({
  repoRoot,
  postBestEffort,
  baseRef,
  admit,
  sessionMetaPath,
  state,
}) {
  const AGENT_CHECK_DONE_URL = FLEET_URL.replace(/\/agents\/?$/, '/agent-check-done');
  const AGENT_PRECHECK_URL = FLEET_URL.replace(/\/agents\/?$/, '/agent-precheck');

  const { workChildren, groupKillChildren } = state;

  // ── THE PROJECT'S OWN CHECK, and the MERGE ─────────────────────────────────
  //
  // The check runs in the agent's own worktree the moment its queue empties, so
  // a reviewer knows before they start reading whether they are reviewing
  // working code. It LABELS the review row; it never blocks it.
  //
  // IT IS THE REPO'S COMMAND, DECLARED IN THE REPO. `.flowviant/check.json`,
  // beside `deploy.json`, because a check travels with the code and changes
  // with it — a setting in the app would go stale the first time somebody
  // renamed a script. An absent file is a MEASURED answer ('none'), not a nag:
  // plenty of projects have no single command that means "is this alright".
  //
  // It runs through a shell, and that is no wider than what already happens in
  // that directory: every turn in this worktree spawns a CLI with build
  // permissions, so a repository that can run arbitrary code during a turn can
  // run it here too. What this is NOT is the deleted dev-run supervisor —
  // nothing here resolves a command, guesses a stack, or starts a server.
  const CHECK_TIMEOUT_MS = 10 * 60_000;
  const CHECK_OUTPUT_CAP = 4000;

  const readCheckCommand = () => {
    try {
      const raw = readFileSync(join(repoRoot, '.flowviant', 'check.json'), 'utf8');
      const cfg = JSON.parse(raw);
      const cmd = typeof cfg?.command === 'string' ? cfg.command.trim() : '';
      return cmd ? cmd.slice(0, 500) : null;
    } catch {
      return null; // absent, unreadable or not JSON — all mean "no check"
    }
  };

  const postCheck = async (body) => {
    // Same bounded retry as postAgentPlan — see postBestEffort. On the
    // final failure the row simply keeps its previous answer, which is
    // null the first time.
    await postBestEffort(AGENT_CHECK_DONE_URL, body);
  };

  const runCheck = async (agentId, wt) => {
    const cmd = readCheckCommand();
    const headSha = (git(['rev-parse', 'HEAD'], wt) || '').trim() || undefined;
    if (!cmd) {
      await postCheck({ agentId, status: 'none', ...(headSha ? { headSha } : {}) });
      return;
    }
    const cleared = clearNonArtifacts(wt);
    if (cleared.length)
      warn(
        `agent ${agentId}: removed ${cleared.length} non-artifact file(s) from ${ARTIFACT_DIR} before the check — ${cleared.slice(0, 5).join(', ')}`
      );
    const out = await new Promise((resolve) => {
      let text = '';
      let done = false;
      const finish = (status) => {
        if (done) return;
        done = true;
        resolve({ status, text });
      };
      let child;
      try {
        // DETACHED, so the child's pid is its PROCESS GROUP. A check is almost
        // always a shell that spawns the real runner, and signalling the shell
        // alone leaves the runner holding the worktree — and this place's
        // WRITER lock — for as long as it likes.
        //
        // AND WITHOUT THE MACHINE CREDENTIAL. The check is the repo's command
        // run with nobody watching, and it inherited `FLOWVIANT_MACHINE_TOKEN`
        // — so anything the check executes (a test a turn wrote, a
        // dependency's postinstall) could read the credential the whole
        // machine authenticates with. It is `checkEnv()`, the environment the
        // agent's own turn ran under (`cliEnv`'s rule), NOT `childEnv`'s
        // allowlist: the agent runs these same tests in its turn, and a check
        // stripped of `JAVA_HOME`, `DATABASE_URL` or the rest of the operator's
        // shell would FAIL where the agent's own run passed — a "Check failed"
        // the product manufactured and then relayed as the project's verdict.
        // The planted-file path is closed by `clearNonArtifacts` above.
        child = spawn(cmd, {
          cwd: wt,
          shell: true,
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: checkEnv(),
        });
        /**
         * …AND IT IS TRACKED, so a stop or a takeover takes it with them.
         *
         * A check is a full test or build run in the agent's worktree, and it
         * was the one long-lived child the daemon spawned without telling its
         * own teardown about it. `shutdownWork` signalled the CLI children and
         * left this one — so restarting the daemon, or a same-repo takeover,
         * orphaned a running test suite inside a worktree the sweep may then
         * try to remove. The ten-minute timer would eventually kill it, but by
         * then it belongs to no daemon and nothing on any surface names it.
         *
         * Registered for a GROUP kill: with `shell: true` the child is
         * `/bin/sh`, and signalling it leaves the runner it started behind —
         * which is the process actually holding the worktree. See
         * `groupKillChildren` for why this one is exempt from the
         * never-signal-the-group rule.
         */
        workChildren.set(child, agentId);
        groupKillChildren.add(child);
      } catch (e) {
        // TEXT BEFORE FINISH: `finish` captures `text` by value into the
        // resolved object, so assigning afterwards threw the spawn error away
        // and the surface showed an empty failure.
        text = String(e?.message || e);
        finish('failed');
        return;
      }
      /**
       * The TAIL, not the head: a failing check says why at the end. And
       * SCRUBBED BEFORE IT IS CUT, which is the order that matters.
       *
       * It used to slice first: `text = (text + buf).slice(-CAP)`, with a
       * single `envScrub` at the very end. `envScrub` replaces EXACT full
       * values, so any credential straddling either boundary — the rolling
       * window's, or a chunk's — was already cut in half by the time it was
       * looked at, matched nothing, and the surviving tail was written to
       * `agent.checkOutput` and shown to every member of the project. A failing
       * integration test that dumps its environment is an ordinary way to reach
       * that, and the partial is enough where the prefix of the key is a
       * publicly known constant.
       *
       * Scrubbing on every chunk fixes both straddles at once: the accumulated
       * text always holds the previous kept tail plus the whole new chunk, so a
       * value split across chunks is whole here, and a value near the window
       * edge is redacted before anything is discarded. Bounded work — the
       * string is never longer than the cap plus one chunk.
       *
       * The one case it cannot cover is a secret LONGER than the cap itself,
       * which can never sit in the window whole. The final scrub below stays as
       * the second pass over what actually ships.
       */
      const keep = (buf) => {
        text = envScrub(text + buf.toString()).slice(-CHECK_OUTPUT_CAP);
      };
      child.stdout?.on('data', keep);
      child.stderr?.on('data', keep);
      const timer = setTimeout(() => {
        try {
          // The GROUP, not the child: killing the shell leaves whatever it
          // started running, which is the thing actually taking ten minutes.
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          try {
            child.kill('SIGKILL');
          } catch {
            /* already gone */
          }
        }
        text += '\n[flowviant] the check ran past ten minutes and was stopped';
        // RESOLVE HERE TOO. Waiting for 'close' after a kill is the shape that
        // hangs: if the group is already gone the event never arrives, and this
        // promise holds the place's writer lock forever.
        finish('failed');
      }, CHECK_TIMEOUT_MS);
      child.on('error', (e) => {
        clearTimeout(timer);
        workChildren.delete(child);
        text += String(e?.message || e);
        finish('failed');
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        workChildren.delete(child);
        finish(code === 0 ? 'passed' : 'failed');
      });
    });
    await postCheck({
      agentId,
      status: out.status,
      output: envScrub(out.text).slice(-CHECK_OUTPUT_CAP),
      ...(headSha ? { headSha } : {}),
    });
  };

  // ── THE AI PRE-REVIEW ──────────────────────────────────────────────────────
  //
  // A FRESH Claude reads the branch before the human does. The owner asked for
  // it in these words: "before having the user manually check, can we have the
  // daemon … spawn an agent to review the work so basically we get an ai to look
  // at the review before a human looks at it for a double check."
  //
  // IT IS NOT THE AGENT CHECKING ITSELF. `runTurn` is called with no `resume`,
  // so there is no conversation to inherit: an agent that spent four turns
  // arguing itself into a design defends that design, and asked whether its work
  // meets the card it answers from the very context that produced the work. The
  // reviewer stands IN the agent's worktree because it needs the code and the
  // diff, under `readOnly` (`consultPermFor` — the fenced Read/Glob rules plus
  // a few path-validated git reads) with NO MCP passed at all, so there is no
  // control plane on this turn even if the repository it reads tries to steer
  // it.
  //
  // IT LABELS AND NEVER BLOCKS — the check's own law, one function up. Approve,
  // the per-card verdicts and the ship quiz do not know this exists. Every exit
  // below POSTS NOTHING, and the server renders an absent precheck as nothing:
  // a failed, timed-out, skipped or unparseable read leaves the human's review
  // exactly as it was before this feature existed. Ignorance never withholds.
  //
  // NO VERSION FLOOR. This is a daemon→server report on a NEW endpoint, so an
  // older daemon simply never posts, and an older SERVER 404s — which `postPre`
  // treats as delivered-and-done for the agent-trace reason stated there.
  //
  // IT RIDES THE BEAT THE CHECK ALREADY OWNS (`runReviewEntry`), AFTER it: the
  // check is a local command and this is a model call, so the cheap answer lands
  // on the row first and a wedged reviewer cannot delay it.
  /**
   * FIVE MINUTES, and `runTurn` has no timer of its own.
   *
   * Half the planner's cap, because this turn is strictly smaller — it reads one
   * branch's diff and answers, where a planner reads a repository to decide
   * whether a batch of work collides. And it is HELD INSIDE THE PLACE WRITER
   * LOCK by the beat it rides, so every minute here is a minute the agent's next
   * turn (or its merge) is waiting: a generous cap on a label would be spending
   * the work's time on a note about the work.
   */
  const PRECHECK_TIMEOUT_MS = 5 * 60_000;
  /** Commit subjects handed to the reviewer. A bound on the prompt, not on the
   *  branch — the reviewer reads the diff itself, and the log is context. */
  const PRECHECK_LOG_LINES = 80;

  /**
   * ONE PRE-REVIEW, POSTED.
   *
   * Resolves TRUE for a permanent refusal as well as a success, and that is
   * deliberate — the `postAgentTrace` rule, for the same reason: a server with
   * no such route 404s this body and will 404 every retry of it, so re-sending
   * would be a wedge wearing a retry's clothes. A NETWORK error resolves false
   * and is retried ONCE, because unlike a trace batch this body cost a whole
   * model call and losing it to a blip means the operator paid for a label
   * nobody ever sees.
   *
   * THE RETRY IS NOT A GUARANTEE THAT THE FIRST ATTEMPT FAILED, and since the
   * body started carrying `usage` (0.90.0) that matters. The `catch` below
   * takes the 30-second `AbortSignal` with everything else, so a server that
   * was merely SLOW — and committed — receives this identical body twice. The
   * store was always idempotent; the token counts riding it were not, and a
   * timed-out-but-committed post added them twice. The SERVER closes that: its
   * write refuses a body whose text already sits on the row, so a re-send
   * stores the same reading and charges nothing for it. Nothing here needs to
   * change, and nothing here may start assuming a thrown fetch means the
   * server never saw this.
   */
  const postPre = async (body) => {
    try {
      const res = await fetch(AGENT_PRECHECK_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${FLEET_TOKEN}`,
          'User-Agent': USER_AGENT,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(30_000),
        body: JSON.stringify(body),
      });
      return (
        res.ok ||
        (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429)
      );
    } catch {
      return false; // a blip — worth one more attempt at a model call's answer
    }
  };

  /**
   * THE BRANCH'S OWN COMMITS, subject + trailers, and the card ids they name.
   *
   * MEASURED, never asserted — the same reason `commitsBetween` exists. The
   * trailer ids are what let the prompt say "N earlier cards' specs are not on
   * this box" honestly: the difference between the cards this branch claims and
   * the specs this disk holds is a fact, and a box that adopted the agent
   * mid-run is exactly the case where it is non-zero.
   *
   * IT CANNOT THROW. `baseRef()` is free text an owner typed and may name no
   * ref at all; an unreadable range costs the reviewer its context, never the
   * review-entry beat it is standing in.
   */
  const branchLog = (wt) => {
    let out;
    try {
      out = git(['log', '--format=%s%n%b%n--', `${baseRef()}..HEAD`, '--not', baseRef()], wt);
    } catch {
      return { text: '', taskIds: [] };
    }
    if (typeof out !== 'string') return { text: '', taskIds: [] };
    // LINEAR, never backtracking (audit 2026-09-24) — this was
    // `out.matchAll(/^\s*Flowviant-Task:\s*(\S+)\s*$/gm)`, whose `\s*$` is
    // quadratic against a long trailing run of whitespace on one line
    // (measured ~1s at 40KB), and a branch's own commit log is exactly the
    // kind of text an agent's commits can grow past that. `taskIdsFromMessage`
    // is the same line-split, length-capped reader every other trailer scan
    // in this codebase uses.
    const taskIds = taskIdsFromMessage(out);
    const text = out
      .split('\n')
      .filter((l) => l.trim())
      .slice(0, PRECHECK_LOG_LINES)
      .join('\n');
    return { text, taskIds: [...taskIds] };
  };

  const runPrecheck = async (agentId, wt, agentName) => {
    /**
     * WHICH CLI READS. `pickRuntimeFor('consult')` — the same picker the scratch
     * planner uses, and for the same reason: this prompt was written against
     * Claude, and a machine with no read-only-capable runtime simply does not
     * produce a precheck. Nothing is posted and nothing is said on the row.
     */
    const rt = pickRuntimeFor('consult');
    if (!rt) return;
    /**
     * THE PRESSURE GUARD, at the spawn, exactly as every other unattended lane
     * asks it. `churn` and never `interactive`: nobody is watching this, and a
     * label is the first thing that should not be started on a box that is
     * struggling. Deferring here does NOT queue anything — there is no job and
     * no re-offer — so a precheck skipped under pressure is simply a precheck
     * that did not happen, which is what absence already means.
     */
    const hold = admit('churn');
    if (hold) {
      note(`${c.cyan('pre-review')} ${c.dim(`— skipped: ${hold.reason}`)}`);
      return;
    }
    const releaseSlot = admit.reserve();

    // THE HEAD THE READING BELONGS TO, taken BEFORE the turn — the
    // `checkFingerprint` shape, so a commit landing after this voids it rather
    // than letting an old reading label a branch it never saw. Optional: an
    // unreadable head costs the staleness comparison, not the precheck.
    let headSha = null;
    try {
      headSha = (git(['rev-parse', 'HEAD'], wt) || '').trim() || null;
    } catch {
      headSha = null;
    }

    const stash = readStash(sessionMetaPath(wt, 'flowviant-agent-cards', agentId));
    const log = branchLog(wt);
    /** Cards the BRANCH names that this box has no spec for. Measured, not
     *  guessed — see agentCards.mjs on why a stash is per-box. */
    const held = new Set(stash.map((s) => s.taskId));
    const missingSpecs = log.taskIds.filter((id) => !held.has(id)).length;

    let out = '';
    let child = null;
    let timer = null;
    /** The cap fired: the CLI was still running when this machine stopped it. */
    let wedged = false;
    /**
     * WHAT THE READING SPENT — the agent-turn lane's own relay, on the one
     * other lane that charges an AGENT (2026-09-19).
     *
     * It rides the agent and never a card link: a pre-review belongs to no card
     * (the same reason `workChildren` gets a null task id below), so the four
     * counters it adds to are the container's alone. That is also why an
     * agent's links can never sum to its total, and the schema says so.
     *
     * A WEDGED OR UNPARSEABLE READING POSTS NOTHING AT ALL, so it charges
     * nothing either — which under-reports a turn that really did spend. That
     * is the honest direction: there is no row to put it on, and inventing a
     * settle to carry a number would be a post whose only content is a bill.
     */
    let usage = null;
    /**
     * THE CONVERSATION THIS READING SPEAKS UNDER — held for exactly one reason:
     * to DELETE the transcript it leaves behind (review, 2026-09-17).
     *
     * This is the first thing in the daemon to run a second `claude -p` inside
     * an AGENT's worktree, and the agent's own resume is `--continue`, which is
     * CWD-KEYED — the invariant `runAgentTurn` states in words ("ONE AGENT IS
     * ONE DIRECTORY, so the CLI's own cwd-keyed resume is exactly right here").
     * Leaving this turn's `~/.claude/projects/<munged-cwd>/<id>.jsonl` in place
     * makes the read-only stranger the newest conversation in that directory,
     * so the agent's NEXT turn — a send-back's re-queued card, a merge-resolve,
     * a human's typed answer — resumes "you are a SECOND reviewer… YOU ARE
     * READ-ONLY" instead of its own four-turn context, under build permissions.
     * That is the 0.69.0 Workbench cross-resume and codex's `resume --last`,
     * arriving a third time by a third route.
     *
     * `removeProbeTranscript` is exported for precisely this and already serves
     * the skills probe and the dev-command resolver.
     */
    let preSession = null;
    try {
      /**
       * THE CAP RESOLVES THE WAIT ITSELF rather than waiting for `close` after
       * the kill — the shape the project check and the planner both keep. A
       * SIGKILLed process whose stdio a grandchild still holds can be slow to
       * emit `close`, or never emit it, and this promise is inside the place's
       * writer lock.
       */
      let stopWaiting = () => {};
      const capped = new Promise((r) => {
        stopWaiting = r;
      });
      const turn = runTurn({
        prompt: AGENT_PRECHECK_KICKOFF({
          agentName,
          cards: stash.map((s) => s.prompt).join('\n---\n'),
          missingSpecs,
          commits: log.text,
          diffCommand: `git diff ${baseRef()}...HEAD`,
        }),
        system: SYSTEM_PRECHECK,
        // READ-ONLY, and no MCP: `mcpArgs` is omitted entirely rather than
        // passed empty, so there is no control plane on this turn at all.
        readOnly: true,
        cwd: wt,
        runtime: rt,
        // NO `resume`, AND THAT IS THE FEATURE. A resumed turn would be the
        // agent grading its own homework out of its own context; this is a
        // stranger reading a diff.
        streamJson: true,
        answerFromResult: true,
        label: c.cyan('[pre-review]'),
        // The id the CLI reports at `system.init` — harvested off the stream
        // this turn already parses, no probe and no extra spawn. Held only so
        // the `finally` below can delete this turn's transcript; see
        // `preSession`.
        onInit: (i) => {
          if (typeof i.sessionId === 'string' && i.sessionId.trim())
            preSession = i.sessionId.trim();
        },
        // The CLI's own count for this reading. Set, never accumulated: one
        // turn is one `result` event, and the adding-up is the server's.
        // Tagged with the CLI, so a Claude pre-review of a Codex agent is
        // charged as Claude's and not folded into the agent's own figure.
        onUsage: (u) => {
          usage = { ...u, runtime: rt };
        },
        onSpawn: (ch) => {
          child = ch;
          // No task id: a pre-review belongs to no card, and the machine
          // snapshot's per-task rows must not invent one. It still COUNTS
          // against the machine's ceiling — see liveTurnCount.
          workChildren.set(ch, null);
          releaseSlot();
          // ARMED AT THE SPAWN, not at entry: time spent getting here is not a
          // wedged CLI. The CHILD and never its group — a read-only turn starts
          // no server, so there is nothing behind it worth signalling and
          // everything to lose by signalling somebody else's.
          timer = setTimeout(() => {
            wedged = true;
            try {
              ch.kill('SIGKILL');
            } catch {
              /* already gone */
            }
            stopWaiting('');
          }, PRECHECK_TIMEOUT_MS);
          timer.unref?.();
        },
      });
      out = await Promise.race([turn, capped]);
    } catch {
      return; // a label may never fail the beat it rides
    } finally {
      if (timer) clearTimeout(timer);
      if (child) workChildren.delete(child);
      releaseSlot();
      /**
       * DELETE THIS READING'S TRANSCRIPT, on EVERY exit — settled, wedged and
       * killed, or thrown — because every one of them leaves the file behind
       * and the agent's `--continue` reads the newest one in the directory.
       *
       * AFTER the kill and ON A DELAY, the skills probe's own shape: the
       * transcript is the CHILD's file, so removing it while the child is still
       * dying races a recreate. Unref'd — it must not hold the process open.
       */
      if (preSession) setTimeout(() => removeProbeTranscript(wt, preSession), 750).unref?.();
    }

    // A WEDGED READING POSTS NOTHING. There is no row to settle and nobody
    // waiting on an answer, so the honest record is that no pre-review exists —
    // the same silence a machine that never ran one leaves.
    if (wedged) {
      note(`${c.cyan('pre-review')} ${c.dim('— ran past five minutes and was stopped')}`);
      return;
    }

    /**
     * SCRUBBED ON THE WAY OUT, every string — AND SCRUBBED BEFORE IT IS CUT,
     * which is the order that matters and the reason `envScrub` rides INTO the
     * parser rather than being applied to what comes back out.
     *
     * This turn read the repository with `cat` and `git show` in a worktree
     * holding the project's materialized dev secrets, and its answer is about to
     * be stored and rendered to every member of the project. `scrub` replaces
     * EXACT full values, so a note capped first and scrubbed second hands the
     * scrub a credential already cut in half: it matches nothing and the
     * surviving prefix ships. The check's output lane learned exactly that the
     * expensive way, and this lane relearned it in review (2026-09-17) — see
     * `parsePrecheck`, which now caps only what it has already redacted.
     */
    const result = parsePrecheck(out, envScrub);

    /**
     * A QUOTA LIMIT SKIPS THE PRE-REVIEW AND PARKS NOTHING — AND A LIMIT IS
     * ONLY A LIMIT WHEN THE READING PRODUCED NOTHING.
     *
     * `limitLine` is a literal phrase match over the CLI's whole output, and
     * under `answerFromResult` that output IS the reviewer's answer — so a
     * pre-review OF rate-limiting code, or any triage that quotes the phrase,
     * read as a quota failure and threw a perfectly good reading away. The
     * agent-turn lane fixed this exact false positive once (`const limit = res
     * ? null : limitLine(out)`); gating on "nothing parsed" is what makes the
     * match mean what it says.
     *
     * And when it IS a limit, nothing parks. `postAgentParked` stops EVERY
     * agent on the project, because the CLI login is shared — the right answer
     * when the thing that hit the limit was somebody's actual work, the wrong
     * one here: parking a whole fleet because a LABEL could not be written
     * would let an optional readout take the product's primary lane down. The
     * branch is still reviewable; it just has no note on it.
     */
    if (!result) {
      if (limitLine(out)) {
        note(`${c.cyan('pre-review')} ${c.dim('— skipped: the CLI reported a limit')}`);
      }
      // UNPARSEABLE POSTS NOTHING. A half-read triage is a plausible-looking
      // paragraph nobody wrote, rendered on the surface where somebody decides
      // whether a branch reaches main — see parsePrecheck.
      return;
    }

    const body = {
      agentId,
      ...(headSha ? { headSha } : {}),
      ...(usage ? { usage } : {}),
      cards: result.cards.map((cd) => ({
        taskId: cd.taskId,
        verdict: cd.verdict,
        ...(cd.note ? { note: cd.note } : {}),
      })),
      ...(result.overall ? { overall: result.overall } : {}),
    };
    // ONE RETRY, and only for a network error — see `postPre`. A permanent
    // refusal is an older server, and asking it again changes nothing.
    if (!(await postPre(body))) await postPre(body);
  };

  /**
   * REVIEW ENTRY — everything this machine does the moment an agent's queue
   * empties, in one place.
   *
   * It exists so the two readings cannot drift apart at the three call sites
   * that own this beat (the settle reply, the held body's re-POST, and the
   * stale-merge re-read after base is folded in). Each of those used to call
   * `runCheck` directly; a second thing to run at the same moment is a second
   * thing three call sites can forget.
   *
   * THE CHECK FIRST, ALWAYS. It is a local command whose answer the board wants
   * on the row immediately; the pre-review is a model call that may take
   * minutes. Ordering them the other way would put a label behind a label.
   *
   * NEITHER MAY THROW PAST THIS POINT. Both are optional readouts and both run
   * INSIDE the place's writer lock on a path whose callers settle real work —
   * `runAgentMerge` in particular reports a claimed merge after this returns.
   */
  const runReviewEntry = async (agentId, wt, agentName) => {
    try {
      await runCheck(agentId, wt);
    } catch {
      /* the row keeps its previous check answer, which is null the first time */
    }
    try {
      await runPrecheck(agentId, wt, agentName);
    } catch {
      /* no pre-review is posted, and absence renders nothing */
    }
  };

  return { runReviewEntry };
}
