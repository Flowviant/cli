/**
 * The materialization boundary — the two places a hostile targetFile could act.
 *
 * `knownTargetFiles` is refilled from the server bundle and from the on-disk
 * cache, and the stale sweep joins each entry to a worktree and calls rmSync.
 * The isTrackedInGit check cannot gate that: `ls-files` on a path OUTSIDE the
 * worktree throws, the catch reads as "not tracked", and the deletion
 * proceeds — so before the isSafeTarget gate, `../victim` in a cache file was
 * a delete primitive pointed anywhere on the box. The write path had the gate
 * all along; these tests pin that the delete path holds the same line, and
 * that `.git/**` is refused at intake so a value sealed to
 * `.git/hooks/pre-commit` can never become code git runs.
 *
 * The cache seeding reimplements writeCache the way grant.test.mjs
 * reimplements the minting side: only so this file can stand alone.
 *
 * Run: node --test bin/lib/env.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// HOME must move BEFORE env.mjs computes its keypair/cache paths at import —
// this test writes a keypair and a cache, and must never touch the real one.
const HOME = mkdtempSync(join(tmpdir(), 'fv-envhome-'));
process.env.HOME = HOME;

const env = await import('./env.mjs');
const sodium = (await import('libsodium-wrappers-sumo')).default;
await sodium.ready;
await env.ensureKeypair();

const B64 = sodium.base64_variants.ORIGINAL;
const HEADER = '# Materialized by flowviant env sync — DO NOT COMMIT.\nX=1\n';

/** writeCache's twin: encrypt a bundle payload under the key env.mjs derives
 *  from its own keypair, so loadCachedEnv accepts it as its own.
 *
 *  `home` is a parameter because the recovery-code tests below drive a
 *  SUBPROCESS with its own HOME, and seeding from here — where sodium is
 *  already loaded — is what keeps that subprocess's script down to imports
 *  that resolve: a script written into a temp directory cannot resolve a bare
 *  `libsodium-wrappers-sumo`, while an absolute import of `env.mjs` resolves
 *  its own dependencies from inside the package. */
function seedCache(projectId, payload, home = HOME) {
  const stored = JSON.parse(readFileSync(join(home, '.flowviant', 'env-keypair.json'), 'utf8'));
  const key = sodium.crypto_generichash(
    sodium.crypto_secretbox_KEYBYTES,
    sodium.from_base64(stored.priv, B64)
  );
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const box = sodium.crypto_secretbox_easy(
    sodium.from_string(JSON.stringify(payload)),
    nonce,
    key
  );
  const dir = join(home, '.flowviant', 'env-cache');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${projectId}.json`),
    JSON.stringify({ nonce: sodium.to_base64(nonce, B64), box: sodium.to_base64(box, B64) })
  );
}

function makeRepo(dir) {
  const git = (args) =>
    execFileSync('git', args, {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'T',
        GIT_AUTHOR_EMAIL: 't@e',
        GIT_COMMITTER_NAME: 'T',
        GIT_COMMITTER_EMAIL: 't@e',
      },
    });
  git(['init', '-q', '-b', 'main']);
  writeFileSync(join(dir, 'a.txt'), 'one');
  git(['add', '.']);
  git(['commit', '-qm', 'first']);
}

test('a hostile cache path never reaches rmSync, and .git never gets a secret', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'fv-envwt-'));
  const wt = join(parent, 'repo');
  mkdirSync(wt);
  makeRepo(wt);

  // The would-be victims: a file OUTSIDE the worktree that a traversal entry
  // would resolve to, and a planted file inside .git — both wearing our
  // header, which is exactly the disguise a real attack would use.
  const outside = join(parent, 'outside-pwn');
  writeFileSync(outside, HEADER);
  writeFileSync(join(wt, '.git', 'planted'), HEADER);
  // A legitimately stale materialized file: the sweep must still remove it,
  // or the gate has thrown the feature out with the attack.
  writeFileSync(join(wt, 'old.env'), HEADER);

  seedCache('proj-test', {
    bundleVersion: 3,
    values: [
      { name: 'API_KEY', env: 'dev', scope: 'app', targetFile: '.env', value: 'secret-value-1' },
      // Refused at grouping: a `.git` segment turns a materialized value into
      // code git runs on the operator's next commit.
      { name: 'EVIL', env: 'dev', scope: 'app', targetFile: '.git/hooks/pre-commit', value: 'pwn' },
    ],
    knownFiles: ['.env', 'old.env', '../outside-pwn', '.git/planted'],
  });

  assert.equal(await env.loadCachedEnv('proj-test'), true);
  env.materializeInto(wt);

  // The honest half still works end to end.
  const written = readFileSync(join(wt, '.env'), 'utf8');
  assert.match(written, /^# Materialized by flowviant env sync/);
  assert.match(written, /API_KEY=secret-value-1/);
  assert.equal(existsSync(join(wt, 'old.env')), false, 'a genuinely stale file must still be swept');

  // The gates: nothing outside the worktree was deleted, nothing landed in
  // .git, and the planted .git file was not "cleaned up" either.
  assert.equal(existsSync(outside), true, 'a traversal path in the cache must never be rmSync-ed');
  assert.equal(existsSync(join(wt, '.git', 'planted')), true, 'a .git path must never be rmSync-ed');
  assert.equal(existsSync(join(wt, '.git', 'hooks', 'pre-commit')), false, 'a .git target must never be written');
});

/**
 * A KEYPAIR WE CANNOT READ IS NOT A KEYPAIR WE MAY REPLACE (2026-09-14).
 *
 * `ensureKeypair` read the file inside a bare catch commented "first run", so
 * EVERY failure — a truncated file, bad JSON, EACCES — was treated as a first
 * run and the box silently MINTED A NEW IDENTITY over the old one. Two things
 * ride that identity: the project's private key is sealed to it (a new one
 * cannot open any wrap, and re-enrolment CAS-es on `project_pub IS NULL`), and
 * since holdership it is what tells two computers apart — so the same physical
 * box arrives at the roster as a stranger and stands itself down as a standby
 * of itself for the whole claim window.
 *
 * Only ENOENT is a first run. Anything else throws, and the one caller that has
 * to survive it already does: `envQueryParams` is wrapped in the poll, so the
 * poll simply carries no `envpub` — which is the documented EXEMPT arm, reached
 * honestly instead of by re-keying the box every restart.
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
      ['-e', "const e = await import(process.argv[1]); await e.ensureKeypair();", join(process.cwd(), 'bin/lib/env.mjs')],
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
    ['-e', "const e = await import(process.argv[1]); await e.ensureKeypair();", join(process.cwd(), 'bin/lib/env.mjs')],
    { env: { ...process.env, HOME: fresh }, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  assert.ok(existsSync(join(fresh, '.flowviant', 'env-keypair.json')), 'a first run still mints one');
});

/**
 * REGISTERING IS ENROLLING (2026-09-20) — and the terminal stops sending people
 * to a button that no longer exists.
 *
 * `handleRosterEnv`'s register branch printed a key fingerprint and told the
 * reader that "an admin approves it in Settings → Environment (compare the
 * emoji)". The server no longer produces a `pending` row at all: the box
 * already holds this project's machine credential, which a person handed it by
 * typing a device code into the app, so that WAS the approval. The owner:
 * *"having the extra layer of security on the web makes no sense when its not
 * the decision maker and the terminal's init of flowviant is."*
 *
 * Pinned as SOURCE TEXT, because the branch it lives in needs a whole roster
 * tick and a live server to reach, and the failure here is a sentence rather
 * than a behaviour — an instruction that cannot be carried out reads exactly
 * like a working one.
 */
test('the register branch sends nobody to an approve button', () => {
  const src = readFileSync(join(process.cwd(), 'bin/lib/env.mjs'), 'utf8');

  // THE CANARY. A pin over a file it failed to read passes every not.match ever
  // written against it — the inert-pin class this product has caught five
  // times.
  assert.match(src, /export async function handleRosterEnv/, 'reading the real module');
  assert.match(src, /await post\('register'/, 'the register call is still there');

  // Comments carry the obituary, so the ban is on the CODE. Strip them first —
  // a raw grep would fail on the very comment explaining the removal, which is
  // the `deployAuthority` lesson.
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

  assert.doesNotMatch(code, /an admin approves it/, 'the approve instruction is gone');
  assert.doesNotMatch(code, /compare the emoji/, 'the fingerprint comparison is gone');
  assert.doesNotMatch(code, /fingerprint \$\{/, 'nothing prints a fingerprint');
  // And the function it printed went with the card it existed to be compared
  // against — including its export, since the web's twin is deleted too.
  assert.doesNotMatch(code, /pubkeyEmoji/, 'pubkeyEmoji is deleted, not merely unused');
  assert.equal(typeof env.pubkeyEmoji, 'undefined', 'and it is not exported any more');

  // WHAT REPLACED IT: one quiet line that states what happened and asks for
  // nothing. A registration is not a request. WHICH line it is depends on what
  // the server answered, and that belongs to the relay pin below rather than
  // here — this test is about the instruction being gone.
  assert.match(code, /· registered as \$\{c\.bold\(label\)\}/);
});

/**
 * THE REGISTER LINE RELAYS THE SERVER, AND DOES NOT ASSERT AN OUTCOME.
 *
 * The first cut of "registering is enrolling" replaced the approve instruction
 * with `enrolled as X — secrets sync to this box automatically`, printed
 * unconditionally. A fresh registration comes back `approved`, not `enrolled`:
 * the key is not on this box yet and arrives only once some box that holds it
 * polls. And an OLDER server still answers `pending`, where the line was
 * claiming a state that box would never reach without somebody clicking.
 *
 * Source text again, for the same reason the pin above is: reaching this
 * branch needs a roster tick and a live server, and the failure is a SENTENCE
 * — an assertion that is merely premature reads exactly like a true one.
 */
test('the register line says what the server answered, not what we hoped', () => {
  const src = readFileSync(join(process.cwd(), 'bin/lib/env.mjs'), 'utf8');
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

  // THE CANARY: the response is actually read. Printing a relay off a value
  // nobody captured is the whole bug this pins.
  assert.match(code, /registered = await post\('register'/, 'the response is captured');
  assert.match(code, /registered\?\.status === 'approved'/);
  assert.match(code, /registered\?\.status === 'pending'/);
  assert.match(code, /registered\?\.status === 'enrolled'/);

  // One sentence per state, each true of that state and of no other.
  assert.match(code, /secrets sync to this box automatically/, 'enrolled: the key is here');
  assert.match(code, /as soon as a machine holding the key is online/, 'approved: it is coming');
  assert.match(code, /this server is waiting on an approval in Settings/, 'pending: an older server');
  // And an answer we do not recognise says only the part we measured.
  assert.match(code, /registered as \$\{c\.bold\(label\)\}/);
});

/**
 * THE RECOVERY CODE WAITS UNTIL THERE IS SOMETHING TO RECOVER (2026-09-20).
 *
 * `bootstrapProject` printed it on the FIRST DAEMON OF EVERY PROJECT — a
 * keypair is bootstrapped whether or not a single secret exists — so the
 * loudest custody artefact this product owns was being handed to people who
 * had run `npx flowviant` to connect a machine and had no vault at all. That
 * is the complaint the approve gate died of, printed instead of clicked.
 *
 * So: bootstrap is silent, the passphrase is parked in this box's own keypair
 * file beside the private key it recovers, and it prints the first time this
 * box MATERIALIZES a secret — the first moment the sentence is true.
 *
 * SUBPROCESSES, and they are not ceremony. "Once" has two halves that only a
 * second process can tell apart: a module flag (this run said it already) and
 * the `shown` mark in the file (every future run). A single in-process test
 * proves the weaker half and would pass with the file write deleted.
 */
/** A box whose HOME is a fresh directory: the keypair is MINTED HERE, where
 *  sodium already is, so the subprocess script needs nothing but `env.mjs`. */
const newBox = (home) => {
  const kp = sodium.crypto_box_keypair();
  mkdirSync(join(home, '.flowviant'), { recursive: true });
  writeFileSync(
    join(home, '.flowviant', 'env-keypair.json'),
    JSON.stringify({
      pub: sodium.to_base64(kp.publicKey, B64),
      priv: sodium.to_base64(kp.privateKey, B64),
    }),
    { mode: 0o600 }
  );
  seedCache(
    'proj-recovery',
    {
      bundleVersion: 1,
      values: [
        { name: 'API_KEY', env: 'dev', scope: 'app', targetFile: '.env', value: 'secret-value-1' },
      ],
      knownFiles: ['.env'],
    },
    home
  );
};

/** One daemon process: stash (optionally), load the cache, materialize twice.
 *  The marker between the two passes is what lets the caller ask "and not
 *  again" without a second assertion about ordering. */
const recoveryRunner = (home, wt, extra = {}) => {
  const script = join(home, 'runner.mjs');
  writeFileSync(
    script,
    `
const env = await import(process.env.FV_MODULE);
if (process.env.FV_STASH) {
  await env.ensureKeypair();
  env.stashRecoveryCode(process.env.FV_STASH, process.env.FV_STASH_PROJECT || null);
}
await env.loadCachedEnv('proj-recovery');
env.materializeInto(process.env.FV_WT);
console.log('---SECOND-PASS---');
env.materializeInto(process.env.FV_WT);
`,
    'utf8'
  );
  return execFileSync(process.execPath, [script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      NO_COLOR: '1',
      FV_MODULE: join(process.cwd(), 'bin/lib/env.mjs'),
      FV_WT: wt,
      ...extra,
    },
    stdio: ['ignore', 'pipe', 'ignore'],
  });
};

test('the recovery code prints on the first materialized secret, once, ever', () => {
  const home = mkdtempSync(join(tmpdir(), 'fv-recov-'));
  const wt = join(mkdtempSync(join(tmpdir(), 'fv-recovwt-')), 'repo');
  mkdirSync(wt);
  makeRepo(wt);
  newBox(home);
  const PASS = 'abcd-efgh-jkmn-pqrs-tuvw-xyz2';

  const first = recoveryRunner(home, wt, { FV_STASH: PASS, FV_STASH_PROJECT: 'proj-recovery' });
  const [before, after] = first.split('---SECOND-PASS---');

  // The secret actually landed — otherwise the whole run proves nothing.
  assert.match(readFileSync(join(wt, '.env'), 'utf8'), /API_KEY=secret-value-1/);
  assert.match(before, /RECOVERY CODE/, 'the block prints on the first materialized secret');
  assert.ok(before.includes(PASS), 'and it carries the passphrase');
  assert.doesNotMatch(after, /RECOVERY CODE/, 'not again in the same process');
  assert.equal(after.includes(PASS), false);

  // AND THE MARK IS DURABLE. A fresh process, same box, same stash: the file
  // says it has been shown, so nothing is printed. Without the write-back this
  // passes only until the daemon restarts, which is every auto-update.
  const second = recoveryRunner(home, wt);
  assert.doesNotMatch(second, /RECOVERY CODE/, 'a later process never reprints it');
  assert.equal(second.includes(PASS), false);
  const stored = JSON.parse(readFileSync(join(home, '.flowviant', 'env-keypair.json'), 'utf8'));
  assert.equal(stored.recovery.shown, true, 'the mark lives in the file, not just in memory');
  // THE SHAPE IS EXTENDED, NOT REPLACED: an older daemon reads `pub`/`priv`
  // and ignores the rest, so the box keeps its identity either way.
  assert.equal(typeof stored.pub, 'string');
  assert.equal(typeof stored.priv, 'string');
});

/**
 * A CODE PARKED FOR ANOTHER PROJECT IS NEVER PRINTED HERE.
 *
 * The keypair file is per BOX; the recovery code is per PROJECT. A daemon
 * serves one project, so a stash naming a different one can only be a leftover
 * — and printing it beside this project's secrets would attribute a passphrase
 * to the wrong vault, which is worse than not printing it at all: the person
 * would file it as the code for the vault they were looking at.
 */
test('a code parked for another project is never printed here', () => {
  const home = mkdtempSync(join(tmpdir(), 'fv-recov-quiet-'));
  const wt = join(mkdtempSync(join(tmpdir(), 'fv-recovwt-quiet-')), 'repo');
  mkdirSync(wt);
  makeRepo(wt);
  newBox(home);
  const PASS = 'zzzz-yyyy-xxxx-wwww-vvvv-uuu2';

  // Stashed against a DIFFERENT project than the one this box is serving. The
  // keypair file is per BOX and the code is per PROJECT, so printing it here
  // would attribute a passphrase to the wrong vault.
  const out = recoveryRunner(home, wt, { FV_STASH: PASS, FV_STASH_PROJECT: 'some-other-project' });
  // THE CANARY: a secret really was written, so the print WAS reached and
  // declined — not skipped because nothing materialized.
  assert.match(readFileSync(join(wt, '.env'), 'utf8'), /API_KEY=secret-value-1/);
  assert.match(out, /---SECOND-PASS---/, 'the run really did reach materialization');
  assert.doesNotMatch(out, /RECOVERY CODE/);
  assert.equal(out.includes(PASS), false);
  // And it stays parked rather than being consumed: the mark is untouched, so
  // the box that really owns this code can still be told.
  const stored = JSON.parse(readFileSync(join(home, '.flowviant', 'env-keypair.json'), 'utf8'));
  assert.equal(stored.recovery.shown, false);
});

/**
 * AND BOOTSTRAP ITSELF SAYS NOTHING. Source text, because `bootstrapProject`
 * POSTs to a live server and is not exported; what is being pinned is that the
 * loud block moved OUT of it, which is a property of the text.
 */
test('bootstrap prints no passphrase', () => {
  const src = readFileSync(join(process.cwd(), 'bin/lib/env.mjs'), 'utf8');
  const start = src.indexOf('async function bootstrapProject()');
  assert.ok(start > -1, 'reading the real function');
  const body = src
    .slice(start)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

  // THE CANARY: the passphrase is still minted here, so a pin that stopped
  // matching would be visible rather than silently green.
  assert.match(body, /const passphrase = /);
  // It goes to the file, and the ONE print left is the failure branch — a
  // stash that did not land is the single case where losing the code to keep
  // the terminal tidy is not a trade anybody would make.
  assert.match(body, /stashRecoveryCode\(passphrase/);
  assert.doesNotMatch(body, /c\.yellow\(passphrase\)/, 'nothing prints it on the happy path');
  assert.equal(body.split('printRecoveryBlock(passphrase)').length - 1, 1, 'exactly one, and it is the could-not-save branch');
});
