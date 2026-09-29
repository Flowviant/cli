/**
 * THE ENV COMPARISON SCAN — and nothing this box holds for anybody.
 *
 * `scanEnvFiles()` reads the checkout's own `.env*` files and reports variable
 * NAMES plus a short VALUE FINGERPRINT SALTED WITH THE PROJECT ID, so the app
 * can answer "why does it work on that box and not this one?" without an
 * eight-character hash over `production` becoming a dictionary lookup. THE
 * VALUE NEVER LEAVES THE BOX. The values it read are handed to the uplink
 * scrubber (`uplinkScrub.mjs`, through `learnSecrets`) and go no further — a
 * report is a statement about the CHECKOUT'S FILES, and neither the values nor
 * this process's environment are part of one.
 *
 * ── ONE OF THREE (2026-09-26, the SOLID pass) ──
 *
 * This file used to hold three things: the BOX KEYPAIR (now `boxIdentity.mjs`
 * — `envpub`, holdership, the registry row), the UPLINK SCRUBBER (now
 * `uplinkScrub.mjs` — what every posted line is redacted against), and this
 * scan. They shared a file because all three were what the vault below left
 * standing, not because they change together: an identity rule, a redaction
 * policy and a dotenv parser have three different reasons to be edited. The
 * scan keeps the file's name because it is the one that is about the env.
 *
 * WHERE THE SCRUBBER IS FED — settled, not a leftover: `scanEnvForScrub` calls
 * `learnSecrets` itself instead of each poll site doing it. There are two such
 * sites (the 60s report beat in `fleetReports.mjs`, the pre-first-poll feed in
 * `fleet.mjs`), and a scan whose values a caller forgets to hand over is a
 * secret that stops being redacted — the same "no call site has to remember" argument that put the
 * process-env join inside `learnSecrets`. The dependency runs one way (this
 * file knows the scrubber's one door; the scrubber knows nothing of `.env`),
 * and `scanEnvFiles` stays the pure half every parser test drives.
 *
 * ── THE VAULT IS DELETED (2026-09-21) ──
 *
 * This module used to be the CRYPTO ANCHOR of an end-to-end-encrypted team
 * secrets vault: the project's private key reached this box sealed to the
 * box keypair (`boxIdentity.mjs` now), the daemon opened every value, cached
 * them encrypted on disk, MATERIALIZED `.env` files into every session
 * worktree, executed wrap jobs for
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
 * correctness rule — all of it in `boxIdentity.mjs` now, which carries the
 * argument.
 *
 * `excludeInWorktree` moved to `git.mjs`: it is a generic `git info/exclude`
 * helper that only ever lived here because the materializer was its first
 * caller.
 */

import { readdirSync, readFileSync, lstatSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
// THE PROJECT ID, as a live binding. It salts every fingerprint (see
// `fingerprint`), and it is a `let` in config.mjs because startProject.mjs's ambiguity
// picker chooses a project AFTER import — reading a frozen copy here would salt
// a picked project's report with `null` and report nothing at all.
import { PROJECT_ID } from './config.mjs';
// THE SCRUBBER'S ONE DOOR. The scan reads the checkout; `uplinkScrub.mjs`
// decides what of it to hide. They meet at this call and nowhere else.
import { learnSecrets } from './uplinkScrub.mjs';

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
 * only impure things about this whole lane are the scrubber's rebuild and one
 * read of `process.env`, and both live behind `learnSecrets`
 * (`uplinkScrub.mjs`), which carries why the process environment is merged in
 * and why an empty read does not clear what the scrubber already knows.
 *
 * THE SCRUBBER IS FED WHETHER OR NOT THE REPORT IS SENT. The report is deduped
 * against its own hash and posted at most once per change; redaction has no
 * such economy and must reflect the newest read every time, because a secret
 * added to `.env` five minutes ago is exactly the one a turn is about to echo.
 *
 * THE REPORT HALF IS THE REAL READ: an empty scan returns an empty report even
 * while the scrubber keeps what it knew, so the app is told what was actually
 * measured.
 */
export function scanEnvForScrub(repoRoot, salt = PROJECT_ID) {
  const scanned = scanEnvFiles(repoRoot, salt);
  learnSecrets(scanned.values);
  return { files: scanned.files, filesTotal: scanned.filesTotal, varsTotal: scanned.varsTotal };
}
