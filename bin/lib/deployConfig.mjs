/**
 * WHAT THIS REPO DECLARES AS DEPLOY TARGETS — `.flowviant/deploy.json` read
 * off the BASE commit, and the redacted, normalized metadata reported to the
 * server's mirror.
 *
 * Split out of deploy.mjs (SOLID F060): this half changes with the file's
 * shape and the `/fleet/deploy-config` wire. The job lease (deploy.mjs), the
 * throwaway checkout (deployCheckout.mjs) and the commands (deployRunner.mjs)
 * each change for their own reasons. The runner asks `readDeployConfig` again
 * at the very commit it is about to build, so this is the file's one reader.
 */

import { git } from './git.mjs';
import { warn } from './ui.mjs';
import { scrub } from './uplinkScrub.mjs';
import { myPubB64 } from './boxIdentity.mjs';
import { post } from './deployWire.mjs';

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
  /**
   * NORMALIZE BEFORE POSTING (2026-09-24, the audit). `.flowviant/deploy.json`
   * is a hand-written file; the shared schema treats `healthStatus` /
   * `healthcheck` / `build` / `label` as display metadata and drops what it
   * cannot read rather than refusing the whole target — but this file used to
   * send them through unmodified, so a `"healthStatus": "200"` (which
   * `verifyHealth` in deployRunner.mjs already coerces with `Number()`) or a `null` label
   * used to reach the wire looking present-but-unreadable. Send exactly what
   * the mirror is going to keep instead of what the file happened to spell:
   * a numeric `healthStatus` when the value is numeric or a numeric string,
   * and no key at all for `label` / `healthcheck` / `build` when the file's
   * value is not a non-empty string.
   */
  const numOrOmit = (v) => {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && /^\s*\d+\s*$/.test(v)) return Number(v);
    return undefined;
  };
  const strOrOmit = (v) => (typeof v === 'string' && v.trim() ? v : undefined);
  const meta = targets.map((t) => {
    const label = strOrOmit(t.label);
    const build = strOrOmit(t.build);
    const healthcheck = strOrOmit(t.healthcheck);
    const healthStatus = numOrOmit(t.healthStatus);
    return {
      id: t.id,
      ...(label !== undefined ? { label } : {}),
      provider: t.provider || 'cloudflare',
      command: scrub(String(t.command ?? '')),
      ...(build !== undefined ? { build: scrub(build) } : {}),
      commands: scrubCmds(t.commands),
      ...(healthcheck !== undefined ? { healthcheck } : {}),
      ...(healthStatus !== undefined ? { healthStatus } : {}),
      pushSecrets: t.pushSecrets,
      // Deploy-on-merge: the env this target auto-deploys to when commits land
      // on base. MUST ride this map — a field forgotten here never reaches the
      // server, and the server is what turns a landed report into the job.
      ...(typeof t.onMerge === 'string' ? { onMerge: t.onMerge } : {}),
    };
  });
  try {
    const data = await post('deploy-config', { pubkey: myPubB64(), targets: meta });
    // Set on any 2xx, rejected targets included — the route now accepts a
    // report per-target rather than failing the whole thing, so a target it
    // could not read is not a reason to re-post this same file forever.
    lastConfigJson = json;
    // THE SERVER NAMES WHAT IT COULD NOT READ. Warned once per CHANGED config —
    // this function only reaches here when the file did — never once per poll.
    const rejected = Array.isArray(data?.rejected) ? data.rejected : [];
    for (const r of rejected) {
      warn(
        `deploy: .flowviant/deploy.json target "${r?.id ?? '?'}" was not accepted — ${r?.reason ?? 'invalid'}`
      );
    }
  } catch (e) {
    warn(`deploy: could not report config — ${e.message}`);
  }
}
