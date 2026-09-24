/**
 * THE CREDENTIAL MUST NOT BE IN A SPAWNED COMMAND'S ENVIRONMENT.
 *
 * This file exists because the previous guarantee was a comment over a no-op:
 * `delete env.FLEET_TOKEN` removed a name that was never in the environment
 * (the variable is `FLOWVIANT_FLEET`), so the machine credential rode into
 * every deploy command and into `target.build`, a string the repo controls,
 * for as long as that line was there. Nothing failed. Nothing could fail —
 * there was no test, and a denylist has nothing to assert against.
 *
 * An allowlist can be tested, which is most of the argument for it.
 *
 * Run: node --test bin/lib/childEnv.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { childEnv, DROPPED_SAMPLE, DEPLOY_KEEP_NAMES, processEnvSecrets } from './childEnv.mjs';

test('the machine credential is absent — the exact bug this replaces', () => {
  process.env.FLOWVIANT_FLEET = 'fleet-secret-value';
  const env = childEnv({ cwd: '/w' });
  assert.equal(env.FLOWVIANT_FLEET, undefined);
  // And not under any other spelling: assert on the VALUE, because the failure
  // mode was a name mismatch and a name-only check is what missed it.
  assert.ok(
    !Object.values(env).includes('fleet-secret-value'),
    'the credential VALUE appears in the child environment under some key'
  );
  delete process.env.FLOWVIANT_FLEET;
});

test('a secret nobody thought of is absent too, because the list is a KEEP list', () => {
  // The whole point of an allowlist: this passes without anyone adding the name
  // anywhere. A denylist would need this exact string to have been foreseen.
  process.env.SOME_FUTURE_VENDOR_TOKEN = 'x';
  const env = childEnv({});
  assert.equal(env.SOME_FUTURE_VENDOR_TOKEN, undefined);
  delete process.env.SOME_FUTURE_VENDOR_TOKEN;
});

test('every name in the documented sample is dropped', () => {
  for (const k of DROPPED_SAMPLE) process.env[k] = 'sensitive';
  const env = childEnv({});
  for (const k of DROPPED_SAMPLE) assert.equal(env[k], undefined, `${k} survived`);
  for (const k of DROPPED_SAMPLE) delete process.env[k];
});

test('PATH and the toolchain shims survive — without them the command is ENOENT', () => {
  process.env.NVM_DIR = '/home/x/.nvm';
  process.env.VOLTA_HOME = '/home/x/.volta';
  const env = childEnv({});
  assert.ok(env.PATH, 'PATH must survive or nothing runs at all');
  assert.equal(env.NVM_DIR, '/home/x/.nvm');
  assert.equal(env.VOLTA_HOME, '/home/x/.volta');
  delete process.env.NVM_DIR;
  delete process.env.VOLTA_HOME;
});

test('TERM and BROWSER are SET by us, not inherited', () => {
  process.env.TERM = 'xterm-256color';
  const env = childEnv({});
  // A process that believes it owns a TTY draws progress bars into a pipe
  // forever — unreadable in a tail, and it pins a CPU on some tools.
  assert.equal(env.TERM, 'dumb');
  assert.equal(env.BROWSER, 'none');
  delete process.env.TERM;
});

test('NODE_ENV and PORT are never asserted', () => {
  process.env.NODE_ENV = 'production';
  process.env.PORT = '9999';
  const env = childEnv({ cwd: '/w' });
  // Asserting NODE_ENV would be Flowviant choosing what the framework decides.
  assert.equal(env.NODE_ENV, undefined);
  // And a HINTED port has no cwd attribution behind it, which is the one real
  // security control this feature family has.
  assert.equal(env.PORT, undefined);
  delete process.env.NODE_ENV;
  delete process.env.PORT;
});

test('cwd becomes PWD, and extra is layered last', () => {
  const env = childEnv({ cwd: '/w/session/abc', extra: { CLOUDFLARE_API_TOKEN: 'given' } });
  assert.equal(env.PWD, '/w/session/abc');
  // `extra` is the CALLER's own material. It is never repo-supplied: the
  // deleted preview feature let a branch file contribute an env map layered
  // last, which is how a branch got to set PATH.
  assert.equal(env.CLOUDFLARE_API_TOKEN, 'given');
});

/**
 * THE DEPLOY OPT-IN IS A SECOND ALLOWLIST, NOT A DOOR OUT OF THE FIRST
 * (2026-09-21).
 *
 * Deploy used to get its credentials from the secrets vault —
 * `extra: deployCreds()`, values Flowviant had decrypted onto this box. The
 * vault is deleted (the owner: "no i dont want it"), so the source is the
 * OPERATOR's own environment, and this file's whole premise is that a spawned
 * command is built from `{}`. Hence the widening.
 *
 * What it must never become is `{...process.env}` for deploys. A deploy target's
 * `build` is a REPO-CONTROLLED string, so the kept set IS the blast radius, and
 * the rot argument for an allowlist does not weaken because the caller is a
 * deploy.
 */
test('deploy: true keeps the named infra credentials — and only those', () => {
  for (const k of DEPLOY_KEEP_NAMES) process.env[k] = `value-of-${k}`;
  process.env.SOME_OTHER_VENDOR_TOKEN = 'must-not-survive';
  process.env.FLOWVIANT_FLEET = 'fleet-secret-value';
  try {
    const env = childEnv({ cwd: '/w', deploy: true });
    for (const k of DEPLOY_KEEP_NAMES) {
      assert.equal(env[k], `value-of-${k}`, `${k} must reach the deploy command`);
    }
    // A name nobody put on the list is still absent — the point of a KEEP list.
    assert.equal(env.SOME_OTHER_VENDOR_TOKEN, undefined);
    // AND THE MACHINE CREDENTIAL IS STILL ABSENT AT THE OPT-IN. It is the one
    // secret whose leak costs the project itself, and `target.build` is a
    // string the repo controls.
    assert.equal(env.FLOWVIANT_FLEET, undefined);
    assert.ok(!Object.keys(env).some((k) => k.startsWith('FLOWVIANT_')));
    assert.ok(!Object.values(env).includes('fleet-secret-value'));
  } finally {
    for (const k of DEPLOY_KEEP_NAMES) delete process.env[k];
    delete process.env.SOME_OTHER_VENDOR_TOKEN;
    delete process.env.FLOWVIANT_FLEET;
  }
});

test('and WITHOUT the opt-in those same names are dropped', () => {
  for (const k of DEPLOY_KEEP_NAMES) process.env[k] = 'sensitive';
  try {
    const env = childEnv({ cwd: '/w' });
    for (const k of DEPLOY_KEEP_NAMES) {
      assert.equal(env[k], undefined, `${k} must not leak into an ordinary child`);
    }
  } finally {
    for (const k of DEPLOY_KEEP_NAMES) delete process.env[k];
  }
});

test('the deploy path actually calls it — a helper nobody uses fixes nothing', async () => {
  const { readFileSync } = await import('node:fs');
  const raw = readFileSync(new URL('./deploy.mjs', import.meta.url), 'utf8');
  // CODE ONLY. The obituary in deploy.mjs QUOTES the shape it replaced — that
  // is the most useful line in the file and it is also an exact match for what
  // this bans. Asserting over raw source fails on its own documentation, which
  // is a false alarm that trains people to weaken the test.
  const src = raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .join('\n');
  // `runDeployIn` is where the commands run since the deploy moved into a
  // throwaway base worktree (audit 2026-09-24); `runDeploy` only cuts it.
  const i = src.indexOf('async function runDeployIn(');
  assert.ok(i > -1);
  const end = src.indexOf('\nasync function', i + 10);
  // BOTH ANCHORS BEFORE THE SLICE. An `indexOf` that returns −1 slices to the
  // end of the file (or, the other way round, to nothing) and the assertions
  // below then pass over the wrong text — the inert-pin class this repo has
  // caught repeatedly.
  assert.ok(end > i, 'the end anchor must exist too');
  const fn = src.slice(i, end);
  assert.ok(fn.includes('childEnv('), 'runDeploy must build its env through childEnv');
  // …through the OPT-IN, since the vault that used to supply `extra` is gone.
  assert.ok(fn.includes('deploy: true'), 'and it must ask for the infra-credential group');
  // The old shape must not come back.
  assert.ok(!/\{\s*\.\.\.process\.env\s*,\s*\.\.\.deployCreds\(\)/.test(src));
  // Nor the vault readers it was built on. `deployCreds` and `appSecretsFor`
  // are DELETED from env.mjs, and deploy.mjs's obituary NAMES both — which is
  // the most useful prose in the file and also an exact match for what this
  // bans. So the ban is on `src`, which is already comment-stripped above, and
  // the canary is that the obituary is still there in the raw text.
  assert.match(raw, /appSecretsFor\('prod'\)/, 'the obituary still explains what left');
  assert.ok(!/\bdeployCreds\(/.test(src), 'nothing reads deploy credentials out of a vault');
  assert.ok(!/\bappSecretsFor\(/.test(src), 'nothing pushes vault secrets any more');
});

/**
 * THE REDACTION LIST IS DERIVED FROM THE ADMISSION LIST (2026-09-21, the
 * review) — which is what stops the two drifting.
 *
 * Until the vault was deleted, `scrub()` was fed the decrypted bundle, and its
 * deploy-scope half WAS `CLOUDFLARE_API_TOKEN` and friends — so `wrangler`
 * output was redacted on its way to the server. The replacement scrubber reads
 * the CHECKOUT'S `.env*` files, and an operator's deploy credential lives in
 * the shell they started the daemon in, which is the entire reason
 * `DEPLOY_KEEP` exists. So the one lane that hands a secret to a command and
 * then streams that command's stdout to the server had stopped redacting it,
 * under a `deploy.mjs` docblock still asserting the opposite.
 *
 * It is DERIVED rather than listed a second time, because a hand-kept copy
 * rots the moment somebody adds a name here and forgets the other file. That
 * is the same argument this module makes for an allowlist over a denylist,
 * applied one level up.
 */
test('processEnvSecrets covers every DEPLOY_KEEP name that is actually set', () => {
  for (const k of DEPLOY_KEEP_NAMES) process.env[k] = `value-of-${k}`;
  process.env.SOME_OTHER_VENDOR_TOKEN = 'not-ours-to-hide';
  process.env.FLOWVIANT_FLEET = 'fleet-secret-value';
  try {
    const found = processEnvSecrets();
    const byName = new Map(found.map((v) => [v.name, v.value]));
    for (const k of DEPLOY_KEEP_NAMES) {
      assert.equal(byName.get(k), `value-of-${k}`, `${k} must be redactable`);
    }
    // A name nobody put on either list is not this daemon's secret to hide.
    assert.ok(!byName.has('SOME_OTHER_VENDOR_TOKEN'));
    // The machine credential IS redactable (2026-09-24, the audit — this line
    // used to assert the opposite, "it is never passed to a child"). It is
    // never passed to a DEPLOY child, but a CLI turn inherited it and could
    // echo it into a trace; redacting a value we never pass costs nothing.
    assert.equal(byName.get('FLOWVIANT_FLEET'), 'fleet-secret-value');
    // …and redacting it still does not ADMIT it anywhere.
    assert.equal(childEnv({ cwd: '/w', deploy: true }).FLOWVIANT_FLEET, undefined);
  } finally {
    for (const k of DEPLOY_KEEP_NAMES) delete process.env[k];
    delete process.env.SOME_OTHER_VENDOR_TOKEN;
    delete process.env.FLOWVIANT_FLEET;
  }
});

/**
 * TWO NAMES ARE REDACTED THAT ARE NEVER PASSED, and the asymmetry is the point.
 *
 * `CF_API_TOKEN` and `CF_ACCOUNT_ID` are wrangler's older spellings — it still
 * reads them — so a box may hold the token under that name while the deploy
 * command is handed nothing. Redacting a value we do not pass costs nothing and
 * covers the operator still on the old spelling; PASSING one would widen the
 * blast radius of a repo-controlled `build` string, which is what this module
 * exists to bound. Redaction and admission are different questions, and this is
 * the one place they are allowed to differ.
 */
test('the old wrangler spellings are redactable but never admitted', () => {
  process.env.CF_API_TOKEN = 'cf-old-spelling-token';
  process.env.CF_ACCOUNT_ID = 'cf-old-spelling-account';
  try {
    const byName = new Map(processEnvSecrets().map((v) => [v.name, v.value]));
    assert.equal(byName.get('CF_API_TOKEN'), 'cf-old-spelling-token');
    assert.equal(byName.get('CF_ACCOUNT_ID'), 'cf-old-spelling-account');
    // …and the deploy child still does not get them, at any opt-in.
    const env = childEnv({ cwd: '/w', deploy: true });
    assert.equal(env.CF_API_TOKEN, undefined);
    assert.equal(env.CF_ACCOUNT_ID, undefined);
  } finally {
    delete process.env.CF_API_TOKEN;
    delete process.env.CF_ACCOUNT_ID;
  }
});

test("the daemon's own credentials are redactable and never admitted", () => {
  const names = ['FLOWVIANT_MACHINE_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN', 'OPENAI_API_KEY'];
  for (const k of names) process.env[k] = `value-of-${k}`;
  try {
    const byName = new Map(processEnvSecrets().map((v) => [v.name, v.value]));
    const env = childEnv({ cwd: '/w', deploy: true });
    for (const k of names) {
      assert.equal(byName.get(k), `value-of-${k}`, `${k} must be redactable`);
      assert.equal(env[k], undefined, `${k} must never reach a deploy child`);
    }
  } finally {
    for (const k of names) delete process.env[k];
  }
});

/** AN ABSENT NAME IS ABSENT, never an empty string: a `''` in the scrub list
 *  would make `String.split('')` explode every posted line into characters. */
test('only names that are actually set appear, and never as empty strings', () => {
  for (const k of DEPLOY_KEEP_NAMES) delete process.env[k];
  delete process.env.CF_API_TOKEN;
  delete process.env.CF_ACCOUNT_ID;
  process.env.VERCEL_TOKEN = '';
  try {
    const found = processEnvSecrets();
    assert.ok(!found.some((v) => v.name === 'VERCEL_TOKEN'), 'an empty value is not a secret');
    assert.ok(found.every((v) => typeof v.value === 'string' && v.value.length > 0));
  } finally {
    delete process.env.VERCEL_TOKEN;
  }
});

test('the renamed credential variable is stripped from children like the old one (2026-09-21)', async () => {
  const { childEnv } = await import('./childEnv.mjs');
  process.env.FLOWVIANT_MACHINE_TOKEN = 'machine-secret-value';
  try {
    const env = childEnv();
    assert.equal(env.FLOWVIANT_MACHINE_TOKEN, undefined);
  } finally {
    delete process.env.FLOWVIANT_MACHINE_TOKEN;
  }
});

test('config reads FLOWVIANT_MACHINE_TOKEN first and keeps FLOWVIANT_FLEET as the fallback', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('./config.mjs', import.meta.url), 'utf8');
  const a = src.indexOf('export let FLEET_TOKEN =');
  const b = src.indexOf("CREDENTIAL.entry?.fleetToken", a);
  assert.ok(a >= 0 && b > a, 'both anchors present');
  const slice = src.slice(a, b);
  assert.ok(slice.indexOf('FLOWVIANT_MACHINE_TOKEN') < slice.indexOf('FLOWVIANT_FLEET'), 'new name wins, old name still read');
});
