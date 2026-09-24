/**
 * THREE THINGS THIS BOX KNOWS ABOUT ITSELF — and nothing it holds for anybody.
 *
 *  1. THE BOX KEYPAIR. A persistent X25519 keypair at
 *     `~/.flowviant/env-keypair.json` (0600). Its public half rides EVERY roster
 *     poll as `envpub`, and that is what tells two computers apart when the
 *     server decides which of them is this project's machine (holdership,
 *     2026-09-14) and which rows belong to which box in the registry
 *     (`machine_box`, 0.91.0). It is an identity LABEL for arbitration, never
 *     an authorization: nothing is GRANTED by it — the credential grants, the
 *     pubkey only disambiguates boxes.
 *  2. THE UPLINK SCRUBBER. `scrub()` redacts secret values out of every piece
 *     of text this daemon posts — turn streams, tool events, the trace,
 *     process command lines, wiki progress, deploy logs. It is fed from TWO
 *     places (2026-09-21, the review): the checkout's `.env*` files, and the
 *     PRESENT values of `childEnv`'s `DEPLOY_KEEP` names out of this process's
 *     own environment, which is where an operator's `CLOUDFLARE_API_TOKEN`
 *     actually lives and which the deploy lane hands to a command whose stdout
 *     it then streams to the server. It redacts on SHAPE, never on meaning: a
 *     value that looks like an ordinary word is left alone, because a relay
 *     that swaps the CLI's own words for `[REDACTED:NODE_ENV]` has stopped
 *     being a relay.
 *  3. THE ENV COMPARISON SCAN. `scanEnvFiles()` reads the checkout's own
 *     `.env*` files and reports variable NAMES plus a short VALUE FINGERPRINT
 *     SALTED WITH THE PROJECT ID, so the app can answer "why does it work on
 *     that box and not this one?" without an eight-character hash over
 *     `production` becoming a dictionary lookup. THE VALUE NEVER LEAVES THE
 *     BOX, and neither does anything from (2) — a report is a statement about
 *     the CHECKOUT'S FILES, and this process's environment is not one.
 *
 * ── THE VAULT IS DELETED (2026-09-21) ──
 *
 * This module used to be the CRYPTO ANCHOR of an end-to-end-encrypted team
 * secrets vault: the project's private key reached this box sealed to the
 * keypair above, the daemon opened every value, cached them encrypted on disk,
 * MATERIALIZED `.env` files into every session worktree, executed wrap jobs for
 * newly registered boxes, executed rotations when a machine was revoked, and
 * minted a one-time RECOVERY PASSPHRASE parked beside the private key. About
 * 700 lines, a `libsodium-wrappers-sumo` Argon2 dependency, four `/fleet/env/*`
 * endpoints, a `flowviant env` subcommand, and five server tables.
 *
 * The owner, asked directly whether he wanted it:
 *
 *     "no i dont want it. unless its needed where i want to show the env of
 *      each of the machines (for comparison)."
 *
 * and on the recovery passphrase the whole custody ceremony existed to protect:
 *
 *     "no, its fine to repaste from providers."
 *
 * So the vault goes whole and the ONE readout inside it that was genuinely
 * wanted — seeing what each machine's environment looks like — is rebuilt as
 * the scan below, which holds no secrets and therefore needs no custody, no
 * recovery code, no rotation and no wrap jobs. Gone with it: `handleRosterEnv`,
 * `bootstrapProject`, `fetchBundle`, `loadCachedEnv`, the encrypted
 * `~/.flowviant/env-cache`, `materializeInto` / `hasMaterialized`,
 * `deployCreds` / `appSecretsFor`, `stashRecoveryCode` /
 * `printRecoveryCodeOnce`, `removeStaleEnvFile`, `isSafeTarget`, and the
 * `envv` / `envskip` poll params the materializer reported through.
 *
 * WHAT DID NOT GO, AND MUST NOT: the keypair file, its path, and its 2026-09-14
 * correctness rule (only ENOENT mints; every other read failure RETHROWS).
 * Rotating this box's identity would make the same physical machine arrive at
 * the roster as a stranger — a new row in the registry, and a standby of
 * itself for the whole holder-claim window.
 *
 * `excludeInWorktree` moved to `git.mjs`: it is a generic `git info/exclude`
 * helper that only ever lived here because the materializer was its first
 * caller.
 */

import { readdirSync, readFileSync, writeFileSync, mkdirSync, lstatSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
// STILL SUMO, and deliberately not narrowed to the standard build in the same
// pass that deleted the vault. `crypto_box_keypair` exists in both, but the
// sumo package is what is installed, what every other daemon on npm resolves,
// and swapping the dependency is a separate change with its own install-time
// failure modes. Nothing here needs Argon2 any more; nothing here forbids the
// narrowing either.
import sodium from 'libsodium-wrappers-sumo';
// THE PROJECT ID, as a live binding. It salts every fingerprint (see
// `fingerprint`), and it is a `let` in config.mjs because cli.mjs's ambiguity
// picker chooses a project AFTER import — reading a frozen copy here would salt
// a picked project's report with `null` and report nothing at all.
import { PROJECT_ID } from './config.mjs';
// THE DEPLOY LANE'S OWN ALLOWLIST, borrowed for REDACTION ONLY. Deriving the
// scrub list from the set a deploy command is actually handed is what stops the
// two drifting; `processEnvSecrets`'s docblock carries the whole argument,
// including why none of it ever reaches the wire.
import { processEnvSecrets } from './childEnv.mjs';

const B64 = () => sodium.base64_variants.ORIGINAL;
const KEYPAIR_PATH = join(homedir(), '.flowviant', 'env-keypair.json');

// ── What `scrub` will redact ───────────────────────────────────────────────
//
// THE PREDICATE LIVES ABOVE THE LIST ON PURPOSE (2026-09-21): the list is
// FILTERED THROUGH IT ONCE, when a scan rebuilds it, rather than tested per
// call. `scrub` runs on every posted line of every turn stream, tool event and
// deploy log, and it does a whole-string `split`/`join` per value — so a value
// that will never match must not survive into the loop at all. Pre-filtering
// also makes the list smaller than it was before this pass on a typical
// checkout, because half of a real `.env` is ordinary configuration.

/**
 * THE LENGTH FLOOR. A value of one or two characters — `1`, `ab`, `on` — occurs
 * in ordinary prose constantly, so redacting one replaces half of every stream
 * this daemon posts with `[REDACTED:NAME]` and the trace stops being readable
 * at all. Six is the point below which a value is far likelier to be a flag
 * than a secret, and nothing this short is worth making the product illegible
 * for.
 *
 * (It used to carry the comment "mirrors shared ENV_SCRUB_MIN_LENGTH". That
 * constant does not exist anywhere in the monorepo any more — it went with the
 * vault's server half on 2026-09-21 — and a cross-reference to a deleted
 * identifier reads as "do not change this, the other end depends on it", which
 * is a claim about a coupling nobody can check. The floor's own argument is
 * above and it stands on its own.)
 */
const SCRUB_MIN_LENGTH = 6;

/**
 * A VALUE THAT LOOKS LIKE AN ORDINARY WORD IS NOT REDACTED (2026-09-21, the
 * review) — and this is a correctness fix, not a tuning knob.
 *
 * `scrub` now reads the CHECKOUT'S `.env*` files, and a real `.env` is full of
 * configuration that is not secret at all: `NODE_ENV=development`,
 * `HOST=localhost`, `APP_NAME=flowviant`, `LOG_LEVEL=verbose`,
 * `AWS_REGION=us-east-1`. With those in the list, every occurrence of the word
 * "development" in the CLI's own narration came back as
 * `[REDACTED:NODE_ENV]` — so a turn trace, which exists to relay what the CLI
 * said, was relaying something else. A relay does not swap the words it
 * carries. That is a worse failure than under-redaction, because it is silent,
 * universal, and destroys the readout the trace was built for.
 *
 * TWO SHAPE TESTS, applied per value, both cheap and both about SHAPE rather
 * than meaning (nothing here classifies, guesses, or asks a model):
 *
 *  · A PLAIN IDENTIFIER — starts with a letter, runs at most sixteen
 *    characters, and is made only of letters, digits and `.` `/` `-`. That is
 *    what a word, a hostname, a short version string and an enum value all look
 *    like. `_` is deliberately NOT in the set: an underscore is rare in prose
 *    and common in key material (`sk-live_…`), so its presence is the cheapest
 *    honest signal that a string was minted rather than written.
 *  · A SHORT VALUE WITH LITTLE VARIETY — under twelve characters and drawing on
 *    fewer than three of {lower, upper, digit, symbol}. A real credential short
 *    enough to be under twelve characters is mixed; `us-east-1` and `verbose`
 *    are not.
 *
 * THE ACCEPTED COST, STATED RATHER THAN HIDDEN: a genuinely secret value that
 * is short and lowercase — `hunter2secret`, a thirteen-character all-letters
 * password — is NOT redacted. Under-redaction is chosen here over making the
 * product illegible, because the alternative is a trace nobody can read and a
 * product that silently rewrites its own CLI's output. An operator whose secret
 * is a dictionary word has a problem this function cannot fix. Anything with a
 * symbol, a case mix, twelve-plus characters, or an underscore — which is every
 * token, key, URL, JWT and hex digest anybody actually pastes into a `.env` —
 * is redacted.
 */
const SCRUB_PLAIN_RE = /^[A-Za-z][A-Za-z0-9._/-]{0,15}$/;
function characterClasses(value) {
  let n = 0;
  if (/[a-z]/.test(value)) n += 1;
  if (/[A-Z]/.test(value)) n += 1;
  if (/[0-9]/.test(value)) n += 1;
  if (/[^A-Za-z0-9]/.test(value)) n += 1;
  return n;
}
function worthRedacting(value) {
  if (typeof value !== 'string' || value.length < SCRUB_MIN_LENGTH) return false;
  if (SCRUB_PLAIN_RE.test(value)) return false;
  if (value.length < 12 && characterClasses(value) < 3) return false;
  return true;
}

// ── Module state ───────────────────────────────────────────────────────────
let keypair = null; // { publicKey: Uint8Array, privateKey: Uint8Array }

/**
 * WHAT `scrub` REDACTS — `[{ name, value }]`, refilled by every env scan.
 *
 * THIS ARRAY CHANGED HANDS (2026-09-21), and the change is an IMPROVEMENT
 * rather than a salvage. It used to hold the vault's decrypted bundle: only
 * the values Flowviant itself had delivered to this box. With the vault gone
 * that array would be permanently empty and `scrub` would become a silent
 * no-op in roughly ten call sites — the worst possible way for a redactor to
 * stop working, because every one of those sites keeps calling it and nothing
 * looks different until a secret is already in the server's database.
 *
 * So it is filled from the CHECKOUT'S OWN `.env*` FILES, which are the box's
 * REAL secrets: the ones the operator pasted in from their providers, the ones
 * a dev server actually loads, and the ones a CLI turn is overwhelmingly
 * likeliest to echo into a log. The vault could only ever redact what it had
 * delivered; this redacts what is there.
 *
 * ── TWO SOURCES, KEPT IN TWO VARIABLES (2026-09-21, the review) ──
 *
 * `values` is what `scrub` reads and is rebuilt on every scan as
 * `processEnvSecrets()` ++ `fileValues`. The split exists because the two halves
 * have opposite failure modes. The CHECKOUT half can come back empty for two
 * different reasons — the operator deleted `.env`, or this pass could not read
 * the directory — so an empty read must NOT replace it (see `scanEnvForScrub`).
 * The PROCESS half cannot blink: `process.env` is in memory and reading it is
 * infallible, so it is replaced unconditionally, and folding it into one array
 * with the file half would make a single unreadable-directory blip drop the
 * operator's deploy credential out of the redactor too.
 *
 * SEEDED AT IMPORT, deliberately. `scrub` is reachable from the deploy lane and
 * from a turn before the first scan has run, and the process half needs no
 * checkout, no credential and no I/O to be correct — so there is no moment at
 * which this module knows a deploy token and is not hiding it.
 *
 * AND IT IS ALREADY FILTERED. Every entry in `values` has passed
 * `worthRedacting` — see that predicate's block above — so `scrub` itself makes
 * no decisions and simply replaces. `fileValues` keeps the UNFILTERED read,
 * because the filter is about redaction and the read is about what is on disk.
 */
let fileValues = [];
let values = processEnvSecrets().filter((v) => worthRedacting(v.value));

export async function sodiumReady() {
  await sodium.ready;
}

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

// ── The env comparison scan ────────────────────────────────────────────────

/**
 * THE BOUNDS, as local literals.
 *
 * They mirror the server's own report schema (`packages/shared` — the env
 * report's zod parse), and they are DUPLICATED here on purpose rather than
 * imported: this package ships to npm on its own and has no path to the
 * monorepo's shared types. The daemon holds its own line for the same reason
 * every other boundary in this file does — a report that the server will
 * reject is a report nobody sees, and clamping here is what makes the
 * difference visible as a smaller list rather than a 400.
 *
 * ── THE REPORT'S CAPS ARE NOT THE SCRUBBER'S, AND THAT ASYMMETRY IS
 *    DELIBERATE (2026-09-21, the review) ──
 *
 * `MAX_ENV_FILES` / `MAX_ENV_VARS` bound what goes ON THE WIRE, because a
 * comparison screen is a thing a person reads and a 4000-row list answers
 * nothing. `MAX_SCRUB_VALUES` bounds what this box KNOWS TO HIDE, and it is an
 * order of magnitude larger because redaction has no wire cost, no render cost
 * and no reader. A secret dropped for being the 201st variable in the checkout
 * is a secret in the server's database — the report's economy must never be
 * allowed to decide that. The scrub list is still bounded, because an
 * unbounded `split`/`join` loop over a stream is a real cost; 2000 is a number
 * no honest checkout reaches.
 *
 * `MAX_SCAN_FILES` is the read bound that makes `filesTotal`/`varsTotal`
 * affordable: every `.env*` name in the root is COUNTED, and the first 64 are
 * actually read, so the totals are honest about a directory somebody has let
 * grow without this scan walking an unbounded list of files on the poll's beat.
 */
const MAX_ENV_FILES = 8;
const MAX_ENV_VARS = 200; // TOTAL across every file, not per file — REPORT only
const MAX_ENV_NAME_CHARS = 64;
const MAX_ENV_FILE_BYTES = 256 * 1024;
const MAX_SCAN_FILES = 64;
const MAX_SCRUB_VALUES = 2000;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** `.env`, `.env.local`, `.env.production` … and never a template. A file whose
 *  name ends `.example` / `.sample` / `.template` is somebody's DOCUMENTATION
 *  of the shape, committed on purpose, and its "values" are placeholders — so
 *  it would fingerprint `your-key-here` on every box and report them as
 *  agreeing, which is the exact opposite of what a comparison is for. */
const isEnvFileName = (name) =>
  (name === '.env' || name.startsWith('.env.')) &&
  !/\.(example|sample|template)$/i.test(name);

/**
 * ONE LINE OF DOTENV. Blank lines and `#` comments are skipped, an optional
 * `export ` prefix is allowed, the line is split on the FIRST `=` (a value may
 * contain any number of them), key and value are trimmed, and ONE matching pair
 * of surrounding quotes is stripped. A line with no `=` is skipped rather than
 * guessed at; `null` means "this is not a variable".
 *
 * ── WHAT "PARSED THE WAY EVERY DOTENV PARSER DOES" USED TO GLOSS OVER, AND
 *    WHAT THE REAL RULES ARE (2026-09-21, the review) ──
 *
 * 1. AN INLINE COMMENT IS NOT PART OF THE VALUE. `PORT=3000 # dev server`
 *    loads as `3000` everywhere, and this parser kept ` # dev server`. Two
 *    consequences, both wrong in the direction that matters: the FINGERPRINT
 *    then depended on somebody's comment, so two boxes running the identical
 *    port disagreed on the one screen whose whole job is to say whether they
 *    agree; and the scrub list held a value that never occurs in any log, so
 *    the real one was not redacted. Inside a QUOTED value a `#` is literal
 *    (`PASS="a#b"` is `a#b`), and the quoted branch below never looks for one.
 *
 *    DELIBERATELY NARROWER THAN dotenv v16 ON ONE POINT, and it is stated
 *    rather than hidden: dotenv's unquoted value group is `[^#\r\n]+`, so
 *    `PASS=a#b` loads as `a`. Here a `#` only begins a comment when it is at
 *    the start or preceded by WHITESPACE. An unquoted password containing `#`
 *    is an ordinary thing for an operator to paste, and cutting it would
 *    produce exactly the two failures above — a fingerprint of a value nobody
 *    holds, and a redaction that misses the secret. Keeping too much is the
 *    safe direction for both halves of this module; inventing a shorter value
 *    is not.
 *
 * 2. A QUOTED VALUE MAY NOT END ON THIS LINE, and that was a BLOCKER. An RSA
 *    private key pasted into `.env` as
 *
 *        KEY="-----BEGIN RSA PRIVATE KEY-----
 *        MIIEpAIBAAKCAQEA...
 *        -----END RSA PRIVATE KEY-----"
 *
 *    was parsed a line at a time, so the variable's "value" was the header
 *    line. Every RSA key on every box then fingerprinted to the same eight
 *    characters, which made the comparison screen state that two DIFFERENT
 *    private keys agree — a readout whose only job is to answer "do these
 *    boxes match" answering it backwards. Worse, `scrub` was handed the header
 *    instead of the key, so the actual key body was NOT redacted out of turn
 *    traces or deploy logs.
 *
 *    The fix is the file's own rule applied honestly: a value we cannot read
 *    correctly is reported as NOTHING, never as a wrong fingerprint — the same
 *    call an over-long name gets ("a cut name is a DIFFERENT VARIABLE"). So an
 *    unterminated quote returns `{ name, unterminated }` and the caller DROPS
 *    the variable from both halves and consumes forward to the closing quote,
 *    so the key's own body lines are never mistaken for variables of their own.
 *    That forward skip is not cosmetic: base64 carries `=` padding and a body
 *    line can perfectly well contain `A=B`, which this parser would otherwise
 *    read as a variable whose value is a slice of somebody's private key.
 *
 *    THE COST IS NAMED: a legitimately multi-line value is invisible to the
 *    comparison AND unredacted. Reading it properly means a stateful parser
 *    that also has to decide what `\n` escaping means per dialect, and getting
 *    that subtly wrong reproduces exactly the bug above. Silence is the honest
 *    answer until somebody asks for the feature.
 */
function parseEnvLine(raw) {
  const line = raw.trim();
  if (!line || line.startsWith('#')) return null;
  const eq = line.indexOf('=');
  if (eq <= 0) return null;
  const name = line.slice(0, eq).trim().replace(/^export\s+/, '');
  const rest = line.slice(eq + 1).trim();
  const quote = rest[0];
  if (quote === '"' || quote === "'") {
    const close = rest.indexOf(quote, 1);
    // No closing quote ON THIS LINE. We know the name and we do not know the
    // value; saying so is the whole contract.
    if (close < 0) return { name, unterminated: quote };
    // Anything after the closing quote is a comment or stray text, and a `#`
    // INSIDE the quotes is part of the value.
    return { name, value: rest.slice(1, close) };
  }
  const hash = rest.search(/(?:^|\s)#/);
  return { name, value: hash < 0 ? rest : rest.slice(0, hash).trimEnd() };
}

/**
 * WHERE A MULTI-LINE QUOTED VALUE ENDS — the index of the line holding its
 * closing quote, or the end of the file if there is none.
 *
 * Deliberately the cheap shape: the first line containing that quote character
 * closes it. An escaped quote inside the body would end it early, which cuts
 * the skip short and lets a few body lines be looked at again — and those lines
 * are dropped anyway, because `ENV_NAME_RE` refuses every name a base64 or PEM
 * body can produce. Under-skipping degrades to the old behaviour on a line or
 * two; over-skipping would silently eat real variables after the key, which is
 * the failure worth avoiding.
 *
 * An unterminated quote that runs to EOF consumes the rest of the file, which
 * is what a shell and a dotenv loader both effectively do with one.
 */
function closingQuoteLine(lines, start, quote) {
  for (let i = start + 1; i < lines.length; i++) if (lines[i].includes(quote)) return i;
  return lines.length;
}

/**
 * A VALUE FINGERPRINT — sha256 over `<projectId>\n<value>`, first 8 hex
 * characters.
 *
 * THE VALUE NEVER LEAVES THE BOX. The whole question the owner asked is
 * comparative — "show the env of each of the machines (for comparison)" — and
 * a comparison needs only to know whether two boxes hold the SAME thing, which
 * a fingerprint answers and a value answers no better. Sending the value would
 * rebuild, on a plainer wire, the exact custody problem the vault was deleted
 * to be rid of.
 *
 * ── IT IS SALTED PER PROJECT (2026-09-21, the review), BECAUSE AN UNSALTED
 *    TRUNCATED HASH OVER A LOW-ENTROPY VALUE IS A DICTIONARY ORACLE ──
 *
 * The first cut hashed the value alone. Half of a real `.env` is drawn from a
 * vocabulary of a few hundred strings — `true`, `false`, `3000`, `8080`,
 * `development`, `production`, `postgres`, `localhost`, `info` — so anybody who
 * could read a stored report could recover those values with one precomputed
 * table, and the eight characters that were chosen to be uninformative became
 * a lookup key instead. Salting with the project id makes the table worthless
 * without knowing which project it is for, and makes it per-project even then.
 *
 * IT COSTS THE FEATURE NOTHING, and that is what makes the trade obvious: the
 * screen compares the BOXES OF ONE PROJECT. Two projects agreeing on a value is
 * not a question anybody has asked, is not rendered anywhere, and is stated
 * here as NOT A FEATURE so that a later "why don't these match" has an answer
 * in the file rather than a bug report.
 *
 * Eight hex characters is 32 bits — a birthday collision at a few tens of
 * thousands of distinct values, which no single project's env is — and it stays
 * deliberately SHORT so nobody mistakes it for a commitment to the value.
 */
const fingerprint = (salt, value) =>
  createHash('sha256').update(`${salt}\n${value}`, 'utf8').digest('hex').slice(0, 8);

/**
 * READ THE CHECKOUT'S `.env*` FILES AND REPORT WHAT IS IN THEM BY NAME.
 *
 * Returns
 * `{ files: [{ file, vars: [{ name, fp }] }], filesTotal, varsTotal, values }`
 * — `files` + the two totals are the REPORT (names and fingerprints, safe to
 * send) and `values` is what stays here and feeds `scrub`. The two are
 * separated at the type level rather than by a filter at the call site, because
 * the one mistake that would matter here is a value riding the report, and a
 * caller that has to remember to strip something will eventually not.
 *
 * ── THE TOTALS RIDE BESIDE THE CAPPED LISTS (2026-09-21, the review) ──
 *
 * `filesTotal` and `varsTotal` are the numbers BEFORE the report's caps, so the
 * app can say "N more not shown" instead of letting a list silently cut at
 * eight files read as the whole directory. That is the rule `repoState` already
 * keeps for branches and worktrees, and the rule the listeners panel learned
 * the hard way when `wrangler dev` opened nine sockets into a cap of eight: a
 * list cut without saying so answers "how much is in here" with a lie.
 *
 * ── THE SALT IS AN ARGUMENT, AND AN ABSENT ONE REPORTS NOTHING ──
 *
 * `salt` is the project id (see `fingerprint`). It is passed in rather than
 * read from config here so this function stays pure and provable from a temp
 * directory; `scanEnvForScrub` is the impure wrapper that defaults it.
 *
 * A box that cannot name its project — a credential handed in through
 * `FLOWVIANT_FLEET` with nothing in the store — reports NO FILES AT ALL rather
 * than fingerprints salted with something else. Incomparable fingerprints would
 * render as a confident `differs` beside a box that holds the identical value,
 * which is the readout asserting the opposite of the truth. Ignorance renders
 * nothing, the three-state rule this daemon keeps everywhere. THE SCRUB HALF IS
 * UNAFFECTED: `values` is filled whatever the salt is, because hiding a secret
 * needs no project id and a box with no report is not a box with no secrets.
 *
 * ── THE CHECKOUT ROOT ONLY, AND THAT BOUND IS DELIBERATE ──
 *
 * Not worktrees (a session's directory is a branch of this one, and reporting N
 * near-identical copies answers a question nobody asked), not subdirectories,
 * and not "every `.env*` git knows about". A monorepo genuinely does keep
 * `apps/api/.dev.vars` and friends, and this scan will not see them — that is
 * an accepted, stated limit rather than an oversight. Walking a tree to find
 * secret files is how a scan ends up reading `node_modules/**` on somebody's
 * laptop, and the root is where the overwhelming majority of the "it works on
 * my machine" difference actually lives. Widening it is a decision with an
 * argument, not a tweak.
 *
 * ── A SYMLINK IS NOT A FILE (2026-09-21, the review) ──
 *
 * `statSync` FOLLOWS a link, so `.env.link -> /proc/self/environ` was stat'd
 * and size-capped at its TARGET and then read: the scan would have reported the
 * daemon's own process environment — the machine credential among it — as this
 * checkout's variables, and `-> /etc/shadow` or a link onto a multi-gigabyte
 * file elsewhere are the same gesture. `lstatSync` + `isFile()` refuses every
 * one of them without needing to reason about where any of them point. The
 * argument is one line: this scan reads THE CHECKOUT, and a link is an
 * instruction to read somewhere else. A checkout whose `.env` is genuinely a
 * symlink into a secrets directory reports nothing, which is the same silence
 * every other unreadable thing here produces.
 *
 * ── IT NEVER THROWS ──
 *
 * This runs on the poll's own beat. A per-file error contributes nothing and is
 * swallowed; an unreadable directory yields an empty report. Ignorance renders
 * nothing — a box that could not look reports no files, and the app's answer to
 * that is silence rather than "this machine has no env".
 */
export function scanEnvFiles(repoRoot, salt) {
  const out = { files: [], filesTotal: 0, varsTotal: 0, values: [] };
  if (!repoRoot || typeof repoRoot !== 'string') return out;
  let names;
  try {
    names = readdirSync(repoRoot).filter(isEnvFileName).sort();
  } catch {
    return out; // unreadable checkout — say nothing rather than say "none"
  }
  out.filesTotal = names.length;
  const canReport = typeof salt === 'string' && salt.length > 0;
  let budget = MAX_ENV_VARS;
  for (const name of names.slice(0, MAX_SCAN_FILES)) {
    try {
      const abs = join(repoRoot, name);
      // The cap is checked against the LSTAT before the read, so a stray binary
      // named `.env.bin` — or a log somebody redirected into `.env.out` — is
      // never slurped into memory at all. A directory called `.env.d` is not a
      // file and contributes nothing, and neither is a SYMLINK: see above.
      const st = lstatSync(abs);
      if (!st.isFile() || st.size > MAX_ENV_FILE_BYTES) continue;
      // A MAP, because LAST WRITE WINS inside one file — which is how a dotenv
      // loader resolves a repeated key, so the fingerprint reported is the one
      // actually in force. It also makes the totals honest: a file that sets
      // the same key forty times counts once, not forty times.
      const byName = new Map();
      const lines = readFileSync(abs, 'utf8').split('\n');
      for (let i = 0; i < lines.length; i++) {
        const parsed = parseEnvLine(lines[i]);
        if (!parsed) continue;
        // A VALUE WE CANNOT READ IS REPORTED AS NOTHING. The variable is
        // dropped from BOTH halves and the scan steps over its continuation
        // lines, so a PEM body can never be read as variables of its own.
        if (parsed.unterminated) {
          i = closingQuoteLine(lines, i, parsed.unterminated);
          continue;
        }
        // A NAME THAT FAILS EITHER TEST IS DROPPED, NEVER TRUNCATED: a cut name
        // is a DIFFERENT VARIABLE, and a comparison screen rendering two boxes'
        // truncated names as the same row is worse than rendering neither.
        if (parsed.name.length > MAX_ENV_NAME_CHARS) continue;
        if (!ENV_NAME_RE.test(parsed.name)) continue;
        if (!byName.has(parsed.name) && byName.size >= MAX_SCRUB_VALUES) continue;
        byName.set(parsed.name, parsed.value);
      }
      out.varsTotal += byName.size;
      // Decided BEFORE this file spends any budget, so `budget` reaching zero
      // inside a file still lets that file's own entry carry what it got.
      const reporting = canReport && budget > 0 && out.files.length < MAX_ENV_FILES;
      const vars = [];
      for (const [n, value] of byName) {
        // THE SCRUB LIST IS NOT BOUNDED BY THE REPORT'S CAPS — see the bounds
        // block above. A secret dropped for being the 201st is a secret in the
        // server's database.
        if (out.values.length < MAX_SCRUB_VALUES) out.values.push({ name: n, value });
        if (reporting && budget > 0) {
          vars.push({ name: n, fp: fingerprint(salt, value) });
          budget -= 1;
        }
      }
      if (reporting) out.files.push({ file: name, vars });
    } catch {
      /* an unreadable file contributes nothing — never a thrown poll */
    }
  }
  return out;
}

/**
 * Run a scan and hand its values to the scrubber. Returns the REPORT half —
 * `{ files, filesTotal, varsTotal }`, the body `/fleet/env-report` posts.
 *
 * Separated from `scanEnvFiles` so the scan itself stays pure and testable: the
 * only impure things about this whole lane are one module-level assignment and
 * one read of `process.env`, and both live here where they can be read in four
 * lines.
 *
 * THE SCRUBBER IS FED WHETHER OR NOT THE REPORT IS SENT. The report is deduped
 * against its own hash and posted at most once per change; redaction has no
 * such economy and must reflect the newest read every time, because a secret
 * added to `.env` five minutes ago is exactly the one a turn is about to echo.
 *
 * THE PROCESS ENVIRONMENT'S INFRA CREDENTIALS ARE MERGED IN HERE, and here is
 * the point: this is the one function every caller already goes through, so the
 * two lists cannot drift and nobody has to remember. They are derived from
 * `childEnv`'s own `DEPLOY_KEEP`, which is the set a deploy command is actually
 * handed — see `processEnvSecrets` for why they are redacted and never
 * reported. They are re-read on every scan rather than frozen at import,
 * because that costs nothing and an environment read once is a list that can
 * only be wrong.
 *
 * AN EMPTY READ DOES NOT CLEAR WHAT WE ALREADY KNOW, and this is the one place
 * the two halves deliberately disagree. A scan that comes back with nothing is
 * two different facts wearing one shape — the operator deleted `.env`, or this
 * pass could not read the directory (EACCES, a mid-sweep rename, a network
 * mount that blinked) — and `scanEnvFiles` swallows per-file errors by design
 * so the poll cannot throw. Replacing the list on an empty read means a blip
 * silently turns the redactor OFF, which is the exact failure mode the whole
 * repoint above exists to avoid, and it is invisible until a secret is already
 * in the server's database. Hence the separate `fileValues`: the process half
 * is refreshed unconditionally (process.env does not blink) while the file half
 * is only ever replaced by a read that found something.
 *
 * So an empty read leaves the previous list standing. The cost is
 * OVER-redaction — a value the operator has since removed or rotated keeps
 * being replaced with `[REDACTED:NAME]` for the life of this process — and
 * over-redacting is the safe direction, the same one every three-state readout
 * in this daemon takes. The REPORT half is unaffected: it returns the real
 * (empty) read, so the app is told what was actually measured.
 */
export function scanEnvForScrub(repoRoot, salt = PROJECT_ID) {
  const scanned = scanEnvFiles(repoRoot, salt);
  if (scanned.values.length) fileValues = scanned.values;
  // FILTERED ONCE, HERE — see the predicate's own block above: `scrub` is a hot
  // path and a value that can never match must not survive into its loop.
  values = [...processEnvSecrets(), ...fileValues].filter((v) => worthRedacting(v.value));
  return { files: scanned.files, filesTotal: scanned.filesTotal, varsTotal: scanned.varsTotal };
}

// ── Uplink scrubbing ───────────────────────────────────────────────────────

/** Redact every known secret value from daemon-posted text. The list has
 *  already been through `worthRedacting`, so this makes no decisions: an
 *  ordinary word, a short flag and anything under the length floor are simply
 *  not in it. */
export function scrub(text) {
  if (typeof text !== 'string' || !text || !values.length) return text;
  let out = text;
  for (const v of values) out = out.split(v.value).join(`[REDACTED:${v.name}]`);
  return out;
}

/**
 * The NAME of the first known secret whose value appears in `bytes` as an
 * exact byte substring, or null. For the payloads `scrub` cannot touch: a
 * binary artifact (a PNG's text chunk, a PDF's uncompressed stream, a zip's
 * stored entry) is not text to rewrite — replacing bytes inside one corrupts
 * it — so the caller WITHHOLDS a hit rather than redacting it. The same list,
 * already filtered by `worthRedacting`, so the two can never disagree about
 * what counts as a secret. It sees only what is stored plainly: a value inside
 * a deflated stream is not a substring of the file, and that is stated where
 * it is used (artifacts.mjs).
 */
export function secretIn(bytes) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || !values.length) return null;
  for (const v of values) if (bytes.includes(v.value, 0, 'utf8')) return v.name;
  return null;
}
