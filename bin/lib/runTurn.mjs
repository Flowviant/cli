/**
 * ONE HEADLESS CLI TURN — the argv the runtime's adapter builds, the child it
 * spawns (its own process group, the daemon's environment minus the machine
 * credential), and the supervision of its output until it closes.
 *
 * Split out of claude.mjs (SOLID 2026-09-26) because process lifetime — spawn,
 * decode, error, close — changes for its own reasons. The posture it hands the
 * adapter comes from claudePosture.mjs by the profile's name; Claude's stream
 * is read by claudeStream.mjs; every other runtime brings its own `parse`
 * (runtimeEvents.mjs).
 */

import { spawn } from 'node:child_process';
import { runtimeById } from './runtimes.mjs';
import { withoutMachineCredentials } from './machineEnv.mjs';
import { openBrowserHome, withoutWindows } from './noWindowEnv.mjs';
import { resolveTurnProfile } from './turnProfile.mjs';
import { claudePermFor } from './claudePosture.mjs';
import { handleStreamLine } from './claudeStream.mjs';
import { never, workLanesStopped } from './standDownGate.mjs';
import { learnCodexLimits, recordClaudeRateLimit } from './runtimeLimits.mjs';
import { codexTurnModel } from './turnModel.mjs';

/** How long a Codex turn's answer may wait on its rollout's model line. */
const CODEX_MODEL_READ_MS = 1_500;

/**
 * THE ENVIRONMENT A CLI TURN IS SPAWNED WITH — the daemon's own, plus the
 * turn's MCP token, MINUS the machine credential (2026-09-24, the audit).
 *
 * A turn cannot be handed a curated environment the way `childEnv` builds one
 * for a deploy: the CLI's own sign-in lives in this environment, and stripping
 * it signs the CLI out. But on a headless box started as
 * `FLOWVIANT_MACHINE_TOKEN=… npx flowviant` the MACHINE CREDENTIAL lives here
 * too, and every turn — and every dev server and script a turn starts, which
 * inherit it — could read it with one `env`. Nothing a CLI or its children do
 * needs it: the daemon authenticates to the server itself, and a turn that
 * needs the project's tools gets its own per-turn token through `mcpEnv` or
 * the MCP config file. So those two names, and only those, are removed —
 * by the one rule in machineEnv.mjs, which the project check obeys too.
 */
/**
 * …AND, UNLESS A PERSON IS AT THE KEYBOARD, NO WAY TO A WINDOW (2026-09-29).
 * `display: true` is the Terminal tab's alone: a person typing there may ask
 * for a window and gets their own environment. Every other turn — an agent's,
 * its pre-review, the planner, the wiki, intake, the capture chat, and any
 * lane added later that does not say otherwise — runs under
 * `withoutWindows` (noWindowEnv.mjs), its browsers in `browserHome`.
 */
export function cliEnv(mcpEnv, { display = false, browserHome = null } = {}) {
  // After the merge, so an mcpEnv can never smuggle one back in.
  const env = withoutMachineCredentials({ ...process.env, ...(mcpEnv ?? {}) });
  return display === true ? env : withoutWindows(env, browserHome);
}

// One Claude Code turn. Output is captured (for sentinel detection) and streamed
// through, line-prefixed with the worker label so a fleet stays legible.
//
// `streamJson` switches to `--output-format stream-json` and parses the event
// stream: only the humanized tool activity reaches the console (a legible
// stream of `read …`, `grep …`, `+ node …`), assistant text is folded into the
// returned string for sentinel detection, and each activity is handed to
// `onActivity` so the caller can forward progress. Build-agent turns leave it
// off and keep the raw text passthrough + line sentinels.
export function runTurn(opts) {
  const { prompt, resume, system, cwd, mcpConfig, mcpArgs, mcpEnv, agentTools, runtime = 'claude', label, onSpawn, streamJson, answerFromResult, onActivity, onToolEvent, onInit, onUsage, onRateLimit, onModel, onThreadId, onAnswer, vaultDir, knowledgeDir, resultSchemaArgs, model, effort, adoptResumeId, resumeThreadId, resumeConversationId, display, browserHome } = opts;
  /**
   * AFTER THE TEARDOWN, NO TURN STARTS AND NO TURN ENDS (standDownGate.mjs).
   * A stand-down that drains a deploy keeps this process alive; without this
   * a turn the teardown killed would hand its empty output back to its lane,
   * which would settle it as `nothing` or spawn a fresh retry nobody kills.
   * Both answers stay pending instead, as `process.exit` left them.
   */
  if (workLanesStopped()) return never();
  return new Promise((resolveTurn) => {
    const resolve = (v) => {
      if (!workLanesStopped()) resolveTurn(v);
    };
    const rt = runtimeById(runtime);
    // AN UNKNOWN RUNTIME IS REFUSED, NEVER RUN AS CLAUDE (2026-09-26). Asked
    // before anything is spawned. This is the belt, not the relay: the words
    // a person sees come from the callers' own gates, asked earlier (the agent
    // lane's `canRun` answers "this machine cannot run <id>", the session
    // lane's `unsupported` check). Here the daemon log names the id and the
    // turn answers nothing — never Claude wearing the other runtime's name.
    if (!rt) {
      console.error(`\nerror: cannot run '${runtime}' — this daemon does not know that runtime; update flowviant`);
      resolve('');
      return;
    }
    /**
     * ONE PROFILE, NAMED BY THE CALLER (turnProfile.mjs). An unknown name or a
     * retired posture switch fails the turn in words — never the build
     * posture by fall-through.
     */
    const turnProfile = resolveTurnProfile(opts);
    if (turnProfile.error) {
      console.error(`\nerror: ${turnProfile.error}`);
      resolve('');
      return;
    }
    // A PROFILE SOME RUNTIMES CANNOT EXPRESS FAILS THE TURN — plan mode off
    // Claude, a design or research posture on a runtime that does not declare
    // it. The callers refuse first, in words (the tab lane; the agent lane's
    // `canRun`); this is the belt no caller can skip. The other adapters build
    // argv from the profile name and never read `perm`, so the only
    // alternative is their build branch — for codex `--sandbox
    // danger-full-access`: a research card's words with the whole machine to
    // act on. Asked against the runtime's own declared profiles, so the day an
    // adapter learns to express one this opens by itself.
    const offRuntime = turnProfile.onlyOn?.(rt);
    if (offRuntime) {
      console.error(`\nerror: ${offRuntime}`);
      resolve('');
      return;
    }
    if (!rt.args) {
      // Reached only if a brief names a runtime this daemon declares but cannot
      // drive. Fail as a turn with no sentinel — the loop already treats that as
      // "the protocol did not complete" and retries, rather than inventing a
      // completion for work that never started.
      console.error(`\nerror: cannot run '${rt.label}' — ${rt.blocked}`);
      resolve('');
      return;
    }
    /**
     * THE PERSON'S LOGIN, FOR A POSTURE THAT READS NONE OF THEIR CONFIG
     * (2026-09-29, codexPersonal.mjs). Asked of the runtime that has one
     * (Codex; Claude reads its own inside its adapter), with the environment
     * this turn's CLI will run in — its CODEX_HOME is the agent's own when the
     * lane keeps one — so the file read is the file the CLI would have read.
     * Its `args` go to the adapter; its `env`, the literal secrets those name,
     * to the child below and never to argv.
     */
    const personal =
      rt.personal?.({
        profile: turnProfile.adapterProfile,
        vaultDir,
        model,
        effort,
        env: { ...process.env, ...(mcpEnv ?? {}) },
      }) ?? null;
    // Pin the model — never inherit the user's global default (which for Claude
    // may be a 1M/long-context tier their subscription can't bill autonomous
    // work on). A per-task override (chosen in the app, validated server-side
    // against a fixed list before it ever reaches this argv) wins over the
    // machine pin; absent, the pin stands. Effort has no machine-level pin at
    // all: unset means the CLI's own default, the honest resting state.
    //
    // TWO FORMS OF THE SAME DECISION, and the redundancy is deliberate rather
    // than sloppy. `profile` is the NAME of the posture — a promise about what
    // must be impossible during the turn — and every runtime expresses it in its
    // own vocabulary: Claude as an `--allowedTools` verb list, Codex as a kernel
    // sandbox mode plus feature toggles. `perm` is Claude's expression, looked
    // up by the SAME name (`claudePermFor`), so the two cannot disagree about
    // which posture a turn is running under. There is no precedence chain left
    // to get wrong: the caller named one profile (turnProfile.mjs).
    const args = rt.args({
      personal,
      prompt,
      system,
      model,
      effort,
      resume,
      streamJson,
      profile: turnProfile.adapterProfile,
      agentTools,
      // Adopting a terminal session (workSessionTurns.mjs): Claude turns it into
      // `--resume <id> --fork-session` (a FORK — the original is untouched);
      // agy turns it into `--conversation <id>` (a MOVE — agy has no fork, the
      // tab continues the terminal conversation itself). Codex THROWS on it,
      // so a mis-wired adoption fails as a loud turn error rather than a
      // silent fresh conversation wearing an adopted session's name.
      adoptResumeId,
      // Only the wiki profile uses it, but it is passed unconditionally: a
      // runtime that can path-scope its writes needs to know WHERE the vault is,
      // and Claude — which cannot — simply ignores it.
      vaultDir,
      // The turn's own directory, for a runtime that fences its writes to a
      // path under it: Codex's image profile makes `<cwd>/.flowviant/artifacts`
      // its one writable root (0.114.0). The other adapters ignore it.
      cwd,
      // THE PROJECT'S KNOWLEDGE LIBRARY (0.94.0), when this box holds one. It
      // lives in the CHECKOUT and a turn usually runs in a worktree, so the
      // prompt hands an absolute path OUTSIDE the cwd — and a curated Claude
      // profile (the capture chat's read-only list, `FLOWVIANT_SAFE=1`) may
      // refuse a read there. `--add-dir` says the directory is one it may read.
      // Only Claude's adapter uses it; codex's sandboxes read the filesystem
      // already, and agy's `--add-dir` is spent on the wiki vault.
      knowledgeDir,
      // Structured-output flags for the MEDIATED path. Handed to the adapter
      // rather than appended here for the same reason `mcp` is: Codex takes its
      // prompt as a trailing positional, so a flag after it is in the wrong
      // place.
      resultSchemaArgs,
      // PLAN MODE REPLACES THE POSTURE, never joins it: beside
      // `--dangerously-skip-permissions` the bypass wins silently (measured —
      // see PLAN_MODE_PERM).
      perm: claudePermFor(turnProfile.name, knowledgeDir),
      // Handed to the adapter rather than appended here, because WHERE these go
      // is a property of the CLI: Codex reads its prompt as a trailing
      // positional, so a flag after it is a flag in the wrong place.
      // Wiki-vault turns are pure file work and pass neither — no MCP at all.
      mcp: turnProfile.strictMcp ? ['--strict-mcp-config'] : mcpConfig ? ['--mcp-config', mcpConfig] : (mcpArgs ?? []),
      // Resuming a SPECIFIC held conversation by its own id (workSessionTurns.mjs, codex
      // sessions). Runtimes without a by-id resume ignore it and keep their
      // `resume` behavior unchanged.
      resumeThreadId,
      // agy's by-id resume (workSessionTurns.mjs, antigravity sessions): the conversation
      // id learned from the adopt hint or the cwd registry after a turn.
      resumeConversationId,
    });
    // Whatever this machine is signed in with, we use. We do NOT pick.
    //
    // This used to delete ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN to force
    // the subscription path, which was right when the daemon ran on a
    // developer's laptop: a key left in their shell would silently bill every
    // turn as raw API usage instead of the plan they were already paying for.
    // On a machine the project leaves running, an inherited org key is the
    // POINT — deleting it is the daemon overriding the credential its operator
    // deliberately configured.
    //
    // Which credential is correct, and whether an account may be shared, is
    // between the operator and the vendor. Flowviant does not detect it and does
    // not enforce it; it runs the CLI the ordinary way and relays what happens.
    //
    // A turn nobody is sitting at keeps its browsers in a home of its own —
    // the lane's kept one (an agent's), else this spawn's, removed when the
    // CLI closes. See `cliEnv`.
    const browser = display === true ? null : openBrowserHome(browserHome);
    const child = spawn(rt.bin, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      /**
       * ITS OWN PROCESS GROUP, so what the agent starts stays attributable.
       *
       * Everything the CLI spawns inherits this pgid and KEEPS it through
       * `nohup` and `setsid` — which is exactly when attribution by descendancy
       * fails, because reparenting to init breaks the ppid chain the moment a
       * process becomes long-running. `processes.mjs` reads the group; the
       * Workbench renders it.
       *
       * TEARDOWN IS DELIBERATELY UNCHANGED: `shutdownWork` still SIGTERMs this
       * CHILD and never the group. Signalling the group would kill the dev
       * server the driver started every time the daemon restarts — including
       * on an ordinary auto-update, unattended — which is the outcome the
       * deleted dev-run supervisor spent a whole registry avoiding. Flowviant
       * does not manage those processes; it reports them.
       *
       * Not `unref`'d: the daemon must still wait on this turn.
       */
      detached: true,
      // Only ADDS to the environment (the worker token, for runtimes that read
      // it from there). Never replaces it: the CLI's own credentials live in
      // this environment, and handing it a curated one signs it out. What it
      // REMOVES is this daemon's machine credential and, for a turn nobody is
      // sitting at, every way to a window — see `cliEnv`.
      // The login's literal secrets first, so nothing of the lane's (its MCP
      // token, its CODEX_HOME) can be overwritten by one.
      env: cliEnv(personal?.env ? { ...personal.env, ...(mcpEnv ?? {}) } : mcpEnv, {
        display: display === true,
        browserHome: browser?.dir,
      }),
    });
    if (browser) {
      child.once('close', browser.cleanup);
      child.once('error', browser.cleanup);
    }
    onSpawn?.(child);
    // When this turn began, for the Codex rollout read: a `turn_context` older
    // than this is a previous turn's (turnModel.mjs).
    const spawnedAt = Date.now();
    let out = '';
    const pfx = label ? `${label} ` : '';
    const emit = (s) => process.stdout.write(pfx ? s.replace(/\n/g, `\n${pfx}`) : s);

    // A runtime with its own parser is ALWAYS line-parsed — for Codex the JSONL
    // stream is the only output there is, so treating it as raw text would print
    // event objects at the operator and, worse, hand the sentinel matcher a
    // string containing every word the model reasoned about.
    const lineParsed = streamJson || Boolean(rt.parse);
    if (lineParsed) {
      let buf = '';
      const appendText = (t) => {
        out += t;
      };
      /**
       * THE PLAN'S WINDOWS, LEARNED OFF EVERY TURN THIS DAEMON RUNS (0.109.0).
       *
       * This is the one spawn point — agent turns, Terminal tabs, capture
       * chats, the planner, the pre-review and the wiki all come through here
       * — so it is the one place that sees every CLI's word on its plan.
       * Claude says it on the stream (`rate_limit_event`), recorded as it
       * arrives; a caller's own `onRateLimit` still hears it. Codex writes it
       * into the thread's rollout file instead, so the thread this turn spoke
       * under (announced on `thread.started`, else the one it resumed) is read
       * AFTER the child closes, on the next tick — the turn's answer never
       * waits on a file read. See runtimeLimits.mjs.
       */
      const onRate = (info) => {
        recordClaudeRateLimit(info);
        onRateLimit?.(info);
      };
      let codexThread = rt.id === 'codex' && typeof resumeThreadId === 'string' ? resumeThreadId : null;
      /**
       * THE MODEL THIS SPAWN RAN ON, ONCE (2026-09-29, turnModel.mjs). Claude
       * names it in its init event and again on every reply; the first valid
       * one is the answer, so the init wins and the first reply is the
       * fallback. Codex names it only in its rollout, read at close below.
       */
      let ranOn = null;
      const onRanOn = (m) => {
        if (ranOn || !m) return;
        ranOn = m;
        onModel?.(m);
      };
      /** One line of the child's stdout, in whichever dialect it speaks. */
      const onLine = (line) => {
        if (!rt.parse)
          return handleStreamLine(line, { cwd, emit, onActivity, onToolEvent, appendText, answerFromResult, onInit, onUsage, onRateLimit: onRate, onModel: onRanOn });
        const ev = rt.parse(line, cwd);
        if (!ev) return;
        // The conversation id, when the runtime announces one (codex's
        // thread.started). Purely additive: callers that pass no onThreadId —
        // every dispatch path — see zero behavior change.
        if (ev.threadId) {
          if (rt.id === 'codex') codexThread = ev.threadId;
          onThreadId?.(ev.threadId);
        }
        // The runtime's own token count (codex's `turn.completed`) — the same
        // `onUsage` Claude's result event feeds, so a caller charges a turn
        // identically whichever CLI ran it.
        if (ev.usage) onUsage?.(ev.usage);
        // One agent MESSAGE, alone — see parseCodexLine's `answer`. Last call
        // wins at the caller, which is what "the final answer" means.
        if (typeof ev.answer === 'string') onAnswer?.(ev.answer);
        if (ev.text) appendText(ev.text);
        if (ev.activity) {
          emit(`${ev.activity.label}\n`);
          onActivity?.(ev.activity);
        }
      };
      // DECODED AS A STREAM, never chunk by chunk (2026-09-24, the audit): a
      // pipe read can end inside a multi-byte character — the em dash models
      // write constantly — and `d.toString()` per chunk turned each half into
      // U+FFFD, which JSON.parse accepts and the reply then carried verbatim.
      // `setEncoding` holds the partial bytes over to the next chunk.
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (d) => {
        buf += d;
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (line.trim()) onLine(line);
        }
      });
      // stderr is not JSON (warnings/errors) — pass through and keep for sentinels.
      child.stderr.on('data', (s) => {
        out += s;
        emit(s);
      });
      child.on('error', (e) => {
        if (e.code === 'ENOENT') {
          // A MISSING CLI FAILS THE TURN, NOT THE DAEMON. This called
          // process.exit(1), which was defensible while `claude` was the only
          // runtime and preflight refused to start without it — the process
          // could not reach here. Both halves of that are gone: preflight is now
          // fatal only when NOTHING is drivable, so a Codex-only machine starts
          // legitimately, and the wiki/plan-check/consult turns still ask for
          // Claude by default. On such a machine the first wiki sweep would have
          // killed the whole daemon, taking every in-flight build with it,
          // because one background job could not find one binary.
          console.error(`\nerror: '${rt.bin}' CLI not found on PATH. Install ${rt.label} first: ${rt.install}`);
          resolve('');
          return;
        }
        console.error(e);
        resolve(out);
      });
      child.on('close', () => {
        if (buf.trim()) onLine(buf);
        const handBack = () => {
          resolve(out);
          // After the answer is handed back, never before it: see `onRate`.
          if (codexThread) {
            const thread = codexThread;
            setImmediate(() => void learnCodexLimits(thread));
          }
        };
        /**
         * A CODEX TURN'S MODEL IS IN ITS ROLLOUT, so a caller that asked for
         * it waits for one bounded read before the answer goes back — the
         * settle it rides is built from that answer. Only then: a caller that
         * passes no `onModel` hands back exactly as before. A read that fails
         * or overruns reports nothing (never a guess).
         */
        if (codexThread && onModel && !ranOn) {
          const thread = codexThread;
          let timer = null;
          const cap = new Promise((res) => {
            timer = setTimeout(() => res(null), CODEX_MODEL_READ_MS);
          });
          void Promise.race([codexTurnModel(thread, { since: spawnedAt }), cap])
            .then(onRanOn, () => {})
            .finally(() => {
              clearTimeout(timer);
              handBack();
            });
          return;
        }
        handBack();
      });
      return;
    }

    const onChunk = (s) => {
      out += s;
      emit(s);
    };
    // Stream-decoded for the same reason as the line-parsed path above.
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', onChunk);
    child.stderr.on('data', onChunk);
    child.on('error', (e) => {
      if (e.code === 'ENOENT') {
        // A MISSING CLI FAILS THE TURN, NOT THE DAEMON — same fix as the
        // line-parsed path above; this raw-output duplicate used to
        // process.exit(1) and take every in-flight worker down with it.
        console.error(`\nerror: '${rt.bin}' CLI not found on PATH. Install ${rt.label} first: ${rt.install}`);
        resolve('');
        return;
      }
      console.error(e);
      resolve(out);
    });
    child.on('close', () => resolve(out));
  });
}
