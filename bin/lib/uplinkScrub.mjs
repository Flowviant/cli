/**
 * THE UPLINK SCRUBBER — what this daemon hides from every piece of text it
 * posts, and the one thing in this file.
 *
 * `scrub()` redacts secret values out of every piece of text this daemon posts
 * — turn streams, tool events, the trace, process command lines, wiki
 * progress, deploy logs — and `secretIn()` finds them inside the bytes it
 * cannot rewrite. It is fed from TWO places (2026-09-21, the review): the
 * checkout's `.env*` files (`env.mjs`'s scan hands them to `learnSecrets`), and
 * the PRESENT values of `childEnv`'s `DEPLOY_KEEP` names out of this process's
 * own environment, which is where an operator's `CLOUDFLARE_API_TOKEN`
 * actually lives and which the deploy lane hands to a command whose stdout it
 * then streams to the server. It redacts on SHAPE, never on meaning: a value
 * that looks like an ordinary word is left alone, because a relay that swaps
 * the CLI's own words for `[REDACTED:NODE_ENV]` has stopped being a relay.
 * NOTHING HERE EVER REACHES THE WIRE — it is a list of what to hide, not a
 * report.
 *
 * SPLIT OUT OF `env.mjs` (2026-09-26, the SOLID pass). That module held three
 * things with three unrelated reasons to change — the box keypair
 * (`boxIdentity.mjs`), the env comparison scan (still `env.mjs`), and this
 * redaction policy — and a change to what counts as a secret had to be made in
 * the same file as the dotenv parser and the identity mint. The scan now owns
 * READING the checkout; this module owns DECIDING what to hide and hiding it,
 * and the two meet at exactly one call, `learnSecrets`.
 */

// THE DEPLOY LANE'S OWN ALLOWLIST, borrowed for REDACTION ONLY. Deriving the
// scrub list from the set a deploy command is actually handed is what stops the
// two drifting; `processEnvSecrets`'s docblock carries the whole argument,
// including why none of it ever reaches the wire.
import { processEnvSecrets } from './childEnv.mjs';

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
  // THE PLAIN-IDENTIFIER EXEMPTION DOES NOT COVER A CASE-AND-DIGIT MIX
  // (2026-09-24, the audit). It was checked first and alone, so a generated
  // password — `Tq8vZ2mKp4Lx9RbN`, the `pwgen -s 16` shape, or a twelve-
  // character `Hx93kPq2Lm7w` — starts with a letter, fits sixteen characters of
  // [A-Za-z0-9] and was left in plain text everywhere this daemon posts, against
  // this block's own promise that "a case mix" is redacted. A word, a hostname,
  // a region or a version string does not draw on upper, lower AND digits at
  // once; a minted secret almost always does.
  if (SCRUB_PLAIN_RE.test(value) && !(/[a-z]/.test(value) && /[A-Z]/.test(value) && /[0-9]/.test(value))) {
    return false;
  }
  if (value.length < 12 && characterClasses(value) < 3) return false;
  return true;
}

// ── Module state ───────────────────────────────────────────────────────────

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
 * the directory — so an empty read must NOT replace it (see `learnSecrets`).
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

/**
 * HAND THE SCRUBBER A FRESH READ OF THE CHECKOUT'S `.env*` VALUES —
 * `[{ name, value }]`, unfiltered, exactly as `scanEnvFiles` returns them — and
 * rebuild the list `scrub` reads.
 *
 * THE PROCESS ENVIRONMENT'S INFRA CREDENTIALS ARE MERGED IN HERE, and here is
 * the point: this is the one function every scan already goes through, so the
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
 * in this daemon takes. The REPORT half is the scan's, and is unaffected: it
 * returns the real (empty) read, so the app is told what was actually measured.
 */
export function learnSecrets(scannedValues) {
  if (scannedValues.length) fileValues = scannedValues;
  // FILTERED ONCE, HERE — see the predicate's own block above: `scrub` is a hot
  // path and a value that can never match must not survive into its loop.
  values = [...processEnvSecrets(), ...fileValues].filter((v) => worthRedacting(v.value));
}

// ── Uplink scrubbing ───────────────────────────────────────────────────────

/** Redact every known secret value from daemon-posted text. The list has
 *  already been through `worthRedacting`, so this makes no decisions: an
 *  ordinary word, a short flag and anything under the length floor are simply
 *  not in it. */
export function scrub(text) {
  if (typeof text !== 'string' || !text) return text;
  let out = text;
  for (const v of values) out = out.split(v.value).join(`[REDACTED:${v.name}]`);
  return out.replace(FLOWVIANT_TOKEN_RE, `[REDACTED:${FLOWVIANT_TOKEN_NAME}]`);
}

/**
 * EVERY FLOWVIANT CREDENTIAL, CAUGHT BY SHAPE (2026-09-24, the audit).
 *
 * The value lists above are the CHECKOUT'S secrets and the process
 * environment's, and neither holds the one secret that costs the project
 * itself: the MACHINE CREDENTIAL. It sits in `~/.flowviant/credentials.json` —
 * for EVERY project connected on this box, 0600 and readable by every turn,
 * since a turn runs as this uid — and the server mints more of the same shape
 * per turn (the work and capture tokens a tab's MCP server carries). A turn
 * that read the store and wrote it into an artifact, a trace or an answer
 * shipped it verbatim, because `scrub` had no value to match; and a design
 * artifact runs scripts in a frame that may navigate itself, so the page that
 * held it could carry it anywhere.
 *
 * Every one of them is `fva_` + 40 characters of nanoid (the server's
 * `AGENT_TOKEN_PREFIX`), so a SHAPE catches them all, including ones this
 * process never saw, with no store read and nothing to keep in sync. Twenty is
 * the floor so the 12-character prefix the app shows for identification
 * (`fva_` + 8) still reads as itself.
 */
const FLOWVIANT_TOKEN_RE = /fva_[A-Za-z0-9_-]{20,}/g;
const FLOWVIANT_TOKEN_NAME = 'FLOWVIANT_TOKEN';

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
  if (!Buffer.isBuffer(bytes) || !bytes.length) return null;
  for (const v of values) if (bytes.includes(v.value, 0, 'utf8')) return v.name;
  // The token SHAPE too (see `scrub`). `latin1` maps every byte to one
  // character, so the ASCII pattern matches exactly where the bytes do.
  if (bytes.includes('fva_') && new RegExp(FLOWVIANT_TOKEN_RE.source).test(bytes.toString('latin1'))) {
    return FLOWVIANT_TOKEN_NAME;
  }
  return null;
}
