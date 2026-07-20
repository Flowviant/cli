/**
 * Team env sync — the daemon is the CRYPTO ANCHOR. This machine holds a
 * persistent X25519 keypair (~/.flowviant/env-keypair.json, 0600); the
 * project's private key reaches it only sealed to that pubkey. Everything the
 * server stores is ciphertext it cannot open.
 *
 * Duties per roster tick (handleRosterEnv):
 *  - register this machine's pubkey (once) → an admin approves in Settings.
 *  - bootstrap the project keypair when none exists (first machine): generate
 *    it + a standing RECOVERY keypair wrapped under a one-time passphrase
 *    printed exactly once — rotations re-seal to the same recovery pub, so
 *    that passphrase survives forever.
 *  - sync: on a bundle version change, unwrap the priv, open every sealed
 *    value, cache (encrypted under a key derived from our own priv), and
 *    rematerialize env files into the agent worktrees.
 *  - execute wrap jobs (admin approved a new machine → seal the priv to it).
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
  rmSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir, hostname } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import sodium from 'libsodium-wrappers';
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

/** 6-emoji key fingerprint — algorithm MUST match the web's pubkeyEmoji
 *  (EnvironmentSettings.tsx) so the human can compare terminal ↔ approve card. */
// MUST stay byte-identical to the web's pubkeyEmoji (EnvironmentSettings.tsx) —
// the human compares the two strings. 32 glyphs × 8 positions, effective ~40
// bits. Two FNV-1a rolling hashes over the whole key + a murmur3 finalizer per
// glyph (a plain additive sum collapsed the space to ~10 bits — grindable).
const FP_EMOJI = ['🦊','🐙','🦕','🐝','🦉','🐬','🦁','🐸','🦄','🐢','🦋','🐺','🦜','🐳','🦔','🐌','🦩','🐿️','🦥','🐨','🦦','🐇','🦡','🦂','🦨','🐜','🦢','🐋','🦭','🐞','🦚','🐊'];
export function pubkeyEmoji(pubkeyB64) {
  let h1 = 0x811c9dc5 >>> 0;
  let h2 = 0xc2b2ae35 >>> 0;
  for (let i = 0; i < pubkeyB64.length; i++) {
    const ch = pubkeyB64.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ ch, 0x85ebca6b) >>> 0;
  }
  let out = '';
  for (let i = 0; i < 8; i++) {
    let x = (((i < 4 ? h1 : h2) + i * 0x9e3779b1) >>> 0);
    x ^= x >>> 16;
    x = Math.imul(x, 0x7feb352d) >>> 0;
    x ^= x >>> 15;
    x = Math.imul(x, 0x846ca68b) >>> 0;
    x ^= x >>> 16;
    out += FP_EMOJI[x & 31];
  }
  return out;
}

/** This machine's persistent keypair (created on first use, 0600). */
export async function ensureKeypair() {
  await sodium.ready;
  if (keypair) return keypair;
  try {
    const stored = JSON.parse(readFileSync(KEYPAIR_PATH, 'utf8'));
    keypair = {
      publicKey: sodium.from_base64(stored.pub, B64()),
      privateKey: sodium.from_base64(stored.priv, B64()),
    };
    return keypair;
  } catch {
    /* first run */
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

/** Query params the roster poll carries: identity + materialized version. */
export async function envQueryParams() {
  await ensureKeypair();
  const params = { envpub: myPubB64() };
  if (bundleVersion >= 0) params.envv = String(bundleVersion);
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
  knownTargetFiles = new Set(cached.knownFiles ?? values.map((v) => v.targetFile));
  cachedProjectId = projectId;
  return values.length > 0;
}

// ── Materialization ────────────────────────────────────────────────────────

/** Per-worktree git exclude — untracked AND unstageable. A git worktree's
 *  `.git` is a FILE pointing at its private gitdir; info/exclude there applies
 *  to that worktree only and never touches the user's repo. */
function excludeInWorktree(wt, relPaths) {
  try {
    const dotGit = join(wt, '.git');
    let gitdir = dotGit;
    try {
      const content = readFileSync(dotGit, 'utf8');
      const m = content.match(/^gitdir:\s*(.+)\s*$/m);
      if (m) gitdir = resolve(wt, m[1].trim());
    } catch {
      /* .git is a directory (main checkout) — use it directly */
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

const isSafeTarget = (p) =>
  p &&
  p.length <= 200 &&
  !p.includes('\\') &&
  !p.includes('\0') &&
  !p.startsWith('/') &&
  p.split('/').every((s) => s.length > 0 && s !== '.' && s !== '..');

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

// Per-worktree: the target files we last materialized THIS SESSION.
const lastFilesByWorktree = new Map();
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
 *  our header) and not git-tracked — never touch a file we didn't write. */
function removeStaleEnvFile(wt, rel) {
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

/** Write the decrypted env into ONE worktree. Never call on the wiki worktree. */
export function materializeInto(wt) {
  if (!wt || !existsSync(wt)) return;
  const byFile = new Map();
  for (const v of values) {
    if (!isSafeTarget(v.targetFile)) continue;
    const list = byFile.get(v.targetFile) ?? [];
    list.push(v);
    byFile.set(v.targetFile, list);
  }

  const written = [];
  for (const [file, list] of byFile) {
    if (isTrackedInGit(wt, file)) {
      warn(`env: "${file}" is tracked in git — refusing to write secrets there (gitignore it). Its keys are NOT materialized.`);
      continue;
    }
    try {
      const abs = join(wt, file);
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
      written.push(file);
    } catch (e) {
      warn(`env: could not write ${file} into worktree: ${e.message}`);
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
  if (written.length) excludeInWorktree(wt, written);
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
      try {
        await post('register', { pubkey: myPubB64(), label });
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
      const fp = pubkeyEmoji(myPubB64());
      info(`${c.cyan('env')}    · this machine requested env access as ${c.bold(label)}`);
      note(`  fingerprint ${fp} — an admin approves it in Settings → Environment (compare the emoji).`);
      return { changed: false };
    }
    if (env.status === 'pending') return { changed: false }; // waiting on the admin
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

    // Execute approved enrollments: seal the priv to each new machine. The
    // wrap's epoch rides along — the server rejects (stale) if a rotation moved
    // it since we fetched, so nobody enrolls with a dead key.
    if (bundle.pendingWraps.length) {
      const wraps = bundle.pendingWraps.map((p) => ({
        daemonId: p.daemonId,
        wrappedPriv: seal(projectPriv, p.pubkey),
      }));
      const res = await post('wraps', { pubkey: myPubB64(), keyEpoch: bundle.keyEpoch, wraps });
      if (res?.stale) note(`${c.cyan('env')} ${c.dim('— wraps raced a rotation; retrying next poll')}`);
      else ok(`${c.cyan('env')} ${c.dim(`— delivered the key to ${wraps.length} newly approved machine${wraps.length === 1 ? '' : 's'}`)}`);
    }

    // Decrypt the values we have — carrying each key's VERSION so a rotation can
    // prove it re-sealed the current value (not one a concurrent write moved).
    const opened = [];
    let allOpened = true;
    for (const k of bundle.keys) {
      try {
        const plain = openSealed(k.ciphertext, projectPub, projectPriv);
        opened.push({ name: k.name, env: k.env, targetFile: k.targetFile, value: sodium.to_string(plain), version: k.version });
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
      for (const v of values) knownTargetFiles.add(v.targetFile);
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

/** First machine creates the project keypair + the standing recovery target.
 *  The recovery passphrase prints ONCE — rotations re-seal to the same
 *  recovery pub, so this passphrase works forever. */
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

  console.log('');
  ok(`${c.cyan('env')} — this machine created the project's env keypair.`);
  console.log(`  ${c.bold('RECOVERY CODE')} ${c.dim('(shown ONCE — save it in a password manager):')}`);
  console.log(`  ${c.bold(c.yellow(passphrase))}`);
  note('  If every enrolled machine is ever lost, this code is the only way back into the secrets.');
  console.log('');
}
