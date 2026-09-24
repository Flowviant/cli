/**
 * THE BOX KEYPAIR AND THE ENV COMPARISON SCAN — what is left of env.mjs after
 * the secrets vault was deleted (2026-09-21).
 *
 * This file used to pin the MATERIALIZATION boundary: a hostile `targetFile` in
 * the on-disk cache reaching `rmSync`, a value sealed to `.git/hooks/pre-commit`
 * becoming code git runs, the recovery passphrase printing exactly once ever,
 * and the register branch's instructions. All of it went with the vault, on the
 * owner's ruling — *"no i dont want it. unless its needed where i want to show
 * the env of each of the machines (for comparison)"* — and none of those tests
 * were kept as fossils: a test over deleted code is either red or, worse,
 * green over nothing, which is the inert-pin class this product has caught
 * repeatedly.
 *
 * TWO THINGS SURVIVED, and they survived for opposite reasons. The keypair is
 * the BOX'S DURABLE IDENTITY — holdership arbitration and the machine registry
 * both key on `envpub` — so its correctness rule is more load-bearing now than
 * it was when the vault stood on it, not less. The scan is NEW, and it is what
 * the owner's carve-out asked for.
 *
 * Run: node --test bin/lib/env.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// HOME must move BEFORE env.mjs computes its keypair path at import — this test
// writes a keypair and must never touch the real one.
const HOME = mkdtempSync(join(tmpdir(), 'fv-envhome-'));
process.env.HOME = HOME;

const env = await import('./env.mjs');
await env.ensureKeypair();

const MODULE = join(process.cwd(), 'bin/lib/env.mjs');

/** A scratch directory standing in for a checkout root. */
function checkout(files) {
  const dir = mkdtempSync(join(tmpdir(), 'fv-envscan-'));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}

/**
 * A STAND-IN PROJECT ID. Every fingerprint is salted with the project id
 * (2026-09-21) — an unsalted truncated hash over `true` or `3000` is a
 * dictionary lookup — so the tests name one explicitly rather than depending on
 * whatever credential happens to be stored on the machine running them. That is
 * also why `scanEnvFiles` takes the salt as an argument at all.
 */
const SALT = 'proj-0123456789ab';
const fpOf = (v, salt = SALT) =>
  createHash('sha256').update(`${salt}\n${v}`, 'utf8').digest('hex').slice(0, 8);

// ── the box keypair ─────────────────────────────────────────────────────────

/**
 * A KEYPAIR WE CANNOT READ IS NOT A KEYPAIR WE MAY REPLACE (2026-09-14).
 *
 * `ensureKeypair` read the file inside a bare catch commented "first run", so
 * EVERY failure — a truncated file, bad JSON, EACCES — was treated as a first
 * run and the box silently MINTED A NEW IDENTITY over the old one.
 *
 * THE VAULT'S HALF OF THAT ARGUMENT IS GONE AND THE OTHER HALF IS NOT. The
 * project's private key used to be sealed to this keypair, which was the loud
 * consequence; with the vault deleted what remains is the one that actually
 * runs every day — since holdership (2026-09-14) `envpub` is what tells two
 * computers apart, and since the box registry (0.91.0) it is the key of this
 * box's row. Re-keying means the same physical box arrives at the roster as a
 * stranger and stands itself down as a standby of itself for the whole claim
 * window.
 *
 * Only ENOENT is a first run. Anything else throws, and the one caller that has
 * to survive it already does: `envQueryParams` is wrapped in the poll, so the
 * poll simply carries no `envpub` — the documented EXEMPT arm, reached honestly
 * instead of by re-keying the box every restart.
 *
 * A subprocess, because the module memoizes the keypair after its first read.
 */
test('a corrupt keypair is refused, never overwritten', () => {
  const home = mkdtempSync(join(tmpdir(), 'fv-corrupt-'));
  const path = join(home, '.flowviant', 'env-keypair.json');
  mkdirSync(join(home, '.flowviant'), { recursive: true });
  writeFileSync(path, '{"pub":"AAA');

  let threw = false;
  try {
    execFileSync(
      process.execPath,
      ['-e', 'const e = await import(process.argv[1]); await e.ensureKeypair();', MODULE],
      { env: { ...process.env, HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] }
    );
  } catch {
    threw = true;
  }
  assert.ok(threw, 'an unreadable keypair must fail rather than mint a new identity');
  assert.equal(readFileSync(path, 'utf8'), '{"pub":"AAA', 'the file must be exactly as it was');

  // …and the ENOENT half still works: an empty home IS a first run.
  const fresh = mkdtempSync(join(tmpdir(), 'fv-fresh-'));
  execFileSync(
    process.execPath,
    ['-e', 'const e = await import(process.argv[1]); await e.ensureKeypair();', MODULE],
    { env: { ...process.env, HOME: fresh }, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  assert.ok(existsSync(join(fresh, '.flowviant', 'env-keypair.json')), 'a first run still mints one');
});

/**
 * THE FILE DOES NOT MOVE, AND `envpub` IS THE SAME VALUE IT ALWAYS WAS.
 *
 * The vault deletion rewrote this module top to bottom, and the one thing a
 * rewrite of a crypto module is likeliest to do casually is tidy the path or
 * the shape of the file it reads. Either would re-key every box in existence on
 * upgrade: a new row in the machine registry, a lost holdership, and a daemon
 * standing by against itself. So the path and the shape are pinned as facts,
 * not as implementation detail.
 */
test('the keypair lives where it always did, and envpub is read from it', async () => {
  const stored = JSON.parse(readFileSync(join(HOME, '.flowviant', 'env-keypair.json'), 'utf8'));
  assert.equal(typeof stored.pub, 'string');
  assert.equal(typeof stored.priv, 'string');
  assert.equal(env.readStoredPubB64(), stored.pub, 'the stored pub is what the reader returns');
  assert.equal(env.myPubB64(), stored.pub, 'and what the live keypair reports');

  // THE POLL CARRIES THAT VALUE AND NOTHING ELSE. `envv` and `envskip` were
  // facts about the materializer and died with it; `envpub` did not change.
  const params = await env.envQueryParams();
  assert.deepEqual(Object.keys(params), ['envpub']);
  assert.equal(params.envpub, stored.pub);
});

/** THE VAULT IS GONE AS AN EXPORT SURFACE, not merely unused. A module that
 *  still exports `materializeInto` is a module somebody can call. */
test('nothing in the vault is exported any more', async () => {
  for (const name of [
    'handleRosterEnv',
    'materializeInto',
    'hasMaterialized',
    'loadCachedEnv',
    'fetchBundle',
    'deployCreds',
    'appSecretsFor',
    'stashRecoveryCode',
    'excludeInWorktree',
    'pubkeyEmoji',
  ]) {
    assert.equal(typeof env[name], 'undefined', `${name} must be deleted, not merely unused`);
  }
  // …and `excludeInWorktree` did not vanish, it MOVED: it is a generic
  // `git info/exclude` helper and work.mjs still hides `.flowviant/` with it.
  assert.equal(typeof (await import('./git.mjs')).excludeInWorktree, 'function');
});

// ── the env comparison scan ─────────────────────────────────────────────────

test('dotenv rules: comments, blanks, export, the first =, and one pair of quotes', () => {
  const dir = checkout({
    '.env': [
      '# a comment',
      '',
      '   ',
      'PLAIN=hello-world',
      'export EXPORTED=exported-value',
      'QUOTED="double quoted"',
      "SINGLE='single quoted'",
      'WITH_EQUALS=postgres://u:p@h/db?a=1&b=2',
      '  SPACED  =  padded-value  ',
      'NOT_A_VARIABLE_LINE',
      '=leading-equals-has-no-name',
    ].join('\n'),
  });
  const { files, values } = env.scanEnvFiles(dir, SALT);
  assert.equal(files.length, 1);
  assert.equal(files[0].file, '.env');
  const names = files[0].vars.map((v) => v.name);
  assert.deepEqual(names, [
    'PLAIN',
    'EXPORTED',
    'QUOTED',
    'SINGLE',
    'WITH_EQUALS',
    'SPACED',
  ]);

  const valueOf = (n) => values.find((v) => v.name === n)?.value;
  assert.equal(valueOf('EXPORTED'), 'exported-value', 'the export prefix is stripped from the NAME');
  assert.equal(valueOf('QUOTED'), 'double quoted', 'one pair of double quotes comes off');
  assert.equal(valueOf('SINGLE'), 'single quoted', 'and one pair of single quotes');
  // SPLIT ON THE FIRST `=`, never on every one: a database URL is the ordinary
  // case and cutting it at the second separator silently reports a different
  // secret than the one in the file.
  assert.equal(valueOf('WITH_EQUALS'), 'postgres://u:p@h/db?a=1&b=2');
  assert.equal(valueOf('SPACED'), 'padded-value');
});

/**
 * AN INLINE COMMENT IS NOT PART OF THE VALUE (2026-09-21, the review).
 *
 * `PORT=3000 # dev server` loads as `3000` in every dotenv implementation, and
 * this parser kept the comment. Both halves of the module were wrong as a
 * result, in the direction that matters most: the FINGERPRINT depended on
 * somebody's comment, so two boxes running the identical port disagreed on the
 * one screen whose entire job is to say whether they agree; and the scrub list
 * held a string that occurs in no log anywhere, so the real value went
 * unredacted.
 *
 * Inside QUOTES a `#` is literal, and that half must not regress either — a
 * password of `a#b` truncated to `a` is a wrong fingerprint AND an unredacted
 * secret, which is the same pair of failures one step further along.
 */
test('an inline comment is cut from an unquoted value, and is literal inside quotes', () => {
  const dir = checkout({
    '.env': [
      'PORT=3000 # dev server',
      'HOSTNAME=example.com  # trailing spaces too',
      'PASS="a#b"',
      'HASH_NO_SPACE=keep#this',
      'EMPTY_AFTER_HASH=#nothing',
    ].join('\n'),
  });
  const { files, values } = env.scanEnvFiles(dir, SALT);
  const valueOf = (n) => values.find((v) => v.name === n)?.value;
  assert.equal(valueOf('PORT'), '3000');
  assert.equal(valueOf('HOSTNAME'), 'example.com');
  // A QUOTED `#` IS PART OF THE VALUE.
  assert.equal(valueOf('PASS'), 'a#b');
  // DELIBERATELY NARROWER THAN dotenv v16, which cuts at ANY `#` in an
  // unquoted value and would load `keep`. An unquoted password containing `#`
  // is an ordinary paste, and inventing a shorter value produces a fingerprint
  // nobody holds and a redaction that misses the secret. Stated in the parser's
  // own docblock rather than left as a silent divergence.
  assert.equal(valueOf('HASH_NO_SPACE'), 'keep#this');
  assert.equal(valueOf('EMPTY_AFTER_HASH'), '');

  // AND THE FINGERPRINT IS THE COMMENT-FREE VALUE, which is the whole point:
  // the same port on two boxes must agree however either operator annotated it.
  const bare = env.scanEnvFiles(checkout({ '.env': 'PORT=3000\n' }), SALT);
  const fpOfName = (scan, n) => scan.files[0].vars.find((v) => v.name === n).fp;
  assert.equal(fpOfName({ files }, 'PORT'), fpOfName(bare, 'PORT'));
});

/**
 * A MULTI-LINE QUOTED VALUE IS REPORTED AS NOTHING (2026-09-21, the review) —
 * the BLOCKER this pass exists for.
 *
 * An RSA private key pasted into `.env` spans several lines inside one pair of
 * quotes. Parsed a line at a time, the variable's "value" was the PEM header —
 * which every RSA key on earth shares — so the comparison screen fingerprinted
 * two DIFFERENT private keys identically and reported the boxes as agreeing.
 * A readout whose only job is to answer "do these match" answering it
 * backwards. And `scrub` was handed the header rather than the key, so the key
 * BODY was not redacted out of turn traces or deploy logs.
 *
 * The rule applied is the file's own: a value we cannot read correctly is
 * reported as nothing, never as a wrong fingerprint. Both halves drop it, and
 * the scan consumes forward to the closing quote so the key's own body lines
 * cannot be read as variables of their own — base64 carries `=` padding and a
 * body line may perfectly well contain `A=B`.
 */
test('two different multi-line RSA keys report NOTHING, and neither body leaks', () => {
  const key = (seed) =>
    [
      '-----BEGIN RSA PRIVATE KEY-----',
      `MIIEpAIBAAKCAQEA${seed}wwwwwwwwwwwwwwwwwwwwwwwwwwwwww`,
      `A=B${seed}notavariableline`,
      `${seed}QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ==`,
      '-----END RSA PRIVATE KEY-----',
    ].join('\n');
  const body = (seed) =>
    ['APP_NAME=fixture', `PRIVATE_KEY="${key(seed)}"`, 'AFTER_THE_KEY=after-the-key-value'].join('\n');

  const one = env.scanEnvFiles(checkout({ '.env': body('AAAA') }), SALT);
  const two = env.scanEnvFiles(checkout({ '.env': body('ZZZZ') }), SALT);

  for (const scan of [one, two]) {
    const names = scan.files[0].vars.map((v) => v.name);
    // NEITHER A FINGERPRINT NOR A ROW. Reporting the header's hash is what made
    // two different keys read as one.
    assert.ok(!names.includes('PRIVATE_KEY'), 'a value we cannot read is reported as nothing');
    // …and the forward skip means no body line became a variable of its own.
    assert.deepEqual(names, ['APP_NAME', 'AFTER_THE_KEY'], 'the key body invents no variables');
    assert.ok(!scan.values.some((v) => v.name === 'PRIVATE_KEY'));
    assert.ok(
      !scan.values.some((v) => v.value.includes('-----BEGIN RSA PRIVATE KEY-----')),
      'the PEM header must not sit in the scrub list as if it were a secret'
    );
  }
  // THE FAILURE STATED AS A FACT: the two keys must not share a fingerprint,
  // and the only way to guarantee that is for neither to have one.
  const fpFor = (scan) => scan.files[0].vars.find((v) => v.name === 'PRIVATE_KEY');
  assert.equal(fpFor(one), undefined);
  assert.equal(fpFor(two), undefined);

  // AND `scrub` LEAKS NEITHER BODY — it never knew them, so there is nothing to
  // redact, and the assertion that matters is the other one: it must not have
  // taken the SHARED HEADER as a secret and started rewriting ordinary prose.
  env.scanEnvForScrub(checkout({ '.env': body('AAAA') }), SALT);
  const narration = 'the CLI printed -----BEGIN RSA PRIVATE KEY----- while reading the fixture';
  assert.equal(env.scrub(narration), narration, 'the shared header is not redacted out of prose');
  assert.match(env.scrub('after-the-key-value'), /REDACTED:AFTER_THE_KEY/, 'the ordinary vars still are');
});

/**
 * A SYMLINK IS NOT A FILE (2026-09-21, the review).
 *
 * `statSync` FOLLOWS a link, so the scan stat'd and size-capped `.env.link` at
 * its TARGET and then read it. `.env.link -> /proc/self/environ` would have put
 * the daemon's own process environment — the machine credential among it — on
 * the wire as this checkout's variables; `-> /etc/shadow`, or a link onto a
 * multi-gigabyte file elsewhere, are the same gesture with different damage.
 *
 * `lstatSync` + `isFile()` refuses every one without reasoning about where any
 * of them point. The argument is one line: this scan reads THE CHECKOUT, and a
 * link is an instruction to read somewhere else.
 */
test('a symlink in the checkout is never followed, reported, or scrubbed', () => {
  const outside = mkdtempSync(join(tmpdir(), 'fv-outside-'));
  const secretPath = join(outside, 'not-ours.env');
  writeFileSync(secretPath, 'STOLEN_FROM_OUTSIDE=outside-secret-value-1234\n');

  const dir = checkout({ '.env': 'REAL=real-value-in-the-checkout\n' });
  symlinkSync(secretPath, join(dir, '.env.link'));

  const { files, values } = env.scanEnvFiles(dir, SALT);
  assert.deepEqual(files.map((f) => f.file), ['.env'], 'the link contributes no file');
  assert.ok(!values.some((v) => v.name === 'STOLEN_FROM_OUTSIDE'));
  assert.ok(!JSON.stringify(files).includes('STOLEN_FROM_OUTSIDE'));

  // …and it never reaches the redactor either, which is the half that would be
  // invisible: a scrub list quietly holding another directory's values is a
  // list this box had no business reading.
  env.scanEnvForScrub(dir, SALT);
  const line = 'the value outside-secret-value-1234 was never ours to read';
  assert.equal(env.scrub(line), line);
  assert.match(env.scrub('real-value-in-the-checkout'), /REDACTED:REAL/);

  // A DANGLING link is the same answer — nothing, rather than a throw.
  const dangling = checkout({ '.env': 'A=1234567\n' });
  symlinkSync(join(tmpdir(), 'fv-nothing-here-at-all'), join(dangling, '.env.gone'));
  assert.deepEqual(env.scanEnvFiles(dangling, SALT).files.map((f) => f.file), ['.env']);
});

/**
 * THE FINGERPRINT IS SALTED PER PROJECT (2026-09-21, the review).
 *
 * An unsalted eight-character hash over a low-entropy value is a dictionary
 * oracle: half of a real `.env` is drawn from a vocabulary of a few hundred
 * strings — `true`, `3000`, `production`, `postgres`, `localhost` — so one
 * precomputed table recovers them from a stored report, and the eight
 * characters chosen precisely to be uninformative become the lookup key.
 *
 * It costs the feature nothing, which is what makes the trade obvious: the
 * screen compares the BOXES OF ONE PROJECT. Cross-project comparison is NOT a
 * feature and is stated as such, here and in the module.
 */
test('a fingerprint is 8 lowercase hex, is NOT the value, and is salted per project', () => {
  const dir = checkout({ '.env': 'API_KEY=sk-live-abcdef123456\n' });
  const { files, values } = env.scanEnvFiles(dir, SALT);
  const [v] = files[0].vars;
  assert.equal(v.name, 'API_KEY');
  assert.match(v.fp, /^[0-9a-f]{8}$/);
  assert.equal(v.fp, fpOf('sk-live-abcdef123456'));
  // THE UNSALTED HASH IS NOT WHAT SHIPS — pinned, because the regression is one
  // character of a template literal and nothing else would notice.
  assert.notEqual(
    v.fp,
    createHash('sha256').update('sk-live-abcdef123456', 'utf8').digest('hex').slice(0, 8)
  );

  // THE VALUE NEVER LEAVES THE BOX. The report half is names and fingerprints;
  // the value half is a separate return key that only `scrub` consumes. This
  // asserts over the SERIALIZED report, because the mistake that would matter
  // is a value riding along as some extra field nobody looked at.
  const wire = JSON.stringify({ files });
  assert.ok(!wire.includes('sk-live-abcdef123456'), 'no value may appear in the report');
  assert.equal(values[0].value, 'sk-live-abcdef123456', 'but it is kept here for the scrubber');

  // Same value, same PROJECT, two boxes — which is the entire point of the
  // feature: the boxes of one project agreeing is the comparison.
  const other = checkout({ '.env': 'API_KEY=sk-live-abcdef123456\n' });
  assert.equal(env.scanEnvFiles(other, SALT).files[0].vars[0].fp, v.fp);
  // …a different value is a different fingerprint, which is the other half.
  const drifted = checkout({ '.env': 'API_KEY=sk-live-DIFFERENT\n' });
  assert.notEqual(env.scanEnvFiles(drifted, SALT).files[0].vars[0].fp, v.fp);
  // …and a DIFFERENT PROJECT holding the identical value does not agree, which
  // is the salt working and is not a capability anybody lost.
  assert.notEqual(env.scanEnvFiles(other, 'proj-somebody-else').files[0].vars[0].fp, v.fp);
});

/**
 * A BOX THAT CANNOT NAME ITS PROJECT REPORTS NOTHING — AND STILL REDACTS.
 *
 * A credential handed in through `FLOWVIANT_FLEET` with nothing in the store
 * names no project until the roster does, so there is no salt to fingerprint
 * with. Fingerprints salted with something else would render as a confident
 * "these boxes differ" beside a box holding the identical value — the readout
 * asserting the opposite of the truth. Ignorance renders nothing, the
 * three-state rule this daemon keeps everywhere.
 *
 * The scrub half is deliberately UNAFFECTED: hiding a secret needs no project
 * id, and a box with no report is not a box with no secrets.
 */
test('no project id: an empty report, and a fully armed scrubber', () => {
  const dir = checkout({ '.env': 'SECRET_TOKEN=super-secret-value-123\n' });
  for (const salt of [undefined, null, '', 42]) {
    const scan = env.scanEnvFiles(dir, salt);
    assert.deepEqual(scan.files, [], `salt ${String(salt)} must report nothing`);
    assert.equal(scan.values.length, 1, 'but the value is still known to this box');
    // THE TOTALS ARE STILL MEASURED. "We looked and found one file" is true
    // whether or not we can fingerprint what is in it.
    assert.equal(scan.filesTotal, 1);
    assert.equal(scan.varsTotal, 1);
  }
  const report = env.scanEnvForScrub(dir, null);
  assert.deepEqual(report.files, []);
  assert.match(env.scrub('here is super-secret-value-123'), /\[REDACTED:SECRET_TOKEN\]/);
});

/**
 * A TEMPLATE IS NOT AN ENVIRONMENT. `.env.example` is committed documentation
 * of the SHAPE, and its values are placeholders — so every box would report the
 * same fingerprint for `your-key-here` and the comparison screen would show
 * them agreeing, which is the exact opposite of what it is for.
 */
test('.env.example and friends are skipped; real .env.* files are not', () => {
  const dir = checkout({
    '.env': 'A=1234567\n',
    '.env.local': 'B=2345678\n',
    '.env.production': 'C=3456789\n',
    '.env.example': 'A=your-key-here\n',
    '.env.sample': 'A=your-key-here\n',
    '.env.template': 'A=your-key-here\n',
    'env.txt': 'A=nope\n',
    'README.md': 'A=nope\n',
  });
  const { files, filesTotal } = env.scanEnvFiles(dir, SALT);
  assert.deepEqual(
    files.map((f) => f.file).sort(),
    ['.env', '.env.local', '.env.production']
  );
  // …and the TOTAL counts what the scan is willing to consider, not what is in
  // the directory: a template excluded on purpose must not inflate an "N more
  // not shown" that names files this scan would never report.
  assert.equal(filesTotal, 3);
});

test('a name that is too long or not a variable name is DROPPED, never truncated', () => {
  const long = 'X'.repeat(65);
  const ok65 = 'Y'.repeat(64);
  const dir = checkout({
    '.env': [
      `${long}=value-one`,
      `${ok65}=value-two`,
      '9LEADING_DIGIT=value-three',
      'HAS-A-DASH=value-four',
      'HAS SPACE=value-five',
      'GOOD_NAME=value-six',
    ].join('\n'),
  });
  const { files, values } = env.scanEnvFiles(dir, SALT);
  const names = files[0].vars.map((v) => v.name);
  // A CUT NAME IS A DIFFERENT VARIABLE: two boxes whose 70-character names
  // differ only past character 64 would render as one row that agrees.
  assert.ok(!names.some((n) => n.startsWith('X')), 'the over-long name is gone entirely');
  assert.deepEqual(names, [ok65, 'GOOD_NAME'], 'exactly 64 is kept; malformed names are not');
  // And a dropped name's VALUE is not fed to the scrubber either — a redaction
  // labelled with a name nothing reported is a label nobody can act on.
  assert.ok(!values.some((v) => v.value === 'value-one'));
  assert.ok(!values.some((v) => v.value === 'value-four'));
});

/**
 * THE REPORT IS CAPPED, THE TOTALS SAY SO, AND THE SCRUBBER IS NOT CAPPED WITH
 * IT (2026-09-21, the review).
 *
 * Two separate rules and they were one before this pass:
 *
 *  · A LIST CUT AT A CAP WITHOUT SAYING SO ANSWERS "HOW MUCH IS IN HERE" WITH A
 *    LIE. `filesTotal` and `varsTotal` are the numbers BEFORE the caps, so the
 *    app can say "N more not shown" — the rule `repoState` already keeps for
 *    branches and worktrees, and the one the listeners panel learned when
 *    `wrangler dev` opened nine sockets into a cap of eight.
 *  · A SECRET DROPPED FOR BEING THE 201st VARIABLE IS A SECRET IN THE SERVER'S
 *    DATABASE. The 200 exists so a comparison screen stays readable; redaction
 *    has no reader, no wire cost and no render cost, so it gets its own, far
 *    larger bound. Sharing the report's budget made the scrubber's coverage a
 *    function of how many `.env` files somebody happened to have.
 */
test('the report caps at 8 files and 200 vars, the totals state the truth, and scrub is not capped', () => {
  const many = {};
  for (let i = 0; i < 12; i++) many[`.env.f${i}`] = `K${i}=value-${i}\n`;
  const manyScan = env.scanEnvFiles(checkout(many), SALT);
  assert.equal(manyScan.files.length, 8, 'at most eight files on the wire');
  assert.equal(manyScan.filesTotal, 12, 'and the total says how many there really are');
  assert.equal(manyScan.varsTotal, 12);

  // The 200 is a TOTAL across files, not a per-file cap: three files of 150
  // must not report 450 variables.
  const wide = {};
  for (let f = 0; f < 3; f++) {
    wide[`.env.w${f}`] = Array.from({ length: 150 }, (_, i) => `W${f}_${i}=secret-${f}-${i}-Zz9_Qq`).join('\n');
  }
  const wideDir = checkout(wide);
  const scanned = env.scanEnvFiles(wideDir, SALT);
  const reported = scanned.files.reduce((n, f) => n + f.vars.length, 0);
  assert.equal(reported, 200, 'the report stops at two hundred');
  assert.equal(scanned.varsTotal, 450, 'and the total says how many there really are');
  assert.equal(scanned.values.length, 450, 'the scrub list is NOT bounded by the report cap');

  // THE BEHAVIOURAL HALF: a variable past the report's cap is still redacted.
  env.scanEnvForScrub(wideDir, SALT);
  // A value with an underscore and a case mix, so the scrubber's own shape test
  // (ordinary words survive) is not what decides this assertion — the question
  // here is the 200-var BUDGET, and a fixture that fails for a second reason
  // proves nothing.
  const past = 'secret-2-149-Zz9_Qq'; // the third file's last variable — long past 200
  assert.ok(
    !scanned.files.some((f) => f.vars.some((v) => v.name === 'W2_149')),
    'this variable is genuinely past the report cap'
  );
  assert.match(env.scrub(`the log printed ${past}`), /\[REDACTED:W2_149\]/);

  // A stray binary or a redirected log named `.env.bin` is never slurped.
  const big = checkout({ '.env.bin': 'A=1\n' });
  writeFileSync(join(big, '.env.bin'), 'B=x\n'.repeat(200_000)); // ~800KB
  writeFileSync(join(big, '.env'), 'REAL=kept-value\n');
  const bounded = env.scanEnvFiles(big, SALT);
  assert.deepEqual(bounded.files.map((f) => f.file), ['.env'], 'the oversized file contributes nothing');
});

test('the scan never throws, and an unreadable checkout says nothing rather than "none"', () => {
  for (const arg of [undefined, null, '', 42, join(tmpdir(), 'fv-does-not-exist-at-all')]) {
    const out = env.scanEnvFiles(arg, SALT);
    assert.deepEqual(out.files, []);
    assert.deepEqual(out.values, []);
    assert.equal(out.filesTotal, 0);
    assert.equal(out.varsTotal, 0);
  }
  // A directory named `.env.d` is not a file and is stepped over rather than
  // read — the same swallow-per-entry rule.
  const dir = checkout({ '.env': 'A=1234567\n' });
  mkdirSync(join(dir, '.env.d'));
  assert.deepEqual(env.scanEnvFiles(dir, SALT).files.map((f) => f.file), ['.env']);
});

/**
 * THE SCRUBBER IS FED BY THE SCAN, and this is the half that would fail
 * SILENTLY if it were wrong.
 *
 * `scrub()` used to read the vault's decrypted bundle. With the vault gone that
 * array would be permanently empty and `scrub` a no-op in ~10 call sites — turn
 * streams, tool events, the trace, process command lines, deploy logs — every
 * one of which keeps calling it, so nothing would look different until a secret
 * was already in the server's database.
 *
 * It reads the checkout's own `.env*` files now, which is strictly MORE than
 * the vault ever covered for a TURN: these are the values the operator pasted
 * in from their providers and the ones a dev server actually loads. (For a
 * DEPLOY it was strictly less, which is item 2's regression — see below.)
 */
test('scrub redacts what is really on this box, and keeps its length floor', () => {
  const dir = checkout({
    '.env': ['SECRET_TOKEN=super-secret-value-123', 'TINY=ab', 'PORT=3000'].join('\n'),
  });
  const report = env.scanEnvForScrub(dir, SALT);
  assert.ok(report.files.some((f) => f.file === '.env'), 'the report half comes back');

  const out = env.scrub('deploying with super-secret-value-123 on port 3000');
  assert.ok(!out.includes('super-secret-value-123'), 'the secret is gone');
  assert.match(out, /\[REDACTED:SECRET_TOKEN\]/, 'and it is labelled with its name');
  // THE FLOOR STAYS. A two-character value would redact half of every stream,
  // and `3000` is four — short values are skipped rather than hunted.
  assert.match(out, /port 3000/, 'a value under the 6-character floor is left alone');
  assert.equal(env.scrub('nothing in here at all'), 'nothing in here at all');
  assert.equal(env.scrub(null), null, 'a non-string passes through untouched');
});

/**
 * A RELAY DOES NOT SWAP THE WORDS IT CARRIES (2026-09-21, the review).
 *
 * Feeding `scrub` from the checkout's `.env*` files put ordinary configuration
 * in the redaction list — `NODE_ENV=development`, `HOST=localhost`,
 * `APP_NAME=flowviant`, `LOG_LEVEL=verbose`, `AWS_REGION=us-east-1` — so every
 * occurrence of the word "development" in the CLI's own narration came back as
 * `[REDACTED:NODE_ENV]`. The turn trace exists to relay what the CLI said, and
 * it was relaying something else: silent, universal, and destructive of the one
 * readout it was built for. That is a worse failure than under-redaction.
 *
 * Two SHAPE tests fix it — nothing here classifies, guesses, or asks a model —
 * and the accepted cost is stated rather than hidden: a genuinely secret value
 * that is short and all-lowercase is not redacted. Anything with a symbol, a
 * case mix, an underscore, or twelve-plus characters — which is every token,
 * key, URL, JWT and hex digest anybody pastes into a `.env` — still is.
 */
test('ordinary words survive the scrubber; real credentials do not', () => {
  const dir = checkout({
    '.env': [
      'NODE_ENV=development',
      'HOST=localhost',
      'APP_NAME=flowviant',
      'LOG_LEVEL=verbose',
      'AWS_REGION=us-east-1',
      'API_KEY=sk-live_9f3aB2xQ7zR',
      'WEBHOOK_SECRET=0123456789abcdef0123456789abcdef01234567',
      'DATABASE_URL=postgres://user:pw@host/db',
      'SESSION_KEY=Tr0ub4dor&3xx',
    ].join('\n'),
  });
  env.scanEnvForScrub(dir, SALT);

  const narration = [
    'Running in development mode against localhost — this is the flowviant repo.',
    'Log level verbose, region us-east-1.',
  ].join(' ');
  assert.equal(env.scrub(narration), narration, 'not one ordinary word may be swapped');

  for (const secret of [
    'sk-live_9f3aB2xQ7zR',
    '0123456789abcdef0123456789abcdef01234567',
    'postgres://user:pw@host/db',
    'Tr0ub4dor&3xx',
  ]) {
    const line = env.scrub(`the CLI echoed ${secret} into its log`);
    assert.ok(!line.includes(secret), `${secret} must still be redacted`);
    assert.match(line, /\[REDACTED:[A-Z_]+\]/);
  }
});

/**
 * THE OPERATOR'S DEPLOY CREDENTIAL IS REDACTED, AND NEVER REPORTED
 * (2026-09-21, the review) — a REGRESSION this closes, not a new feature.
 *
 * The vault's deploy-scope half WAS `CLOUDFLARE_API_TOKEN` and friends, so
 * while it stood those values were in `scrub`'s list and `wrangler` output was
 * redacted on its way to the server. The replacement scrubber reads the
 * CHECKOUT, and an operator's deploy token lives in the shell they started the
 * daemon in — which is the whole reason `childEnv`'s `deploy: true` widening
 * exists. So the one lane that hands a secret to a command and then streams
 * that command's stdout to the server had stopped redacting it, under a
 * `deploy.mjs` docblock still claiming the opposite.
 *
 * THE OTHER HALF IS THE ONE THAT MUST NOT DRIFT: none of it goes on the wire.
 * `/fleet/env-report` is a statement about the CHECKOUT'S FILES — the owner's
 * "show the env of each of the machines (for comparison)" — and this process's
 * environment is not a fact about the checkout. Values never leave either way;
 * NAMES would, and a name is enough to tell somebody which credential to go
 * looking for.
 */
test('a deploy credential in process.env is scrubbed but never reported', () => {
  const dir = checkout({ '.env': 'REAL=real-value-in-the-checkout\n' });
  process.env.CLOUDFLARE_API_TOKEN = 'cf-Tok3n-dEADbeef-9911';
  process.env.CF_API_TOKEN = 'cf-old-spelling-Tok3n-77';
  try {
    const report = env.scanEnvForScrub(dir, SALT);
    const wire = JSON.stringify(report);
    assert.ok(!wire.includes('cf-Tok3n-dEADbeef-9911'), 'no value may reach the wire');
    assert.ok(!wire.includes('CLOUDFLARE_API_TOKEN'), 'and neither may the NAME');
    assert.ok(!wire.includes('CF_API_TOKEN'));
    assert.equal(report.filesTotal, 1, 'the report is still the checkout, unchanged');

    const line = env.scrub('wrangler said token cf-Tok3n-dEADbeef-9911 and cf-old-spelling-Tok3n-77');
    assert.ok(!line.includes('cf-Tok3n-dEADbeef-9911'));
    assert.match(line, /\[REDACTED:CLOUDFLARE_API_TOKEN\]/);
    // `CF_API_TOKEN` is wrangler's OLDER spelling and is deliberately NOT in
    // `DEPLOY_KEEP` — redacting a value we never pass costs nothing and covers
    // the operator still on it; passing it would widen what a repo-controlled
    // `build` string can reach. Redaction and admission are different questions.
    assert.match(line, /\[REDACTED:CF_API_TOKEN\]/);
  } finally {
    delete process.env.CLOUDFLARE_API_TOKEN;
    delete process.env.CF_API_TOKEN;
  }
  // …and once it leaves the environment, the next scan stops claiming it. The
  // process half is re-read every scan precisely so it cannot go stale.
  env.scanEnvForScrub(dir, SALT);
  const after = 'wrangler said token cf-Tok3n-dEADbeef-9911';
  assert.equal(env.scrub(after), after);
});

/**
 * AN EMPTY READ DOES NOT TURN THE REDACTOR OFF.
 *
 * `scanEnvFiles` swallows per-file and per-directory errors on purpose — it
 * runs on the poll's beat and must never throw into it — so "nothing came
 * back" is two different facts wearing one shape: the operator deleted `.env`,
 * or this pass could not read the directory. Replacing the list on an empty
 * read means one EACCES, one mid-sweep rename or one blinking network mount
 * silently stops `scrub()` redacting, in ~10 call sites that all keep calling
 * it, and nothing looks different until a secret is in the server's database.
 *
 * So the previous list stands. The cost is OVER-redaction, which is the safe
 * direction and the one every three-state readout in this daemon takes. The
 * REPORT half is untouched: it returns the real, empty read, so the app is
 * told what was actually measured rather than what we still remember.
 */
test('a scan that reads nothing leaves the scrubber armed, but reports the truth', () => {
  const dir = checkout({ '.env': 'SECRET_TOKEN=super-secret-value-123\n' });
  env.scanEnvForScrub(dir, SALT);
  assert.match(env.scrub('here is super-secret-value-123'), /\[REDACTED:SECRET_TOKEN\]/);

  const gone = env.scanEnvForScrub(join(tmpdir(), 'fv-vanished-checkout'), SALT);
  assert.deepEqual(gone.files, [], 'the REPORT says what was measured: nothing');
  assert.equal(gone.filesTotal, 0);
  assert.match(
    env.scrub('here is super-secret-value-123'),
    /\[REDACTED:SECRET_TOKEN\]/,
    'but the redactor keeps what it already knew'
  );
});

/**
 * THE REPORT LANE'S SHAPE, PINNED AS SOURCE TEXT — its BEHAVIOUR is driven
 * against a real HTTP server in `envReport.test.mjs`, which is where the
 * statuses, the dedup and the body are actually proved. What is left here is
 * the ORDERING fact that no round trip can show: the scan runs BEFORE the
 * unsupported gate, so a server that cannot take the report never costs this
 * box its redaction.
 */
test('the env report scans before it gates, and the caller never awaits it', () => {
  const raw = readFileSync(join(process.cwd(), 'bin/lib/fleet.mjs'), 'utf8');
  // BOTH ANCHORS BEFORE THE SLICE. An `indexOf` that misses returns −1 and the
  // slice then asserts over the wrong text — or over nothing, which passes
  // every `doesNotMatch` ever written against it.
  const from = raw.indexOf('export async function maybeReportEnv(repoRoot) {');
  const to = raw.indexOf('\nexport function shouldStop(', from + 10);
  assert.ok(from > -1, 'the report lane exists');
  assert.ok(to > from, 'and its end anchor does too');
  const fn = raw.slice(from, to);

  assert.ok(fn.includes('scanEnvForScrub(repoRoot)'), 'the scan feeds the scrubber');
  assert.ok(
    fn.indexOf('scanEnvForScrub(repoRoot)') < fn.indexOf('if (envReportUnsupported) return'),
    'the scan runs even when the post cannot'
  );
  // …and the caller never awaits it: a readout that can delay a poll is worse
  // than no readout.
  assert.ok(raw.includes('void maybeReportEnv(repoRoot);'), 'fired and forgotten on the loop');
});

// ── the 2026-09-24 audit ────────────────────────────────────────────────────

/**
 * A GENERATED PASSWORD IS NOT AN ORDINARY WORD. The plain-identifier exemption
 * was checked first and alone, so `Tq8vZ2mKp4Lx9RbN` (sixteen characters of
 * [A-Za-z0-9], the `pwgen -s 16` shape) and a twelve-character `Hx93kPq2Lm7w`
 * were left in plain text everywhere the daemon posts. A case-and-digit mix is
 * minted, not written; the words the exemption exists for still survive.
 */
test('a case-and-digit mix is redacted even when it looks like an identifier', () => {
  const dir = checkout({
    '.env': ['SESSION_SECRET=Tq8vZ2mKp4Lx9RbN', 'DB_PASSWORD=Hx93kPq2Lm7w', 'NODE_ENV=development', 'AWS_REGION=us-east-1', 'APP=flowviant'].join('\n'),
  });
  env.scanEnvForScrub(dir, SALT);
  for (const secret of ['Tq8vZ2mKp4Lx9RbN', 'Hx93kPq2Lm7w']) {
    const line = env.scrub(`the CLI echoed ${secret} into its log`);
    assert.ok(!line.includes(secret), `${secret} must be redacted`);
    assert.ok(env.secretIn(Buffer.from(`xx${secret}xx`)), `${secret} must be found in bytes too`);
  }
  const narration = 'development on us-east-1 in the flowviant repo';
  assert.equal(env.scrub(narration), narration, 'ordinary words still survive');
});

/**
 * EVERY FLOWVIANT CREDENTIAL IS REDACTED BY SHAPE. The machine credential sits
 * in `~/.flowviant/credentials.json` for every project on the box, readable by
 * any turn, and no value list held it — so a turn that read the store and
 * wrote it into an artifact, a trace or an answer shipped it verbatim.
 */
test('an fva_ token is redacted in text and found in bytes, with no list to feed it', () => {
  const token = 'fva_' + 'Ab3_-xYz9'.repeat(4) + 'Qq12'; // 40 chars, the nanoid alphabet
  const out = env.scrub(`{"projects":{"p":{"fleetToken":"${token}"}}}`);
  assert.ok(!out.includes(token));
  assert.match(out, /\[REDACTED:FLOWVIANT_TOKEN\]/);
  assert.equal(env.secretIn(Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(token), Buffer.from([255])])), 'FLOWVIANT_TOKEN');
  // The app's own identification prefix (`fva_` + 8) is not a credential.
  assert.equal(env.scrub('token fva_Ab3xYz9Q (revoked)'), 'token fva_Ab3xYz9Q (revoked)');
  assert.equal(env.secretIn(Buffer.from('plain bytes, nothing here')), null);
});

/**
 * THE BOX'S IDENTITY IS PUBLISHED ONCE. Two first starts racing on a fresh box
 * each minted a key and the last writer won, so the first kept an identity the
 * disk no longer held. The mint now links a complete temp file into place, and
 * a loser reads the winner's key instead of overwriting it.
 */
test('the keypair mint lets the first writer win and never leaves a temp file', async () => {
  const { readdirSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'fv-mint-'));
  const path = join(dir, 'sub', 'env-keypair.json');
  const first = env.mintKeypairFile(path, JSON.stringify({ pub: 'P1', priv: 'S1' }));
  assert.deepEqual(first, { pub: 'P1', priv: 'S1' });
  // A second minter that lost the race gets the WINNER's identity, and the file
  // is exactly the winner's.
  const second = env.mintKeypairFile(path, JSON.stringify({ pub: 'P2', priv: 'S2' }));
  assert.deepEqual(second, { pub: 'P1', priv: 'S1' });
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { pub: 'P1', priv: 'S1' });
  assert.deepEqual(readdirSync(join(dir, 'sub')), ['env-keypair.json'], 'no temp file is left behind');
  const { statSync } = await import('node:fs');
  assert.equal(statSync(path).mode & 0o777, 0o600, 'still owner-only');
});
