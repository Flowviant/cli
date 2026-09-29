/**
 * RUNNING ONE DEPLOY JOB — cut the base checkout, read the target off that
 * same commit, run build → deploy (or the rollback) with the operator's infra
 * credentials, verify health, and hand back an outcome. No claim, no
 * heartbeat, no report: deploy.mjs owns the lease this runs under.
 *
 * Split out of deploy.mjs (SOLID F060): this half changes with process
 * execution, the command environment, log scrubbing and the health check.
 * `runDeploy` is one job's run in order (checkout → config at that sha →
 * commands → cleanup); it composes deployCheckout.mjs and deployConfig.mjs
 * and owns neither rule.
 *
 * ── THE MACHINE'S OWN ENVIRONMENT IS THE SOURCE OF A DEPLOY'S SECRETS
 *    (2026-09-21), BECAUSE FLOWVIANT NO LONGER HOLDS ANY ──
 *
 * This lane used to get both halves of its secrets from the end-to-end
 * encrypted vault: `deployCreds()` put the deploy-scope credentials in the
 * command's environment, and `appSecretsFor('prod')` fed `wrangler secret put`
 * on stdin so a prod deploy pushed the project's app secrets to the provider's
 * own store. The vault is DELETED — the owner: "no i dont want it. unless its
 * needed where i want to show the env of each of the machines (for
 * comparison)", and on the recovery passphrase that protected it, "no, its fine
 * to repaste from providers".
 *
 * So both halves are gone, and what replaces them is the operator:
 *
 *  - the deploy COMMAND runs with the infra credentials that are in this
 *    daemon's own environment, passed through `childEnv`'s opt-in `deploy: true`
 *    allowlist. If `wrangler` authenticates when the operator runs it in that
 *    shell, it authenticates here.
 *  - the `pushSecrets` step is DELETED outright rather than reimplemented
 *    against `process.env`. It existed to move values Flowviant was custodian
 *    of; with no custody there is nothing here that the operator does not
 *    already have in front of them, and `wrangler secret put` is a command they
 *    can run. Flowviant automating a push of secrets it does not hold, from an
 *    environment it does not own, into a provider store it cannot read back, is
 *    the shape of a feature that fails silently and invisibly. `target
 *    .pushSecrets` is still PARSED and reported (a dormant key is the standing
 *    call) — it simply drives nothing.
 *
 * ── WHAT A DEPLOY LOG IS ACTUALLY SCRUBBED AGAINST, corrected 2026-09-21 by
 *    the review that caught this paragraph asserting a guarantee it had lost ──
 *
 * Every log line that leaves the machine still passes through `scrub`. What
 * this paragraph claimed for a few hours was that being fed from the checkout's
 * `.env*` files was "strictly more of what a deploy log can contain than the
 * vault ever delivered", and for THIS lane that was exactly backwards. The
 * vault's deploy-scope half WAS `CLOUDFLARE_API_TOKEN` and friends, so those
 * were redacted; an operator's own token lives in the shell they started the
 * daemon in — which is the entire reason `childEnv`'s `deploy: true` widening
 * exists — and almost never in a checkout file. So the one lane that hands a
 * credential to a command and then streams that command's stdout to the server
 * was the one lane no longer redacting it.
 *
 * It is fed from BOTH now, and the join is made in `learnSecrets`
 * (`uplinkScrub.mjs`) rather than here so no call site has to remember: the
 * checkout's `.env*` files, plus the PRESENT values of `childEnv`'s own `DEPLOY_KEEP` names out of
 * `process.env` (see `processEnvSecrets`, which also explains why `CF_API_TOKEN`
 * is redacted although it is never passed, and why none of this reaches the
 * `/fleet/env-report` wire — that report is a statement about the checkout's
 * files, and this box's shell is not one). Deriving the redaction list from the
 * admission list is what stops the two drifting the next time a name is added.
 *
 * The honest residue, stated: a credential that is neither in `DEPLOY_KEEP` nor
 * in a checkout `.env*` — one a `build` script fetches for itself, say — is not
 * redacted, because this daemon has never seen it.
 */

import { spawn } from 'node:child_process';
import { scrub } from './uplinkScrub.mjs';
import { childEnv } from './childEnv.mjs';
import { readDeployConfig } from './deployConfig.mjs';
import { openDeployCheckout } from './deployCheckout.mjs';

/** How long one deploy command may run before it is stopped. */
const DEPLOY_COMMAND_TIMEOUT_MS = 30 * 60_000;

/** Run a shell command ASYNC (never blocks the daemon's event loop — the
 *  reconcile poll + the deploy heartbeat must keep firing during a long
 *  deploy). Captures combined + scrubbed output; resolves {ok,out,code}.
 *
 *  A TIMEOUT SETTLES IT, AND TAKES THE WHOLE GROUP (2026-09-26, SOLID F060's
 *  test). With `shell: true` the child is `/bin/sh`, and the timer used to
 *  SIGKILL only that: anything the shell had started — a backgrounded server,
 *  a bundler's worker, `wrangler`'s own children — kept running AND kept the
 *  stdout pipe open, so 'close' never fired, the promise never settled, and
 *  the lease heartbeated a dead deploy for ever (no report, no requeue, and
 *  `deploysInFlight` holding off every self-update). Measured: `sleep 30 &
 *  wait` held the job past its timeout. So the command runs as its own process
 *  group (the shape `gitNetAsync` in git.mjs and the project check in
 *  workAgentCheck.mjs already use), the timer kills the group, and the timer
 *  itself resolves rather than waiting on a pipe a survivor could still hold.
 *  The output gains one line saying so, which reaches the server in the
 *  report's `message` — a relayed fact, not a new wire field.
 *
 *  A STAND-DOWN LETS THE COMMAND FINISH AND REPORT (owner ruling 2026-09-26).
 *  Nothing but the timer above ever kills the group: there is no exit hook
 *  here, and none of the stand-downs (Ctrl+C, SIGTERM, a same-repo takeover,
 *  a commanded stop, a displaced or removed box, a revoked credential) stops
 *  a deploy. They leave through standDownExit.mjs's `leave`, which keeps the
 *  process up — lock held and marked draining, `busy` still written for the
 *  tray — until deploy.mjs has posted the outcome, a refused credential
 *  included (said in words, never thrown). deployRunner.test.mjs pins that the
 *  command outlives even a process that exits under it. `detached` is
 *  setsid, so the command is not in the terminal's foreground group: a Ctrl-C
 *  reaches only the daemon, which then waits for it. A person who presses
 *  Ctrl-C a second time leaves the command running, but the daemon first
 *  posts a best-effort outcome `unknown` (deploy.mjs
 *  `reportDeploysAbandoned`), which the server makes terminal and never hands
 *  out again. Only a SIGKILL, or an `unknown` post that does not land, leaves
 *  the job to the server's three-minute requeue. A service manager that kills
 *  the whole control group after its own stop timeout is outside what this
 *  process can hold (standDownExit.mjs states the unit settings).
 *  `windowsHide` keeps a native Windows daemon from opening a console window
 *  per command. */
export function run(command, { cwd, env, timeoutMs = DEPLOY_COMMAND_TIMEOUT_MS }) {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      env,
      shell: true,
      detached: true,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let buf = '';
    let settled = false;
    const settle = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    const cap = (d) => {
      buf += d.toString();
      if (buf.length > 512 * 1024) buf = buf.slice(-512 * 1024); // bound memory
    };
    child.stdout.on('data', cap);
    child.stderr.on('data', cap);
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, 'SIGKILL'); // the whole group
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }
      const limit = timeoutMs >= 60_000 ? `${Math.round(timeoutMs / 60_000)} minutes` : `${timeoutMs}ms`;
      settle({
        ok: false,
        code: -1,
        out: scrub(`${buf}\n[flowviant] the command ran past ${limit} and was stopped`),
      });
    }, timeoutMs);
    // A broken pipe (a child that exits before its stdin is closed) surfaces as
    // an ASYNC 'error' on the stdin stream, which the try/catch around this
    // cannot catch. Without a listener it is an uncaught exception that kills
    // the whole daemon. Swallow it.
    //
    // The `input` parameter this used to take went with the prod-secret push —
    // it existed so a value could reach `wrangler secret put` on stdin rather
    // than argv, and there is no value left to send. Closing stdin immediately
    // is now the only case.
    child.stdin.on('error', () => {});
    child.stdin.end();
    child.on('close', (code) => {
      settle({ ok: code === 0, code: code ?? -1, out: scrub(buf) });
    });
    child.on('error', (e) => {
      settle({ ok: false, code: -1, out: scrub(`${buf}\n${e.message}`) });
    });
  });
}

const tailLines = (s, n = 40) => s.split('\n').filter(Boolean).slice(-n);

/** Health-check a deployed target: GET the URL, expect `status`. Retries a few
 *  times for propagation lag. */
async function verifyHealth(url, status) {
  for (let i = 0; i < 4; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000), redirect: 'manual' });
      if (res.status === Number(status)) return true; // coerce — a string "200" in deploy.json must still match
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  return false;
}

export async function runDeploy(job, ctx) {
  let checkout;
  try {
    checkout = await openDeployCheckout({
      repoRoot: ctx.repoRoot,
      baseRef: ctx.baseRef,
      jobId: job.id,
      worktreeDir: ctx.worktreeDir,
    });
  } catch (e) {
    return { ok: false, message: `deploy not run — ${e.message}`, logs: [] };
  }
  try {
    const targets = readDeployConfig(ctx.repoRoot, checkout.sha);
    const target = targets.find((t) => t.id === job.targetId);
    if (!target) {
      return { ok: false, message: `target "${job.targetId}" not in .flowviant/deploy.json`, logs: [] };
    }
    const outcome = await runDeployIn(job, target, checkout.dir);
    const short = checkout.sha.slice(0, 12);
    return { ...outcome, sha: checkout.sha, message: `${outcome.message} (${short})` };
  } finally {
    checkout.cleanup();
  }
}

async function runDeployIn(job, target, cwd) {
  // AN ALLOWLIST, not `{...process.env}` minus names. What stood here was
  //
  //     const env = { ...process.env, ...deployCreds() };
  //     delete env.FLEET_TOKEN;
  //
  // and that delete was a NO-OP: `FLEET_TOKEN` is a module constant in
  // config.mjs, while the environment variable is `FLOWVIANT_FLEET`. The
  // machine credential was therefore in the environment of every deploy
  // command — and of `target.build`, which is a string the REPO controls —
  // under a comment asserting the opposite. A denylist is a claim about a set
  // you cannot see; this is built from {} instead.
  //
  // `deploy: true` is the OPT-IN SECOND GROUP (childEnv.mjs): a named set of
  // infra credential variables kept out of this daemon's own environment, and
  // nothing else. It replaced `extra: deployCreds()` when the vault was deleted
  // — the credentials are the OPERATOR's now, in the shell they started the
  // daemon in, rather than values Flowviant decrypted onto the box.
  const env = childEnv({ cwd, deploy: true }); // infra creds; never a file
  const logs = [];
  /**
   * THE ENV-ISOLATION GUARD, RE-APPLIED HERE (2026-09-24, the audit).
   *
   * The server already refuses a non-prod trigger whose target declares no
   * per-env override — `createDeployJob`'s own comment names the same
   * fallback this file resolves, `commands?.[env] || command`, as the reason:
   * the base `command` (and the bare `npx wrangler rollback` default) is the
   * PROD command, so a dev/preview trigger with no override would silently
   * run production. But that check reads the SERVER'S MIRROR
   * (`reportDeployConfig`'s last post), and this function reads the file OFF
   * THE COMMIT it is about to build and run — a window the trigger-time check
   * cannot close: the file on base changed after the last report, or this
   * daemon has not reported yet. So the same rule is asked again here,
   * against the only copy that is about to matter, and prod is the one env
   * this never touches.
   */
  if (job.env !== 'prod') {
    const key = job.kind === 'rollback' ? `rollback:${job.env}` : job.env;
    if (!target.commands?.[key]) {
      return {
        ok: false,
        message: `target declares no ${job.env} command — refusing to fall back to the prod command`,
        logs,
      };
    }
  }
  // Rollback is a single wrangler command; deploy is build → secrets → deploy.
  if (job.kind === 'rollback') {
    const cmd = target.commands?.[`rollback:${job.env}`] || `npx wrangler rollback`;
    const r = await run(cmd, { cwd, env });
    logs.push(...tailLines(r.out));
    return { ok: r.ok, message: r.ok ? 'rolled back' : logs.slice(-6).join('\n'), logs };
  }

  if (target.build) {
    const b = await run(target.build, { cwd, env });
    logs.push(...tailLines(b.out));
    if (!b.ok) return { ok: false, message: `build failed:\n${logs.slice(-6).join('\n')}`, logs };
  }

  // THE PROD-SECRET PUSH IS DELETED (2026-09-21). What stood here read
  // `appSecretsFor('prod')` out of the vault and piped each value into
  // `wrangler secret put` on stdin — never argv, so no prod plaintext in `ps`.
  // That care was right and it is moot: the vault is gone, Flowviant holds no
  // app secret for anybody, and there is nothing left to push. It is not
  // reimplemented against `process.env`, because a deploy that quietly pushes
  // whatever happens to be exported in the daemon's shell into a provider's
  // secret store is a worse feature than no feature — the operator can see and
  // run `wrangler secret put`, and they are the only one who can tell which
  // values belong there. `target.pushSecrets` stays parsed and reported, which
  // is what every retired key in this product does.
  const cmd = target.commands?.[job.env] || target.command;
  const d = await run(cmd, { cwd, env });
  logs.push(...tailLines(d.out));
  if (!d.ok) return { ok: false, message: `deploy failed:\n${logs.slice(-8).join('\n')}`, logs };

  // Extract the wrangler version/deployment id if present.
  const idMatch = d.out.match(/Current Version ID:\s*([0-9a-f-]+)/i);
  const deploymentId = idMatch ? idMatch[1] : null;

  let healthOk = null;
  if (target.healthcheck) {
    healthOk = await verifyHealth(target.healthcheck, target.healthStatus ?? 200);
  }
  return {
    ok: true,
    healthOk,
    deploymentId,
    message: healthOk === false ? 'deployed, but health check failed' : 'deployed',
    logs,
  };
}
