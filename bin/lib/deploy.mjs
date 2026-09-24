/**
 * Cloudflare DevOps — the daemon runs the user's own `wrangler`. Broker-not-
 * host: no cloud credential ever reaches Flowviant. A daemon on a project with
 * deploy allowed claims deploy jobs off the roster, runs build → deploy →
 * verify, and reports the outcome. It also reports its parsed
 * .flowviant/deploy.json so the app can list targets, and (basic) observes
 * out-of-band deployments.
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
 * It is fed from BOTH now, and the join is made in `scanEnvForScrub` rather
 * than here so no call site has to remember: the checkout's `.env*` files, plus
 * the PRESENT values of `childEnv`'s own `DEPLOY_KEEP` names out of
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
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import { FLEET_URL, FLEET_TOKEN, USER_AGENT, DAEMON_INSTANCE } from './config.mjs';
import { c, note, ok, warn } from './ui.mjs';
import { scrub, myPubB64 } from './env.mjs';
import { childEnv } from './childEnv.mjs';
import { git, gitNetAsync } from './git.mjs';

const deployUrl = (tail) => FLEET_URL.replace(/\/agents\/?$/, `/${tail}`);

async function post(tail, body) {
  const res = await fetch(deployUrl(tail), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${FLEET_TOKEN}`,
      'User-Agent': USER_AGENT,
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout(30_000),
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json?.success === false) {
    throw new Error(`${tail} failed (${res.status}${json?.error ? `: ${json.error}` : ''})`);
  }
  return json?.data;
}

/**
 * Read + parse `.flowviant/deploy.json` AS IT IS ON THE BASE BRANCH. Returns []
 * if the branch has none.
 *
 * IT USED TO READ THE WORKING TREE, which made the feature's one stated bound
 * false. `deploy_target`'s own description says "only ids already declared in
 * `.flowviant/deploy.json` on MAIN can be named (the daemon reads and runs from
 * the repo ROOT, never a session worktree, so an agent cannot author the command
 * it triggers without shipping it first)" — and the repo root's WORKING TREE is
 * exactly where the machine operator's tabs stand (their place is the checkout).
 * So an agent that had read an injected instruction could write an uncommitted
 * `.flowviant/deploy.json` naming any shell command, call `deploy_target`, and
 * have the daemon run it from the repo root with `CLOUDFLARE_API_TOKEN` and
 * every other deploy-scope credential in its environment. Nothing about that
 * needed a commit, a review, or an owner.
 *
 * Reading the COMMITTED tree is what makes the sentence true: authoring the
 * command now requires landing it on base, which is a reviewed act. The file is
 * read through git rather than the filesystem, so an uncommitted edit is simply
 * not there.
 *
 * A base ref that does not resolve yields NO TARGETS, and says so once. That is
 * the withholding direction and it is the right one here — a deploy is
 * irreversible and running the wrong file is worse than running nothing.
 */
export function readDeployConfig(repoRoot, baseRef) {
  let raw;
  if (baseRef) {
    try {
      raw = git(['show', `${baseRef}:.flowviant/deploy.json`], repoRoot);
    } catch {
      // No such file on base, or a base ref that does not resolve. Both mean
      // "this branch declares no targets", which is a real answer.
      return [];
    }
  } else {
    // No base ref in hand (a caller that has not been updated). Refuse rather
    // than silently falling back to the working tree — that fallback IS the bug.
    warn('deploy: no base branch resolved, so no deploy targets were read.');
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    const targets = Array.isArray(parsed?.targets) ? parsed.targets : [];
    // Keep only fields the server + runner need; the daemon holds the commands.
    return targets
      .filter((t) => t && typeof t.id === 'string' && typeof t.command === 'string')
      .slice(0, 20);
  } catch (e) {
    warn(`deploy: .flowviant/deploy.json on the base branch is not valid JSON — ${e.message}`);
    return [];
  }
}

/** Report the parsed config to the server (only when it changed). */
let lastConfigJson = null;
export async function reportDeployConfig(repoRoot, baseRef) {
  const targets = readDeployConfig(repoRoot, baseRef);
  const json = JSON.stringify(targets);
  if (json === lastConfigJson) return;
  // Scrub command strings before the server sees them — a command line can embed
  // an internal host or a synced secret. Only redacted metadata leaves the box.
  const scrubCmds = (o) =>
    o && typeof o === 'object'
      ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, scrub(String(v ?? ''))]))
      : o;
  const meta = targets.map((t) => ({
    id: t.id,
    label: t.label,
    provider: t.provider || 'cloudflare',
    command: scrub(String(t.command ?? '')),
    build: t.build ? scrub(String(t.build)) : t.build,
    commands: scrubCmds(t.commands),
    healthcheck: t.healthcheck,
    healthStatus: t.healthStatus,
    pushSecrets: t.pushSecrets,
    // Deploy-on-merge: the env this target auto-deploys to when commits land
    // on base. MUST ride this map — a field forgotten here never reaches the
    // server, and the server is what turns a landed report into the job.
    ...(typeof t.onMerge === 'string' ? { onMerge: t.onMerge } : {}),
  }));
  try {
    await post('deploy-config', { pubkey: myPubB64(), targets: meta });
    lastConfigJson = json;
  } catch (e) {
    warn(`deploy: could not report config — ${e.message}`);
  }
}

/** Run a shell command ASYNC (never blocks the daemon's event loop — the
 *  reconcile poll + the deploy heartbeat must keep firing during a long
 *  deploy). Captures combined + scrubbed output; resolves {ok,out,code}. */
function run(command, { cwd, env }) {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, env, shell: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '';
    const cap = (d) => {
      buf += d.toString();
      if (buf.length > 512 * 1024) buf = buf.slice(-512 * 1024); // bound memory
    };
    child.stdout.on('data', cap);
    child.stderr.on('data', cap);
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }, 30 * 60_000);
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
      clearTimeout(timer);
      resolve({ ok: code === 0, code: code ?? -1, out: scrub(buf) });
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, code: -1, out: scrub(`${buf}\n${e.message}`) });
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

const claiming = new Set(); // in-flight guard (single-flight per daemon process)
/**
 * JOBS THIS PROCESS HAS ALREADY RUN, whatever the server thinks.
 *
 * A deploy is IRREVERSIBLE and the report is not: a transient 5xx, a DNS blip
 * or the 30s timeout meant the outcome never landed, the heartbeat stopped,
 * and three minutes later the server requeued the job and this same daemon ran
 * `wrangler rollback` — or a full prod deploy — a SECOND time, leaving
 * production two versions behind the intended one with nothing recording that
 * it happened twice.
 *
 * So the process remembers. Not a substitute for the report (see the retry
 * below, which is the real fix); a floor under it, for the case where the
 * report never lands at all. It does not survive a restart — nothing local
 * could be trusted to — which is why the retry has to keep the heartbeat alive
 * while it runs.
 */
const ran = new Set();

/**
 * Process queued deploy jobs from the roster. `ctx` = { repoRoot, baseRef,
 * myPubB64 }. Each job: claim → build → deploy → verify → report. Runs
 * concurrently but one-per-jobId.
 */
export function processDeployJobs(jobs, ctx) {
  if (!Array.isArray(jobs) || !jobs.length) return;
  for (const job of jobs) {
    // Defend against a malformed roster element — `job.id` on a null would throw
    // synchronously here (outside the per-job try below) and wedge the whole
    // reconcile loop, since this runs unguarded from the fleet tick.
    if (!job || typeof job.id !== 'string') continue;
    if (claiming.has(job.id)) continue;
    if (ran.has(job.id)) continue; // already executed here — never twice
    claiming.add(job.id);
    void (async () => {
      let beat = null;
      try {
        // `instance` names THIS PROCESS. The pubkey cannot: it is the env
        // keypair read from one file per home directory, so two daemons on one
        // box share it and a pubkey-only read-back let both "win" the claim
        // and run the same deploy twice concurrently.
        const claimed = await post('deploy-claim', {
          jobId: job.id,
          pubkey: ctx.myPubB64(),
          instance: DAEMON_INSTANCE,
        }).catch(() => null);
        if (!claimed?.claimed) return; // another daemon won the claim
        // Keep the claim fresh while we run — a long deploy must never be
        // re-queued out from under us (that would double-deploy). The async
        // run() below keeps the event loop free so this fires.
        /**
         * …AND IT CAN DIE, which is what makes the `stillBeating` predicate
         * below mean anything.
         *
         * `report` is handed `() => beat != null` so it stops retrying once the
         * claim is certainly stale — but `beat` only ever held a timer handle
         * and was never nulled, so that predicate could not return false and
         * `report` retried into a job another daemon may already own.
         *
         * The server re-queues a deploy whose heartbeat is older than three
         * minutes, and this fires every sixty seconds — so three consecutive
         * failures is exactly the point past which the claim cannot be assumed.
         * A single blip does not count: only an unbroken run does.
         */
        let missed = 0;
        beat = setInterval(() => {
          void post('deploy-heartbeat', {
            jobId: job.id,
            pubkey: ctx.myPubB64(),
            // Instance rides the heartbeat too, or a same-box sibling's beat
            // could keep a dead claimer's job "running" past the stale sweep.
            instance: DAEMON_INSTANCE,
          })
            .then(() => {
              missed = 0;
            })
            .catch(() => {
              missed += 1;
              if (missed >= 3 && beat) {
                clearInterval(beat);
                beat = null;
              }
            });
        }, 60_000);
        note(`${c.cyan('deploy')} ${c.dim(`— ${job.kind} ${job.targetId} → ${job.env}…`)}`);
        const outcome = await runDeploy(job, ctx);
        // From here the work is DONE. Whatever the report does, this job must
        // never run again in this process.
        ran.add(job.id);
        await report(job, ctx, outcome, () => beat != null);
        if (outcome.ok) ok(`${c.cyan('deploy')} ${c.dim(`— ${job.targetId} → ${job.env} done${outcome.healthOk === false ? ' (health failed)' : ''}`)}`);
        else warn(`deploy: ${job.targetId} → ${job.env} failed — ${outcome.message}`);
      } catch (e) {
        warn(`deploy job ${job.id} errored: ${e.message}`);
        await report(job, ctx, { ok: false, message: e.message }).catch(() => {});
      } finally {
        // Stopped only AFTER the report has landed or given up — the requeue is
        // gated on heartbeat staleness, so beating through the retries is what
        // stops the server handing this job out again mid-retry.
        if (beat) clearInterval(beat);
        claiming.delete(job.id);
      }
    })();
  }
}

/**
 * A DEPLOY BUILDS THE BASE COMMIT, NEVER THE OPERATOR'S WORKING TREE
 * (audit 2026-09-24).
 *
 * `readDeployConfig` reads the TARGET off base so that authoring a command
 * requires landing it — and then every command ran with `cwd: repoRoot`, the
 * operator's own checkout, on whatever branch they left it with whatever they
 * had not committed. So `npm run build` and `wrangler deploy` read the
 * package.json scripts, wrangler.toml and source of that working tree:
 * deploy-on-merge (queued by a teammate's ship, a PR merge or an agent merge,
 * none of which moves the checkout) shipped code WITHOUT the merge that
 * triggered it, and a co-owner's "deploy it to prod" shipped the operator's
 * half-finished branch. Reproduced: a checkout on `feature` with an
 * uncommitted edit deployed the edit.
 *
 * So a deploy runs in a THROWAWAY DETACHED WORKTREE at the base tip — the
 * shipMerge shape — and the config is read from THAT SHA, so the command and
 * the code it builds are one commit. The directory dies in a `finally`.
 *
 * What a fresh worktree does not have is what git does not track: installed
 * dependencies and the operator's env files. Those are the checkout's
 * ENVIRONMENT, not its code, so for every directory base tracks (three levels
 * deep) a `node_modules` in the checkout is re-created as a directory of links
 * to its entries — a WORKSPACE package's link re-pointed at base's own copy of
 * that package, never the checkout's working tree — and a `.env` / `.env.*` /
 * `.dev.vars` the base commit does not carry is COPIED in. Stated residual:
 * installed third-party packages and those env files are still the checkout's,
 * so a dependency installed for a feature branch, or an untracked env file an
 * agent edited, reaches the build; so does a workspace package's untracked
 * build output (`dist/`), which is simply absent here and fails the build
 * loudly rather than shipping the checkout's. A `.bin` shim is linked whole, so
 * a workspace package's own CLI still runs from the checkout. Submodules are
 * not initialised. The code and the commands no longer come from the checkout.
 */
const ENV_FILE_RE = /^(?:\.env(?:\..+)?|\.dev\.vars)$/;
const lexists = (p) => {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

/** Bring the checkout's untracked environment into a deploy worktree. Returns
 *  every path it created, so the cleanup can unlink them BEFORE the worktree
 *  is removed (a recursive delete must never be handed a symlink into the
 *  operator's own node_modules). */
export function linkCheckoutEnvironment(repoRoot, dir) {
  const made = [];
  let realRoot = repoRoot;
  try {
    realRoot = realpathSync(repoRoot);
  } catch {
    /* compared as given */
  }
  /**
   * A node_modules is a REAL directory of per-entry links, not one link to the
   * checkout's (review, audit 2026-09-24). A workspace package — npm, yarn and
   * pnpm all install one as a link like `node_modules/@x/shared ->
   * ../../packages/shared` — resolves THROUGH the checkout's node_modules into
   * the checkout's WORKING TREE, so a whole-directory link had every bundler
   * import the operator's uncommitted `packages/shared/src` into a deploy of
   * base. An entry whose real path is inside the checkout but outside any
   * node_modules is re-pointed at the SAME path in this worktree (base's copy);
   * one base does not carry is left out, since base cannot import what it does
   * not have. Every other entry links to the checkout's own, as before.
   */
  const linkNodeModules = (src, dst, depth) => {
    let entries;
    try {
      entries = readdirSync(src, { withFileTypes: true });
      mkdirSync(dst);
      made.push(dst);
    } catch {
      return;
    }
    for (const e of entries) {
      const s = join(src, e.name);
      const d = join(dst, e.name);
      // A scope directory holds packages, not a package: one level down.
      if (depth === 0 && e.name.startsWith('@') && e.isDirectory()) {
        linkNodeModules(s, d, 1);
        continue;
      }
      let target = s;
      if (e.isSymbolicLink()) {
        let real;
        try {
          real = realpathSync(s);
        } catch {
          continue; // a dangling link — nothing to bring
        }
        const rel = relative(realRoot, real);
        const inCheckout = rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
        if (inCheckout && !rel.split(sep).includes('node_modules')) {
          if (!existsSync(join(dir, rel))) continue;
          target = join(dir, rel);
        }
      }
      try {
        symlinkSync(target, d);
        made.push(d);
      } catch {
        /* the build says so if it needed it */
      }
    }
  };
  const walk = (rel, depth) => {
    let entries;
    try {
      entries = readdirSync(join(repoRoot, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const src = join(repoRoot, rel, e.name);
      const dst = join(dir, rel, e.name);
      if (e.name === '.git') continue;
      if (e.name === 'node_modules') {
        if (e.isDirectory() && !lexists(dst)) linkNodeModules(src, dst, 0);
        continue;
      }
      if (e.isFile() && ENV_FILE_RE.test(e.name)) {
        if (!lexists(dst)) {
          try {
            copyFileSync(src, dst);
            made.push(dst);
          } catch {
            /* unreadable — the build says so if it needed it */
          }
        }
        continue;
      }
      // Recurse only into directories BASE tracks — an untracked `dist/` or a
      // cache is neither code nor environment, and walking it costs a scan.
      if (e.isDirectory() && depth < 3 && existsSync(dst) && !lexists(join(dst, '.git'))) {
        walk(join(rel, e.name), depth + 1);
      }
    }
  };
  walk('', 0);
  return made;
}

/**
 * Cut the deploy worktree at the base tip. Returns `{ dir, sha, cleanup }`, or
 * throws with a sentence when base does not resolve. `worktreeDir` defaults to
 * the daemon's own worktree home for this repo (fleet.mjs keys it the same
 * way); the job id is hashed into the path, never joined raw — it is a
 * server-named string.
 */
export async function openDeployCheckout({ repoRoot, baseRef, jobId, worktreeDir }) {
  if (!baseRef) throw new Error('no base branch resolved, so there is nothing to deploy from');
  try {
    // A NETWORK call, so timed, non-interactive and off the event loop — a
    // bare `git fetch` here is `execFileSync` with no timeout, and a remote
    // that prompts or a half-open connection froze every poll and lease on
    // the machine until it returned.
    await gitNetAsync(['fetch', 'origin', '--quiet'], repoRoot);
  } catch {
    /* offline — deploy the base this box last saw, and say which */
  }
  let sha;
  try {
    sha = git(['rev-parse', '--verify', `${baseRef}^{commit}`], repoRoot);
  } catch {
    throw new Error(`the base branch ${baseRef} does not resolve on this machine`);
  }
  const home =
    worktreeDir ??
    join(
      homedir(),
      '.flowviant',
      'worktrees',
      `${basename(repoRoot)}-${createHash('sha256').update(repoRoot).digest('hex').slice(0, 8)}`
    );
  const dir = join(home, 'deploy', createHash('sha256').update(String(jobId)).digest('hex').slice(0, 16));
  mkdirSync(join(home, 'deploy'), { recursive: true });
  const drop = (made = [], target = dir) => {
    // Newest first, so a node_modules directory we made is empty of our links
    // by the time it is removed.
    for (const p of [...made].reverse()) {
      try {
        unlinkSync(p);
      } catch {
        try {
          rmdirSync(p);
        } catch {
          /* already gone */
        }
      }
    }
    try {
      git(['worktree', 'remove', '--force', target], repoRoot);
    } catch {
      /* not registered */
    }
    // Every symlink we made is already unlinked, and `rmSync` unlinks a
    // symlink rather than descending it, so this can only delete our own copy.
    try {
      rmSync(target, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
    try {
      git(['worktree', 'prune'], repoRoot);
    } catch {
      /* best-effort */
    }
  };
  drop(); // a corpse from a crashed deploy of the same job
  // …and any other job's corpse old enough that no deploy can still be running
  // in it (two commands at most, 30 minutes each), so a daemon killed
  // mid-deploy does not leave a checkout on disk for ever.
  try {
    const cutoff = Date.now() - 3 * 60 * 60 * 1000;
    for (const name of readdirSync(join(home, 'deploy'))) {
      const p = join(home, 'deploy', name);
      try {
        if (p !== dir && lstatSync(p).mtimeMs < cutoff) drop([], p);
      } catch {
        /* gone meanwhile */
      }
    }
  } catch {
    /* nothing to sweep */
  }
  git(['worktree', 'add', '--detach', dir, sha], repoRoot);
  let made = [];
  try {
    made = linkCheckoutEnvironment(repoRoot, dir);
  } catch {
    /* the build says so if it needed any of it */
  }
  return { dir, sha, cleanup: () => drop(made) };
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

/**
 * THE OUTCOME IS RETRIED, because losing it re-runs the deploy.
 *
 * One `post` with a `.catch(warn)` was the whole of this: a transient 5xx, a
 * DNS blip or the 30s timeout dropped the outcome, the `finally` stopped the
 * heartbeat, and the server — which requeues a running job after three minutes
 * without one — handed the SAME job back to the SAME daemon, which ran it
 * again. For a rollback that is production two versions behind the intended
 * one; for a prod deploy it is the whole deploy run twice. Nothing recorded
 * that it had happened at all.
 *
 * The heartbeat keeps running throughout (the caller's `finally` is what stops
 * it), so the requeue window stays shut for as long as we are still trying.
 * Bounded: six attempts over roughly a minute, then a warning and the local
 * `ran` guard as the floor.
 */
async function report(job, ctx, outcome, stillBeating = () => true) {
  const body = {
    jobId: job.id,
    pubkey: ctx.myPubB64(),
    // The same term the claim carries, for the same reason: the pubkey is one
    // keypair per home directory, so two daemons on one box share it, and a
    // stale holder's late report would otherwise settle the RECLAIMER's
    // running job. The server matches it when present; an older server
    // ignores the extra key.
    instance: DAEMON_INSTANCE,
    ok: !!outcome.ok,
    deploymentId: outcome.deploymentId ?? null,
    healthOk: outcome.healthOk ?? null,
    message: scrub(outcome.message || ''),
  };
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      await post('deploy-report', body);
      return;
    } catch (e) {
      // The last attempt says so; the ones before it are noise on a path that
      // usually recovers.
      if (attempt === 5) {
        warn(`deploy: could not report outcome after 6 tries — ${e.message}`);
        return;
      }
      // If the heartbeat is already gone the requeue window is open and
      // retrying buys nothing — the job may have been handed to somebody else.
      if (!stillBeating()) {
        warn(`deploy: could not report outcome — ${e.message}`);
        return;
      }
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
}
