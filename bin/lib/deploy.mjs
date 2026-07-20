/**
 * Cloudflare DevOps — the daemon runs the user's own `wrangler`. Broker-not-
 * host: no cloud credential ever reaches Flowviant. A deploy-authorized daemon
 * claims deploy jobs off the roster, runs build → push prod secrets → deploy →
 * verify, and reports the outcome. It also reports its parsed
 * .flowviant/deploy.json so the app can list targets, and (basic) observes
 * out-of-band deployments.
 *
 * Every log line that leaves the machine passes through the env scrubber —
 * wrangler output routinely echoes secrets.
 */

import { readFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { FLEET_URL, FLEET_TOKEN, USER_AGENT } from './config.mjs';
import { c, note, ok, warn } from './ui.mjs';
import { deployCreds, appSecretsFor, scrub, myPubB64 } from './env.mjs';

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

/** Read + parse .flowviant/deploy.json from the repo root. Returns [] if none. */
export function readDeployConfig(repoRoot) {
  const path = join(repoRoot, '.flowviant', 'deploy.json');
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    const targets = Array.isArray(parsed?.targets) ? parsed.targets : [];
    // Keep only fields the server + runner need; the daemon holds the commands.
    return targets
      .filter((t) => t && typeof t.id === 'string' && typeof t.command === 'string')
      .slice(0, 20);
  } catch (e) {
    warn(`deploy: .flowviant/deploy.json is not valid JSON — ${e.message}`);
    return [];
  }
}

/** Report the parsed config to the server (only when it changed). */
let lastConfigJson = null;
export async function reportDeployConfig(repoRoot) {
  const targets = readDeployConfig(repoRoot);
  const json = JSON.stringify(targets);
  if (json === lastConfigJson) return;
  // Strip commands/secrets before the server sees the config (metadata only).
  const meta = targets.map((t) => ({
    id: t.id,
    label: t.label,
    provider: t.provider || 'cloudflare',
    command: t.command,
    build: t.build,
    commands: t.commands,
    healthcheck: t.healthcheck,
    healthStatus: t.healthStatus,
    pushSecrets: t.pushSecrets,
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
function run(command, { cwd, env, input }) {
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
    if (input != null) {
      try {
        child.stdin.write(input);
        child.stdin.end();
      } catch {
        /* stdin closed */
      }
    } else {
      child.stdin.end();
    }
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
      if (res.status === status) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  return false;
}

const claiming = new Set(); // in-flight guard (single-flight per daemon process)

/**
 * Process queued deploy jobs from the roster. `ctx` = { repoRoot, baseRef,
 * myPubB64 }. Each job: claim → build → push prod secrets → deploy → verify →
 * report. Runs concurrently but one-per-jobId.
 */
export function processDeployJobs(jobs, ctx) {
  if (!Array.isArray(jobs) || !jobs.length) return;
  for (const job of jobs) {
    if (claiming.has(job.id)) continue;
    claiming.add(job.id);
    void (async () => {
      let beat = null;
      try {
        const claimed = await post('deploy-claim', { jobId: job.id, pubkey: ctx.myPubB64() }).catch(() => null);
        if (!claimed?.claimed) return; // another daemon won the claim
        // Keep the claim fresh while we run — a long deploy must never be
        // re-queued out from under us (that would double-deploy). The async
        // run() below keeps the event loop free so this fires.
        beat = setInterval(() => {
          void post('deploy-heartbeat', { jobId: job.id, pubkey: ctx.myPubB64() }).catch(() => {});
        }, 60_000);
        const targets = readDeployConfig(ctx.repoRoot);
        const target = targets.find((t) => t.id === job.targetId);
        if (!target) {
          await report(job, ctx, { ok: false, message: `target "${job.targetId}" not in .flowviant/deploy.json` });
          return;
        }
        note(`${c.cyan('deploy')} ${c.dim(`— ${job.kind} ${job.targetId} → ${job.env}…`)}`);
        const outcome = await runDeploy(job, target, ctx);
        await report(job, ctx, outcome);
        if (outcome.ok) ok(`${c.cyan('deploy')} ${c.dim(`— ${job.targetId} → ${job.env} done${outcome.healthOk === false ? ' (health failed)' : ''}`)}`);
        else warn(`deploy: ${job.targetId} → ${job.env} failed — ${outcome.message}`);
      } catch (e) {
        warn(`deploy job ${job.id} errored: ${e.message}`);
        await report(job, ctx, { ok: false, message: e.message }).catch(() => {});
      } finally {
        if (beat) clearInterval(beat);
        claiming.delete(job.id);
      }
    })();
  }
}

async function runDeploy(job, target, ctx) {
  const env = { ...process.env, ...deployCreds() }; // inject infra creds; never a file
  const logs = [];
  // Rollback is a single wrangler command; deploy is build → secrets → deploy.
  if (job.kind === 'rollback') {
    const cmd = target.commands?.[`rollback:${job.env}`] || `npx wrangler rollback`;
    const r = await run(cmd, { cwd: ctx.repoRoot, env });
    logs.push(...tailLines(r.out));
    return { ok: r.ok, message: r.ok ? 'rolled back' : logs.slice(-6).join('\n'), logs };
  }

  if (target.build) {
    const b = await run(target.build, { cwd: ctx.repoRoot, env });
    logs.push(...tailLines(b.out));
    if (!b.ok) return { ok: false, message: `build failed:\n${logs.slice(-6).join('\n')}`, logs };
  }

  // Push prod app secrets to the provider's secret store (never written local).
  // `name` is always a validated vault key (alnum/underscore) or skipped, and
  // the VALUE goes only via stdin — never argv (no prod plaintext in ps).
  if (job.env === 'prod' && Array.isArray(target.pushSecrets) && target.pushSecrets.length) {
    const secrets = appSecretsFor('prod');
    for (const name of target.pushSecrets) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || !(name in secrets)) {
        warn(`deploy: pushSecret "${name}" invalid or not in the vault at prod scope — skipping`);
        continue;
      }
      const putCmd = target.commands?.['secretPut']
        ? target.commands['secretPut'].replace('{name}', name)
        : `npx wrangler secret put ${name} --env production`;
      const s = await run(putCmd, { cwd: ctx.repoRoot, env, input: secrets[name] });
      if (!s.ok) return { ok: false, message: `pushing secret ${name} failed`, logs };
    }
  }

  const cmd = target.commands?.[job.env] || target.command;
  const d = await run(cmd, { cwd: ctx.repoRoot, env });
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

function report(job, ctx, outcome) {
  return post('deploy-report', {
    jobId: job.id,
    pubkey: ctx.myPubB64(),
    ok: !!outcome.ok,
    deploymentId: outcome.deploymentId ?? null,
    healthOk: outcome.healthOk ?? null,
    message: scrub(outcome.message || ''),
  }).catch((e) => warn(`deploy: could not report outcome — ${e.message}`));
}
