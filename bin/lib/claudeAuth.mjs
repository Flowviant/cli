/**
 * WHICH CREDENTIAL THIS MACHINE'S CLI WILL RESOLVE — presence and expiry only,
 * never a token value, and never a judgement about which one is correct.
 *
 * ── THE CONFUSION THIS EXISTS TO END ──
 *
 * A turn failed with the CLI's own words relayed verbatim:
 *
 *     Failed to authenticate: OAuth session expired and could not be refreshed
 *
 * and the operator did the obvious thing — opened a terminal on that same
 * machine, typed `claude`, and watched it work. Both observations were true at
 * once, and nothing in the product could explain how, because the one fact that
 * reconciles them is invisible from a browser: THE DAEMON'S CLI AND YOUR SHELL'S
 * CLI DO NOT ALWAYS RESOLVE THE SAME CREDENTIAL.
 *
 * Two ways they diverge, and this module reports both:
 *
 *  · THE ENVIRONMENT. `claude.mjs` spawns the CLI with `{...process.env}` on
 *    purpose — its header says so: "the CLI's own credentials live in this
 *    environment, and handing it a curated one signs it out". It also stopped
 *    deleting ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN deliberately, because on
 *    a machine the project leaves running an inherited org key is the POINT.
 *    The consequence is that an auth variable in the daemon's environment is
 *    handed to every turn — and `process.env` is a SNAPSHOT taken when the
 *    daemon started, so a variable exported weeks ago is still in there long
 *    after it left your shell. A stale one fails in a way a fresh `claude`
 *    never reproduces.
 *  · THE HOME. The CLI reads its store from $HOME. A daemon under systemd, a
 *    different user, or a container has a different one than the shell you
 *    tested in, so "I am logged in" was measured on the wrong file.
 *
 * ── WHAT THIS IS NOT ──
 *
 * NOT A POLICY. Flowviant does not pick a credential, does not prefer the
 * subscription over a key, and does not call either one wrong — `claude.mjs`
 * settled that: "Which credential is correct, and whether an account may be
 * shared, is between the operator and the vendor." This reports what is
 * PRESENT so a person can see the divergence; it never resolves it.
 *
 * NOT A PRECEDENCE CLAIM. Which source the CLI actually prefers is the CLI's
 * own business and it is free to change it. We report that both exist, which is
 * the fact that explains the symptom, and we do not assert which one won.
 *
 * NOT A TOKEN READER. Values never leave — not to the server, not to a log, not
 * into an error. Presence, the variable's NAME, and the refresh expiry, which
 * is a date.
 *
 * ── THE THREE-STATE RULE, WHICH THIS FILE LIVES OR DIES BY ──
 *
 * `source: 'unknown'` is NOT "signed out". Claude Code can keep credentials in
 * an OS keychain (macOS especially), where a file simply does not exist and
 * everything is fine. Reporting a confident "no login" for a machine that is
 * working perfectly is precisely the invented state this product forbids, and
 * it would be worse than saying nothing. Absent means absent; the surface
 * renders nothing for it.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The variables that can carry auth into the CLI from the environment.
 *
 * The first two are the pair `claude.mjs` documents itself as deliberately NOT
 * deleting, and both appear in childEnv.mjs's allowlist. The third is Claude
 * Code's own headless/CI token. Names only ever leave this module — a NAME is
 * what a person greps for, and it is not a secret.
 */
export const AUTH_ENV_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'];

/** Claude Code's OAuth store, relative to the HOME the CLI will be handed. */
const CRED_REL = ['.claude', '.credentials.json'];

/** A stamp that may be seconds or milliseconds, to ISO — or null if it is
 *  neither. Same tolerance the rest of the daemon applies to numbers it did not
 *  write: an unreadable stamp is ABSENT, never zero and never "now". */
function isoFromStamp(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  const ms = n > 1e11 ? n : n * 1000;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * What the CLI on this machine will resolve, as far as it can be seen without
 * spending anything: no process spawned, no request made, no quota touched.
 * Just this process's own environment and one file's metadata.
 *
 * `env` and `home` are parameters rather than reads of `process` so the tests
 * can drive every branch — and so the caller passes the SAME environment the
 * child will actually receive, which is the whole point of the report.
 */
export function claudeAuthContext({ env = process.env, home = null } = {}) {
  const HOME = home ?? env.HOME ?? env.USERPROFILE ?? null;

  // Presence, by NAME. An empty or whitespace-only value is not set: an
  // exported-but-blank variable is a common way to try to UNSET one, and
  // reporting it as present would send somebody hunting a variable that is
  // doing nothing.
  const envVars = AUTH_ENV_VARS.filter((n) => typeof env[n] === 'string' && env[n].trim() !== '');

  let hasFile = false;
  let refreshExpiresAt = null;
  let accessExpiresAt = null;
  let subscriptionType = null;
  if (HOME) {
    try {
      const raw = readFileSync(join(HOME, ...CRED_REL), 'utf8');
      const oauth = JSON.parse(raw)?.claudeAiOauth;
      if (oauth && typeof oauth === 'object') {
        hasFile = true;
        refreshExpiresAt = isoFromStamp(oauth.refreshTokenExpiresAt);
        accessExpiresAt = isoFromStamp(oauth.expiresAt);
        // A plan name is not a secret and it is the one field that tells an
        // operator WHICH kind of account the machine is spending — the thing
        // "the machine is shared and so is its CLI login" makes everyone's
        // business. Anything unexpected is dropped rather than relayed.
        if (typeof oauth.subscriptionType === 'string' && oauth.subscriptionType.length <= 32) {
          subscriptionType = oauth.subscriptionType;
        }
      }
    } catch {
      // Absent, unreadable, or not JSON. All three mean the same thing here:
      // we cannot see a file, which is NOT the same as there not being a
      // login. See the three-state rule in this file's header.
    }
  }

  /**
   * THE SOURCE, and the honest thing to say about it.
   *
   *   'env'     — at least one auth variable is set. Reported first because it
   *               is the state that is invisible from a shell and therefore the
   *               one that misleads; NOT because we know it wins.
   *   'file'    — no variable, and an OAuth store we could read.
   *   'unknown' — neither. A keychain machine lives here, and so does a machine
   *               with no login at all. We cannot tell them apart, so we say
   *               nothing about which it is.
   */
  const source = envVars.length ? 'env' : hasFile ? 'file' : 'unknown';

  return {
    /** The OS user the daemon runs as — the other half of "which store". */
    user: env.USER ?? env.LOGNAME ?? env.USERNAME ?? null,
    home: HOME,
    source,
    /** NAMES ONLY. Never a value, never a prefix, never a length. */
    envVars,
    /** Is there a login sitting behind the variable that may be shadowing it?
     *  This — not `source` on its own — is the confusing state, and it is the
     *  only one the surface is allowed to raise unprompted. */
    envOverridesLogin: envVars.length > 0 && hasFile,
    /** The 22-day clock. Null when we cannot see the file, which includes every
     *  keychain machine, so null must never render as "expired". */
    refreshExpiresAt,
    /** The ~12-hour clock. Reported for completeness and deliberately NOT what
     *  any warning is built from: it lapses constantly and refreshes itself, so
     *  a note built on it would cry wolf twice a day. */
    accessExpiresAt,
    subscriptionType,
  };
}
