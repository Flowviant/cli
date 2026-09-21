/**
 * Team env sync — the daemon is the CRYPTO ANCHOR. This machine holds a
 * persistent X25519 keypair (~/.flowviant/env-keypair.json, 0600); the
 * project's private key reaches it only sealed to that pubkey. Everything the
 * server stores is ciphertext it cannot open.
 *
 * Duties per roster tick (handleRosterEnv):
 *  - register this machine's pubkey (once) → that IS the enrolment (server
 *    2026-09-20): the box already holds this project's machine credential,
 *    which a person handed it by typing a device code into the app, so there is
 *    nothing left for anybody to approve. Nobody clicks; nothing is printed
 *    except one quiet line.
 *  - bootstrap the project keypair when none exists (first machine): generate
 *    it + a standing RECOVERY keypair wrapped under a one-time passphrase —
 *    rotations re-seal to the same recovery pub, so that passphrase survives
 *    forever. Bootstrap itself is SILENT since 2026-09-20: the passphrase is
 *    parked in this box's keypair file and printed the first time this box
 *    materializes a secret, which is the first moment it is about anything
 *    (`stashRecoveryCode`).
 *  - sync: on a bundle version change, unwrap the priv, open every sealed
 *    value, cache (encrypted under a key derived from our own priv), and
 *    rematerialize env files into the agent worktrees.
 *  - execute wrap jobs (another box registered → seal the priv to it).
 *  - execute rotations (a machine was revoked → new keypair, re-seal all
 *    values, re-wrap every enrolled machine, re-seal recovery).
 *
 * Materialization writes per-targetFile KEY=value files into a worktree and
 * registers each path in the worktree's git info/exclude — untracked AND
 * unstageable, so an agent can never commit them. The WIKI worktree never
 * gets env (the cartographer doesn't need secrets).
 *
 * scrub() redacts every known plaintext value from daemon-posted uplinks
 * (turn streams, wiki progress, vault sync). Agent-MCP-direct payloads
 * (evidence, progress, complete) never pass through the daemon — those are
 * covered by the prompt contract, not here.
 */

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  appendFileSync,
  chmodSync,
  lstatSync,
  rmSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir, hostname } from 'node:os';
import { join, dirname, resolve } from 'node:path';
// The SUMO build: the standard `libsodium-wrappers` omits Argon2 (crypto_pwhash),
// which bootstrapProject() needs to derive the recovery-code key — without it
// crypto_pwhash_SALTBYTES is undefined and bootstrap throws every poll.
import sodium from 'libsodium-wrappers-sumo';
import { FLEET_URL, FLEET_TOKEN, USER_AGENT } from './config.mjs';
import { c, info, note, ok, warn } from './ui.mjs';

const B64 = () => sodium.base64_variants.ORIGINAL;
const KEYPAIR_PATH = join(homedir(), '.flowviant', 'env-keypair.json');
const CACHE_DIR = join(homedir(), '.flowviant', 'env-cache');
const SCRUB_MIN_LENGTH = 6; // mirrors shared ENV_SCRUB_MIN_LENGTH
const envUrl = (tail) => FLEET_URL.replace(/\/agents\/?$/, `/env/${tail}`);

// ── Module state (one project per daemon, same as the vault) ───────────────
let keypair = null; // { publicKey: Uint8Array, privateKey: Uint8Array }
let registeredOnce = false;
let projectPriv = null; // Uint8Array — unwrapped project private key
let bundleVersion = -1; // last materialized bundle version (-1 = never)
let values = []; // [{ name, targetFile, value }]
let cachedProjectId = null;

export async function sodiumReady() {
  await sodium.ready;
}

/*
 * `pubkeyEmoji` IS DELETED (2026-09-20), and so is its byte-identical twin in
 * the web app.
 *
 * It existed for exactly one gesture: the terminal printed eight glyphs, the
 * browser's approve card printed the same eight, and a human compared them
 * before pressing Approve. Registering IS enrolling now — the device code that
 * gave this box the project's machine credential was the decision — so there is
 * no approve card, no comparison, and nobody to make it. A fingerprint kept
 * byte-identical across two repos for nobody to look at is worse than none:
 * it reads like a live MITM defence and defends nothing.
 */

/** This machine's persistent keypair (created on first use, 0600). */
export async function ensureKeypair() {
  await sodium.ready;
  if (keypair) return keypair;
  let raw = null;
  try {
    raw = readFileSync(KEYPAIR_PATH, 'utf8');
  } catch (e) {
    /**
     * ONLY "THERE IS NO FILE" IS A FIRST RUN, and the bare catch that used to
     * stand here said every failure was one.
     *
     * This keypair is the box's DURABLE IDENTITY — it is what the project's
     * private key is sealed to, and since 2026-09-14 it is also what tells two
     * computers apart when the server decides which of them is this project's
     * machine. Regenerating it on a truncated file or an unreadable one
     * OVERWRITES that identity: the wraps stop opening, and the box arrives at
     * the roster as a stranger and stands itself down as a standby of itself.
     *
     * A file we cannot read is not a file we may replace. Rethrown, the caller
     * that can survive it does: `envQueryParams` is wrapped, so the poll simply
     * carries no `envpub`, and a poll with no envpub is EXEMPT from arbitration
     * — the documented fail-open arm, reached honestly instead of by minting a
     * new box every restart.
     */
    if (e?.code !== 'ENOENT') throw e;
  }
  if (raw !== null) {
    const stored = JSON.parse(raw);
    keypair = {
      publicKey: sodium.from_base64(stored.pub, B64()),
      privateKey: sodium.from_base64(stored.priv, B64()),
    };
    return keypair;
  }
  keypair = sodium.crypto_box_keypair();
  mkdirSync(dirname(KEYPAIR_PATH), { recursive: true });
  writeFileSync(
    KEYPAIR_PATH,
    JSON.stringify({
      pub: sodium.to_base64(keypair.publicKey, B64()),
      priv: sodium.to_base64(keypair.privateKey, B64()),
    }),
    { mode: 0o600 }
  );
  return keypair;
}

export function myPubB64() {
  return keypair ? sodium.to_base64(keypair.publicKey, B64()) : null;
}

/**
 * THIS BOX'S PUBLIC KEY, READ AND NEVER WRITTEN (2026-09-19, the review).
 *
 * `flowviant machines` is a VIEW-ONLY command — that narrowness is the whole
 * reason a third terminal command was allowed to exist at all — and it was
 * calling `ensureKeypair`, which on a box with no keypair CREATES ONE: a
 * filesystem write, 0600, minting this machine's durable identity, from a
 * command whose entire job is to print a list. Listing must not enrol.
 *
 * It reads the stored file and nothing else. No sodium, no parse of the private
 * half, no creation. NULL for every failure — absent, unreadable, malformed —
 * and null simply means no row gets the "← this box" mark, which is honest: a
 * box that has never run a daemon has never polled, so it is not in the listing
 * to be marked. Claiming a row is you on a guess would be worse than the mark
 * being absent.
 */
export function readStoredPubB64() {
  try {
    const stored = JSON.parse(readFileSync(KEYPAIR_PATH, 'utf8'));
    return typeof stored?.pub === 'string' && stored.pub ? stored.pub : null;
  } catch {
    return null;
  }
}

/**
 * ── THE RECOVERY CODE WAITS UNTIL THERE IS SOMETHING TO RECOVER (2026-09-20) ──
 *
 * `bootstrapProject` used to end with the loudest artefact this product owns:
 * a blank line, RECOVERY CODE in bold, a passphrase in yellow, and "the only
 * way back into the secrets". That fired on the FIRST DAEMON OF EVERY PROJECT
 * — a keypair is bootstrapped whether or not a single secret exists — so the
 * overwhelming majority of the people who saw it were being handed a code for
 * an empty vault, in custody vocabulary they had not asked for, having run
 * `npx flowviant` to connect a machine. That is the same complaint the approve
 * gate died of, printed instead of clicked, and leaving it in would have
 * contradicted the change it shipped beside.
 *
 * So bootstrap is SILENT (one quiet line that the keypair exists) and the code
 * is kept HERE, in this box's own keypair file, until the first time this box
 * materializes a secret — the moment the person actually has something to
 * protect, and the first moment the sentence is true.
 *
 * THE FILE IS THE RIGHT PLACE AND COSTS NOTHING. It already holds the private
 * key the passphrase would recover — anybody who can read one can read the
 * other — so storing it there adds no exposure that was not already the whole
 * security model of this machine. It is 0600 and stays 0600.
 *
 * EXTENDING THE SHAPE IS SAFE. `ensureKeypair` reads `pub` and `priv` and
 * ignores every other key, and it only WRITES the file when there is none, so
 * an older daemon reading a file with a `recovery` field behaves identically
 * and cannot clobber it.
 *
 * THE ONE ACCEPTED COST, stated: a box that bootstraps and never materializes
 * anything never prints the code. That is the point — there is nothing to
 * recover — and the code is not lost, it is on this disk beside the key.
 */
function readKeypairFile() {
  try {
    return JSON.parse(readFileSync(KEYPAIR_PATH, 'utf8'));
  } catch {
    return null;
  }
}

/** 0600 on every write, not just at creation: `writeFileSync`'s `mode` applies
 *  only when the file is created, which is the same trap `materializeInto`
 *  documents. Returns whether it landed — the caller has to know, because the
 *  thing being written is unrecoverable if it does not. */
function writeKeypairFile(stored) {
  try {
    writeFileSync(KEYPAIR_PATH, JSON.stringify(stored), { mode: 0o600 });
    try {
      chmodSync(KEYPAIR_PATH, 0o600);
    } catch {
      /* a filesystem without modes is not a reason to refuse */
    }
    return true;
  } catch {
    return false;
  }
}

/** Park the bootstrap passphrase beside the key it recovers. False means it did
 *  NOT land, and the caller's answer to that is to print it immediately —
 *  losing a recovery code silently is the one outcome worse than printing it
 *  early. */
export function stashRecoveryCode(code, projectId) {
  const stored = readKeypairFile();
  if (!stored?.priv) return false;
  stored.recovery = { code, projectId: projectId ?? null, shown: false };
  return writeKeypairFile(stored);
}

/** Once per process at most, and once per box for real. */
let recoveryUnprinted = true;

function printRecoveryBlock(code) {
  console.log('');
  ok(`${c.cyan('env')} — this machine now holds this project's secrets.`);
  console.log(`  ${c.bold('RECOVERY CODE')} ${c.dim('(shown ONCE — save it in a password manager):')}`);
  console.log(`  ${c.bold(c.yellow(code))}`);
  note('  If every enrolled machine is ever lost, this code is the only way back into the secrets.');
  console.log('');
}

/**
 * Print the parked code the first time this box writes a secret to disk, then
 * mark it shown so it never prints again.
 *
 * The mark is written to the FILE, not just to the module flag, because "once"
 * has to survive a restart. If that write fails the flag still stops this
 * process from repeating itself and a later process prints again — noisy in
 * the safe direction, which is the only direction available when the thing at
 * stake is the only way back into somebody's secrets.
 *
 * The parked `projectId` is checked because the keypair file is per BOX while
 * the code is per PROJECT: a daemon serves one project, so a mismatch means
 * this code belongs to a different one and printing it here would attribute it
 * to the wrong vault. An older stash carries no id and prints regardless.
 */
function printRecoveryCodeOnce() {
  if (!recoveryUnprinted) return;
  const stored = readKeypairFile();
  const rec = stored?.recovery;
  if (!rec?.code || rec.shown) {
    recoveryUnprinted = false;
    return;
  }
  if (rec.projectId && cachedProjectId && rec.projectId !== cachedProjectId) {
    recoveryUnprinted = false; // one project per daemon — this will not change
    return;
  }
  recoveryUnprinted = false;
  printRecoveryBlock(rec.code);
  stored.recovery = { ...rec, shown: true };
  writeKeypairFile(stored);
}

/** Query params the roster poll carries: identity, materialized version, and
 *  the target files we REFUSED to write.
 *
 *  `envv` alone was a half-truth and the surface built on it said the wrong
 *  thing out loud: it is set the moment the bundle DECRYPTS, independent of
 *  whether a single byte reached a worktree, so a project whose `.env` is
 *  tracked in git got the green "on the current env" chip while every session
 *  ran on whatever stale placeholder git had checked out. The daemon knew —
 *  it warned, to a console nobody reads. `envskip` is that warning routed
 *  somewhere a human is actually looking.
 *
 *  A daemon→server REPORT, so it needs no version floor: an older daemon
 *  simply sends no `envskip` key, which reads as "nothing to report" — and
 *  that is honest, because an older daemon genuinely is not measuring it.
 *  Bounded hard: a query string is not a log. */
export async function envQueryParams() {
  await ensureKeypair();
  const params = { envpub: myPubB64() };
  if (bundleVersion >= 0) params.envv = String(bundleVersion);
  // THE EMPTY STRING IS A REPORT, and it is the only thing that can ever CLEAR
  // the surface's warning. Gating this on truthiness (which is what it did
  // first) meant a person who followed the on-screen remedy exactly — gitignore
  // the file, restart — sent no `envskip` at all, the server left the column
  // alone by design, and the amber line stayed up forever telling them to fix
  // something already fixed. Absence must keep meaning IGNORANCE, so the gate
  // is "has a pass actually run", never "is there something to say".
  // (fleet.mjs's query loop had to stop filtering on truthiness too — one
  // check here is useless while a second one downstream drops the same value.)
  if (everMaterialized) {
    const files = [...new Set([...skippedByWorktree.values()].flat())].sort();
    // Each path is percent-encoded BEFORE the join, because `isSafeEnvTargetFile`
    // permits a comma in a filename and the server splits on one — unencoded,
    // `a,b.env` would arrive as two files that do not exist. Truncation is by
    // WHOLE ELEMENTS against a byte budget; a mid-path cut names a file nobody
    // has, which is worse than naming fewer.
    const parts = [];
    let budget = 400;
    for (const f of files) {
      if (parts.length >= 10) break;
      const enc = encodeURIComponent(f);
      if (enc.length + 1 > budget) break;
      parts.push(enc);
      budget -= enc.length + 1;
    }
    params.envskip = parts.join(',');
  }
  return params;
}

// ── HTTP helpers ───────────────────────────────────────────────────────────
async function post(tail, body) {
  const res = await fetch(envUrl(tail), {
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
    throw new Error(`env ${tail} failed (${res.status}${json?.error ? `: ${json.error}` : ''})`);
  }
  return json?.data;
}

export async function fetchBundle() {
  const res = await fetch(`${envUrl('bundle')}?pubkey=${encodeURIComponent(myPubB64())}`, {
    headers: { Authorization: `Bearer ${FLEET_TOKEN}`, 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(30_000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json?.data) throw new Error(`env bundle fetch failed (${res.status})`);
  return json.data;
}

// ── Crypto ─────────────────────────────────────────────────────────────────
const seal = (bytes, pubB64) => sodium.to_base64(sodium.crypto_box_seal(bytes, sodium.from_base64(pubB64, B64())), B64());
const openSealed = (b64, pub, priv) => sodium.crypto_box_seal_open(sodium.from_base64(b64, B64()), pub, priv);

/** Cache the decrypted bundle at rest, encrypted under a key derived from our
 *  own priv — the worktrees hold the same plaintext anyway; this just keeps
 *  the cache from being a SECOND, tidier copy. */
function cacheKey() {
  return sodium.crypto_generichash(sodium.crypto_secretbox_KEYBYTES, keypair.privateKey);
}
function writeCache(projectId, payload) {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
    const box = sodium.crypto_secretbox_easy(sodium.from_string(JSON.stringify(payload)), nonce, cacheKey());
    writeFileSync(
      join(CACHE_DIR, `${projectId}.json`),
      JSON.stringify({ nonce: sodium.to_base64(nonce, B64()), box: sodium.to_base64(box, B64()) }),
      { mode: 0o600 }
    );
  } catch {
    /* cache is best-effort */
  }
}
function readCache(projectId) {
  try {
    const { nonce, box } = JSON.parse(readFileSync(join(CACHE_DIR, `${projectId}.json`), 'utf8'));
    const plain = sodium.crypto_secretbox_open_easy(
      sodium.from_base64(box, B64()),
      sodium.from_base64(nonce, B64()),
      cacheKey()
    );
    return JSON.parse(sodium.to_string(plain));
  } catch {
    return null;
  }
}

/** Offline start: materialize from the encrypted cache before the first poll.
 *  Also seeds knownTargetFiles so stale-file cleanup survives a restart. */
export async function loadCachedEnv(projectId) {
  await ensureKeypair();
  const cached = readCache(projectId);
  if (!cached) return false;
  values = cached.values ?? [];
  bundleVersion = cached.bundleVersion ?? -1;
  // Filtered even though we wrote the cache: this set feeds removeStaleEnvFile,
  // and a cache file predates whatever rules the running daemon enforces.
  knownTargetFiles = new Set((cached.knownFiles ?? values.map((v) => v.targetFile)).filter(isSafeTarget));
  cachedProjectId = projectId;
  return values.length > 0;
}

// ── Materialization ────────────────────────────────────────────────────────

/**
 * Add the materialized paths to the exclude file git ACTUALLY READS.
 *
 * This used to resolve the worktree's own gitdir (`.git/worktrees/<name>`) and
 * write `info/exclude` there, on the belief that it "applies to that worktree
 * only and never touches the user's repo". Git does not read that file: it
 * resolves `info/exclude` against $GIT_COMMON_DIR — the main `.git` — so in
 * every linked worktree the daemon creates, the exclusion did nothing at all.
 * The plaintext secret files stayed visible to `git add -A` — the first thing
 * an agent runs before committing and pushing the branch it is working on.
 *
 * `--git-common-dir` is asked of git rather than derived, because that is the
 * one answer that cannot drift from what git itself will consult. The file is
 * local to the clone and never committed.
 *
 * This is a CONVENIENCE, not the guarantee. The guarantee is the check-ignore
 * verification in materializeInto, which refuses to write a secret that git can
 * still see.
 */
export function excludeInWorktree(wt, relPaths) {
  try {
    let gitdir;
    try {
      gitdir = resolve(
        wt,
        execFileSync('git', ['rev-parse', '--git-common-dir'], {
          cwd: wt,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim()
      );
    } catch {
      return; // not a repo — materializeInto's check-ignore gate will refuse anyway
    }
    const excludePath = join(gitdir, 'info', 'exclude');
    mkdirSync(dirname(excludePath), { recursive: true });
    let existing = '';
    try {
      existing = readFileSync(excludePath, 'utf8');
    } catch {
      /* fresh */
    }
    const missing = relPaths.filter((p) => !existing.split('\n').includes(`/${p}`));
    if (missing.length) {
      appendFileSync(excludePath, `${existing.endsWith('\n') || !existing ? '' : '\n'}${missing.map((p) => `/${p}`).join('\n')}\n`);
    }
  } catch {
    /* best-effort — the agent prompt still forbids committing secrets */
  }
}

/** MUST match the server's isSafeEnvTargetFile (env.schema.ts) — the server
 *  validates at intake, but this file also refills paths from the on-disk
 *  cache and hands them to rmSync, so the daemon holds its own line rather
 *  than trusting either source. `.git` is refused at ANY depth and
 *  case-insensitively (git treats `.GIT` the same on case-insensitive
 *  filesystems): a target of `.git/hooks/pre-commit` would turn a
 *  materialized value into code git runs on the operator's next commit —
 *  check-ignore alone must not be the only thing standing there. The control
 *  range subsumes the old bare `\0` check and keeps a newline out of a PATH,
 *  where nothing downstream expects one. */
const isSafeTarget = (p) =>
  typeof p === 'string' &&
  p.length > 0 &&
  p.length <= 200 &&
  !p.includes('\\') &&
  // eslint-disable-next-line no-control-regex
  !/[\x00-\x1f\x7f]/.test(p) &&
  !p.startsWith('/') &&
  p.split('/').every((s) => s.length > 0 && s !== '.' && s !== '..' && s.toLowerCase() !== '.git');

/** Is this path TRACKED in the repo? info/exclude only hides UNTRACKED files —
 *  materializing secrets into a tracked file would make them stageable and
 *  committable. We refuse those paths entirely. */
function isTrackedInGit(wt, relPath) {
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', '--', relPath], {
      cwd: wt,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Will git hide this path? Asked of git, never inferred.
 *
 * This is the gate that makes writing a secret safe, and it is asked AFTER the
 * exclude file is updated so it reflects the state the agent will actually run
 * under. It fails CLOSED: any error — not a repo, git missing, a weird
 * pathspec — reads as "not ignored", so the secret is not written. A wrong
 * "yes" here puts plaintext on a remote branch; a wrong "no" costs a warning.
 */
function isIgnoredInGit(wt, relPath) {
  try {
    execFileSync('git', ['check-ignore', '-q', '--', relPath], {
      cwd: wt,
      stdio: 'ignore',
    });
    return true; // exit 0 = ignored
  } catch {
    return false;
  }
}

// Per-worktree: the target files we last materialized THIS SESSION.
const lastFilesByWorktree = new Map();

/** Target files refused for a GIT reason, PER WORKTREE — reported to the
 *  server on the next poll. Per-worktree because the refusal is: both
 *  predicates (`isTrackedInGit`, `isIgnoredInGit`) run with `cwd: wt`, so
 *  ".env is refused" is a fact about ONE tree. A process-global set mixed two
 *  trees' answers together and, worse, could only ever grow.
 *
 *  Names only — a path is not a secret, and the whole point is that a human
 *  can act on it ("gitignore apps/api/.dev.vars"). Only the two GIT causes go
 *  in here: they have a remedy the reader can carry out, and the surface names
 *  that remedy. A transient write failure is a warn, not a standing claim. */
const skippedByWorktree = new Map();

/** Worktrees whose most recent pass wrote everything it was asked to.
 *  `hasMaterialized` is built on THIS rather than on "a pass ran", so a pass
 *  that refused something RETRIES on the next turn — which is what lets
 *  `echo .env >> .gitignore` actually take effect without waiting for an
 *  unrelated bundle change. A pass with nothing to write counts as clean. */
const cleanWorktrees = new Set();

/** True once any materialization pass has completed. Distinguishes "we refused
 *  nothing" from "we have not looked", which is the whole contract of the
 *  `envskip` report — see envQueryParams. */
let everMaterialized = false;

/** Has this process completed a CLEAN materialization pass for this worktree?
 *  The creation-only rule (work.mjs) needs a second condition or a directory
 *  that existed before the bundle did is never revisited. */
export function hasMaterialized(wt) {
  return cleanWorktrees.has(wt);
}
// Project-global union of every target file we've ever materialized — PERSISTED
// in the cache and seeded on load, so a file whose key was deleted while the
// daemon was down still gets its stale plaintext copy cleaned on the next
// materialize (lastFilesByWorktree alone is empty after a restart, and
// `git clean -fd` never removes an info/exclude'd file).
let knownTargetFiles = new Set();

const MATERIALIZE_HEADER = '# Materialized by flowviant env sync';

/** Render KEY=value with values that contain newlines/= safely quoted so one
 *  value can't fabricate another key line. */
function renderEnvFile(list) {
  const lines = list.map((v) => {
    const needsQuote = /[\n\r"'`$\\ ]/.test(v.value) || v.value === '';
    if (!needsQuote) return `${v.name}=${v.value}`;
    const esc = v.value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '');
    return `${v.name}="${esc}"`;
  });
  return `${MATERIALIZE_HEADER} — DO NOT COMMIT.\n${lines.join('\n')}\n`;
}

/** Delete a materialized file from a worktree, but ONLY if it's ours (carries
 *  our header) and not git-tracked — never touch a file we didn't write.
 *
 *  `rel` gets the SAME gate the write path has: it arrives via
 *  knownTargetFiles, which is refilled from the server bundle and from the
 *  on-disk cache, and this function joins it to a worktree and calls rmSync.
 *  The isTrackedInGit check cannot stand in for validation — `ls-files` on a
 *  path outside the worktree THROWS, the catch reads as "not tracked", and
 *  the deletion proceeds. A delete primitive validates its own input. */
function removeStaleEnvFile(wt, rel) {
  if (!isSafeTarget(rel)) return;
  if (isTrackedInGit(wt, rel)) return;
  const abs = join(wt, rel);
  try {
    if (existsSync(abs) && readFileSync(abs, 'utf8').startsWith(MATERIALIZE_HEADER)) {
      rmSync(abs, { force: true });
    }
  } catch {
    /* best-effort */
  }
}

/** Deploy-scope credentials (e.g. CLOUDFLARE_API_TOKEN) as a NAME→value map —
 *  injected into the deploy command's process env, NEVER written to a file. */
export function deployCreds() {
  const out = {};
  for (const v of values) if (v.scope === 'deploy' && v.value) out[v.name] = v.value;
  return out;
}

/** app-scope secrets for one environment as a NAME→value map — for pushing to
 *  the provider's secret store on a prod deploy (`wrangler secret put`). */
export function appSecretsFor(env) {
  const out = {};
  for (const v of values) if (v.scope === 'app' && v.env === env && v.value) out[v.name] = v.value;
  return out;
}

/** Write the decrypted env into ONE worktree. Never call on the wiki worktree.
 *  v1 materializes the 'dev' app env (agent test runs + local preview); prod
 *  app secrets go to the provider at deploy, deploy creds are injected only. */
export function materializeInto(wt) {
  if (!wt || !existsSync(wt)) return;
  // NEVER SYNCED IS NOT "NO SECRETS", and conflating them cost a whole session.
  // `values` is empty both before the first bundle lands and for a project that
  // genuinely has none; `bundleVersion < 0` is the one that means IGNORANCE.
  // Writing nothing here and RECORDING it as materialized let a worktree
  // created on the first poll after a restart — before handleRosterEnv had
  // warmed the cache — sit secret-less for its entire life, because nothing
  // re-materializes a directory that is neither fresh nor covered by a bundle
  // CHANGE. Returning without recording is what makes the next turn retry.
  if (bundleVersion < 0) return;
  const byFile = new Map();
  for (const v of values) {
    if (v.scope !== 'app' || v.env !== 'dev') continue; // only local dev secrets hit a worktree file
    if (!isSafeTarget(v.targetFile)) continue;
    const list = byFile.get(v.targetFile) ?? [];
    list.push(v);
    byFile.set(v.targetFile, list);
  }

  // Exclude BEFORE writing, not after. The old order wrote plaintext first and
  // tried to hide it afterwards, so every failure mode — and the exclude file
  // being the wrong one, which it was — left a readable secret sitting where
  // the next `git add -A` in that tree would stage it for a push.
  excludeInWorktree(wt, [...byFile.keys()]);

  const written = [];
  /** Refused for a GIT reason this pass — reported, and remediable. */
  const refusedForGit = [];
  /** Anything that did not get written, git reasons and write failures alike.
   *  Blocks the clean mark so the next turn tries again. */
  let anyProblem = false;
  for (const [file, list] of byFile) {
    if (isTrackedInGit(wt, file)) {
      warn(`env: "${file}" is tracked in git — refusing to write secrets there (gitignore it). Its keys are NOT materialized.`);
      refusedForGit.push(file);
      anyProblem = true;
      continue;
    }
    // The load-bearing check. A materialized secret sits in a worktree where an
    // agent runs `git add -A` and pushes as a matter of course, so "git cannot
    // see this file" is a precondition for writing it, not a nicety.
    if (!isIgnoredInGit(wt, file)) {
      warn(`env: "${file}" is not gitignored — refusing to write secrets there. Add it to .gitignore. Its keys are NOT materialized.`);
      refusedForGit.push(file);
      anyProblem = true;
      continue;
    }
    try {
      const abs = join(wt, file);
      // A SYMLINK AT THE TARGET IS NOT A TARGET. `writeFileSync` follows one,
      // so a link committed into the repo (or dropped by an agent) at the
      // materialization path would write the project's decrypted secrets
      // wherever it points — outside the worktree, and outside everything the
      // check-ignore gate can reason about. `lstat`, not `stat`, and refuse.
      // Cheap, and the whole exposure is one call away otherwise.
      try {
        if (lstatSync(abs).isSymbolicLink()) {
          warn(`env: "${file}" is a symlink — refusing to write secrets through it.`);
          anyProblem = true;
          continue;
        }
      } catch {
        /* does not exist yet — the ordinary case */
      }
      mkdirSync(dirname(abs), { recursive: true });
      const body = renderEnvFile(list);
      // Skip an identical rewrite — otherwise every bundle bump touches the
      // file mtime and hot-restarts a running preview dev-server mid-review.
      let prior = null;
      try {
        prior = readFileSync(abs, 'utf8');
      } catch {
        /* new file */
      }
      if (prior !== body) writeFileSync(abs, body, { mode: 0o600 });
      // `mode` on writeFileSync applies at CREATION only — an overwrite of a
      // file that already existed keeps whatever mode it had, so a 0644 stub
      // committed by a teammate (or left by an older daemon) would hold
      // plaintext secrets world-readable on a shared box. chmod every time.
      try {
        chmodSync(abs, 0o600);
      } catch {
        /* best-effort: a filesystem without modes is not a reason to refuse */
      }
      written.push(file);
    } catch (e) {
      // NOT reported as a refusal: the surface's line names a git cause and a
      // git remedy, and a full disk is neither. It still blocks the clean mark,
      // so the next turn retries.
      warn(`env: could not write ${file} into worktree: ${e.message}`);
      anyProblem = true;
    }
  }

  // Remove any file we ever materialized (this session OR a prior one, via the
  // persisted knownTargetFiles) that has no keys now — a deleted secret's
  // plaintext file must not linger, even across a daemon restart.
  const writtenSet = new Set(written);
  const candidates = new Set([...(lastFilesByWorktree.get(wt) ?? []), ...knownTargetFiles]);
  for (const stale of candidates) {
    if (!writtenSet.has(stale)) removeStaleEnvFile(wt, stale);
  }
  for (const f of written) knownTargetFiles.add(f);
  lastFilesByWorktree.set(wt, written);

  // THE PASS'S VERDICT, recorded whole and REPLACING the previous one — this is
  // what lets a refusal clear. `refusedForGit` is recomputed from scratch every
  // pass, so a file that gets gitignored simply is not in the next one, and the
  // union reported on the poll shrinks. `anyProblem` (which also covers a write
  // failure) is what decides whether this worktree gets retried on the next
  // turn; a clean pass is remembered so we stop touching a live directory.
  if (refusedForGit.length > 0) skippedByWorktree.set(wt, refusedForGit);
  else skippedByWorktree.delete(wt);
  if (anyProblem) cleanWorktrees.delete(wt);
  else cleanWorktrees.add(wt);
  everMaterialized = true;

  // THE FIRST SECRET THIS BOX EVER WROTE TO DISK is the moment the recovery
  // code stops being a warning about nothing — see `printRecoveryCodeOnce`.
  // Gated on `written`, not on reaching this line: a pass that refused every
  // file for a git reason materialized nothing, and the sentence would be
  // false. Nothing is printed on any later pass.
  if (written.length > 0) printRecoveryCodeOnce();
}


// ── Uplink scrubbing ───────────────────────────────────────────────────────

/** Redact every known secret value from daemon-posted text. Values shorter
 *  than the floor ("1", "true") would redact half the stream — skipped. */
export function scrub(text) {
  if (typeof text !== 'string' || !text || !values.length) return text;
  let out = text;
  for (const v of values) {
    if (typeof v.value === 'string' && v.value.length >= SCRUB_MIN_LENGTH) {
      out = out.split(v.value).join(`[REDACTED:${v.name}]`);
    }
  }
  return out;
}

// ── Roster tick ────────────────────────────────────────────────────────────

let busy = false; // one env operation at a time — ticks are cheap to skip

/**
 * React to the roster's env block. Returns { changed } — true when the bundle
 * was (re)materialized so the caller refreshes its worktrees.
 */
export async function handleRosterEnv(env, { projectId } = {}) {
  if (!env || busy) return { changed: false };
  busy = true;
  try {
    await ensureKeypair();
    if (projectId) cachedProjectId = projectId;
    // First tick after a restart: warm from the encrypted cache so worktrees
    // can materialize even if the bundle fetch below fails transiently.
    if (bundleVersion < 0 && cachedProjectId) await loadCachedEnv(cachedProjectId);

    // 1. Introduce this machine (idempotent server-side). registeredOnce is set
    // only AFTER the POST lands — a transient failure must retry next poll, not
    // wedge registration until restart.
    if (env.status === 'none' && !registeredOnce) {
      const label = hostname() || 'daemon';
      let registered = null;
      try {
        registered = await post('register', { pubkey: myPubB64(), label });
      } catch (e) {
        // A 429 = the project is at its machine cap; retrying every poll would
        // just hammer it. Stop for this session (a restart re-tries).
        if (/\(429/.test(e.message)) {
          registeredOnce = true;
          warn('env: this project is at its machine limit — env access not requested. Ask an admin to remove an old machine.');
          return { changed: false };
        }
        throw e; // transient — retry next poll (registeredOnce still false)
      }
      registeredOnce = true;
      /*
       * ONE LINE, AND IT RELAYS WHAT THE SERVER ANSWERED.
       *
       * It used to print a key fingerprint and say "an admin approves it in
       * Settings → Environment (compare the emoji)" — an instruction for a
       * button that no longer exists, about a comparison nobody was making, on
       * top of a credential this box was already trusted with. What replaced it
       * asserted the opposite and just as blindly: "enrolled … secrets sync to
       * this box automatically", printed whatever the response said. A fresh
       * registration comes back `approved`, not `enrolled` — the key is not
       * here yet and arrives only once some box that holds it polls — so the
       * line was claiming a state this box was one or more ticks away from, and
       * on an OLDER server (which still answers `pending`) it was claiming one
       * the box would never reach at all.
       *
       * So the status is read off the response and each state says its own
       * true sentence, and an answer we do not recognise — or no body at all —
       * says only the part we measured: the registration went out.
       */
      const registeredAs = `${c.cyan('env')}    · registered as ${c.bold(label)}`;
      if (registered?.status === 'enrolled') {
        info(`${c.cyan('env')}    · enrolled as ${c.bold(label)} — secrets sync to this box automatically`);
      } else if (registered?.status === 'approved') {
        info(`${registeredAs} — secrets sync here as soon as a machine holding the key is online`);
      } else if (registered?.status === 'pending') {
        // An older server, which still has the approve gate. Say what IT is
        // waiting on rather than what we are: this daemon cannot clear it.
        info(`${registeredAs} — this server is waiting on an approval in Settings`);
      } else {
        info(registeredAs);
      }
      return { changed: false };
    }
    // A HARMLESS WAIT, and the server no longer produces this: registering IS
    // enrolling since 2026-09-20, and a row left `pending` by the old gate is
    // promoted on the register above. Kept because an OLDER server still
    // answers `pending`, and a daemon must not treat an unrecognised state as a
    // reason to act.
    if (env.status === 'pending') return { changed: false };
    if (env.status === 'revoked') return { changed: false };

    // 2. Bootstrap: no project keypair exists — this machine creates it.
    if (env.bootstrapNeeded && (env.status === 'approved' || env.status === 'enrolled' || env.status === 'none')) {
      if (env.status === 'none') return { changed: false }; // register first, next tick
      await bootstrapProject();
      return { changed: false }; // next tick syncs as enrolled
    }
    if (env.status !== 'enrolled') return { changed: false };

    // 3. Wrap jobs + rotation + sync — all need the bundle.
    const needSync = env.bundleVersion !== bundleVersion;
    if (!needSync && !env.pendingWraps && !env.rotationPending) return { changed: false };
    const bundle = await fetchBundle();
    if (!bundle.wrappedPriv || !bundle.projectPub) return { changed: false };
    projectPriv = openSealed(bundle.wrappedPriv, keypair.publicKey, keypair.privateKey);
    const projectPub = sodium.from_base64(bundle.projectPub, B64());

    // Execute pending enrollments: seal the priv to each newly registered
    // machine. Registering is what puts a box on this list now — there is no
    // approval step between the two. The
    // wrap's epoch rides along — the server rejects (stale) if a rotation moved
    // it since we fetched, so nobody enrolls with a dead key.
    if (bundle.pendingWraps.length) {
      const wraps = bundle.pendingWraps.map((p) => ({
        daemonId: p.daemonId,
        wrappedPriv: seal(projectPriv, p.pubkey),
      }));
      const res = await post('wraps', { pubkey: myPubB64(), keyEpoch: bundle.keyEpoch, wraps });
      if (res?.stale) note(`${c.cyan('env')} ${c.dim('— wraps raced a rotation; retrying next poll')}`);
      else ok(`${c.cyan('env')} ${c.dim(`— delivered the key to ${wraps.length} newly registered machine${wraps.length === 1 ? '' : 's'}`)}`);
    }

    // Decrypt the values we have — carrying each key's VERSION so a rotation can
    // prove it re-sealed the current value (not one a concurrent write moved).
    const opened = [];
    let allOpened = true;
    for (const k of bundle.keys) {
      try {
        const plain = openSealed(k.ciphertext, projectPub, projectPriv);
        opened.push({ name: k.name, env: k.env, scope: k.scope ?? 'app', targetFile: k.targetFile, value: sodium.to_string(plain), version: k.version });
      } catch {
        allOpened = false;
        warn(`env: could not open ${k.name} (epoch ${k.keyEpoch}) — skipping; a rotation should heal it`);
      }
    }

    // Execute a pending rotation: new keypair, full coverage, all wraps. If we
    // couldn't open every value, DON'T attempt — a partial rotate would fail
    // the server's coverage check; let another enrolled daemon (which can open
    // them) do it. Server serializes concurrent executors via a claim lock.
    if (bundle.rotationPending) {
      if (!allOpened) {
        warn(`env: skipping rotation — this machine can't open every value; another daemon will rotate`);
        return { changed: false };
      }
      const next = sodium.crypto_box_keypair();
      const nextPubB64 = sodium.to_base64(next.publicKey, B64());
      const res = await post('rotate', {
        pubkey: myPubB64(),
        fromEpoch: bundle.keyEpoch,
        projectPub: nextPubB64,
        values: opened.map((v) => ({ name: v.name, env: v.env, ciphertext: seal(sodium.from_string(v.value), nextPubB64), version: v.version })),
        wraps: bundle.enrolledDaemons.map((d) => ({ daemonId: d.daemonId, wrappedPriv: seal(next.privateKey, d.pubkey) })),
        ...(bundle.recoveryPub ? { recoverySealed: seal(next.privateKey, bundle.recoveryPub) } : {}),
      }).catch((e) => {
        // epoch_stale / value_moved / coverage → a concurrent change; the next
        // poll re-fetches and retries. Not fatal.
        note(`${c.cyan('env')} ${c.dim(`— rotation deferred (${e.message}); retrying next poll`)}`);
        return null;
      });
      if (res) ok(`${c.cyan('env')} ${c.dim('— project key rotated (a machine was revoked); next poll syncs the new epoch')}`);
      return { changed: false }; // resync on the next tick at the new version
    }

    if (needSync) {
      values = opened;
      bundleVersion = bundle.bundleVersion;
      // Fold the current target files into the persisted known set so stale
      // cleanup survives a restart (a key deleted while down still gets swept).
      // Filtered at the fill, not just at the delete: this set is persisted,
      // so an unsafe path admitted here would outlive the bundle that sent it.
      for (const v of values) if (isSafeTarget(v.targetFile)) knownTargetFiles.add(v.targetFile);
      if (cachedProjectId) writeCache(cachedProjectId, { values, bundleVersion, knownFiles: [...knownTargetFiles] });
      ok(`${c.cyan('env')} ${c.dim(`— synced ${values.length} secret${values.length === 1 ? '' : 's'} (env v${bundleVersion})`)}`);
      return { changed: true };
    }
    return { changed: false };
  } catch (e) {
    warn(`env sync: ${e.message} — will retry next poll`);
    return { changed: false };
  } finally {
    busy = false;
  }
}

/**
 * First machine creates the project keypair + the standing recovery target.
 *
 * THIS IS SILENT (2026-09-20). Rotations re-seal to the same recovery pub, so
 * the passphrase minted here works forever — which is exactly why it does not
 * have to be shouted at somebody who has no secrets yet. It is parked in this
 * box's keypair file and printed the first time this box materializes a
 * secret; `stashRecoveryCode`'s docblock carries the whole argument.
 */
async function bootstrapProject() {
  const project = sodium.crypto_box_keypair();
  const recovery = sodium.crypto_box_keypair();
  // Human-typable passphrase: 6 groups of 4 from an unambiguous alphabet.
  const ALPHA = 'abcdefghjkmnpqrstuvwxyz23456789';
  const raw = sodium.randombytes_buf(24);
  const passphrase = Array.from(raw, (b, i) => ALPHA[b % ALPHA.length] + ((i + 1) % 4 === 0 && i < 23 ? '-' : '')).join('');
  const salt = sodium.randombytes_buf(sodium.crypto_pwhash_SALTBYTES);
  const kdfKey = sodium.crypto_pwhash(
    sodium.crypto_secretbox_KEYBYTES,
    passphrase,
    salt,
    sodium.crypto_pwhash_OPSLIMIT_MODERATE,
    sodium.crypto_pwhash_MEMLIMIT_MODERATE,
    sodium.crypto_pwhash_ALG_DEFAULT
  );
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const recoverySecret = JSON.stringify({
    pub: sodium.to_base64(recovery.publicKey, B64()),
    priv: sodium.to_base64(recovery.privateKey, B64()),
  });
  const recoveryBlob = [
    sodium.to_base64(salt, B64()),
    sodium.to_base64(nonce, B64()),
    sodium.to_base64(sodium.crypto_secretbox_easy(sodium.from_string(recoverySecret), nonce, kdfKey), B64()),
  ].join(':');

  await post('bootstrap', {
    pubkey: myPubB64(),
    projectPub: sodium.to_base64(project.publicKey, B64()),
    selfWrap: seal(project.privateKey, myPubB64()),
    recoveryPub: sodium.to_base64(recovery.publicKey, B64()),
    recoveryBlob,
    recoverySealed: seal(project.privateKey, sodium.to_base64(recovery.publicKey, B64())),
  });

  // ONE QUIET LINE. The code goes into the keypair file and waits for the
  // first secret. A stash that did NOT land is the one case that prints now:
  // the passphrase exists only in this closure, and losing the only way back
  // into a project's secrets to keep the terminal tidy is not a trade.
  if (stashRecoveryCode(passphrase, cachedProjectId)) {
    ok(`${c.cyan('env')} ${c.dim('— created this project\'s env keypair')}`);
  } else {
    warn('env: could not save the recovery code to this machine — here it is, once:');
    printRecoveryBlock(passphrase);
  }
}
