/**
 * THE ENVIRONMENT A SPAWNED COMMAND GETS — and, more to the point, what it does
 * not get.
 *
 * WHY THIS FILE EXISTS: `deploy.mjs` carried
 *
 *     const env = { ...process.env, ...deployCreds() };
 *     delete env.FLEET_TOKEN; // ... keep it out of a command that might echo its env
 *
 * and that `delete` was a LIVE NO-OP. `FLEET_TOKEN` is a JS module constant in
 * `config.mjs`; the environment variable is `FLOWVIANT_FLEET`. So the machine
 * credential sat in the environment of every deploy command — including
 * `target.build`, which is a string the REPO controls — under a confident
 * comment saying it did not. That is the whole argument for an allowlist: a
 * denylist is a claim about a set you cannot see, and it rots into a lie the
 * moment one identifier is wrong or one new secret is added upstream.
 *
 * SO: BUILT FROM `{}`, NEVER FROM `{...process.env}` MINUS NAMES. Anything not
 * named below is absent by construction, and a secret added to the daemon's
 * environment next year is absent without anybody remembering this file.
 *
 * WHAT THIS IS NOT. A spawned command runs as the SAME UID as the daemon.
 * `~/.flowviant/credentials.json` and `~/.flowviant/env-keypair.json` are 0600
 * and readable by it. This is a control against ACCIDENT AND INHERITANCE — a
 * crash reporter, a framework error page that dumps `process.env`, a build log,
 * a process that echoes its own environment — and it is NOT confinement. Real
 * confinement is a separate uid or a namespace and is not in this product. No
 * surface may describe anything here as "sandboxed" or "isolated".
 */

/**
 * The complete kept set. Two groups, and both are here for a reason that bit
 * somebody:
 *
 *  - the basics a process needs to exist at all;
 *  - the TOOLCHAIN SHIMS. An operator on nvm, asdf, volta, pnpm or bun has a
 *    PATH that points into a version-manager directory, and without these the
 *    PATH we hand over resolves to nothing — the command fails with ENOENT and
 *    the failure looks like a bad command rather than a stripped environment.
 */
const KEEP = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TZ',
  'LANG',
  'LC_ALL',
  'TMPDIR',
  // Toolchain shims.
  'NVM_DIR',
  'NVM_BIN',
  'ASDF_DIR',
  'ASDF_DATA_DIR',
  'VOLTA_HOME',
  'PNPM_HOME',
  'BUN_INSTALL',
  'N_PREFIX',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
];

/**
 * THE SECOND GROUP: INFRA CREDENTIALS, AND ONLY BEHIND `deploy: true`.
 *
 * WHY IT EXISTS (2026-09-21). Deploy used to get its credentials from the
 * secrets vault — `childEnv({ extra: deployCreds() })`, where `deployCreds()`
 * was the deploy-scope half of a bundle Flowviant had decrypted onto this box.
 * The vault is deleted (the owner: "no i dont want it"), so Flowviant holds no
 * cloud credential for anybody, and the source of a deploy's secrets is now the
 * MACHINE'S OWN ENVIRONMENT — the operator's `CLOUDFLARE_API_TOKEN`, exported
 * in the shell they started the daemon in, exactly as it would be if they ran
 * `wrangler deploy` themselves.
 *
 * But this file exists precisely because a spawned command is built from `{}`,
 * so an operator's own token is absent by construction and `wrangler deploy`
 * fails with an auth error that looks like a broken deploy. Hence an OPT-IN
 * WIDENING for the one command that genuinely needs infra credentials.
 *
 * IT IS STILL AN ALLOWLIST. `deploy: true` does not mean `{...process.env}`; it
 * means these names and nothing else. The whole argument of this module is that
 * a denylist is a claim about a set you cannot see and rots the moment somebody
 * upstream adds a secret — that argument does not weaken because the caller is
 * a deploy.
 *
 * THE BLAST RADIUS IS EXACTLY THIS LIST, and it is worth naming out loud: a
 * deploy target's `build` string is REPO-CONTROLLED (it is read from
 * `.flowviant/deploy.json` on the base branch, so authoring it requires landing
 * a commit — but it is still a string this daemon runs). Everything below is
 * therefore reachable by a reviewed commit on main, and nothing else is.
 *
 * `FLOWVIANT_*` IS NEVER IN IT, at any opt-in. The machine credential is the
 * one secret whose leak costs the project itself, and the bug this module was
 * written for is that it rode into `target.build` under a comment saying it did
 * not.
 */
const DEPLOY_KEEP = [
  'CLOUDFLARE_API_TOKEN',
  'CLOUDFLARE_ACCOUNT_ID',
  'VERCEL_TOKEN',
  'NETLIFY_AUTH_TOKEN',
  'FLY_API_TOKEN',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_REGION',
  'AWS_SESSION_TOKEN',
  'RAILWAY_TOKEN',
  'RENDER_API_KEY',
  'NPM_TOKEN',
];

/**
 * A child environment for a command Flowviant runs on the operator's behalf.
 *
 * `deploy: true` additionally keeps `DEPLOY_KEEP` from `process.env` — the
 * opt-in widening for the one command that needs infra credentials. Nothing
 * else passes it, and passing it does not widen anything beyond that list.
 *
 * `extra` is layered LAST and is the caller's own material. It is never
 * repo-supplied: the deleted preview feature let `.flowviant/preview.json`
 * contribute an `env` map that was layered last and therefore won every
 * collision, which is how a branch got to set `PATH`.
 */
export function childEnv({ cwd, extra, deploy = false } = {}) {
  const env = {};
  for (const k of KEEP) {
    if (typeof process.env[k] === 'string') env[k] = process.env[k];
  }
  if (deploy) {
    for (const k of DEPLOY_KEEP) {
      if (typeof process.env[k] === 'string') env[k] = process.env[k];
    }
  }
  // Set by us rather than inherited.
  //
  // TERM=dumb: a process that believes it owns a TTY draws progress bars and
  // spinners into a pipe forever, which is unreadable in a log tail and pins a
  // CPU on some tools.
  env.TERM = 'dumb';
  // BROWSER=none: nothing should try to open a browser on a headless box. This
  // is the one survivor of the deleted feature's env extras, and it is
  // anti-annoyance rather than security.
  env.BROWSER = 'none';
  if (cwd) env.PWD = cwd;
  // Deliberately NOT set: NODE_ENV (asserting 'development' would be Flowviant
  // choosing what the framework should decide) and PORT (we never hint a port —
  // the port is DISCOVERED by cwd attribution, and a hinted one has no
  // attribution behind it).
  return extra ? { ...env, ...extra } : env;
}

/** The names this deliberately drops on the ORDINARY path, for the test to
 *  assert against. NOT the mechanism — the mechanism is the allowlist above,
 *  and this list is only ever a sample of what it excludes. Adding a name here
 *  changes nothing.
 *
 *  Two of these (`CLOUDFLARE_API_TOKEN`, `AWS_SECRET_ACCESS_KEY`) are in
 *  `DEPLOY_KEEP` and survive `deploy: true`. They stay in this sample on
 *  purpose: the default is what almost every caller gets, and the sample is
 *  about the default. */
export const DROPPED_SAMPLE = [
  'FLOWVIANT_FLEET',
  'FLOWVIANT_FLEET_URL',
  'FLOWVIANT_API_URL',
  'FLOWVIANT_MCP_URL',
  'FLOWVIANT_MODEL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'SSH_AUTH_SOCK',
  'CLOUDFLARE_API_TOKEN',
  'AWS_SECRET_ACCESS_KEY',
  'npm_config__authToken',
];

/** The opt-in group, exported for the test: `deploy: true` keeps exactly these
 *  and nothing else, and a name that is NOT here must still be absent. */
export const DEPLOY_KEEP_NAMES = [...DEPLOY_KEEP];

/**
 * THE SAME INFRA CREDENTIALS, HANDED TO THE REDACTOR — never to the wire
 * (2026-09-21, the review).
 *
 * THE REGRESSION THIS CLOSES. Until the vault was deleted, `scrub()` was fed
 * the decrypted bundle, and the deploy-scope half of that bundle WAS
 * `CLOUDFLARE_API_TOKEN` and friends — so every line of `wrangler` output that
 * echoed the operator's token was redacted on its way to the server. The
 * replacement scrubber reads the CHECKOUT'S `.env*` files, and an operator's
 * deploy credential is almost never in one: it is exported in the shell they
 * started the daemon in, which is exactly why `DEPLOY_KEEP` above exists. So
 * the one lane that PASSES a secret into a command it then streams to the
 * server had stopped redacting it. `deploy.mjs`'s own header was meanwhile
 * still asserting the opposite — "strictly more of what a deploy log can
 * contain than the vault ever delivered" — which is the defended-local-decision
 * shape: a confident comment over a guarantee that had quietly lapsed.
 *
 * WHY IT LIVES HERE AND NOT IN `env.mjs`. This file is the single definition of
 * what a spawned command may be handed; the redaction list must be the same set
 * or it rots the moment somebody adds a name to `DEPLOY_KEEP` and forgets the
 * other half. Deriving it FROM that array is what makes forgetting impossible,
 * and it is why the merge happens inside `scanEnvForScrub` rather than at a
 * call site somebody has to remember. The dependency direction is the only one
 * that is acyclic besides: this module imports nothing at all.
 *
 * TWO NAMES ARE HERE THAT ARE NOT IN `DEPLOY_KEEP`, and the asymmetry is the
 * point. `CF_API_TOKEN` and `CF_ACCOUNT_ID` are wrangler's older spellings — it
 * still reads them — so a box may well hold the token under that name while the
 * deploy command is handed nothing. REDACTING a value we do not pass costs
 * nothing and covers the operator who is still on the old spelling; PASSING one
 * would widen the blast radius of a repo-controlled `build` string, which is
 * the thing this module exists to bound. Redaction and admission are different
 * questions and this is the one place they are allowed to differ.
 *
 * IT NEVER REACHES THE REPORT. `/fleet/env-report` is a statement about the
 * CHECKOUT'S FILES — that is the comparison the owner asked for, "show the env
 * of each of the machines (for comparison)" — and this process's environment is
 * not a fact about the checkout. Relaying it would put a box's shell
 * configuration on the wire under a heading that claims to be about a directory,
 * which is both a lie and a wider disclosure than anybody asked for. Values
 * never leave the box either way; names would, and a name is enough to tell
 * somebody which credential to go looking for.
 */
export function processEnvSecrets() {
  const out = [];
  for (const name of [...DEPLOY_KEEP, 'CF_API_TOKEN', 'CF_ACCOUNT_ID']) {
    const value = process.env[name];
    if (typeof value === 'string' && value) out.push({ name, value });
  }
  return out;
}
