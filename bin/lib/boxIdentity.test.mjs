/**
 * THE BOX KEYPAIR — this box's durable identity (`boxIdentity.mjs`).
 *
 * MOVED HERE from `env.test.mjs` with the module it tests (2026-09-26, the
 * SOLID pass): the keypair left `env.mjs`, which now holds only the env
 * comparison scan. The keypair is the BOX'S DURABLE IDENTITY — holdership
 * arbitration and the machine registry both key on `envpub` — so its
 * correctness rule, its path and its first-writer-wins mint are pinned here as
 * facts, not implementation detail.
 *
 * Run: node --test bin/lib/boxIdentity.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// HOME must move BEFORE boxIdentity.mjs computes its keypair path at import —
// this test writes a keypair and must never touch the real one.
const HOME = mkdtempSync(join(tmpdir(), 'fv-envhome-'));
process.env.HOME = HOME;

const env = await import('./boxIdentity.mjs');
await env.ensureKeypair();

const MODULE = join(process.cwd(), 'bin/lib/boxIdentity.mjs');

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

/**
 * THE IDENTITY HAS ONE HOME. The keypair's path is what makes a box the SAME
 * box across upgrades; a second module computing it is a second place that can
 * drift and re-key every machine in existence. Comments are stripped before
 * matching (the path is named in prose across the daemon — childEnv's 0600
 * argument), so the ban is on CODE that names the file as a path segment: the
 * literal `env-keypair.json` right after a quote or a slash, however it is
 * joined. The one exclusion is the `~/.flowviant/env-keypair.json` display
 * string fleet's warn line prints to a person — a tilde path is never opened.
 *
 * The walk is the whole daemon (`bin/`, recursively: cli.mjs, lib/, lib/hooks/),
 * and each alternative has its OWN canary against the home, so neither half can
 * go inert while the other keeps the pin green.
 */
test('only boxIdentity.mjs builds the keypair path or mints a box key', () => {
  const root = join(process.cwd(), 'bin');
  const home = join(root, 'lib', 'boxIdentity.mjs');
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const pathRe = /(?<!~\/\.flowviant\/)(?<=['"`/])env-keypair\.json/;
  const mintRe = /crypto_box_keypair\(/;
  const own = strip(readFileSync(home, 'utf8'));
  assert.ok(pathRe.test(own), 'canary: the home still builds the keypair path');
  assert.ok(mintRe.test(own), 'canary: the home still mints the key');
  assert.ok(
    pathRe.test("const KEYPAIR_PATH = join(homedir(), '.flowviant', 'env-keypair.json');"),
    'canary: a verbatim copy of the home line is caught',
  );
  assert.ok(!pathRe.test("`could not read ${'~/.flowviant/env-keypair.json'}`"), 'the display string is not a path');
  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? (e.name === 'node_modules' ? [] : walk(join(dir, e.name))) : [join(dir, e.name)],
    );
  const files = walk(root).filter((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs') && f !== home);
  assert.ok(files.some((f) => f.endsWith(join('bin', 'cli.mjs'))), 'canary: the walk reaches cli.mjs');
  assert.ok(files.some((f) => f.includes(join('lib', 'hooks'))), 'canary: the walk reaches lib/hooks');
  const copies = [];
  for (const f of files) {
    const src = strip(readFileSync(f, 'utf8'));
    if (pathRe.test(src) || mintRe.test(src)) copies.push(f.slice(root.length + 1));
  }
  assert.deepEqual(copies, [], 'the box identity must have exactly one home');
});
