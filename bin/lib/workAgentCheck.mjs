/**
 * THE PROJECT'S OWN CHECK — the repo's declared command, run in the agent's
 * worktree the moment its queue empties, and its answer posted as a label.
 *
 * Split out of workAgentReview.mjs (SOLID F039): this half changes for
 * SECURITY reasons (what a repo-controlled command may see and reach — the
 * artifact-directory fence, the environment without the machine credential,
 * the process-group kill), the pre-review for MODEL-REPORTING ones. The review
 * entry beat sequences the two and owns neither.
 */
import { readFileSync, lstatSync, rmSync, readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { FLEET_URL } from './config.mjs';
import { git } from './git.mjs';
import { warn } from './ui.mjs';
import { ARTIFACT_DIR, artifactTypeFor } from './artifacts.mjs';
import { scrub as envScrub } from './uplinkScrub.mjs';
import { withoutMachineCredentials } from './machineEnv.mjs';
import { fleetEndpoint } from './fleetWire.mjs';
import { workLanesStopped } from './standDownGate.mjs';

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
 * machine credential — the same rule `cliEnv` (runTurn.mjs) applies to a turn,
 * imported from its one home (machineEnv.mjs) rather than from the CLI
 * module, so the check never depends on the CLI module's spawn helpers. Nothing a check runs needs the credential the daemon
 * authenticates with; everything else is what the agent's own turn saw when it
 * ran the same tests.
 */
export function checkEnv(env = process.env) {
  return withoutMachineCredentials(env);
}

export function createWorkAgentCheck({ repoRoot, postBestEffort, workChildren, groupKillChildren }) {
  const AGENT_CHECK_DONE_URL = fleetEndpoint('agent-check-done', FLEET_URL);

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
        // A check the teardown killed never reports (standDownGate.mjs): the
        // answer stays pending, as `process.exit` left it before the drain.
        if (workLanesStopped()) return;
        resolve({ status, text });
      };
      // After the teardown no check starts; this promise stays pending.
      if (workLanesStopped()) return;
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

  return { runCheck };
}
