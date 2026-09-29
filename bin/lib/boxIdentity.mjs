/**
 * THE BOX KEYPAIR — this box's durable identity, and the one thing in this file.
 *
 * A persistent X25519 keypair at `~/.flowviant/env-keypair.json` (0600). Its
 * public half rides EVERY roster poll as `envpub`, and that is what tells two
 * computers apart when the server decides which of them is this project's
 * machine (holdership, 2026-09-14) and which rows belong to which box in the
 * registry (`machine_box`, 0.91.0). It is an identity LABEL for arbitration,
 * never an authorization: nothing is GRANTED by it — the credential grants, the
 * pubkey only disambiguates boxes.
 *
 * SPLIT OUT OF `env.mjs` (2026-09-26, the SOLID pass). That module held three
 * things with three unrelated reasons to change — this identity, the checkout's
 * env comparison scan (still `env.mjs`), and the uplink scrubber
 * (`uplinkScrub.mjs`) — and they shared a file only because all three were
 * what was left standing when the secrets vault they once served was deleted
 * (2026-09-21; `env.mjs` keeps that obituary). Nothing here reads a `.env`,
 * and nothing there touches this file. The `env-` in the file name is a fossil
 * of the vault and stays, because the PATH is the identity: see below.
 *
 * WHAT MUST NOT CHANGE: the keypair file, its path, and its 2026-09-14
 * correctness rule (only ENOENT mints; every other read failure RETHROWS).
 * Rotating this box's identity would make the same physical machine arrive at
 * the roster as a stranger — a new row in the registry, and a standby of
 * itself for the whole holder-claim window.
 */

import {
  readFileSync,
  mkdirSync,
  openSync,
  writeSync,
  fsyncSync,
  closeSync,
  linkSync,
  unlinkSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
// STILL SUMO, and deliberately not narrowed to the standard build in the same
// pass that deleted the vault. `crypto_box_keypair` exists in both, but the
// sumo package is what is installed, what every other daemon on npm resolves,
// and swapping the dependency is a separate change with its own install-time
// failure modes. Nothing here needs Argon2 any more; nothing here forbids the
// narrowing either.
import sodium from 'libsodium-wrappers-sumo';

const B64 = () => sodium.base64_variants.ORIGINAL;
const KEYPAIR_PATH = join(homedir(), '.flowviant', 'env-keypair.json');

let keypair = null; // { publicKey: Uint8Array, privateKey: Uint8Array }

/*
 * `sodiumReady` IS DELETED (2026-09-26, the SOLID pass). It moved here out of
 * `env.mjs` with no caller anywhere in the daemon: every door below awaits
 * `sodium.ready` itself, so a separate warm-up export was a door nobody used.
 */

/*
 * `pubkeyEmoji` IS DELETED (2026-09-20), and so is its byte-identical twin in
 * the web app.
 *
 * It existed for exactly one gesture: the terminal printed eight glyphs, the
 * browser's approve card printed the same eight, and a human compared them
 * before pressing Approve. Registering became enrolling, and then the whole
 * enrolment went with the vault — so there is no approve card, no comparison,
 * and nobody to make it. A fingerprint kept byte-identical across two repos
 * for nobody to look at is worse than none: it reads like a live MITM defence
 * and defends nothing.
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
     * This keypair is the box's DURABLE IDENTITY — since 2026-09-14 it is what
     * tells two computers apart when the server decides which of them is this
     * project's machine, and since 0.91.0 it is the key of this box's row in
     * the machine registry. Regenerating it on a truncated file or an
     * unreadable one OVERWRITES that identity: the box arrives at the roster as
     * a stranger and stands itself down as a standby of itself.
     *
     * (It was ALSO what the project's secret vault was sealed to, until the
     * vault was deleted 2026-09-21. That was the loudest consequence and it is
     * gone; the identity consequence is the one that survives, and it is on its
     * own sufficient.)
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
  const minted = sodium.crypto_box_keypair();
  const winner = mintKeypairFile(
    KEYPAIR_PATH,
    JSON.stringify({
      pub: sodium.to_base64(minted.publicKey, B64()),
      priv: sodium.to_base64(minted.privateKey, B64()),
    })
  );
  keypair = {
    publicKey: sodium.from_base64(winner.pub, B64()),
    privateKey: sodium.from_base64(winner.priv, B64()),
  };
  return keypair;
}

/**
 * WRITE THE BOX'S IDENTITY ONCE, ATOMICALLY, AND LET THE FIRST WRITER WIN
 * (2026-09-24, the audit). Returns the `{ pub, priv }` that is ON DISK after
 * the call — ours, or the one a concurrent first start got there with.
 *
 * It was a plain `writeFileSync` reached by every process that saw ENOENT, so
 * two daemons starting together on a fresh box (two projects, two units at
 * boot) each minted a key and the LAST writer won: the first kept a key in
 * memory the disk no longer held and arrived, after its next re-exec, as a
 * different box. And a crash inside the write left a torn file that every later
 * start refuses to read — the only-ENOENT-mints rule doing its job over a file
 * nothing can fix.
 *
 * So the key goes to a private temp file, is fsync'd, and is LINKED into place:
 * `link` fails with EEXIST instead of replacing, so exactly one identity is ever
 * published and every loser reads the winner's. The file at the real path is
 * either absent or complete — never half of one.
 */
export function mintKeypairFile(path, body) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    const fd = openSync(tmp, 'wx', 0o600);
    try {
      writeSync(fd, body);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      linkSync(tmp, path);
      return JSON.parse(body);
    } catch (e) {
      if (e?.code === 'EEXIST') {
        // Somebody else published first. Theirs is the identity; ours is dropped.
        return JSON.parse(readFileSync(path, 'utf8'));
      }
      // A filesystem with no hard links (some network and FUSE mounts answer
      // EPERM/ENOTSUP) must not cost the box its identity — the plain write
      // this replaced worked there. Fall back to an EXCLUSIVE create: still
      // first-writer-wins, only without the torn-write guarantee.
      if (!['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV'].includes(e?.code)) throw e;
      let fd2;
      try {
        fd2 = openSync(path, 'wx', 0o600);
      } catch (e2) {
        if (e2?.code !== 'EEXIST') throw e2;
        return JSON.parse(readFileSync(path, 'utf8'));
      }
      try {
        writeSync(fd2, body);
        fsyncSync(fd2);
      } finally {
        closeSync(fd2);
      }
      return JSON.parse(body);
    }
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      /* already gone */
    }
  }
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
 * THE IDENTITY PARAMS THE ROSTER POLL CARRIES — one key, and it is the box.
 *
 * It used to carry two more: `envv` (the materialized bundle version, which fed
 * the Settings "env vN" chip) and `envskip` (the target files the materializer
 * REFUSED to write, with the empty string as a real "measured, refused nothing"
 * report). Both were facts about the vault and both died with it; the server
 * stopped reading them in the same change.
 *
 * WHAT DID NOT CHANGE IS `envpub`: the same base64 of the same public key out
 * of the same file. Holdership arbitration, the displaced signal and the box
 * registry all key on it, so a box that upgrades to this release must be the
 * SAME box to the server it was before — no new row, no re-claim, no standby
 * of itself. That continuity is the point of this function still existing at
 * all.
 *
 * Absence keeps its reserved meaning: a poll with no `envpub` is EXEMPT from
 * arbitration rather than treated as an unknown box.
 */
export async function envQueryParams() {
  await ensureKeypair();
  return { envpub: myPubB64() };
}
