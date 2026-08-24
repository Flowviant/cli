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
 * A child environment for a command Flowviant runs on the operator's behalf.
 *
 * `extra` is layered LAST and is the caller's own material — deploy
 * credentials, or nothing. It is never repo-supplied: the deleted preview
 * feature let `.flowviant/preview.json` contribute an `env` map that was
 * layered last and therefore won every collision, which is how a branch got to
 * set `PATH`.
 */
export function childEnv({ cwd, extra } = {}) {
  const env = {};
  for (const k of KEEP) {
    if (typeof process.env[k] === 'string') env[k] = process.env[k];
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

/** The names this deliberately drops, for the test to assert against. NOT the
 *  mechanism — the mechanism is the allowlist above, and this list is only ever
 *  a sample of what it excludes. Adding a name here changes nothing. */
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
