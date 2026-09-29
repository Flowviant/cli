/**
 * THE DELETED VAULT'S LEFTOVERS — swept once, and NEVER ON A GUESS
 * (2026-09-21).
 *
 * Deleting the code that writes a file does not delete the file. Every box that
 * ran a daemon before this release still holds two things the secrets vault
 * put there: `~/.flowviant/env-cache/<projectId>.json`, an encrypted copy of
 * the project's secrets that nothing can read any more, and PLAINTEXT `.env`
 * files `materializeInto` wrote into session and task worktrees — which outlive
 * daemon restarts and reboots by design.
 *
 * The property this file exists for is the DESTRUCTIVE one, and it is an
 * absence: an operator's own `.env` is frequently the only copy of something
 * they pasted in from a provider months ago, and deleting it is unrecoverable
 * from here. So the rule is absolute — NO MARKER, NO DELETE — and the marker is
 * inherited rather than invented: `renderEnvFile` opened every file it wrote
 * with `# Materialized by flowviant env sync`, and the vault's own
 * `removeStaleEnvFile` already gated its deletions on exactly that prefix.
 *
 * Run: node --test bin/lib/vaultArtefacts.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeVaultArtefacts, sweepVaultArtefactsOnce } from './vaultArtefacts.mjs';

const HEADER = '# Materialized by flowviant env sync — DO NOT COMMIT.\n';

/** A temp HOME, optionally carrying the vault's encrypted cache directory. */
function home({ cache = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'fv-artefact-home-'));
  if (cache) {
    mkdirSync(join(dir, '.flowviant', 'env-cache'), { recursive: true });
    writeFileSync(join(dir, '.flowviant', 'env-cache', 'p1.json'), '{"nonce":"x","box":"y"}');
  }
  // The keypair lives in the same parent and must survive: it is the box's
  // DURABLE IDENTITY, and re-keying makes the same physical machine arrive at
  // the roster as a stranger.
  mkdirSync(join(dir, '.flowviant'), { recursive: true });
  writeFileSync(join(dir, '.flowviant', 'env-keypair.json'), '{"pub":"p","priv":"q"}');
  return dir;
}

function tree(files) {
  const dir = mkdtempSync(join(tmpdir(), 'fv-artefact-wt-'));
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, body);
  }
  return dir;
}

test('the encrypted env cache is removed, and nothing else under .flowviant is', () => {
  const h = home({ cache: true });
  const res = removeVaultArtefacts({ home: h, roots: [] });
  assert.equal(res.cacheRemoved, true);
  assert.ok(!existsSync(join(h, '.flowviant', 'env-cache')), 'the directory is gone');
  // THE KEYPAIR IS NOT AN ARTEFACT. It is what tells two computers apart on the
  // roster (holdership, the machine registry), and a cleanup that took it would
  // stand this box down as a standby of itself.
  assert.ok(existsSync(join(h, '.flowviant', 'env-keypair.json')), 'the box identity survives');
});

test('a box that never ran the vault reports nothing removed and throws nothing', () => {
  const res = removeVaultArtefacts({ home: home(), roots: [join(tmpdir(), 'fv-no-such-root')] });
  assert.equal(res.cacheRemoved, false);
  assert.deepEqual(res.filesRemoved, []);
});

/**
 * THE ONE THAT MATTERS. A marked file is ours and goes; an UNMARKED `.env` is
 * the operator's and is never touched — not on a name match, not on a path
 * match, not because it sits in a directory we created. Deleting somebody's
 * real `.env` is unrecoverable from here, and a sweep that guesses is worse
 * than a sweep that leaves a marked file behind.
 */
test('a MARKED .env is removed; an unmarked one is left exactly as it was', () => {
  const wt = tree({
    '.env': `${HEADER}API_KEY=materialized-by-us\n`,
    'sessions/abc/.env': `${HEADER}DATABASE_URL=also-ours\n`,
    'sessions/abc/.env.local': 'HAND_WRITTEN=the operators own file\n',
    'apps/api/.dev.vars': `${HEADER}NESTED=ours-too\n`,
    'notes.txt': `${HEADER}not an env file at all\n`,
  });
  const res = removeVaultArtefacts({ home: home(), roots: [wt] });

  assert.ok(!existsSync(join(wt, '.env')), 'the marked root file goes');
  assert.ok(!existsSync(join(wt, 'sessions/abc/.env')), 'and the marked one in a worktree');
  assert.ok(!existsSync(join(wt, 'apps/api/.dev.vars')), 'and a marked nested target');
  assert.equal(res.filesRemoved.length, 3);

  // NO MARKER, NO DELETE.
  assert.equal(
    readFileSync(join(wt, 'sessions/abc/.env.local'), 'utf8'),
    'HAND_WRITTEN=the operators own file\n',
    "an unmarked .env is the operator's and is never touched"
  );
  // …and the marker alone is not a licence: only files that could plausibly BE
  // a target are opened at all, so a marked note is left rather than removed.
  assert.ok(existsSync(join(wt, 'notes.txt')));
});

/**
 * A SYMLINK IS NOT A FILE HERE EITHER. `readFileSync` follows one, so a link
 * named `.env` pointing at a marked file elsewhere would match the header and
 * `rmSync` would then remove the LINK — or, with a different link, something
 * the marker never described. A delete primitive validates its own input; the
 * vault's own `removeStaleEnvFile` recorded that lesson in its comment.
 */
test('a symlink is never removed, however its target is marked', () => {
  const real = tree({ '.env': `${HEADER}ELSEWHERE=not-in-this-tree\n` });
  const wt = tree({ 'keep.txt': 'x\n' });
  symlinkSync(join(real, '.env'), join(wt, '.env'));
  const res = removeVaultArtefacts({ home: home(), roots: [wt] });
  assert.deepEqual(res.filesRemoved, []);
  assert.ok(existsSync(join(wt, '.env')), 'the link is left alone');
  assert.ok(existsSync(join(real, '.env')), 'and so is what it points at');
});

/** `node_modules` and `.git` are never walked. A boot-path sweep that reads
 *  somebody's dependency tree is how a cleanup becomes a hang. */
test('node_modules and dot-directories are stepped over', () => {
  const wt = tree({
    'node_modules/pkg/.env': `${HEADER}DEEP=ours-but-not-walked\n`,
    '.git/.env': `${HEADER}ALSO=not-walked\n`,
    '.env': `${HEADER}TOP=ours\n`,
  });
  const res = removeVaultArtefacts({ home: home(), roots: [wt] });
  assert.equal(res.filesRemoved.length, 1);
  assert.ok(existsSync(join(wt, 'node_modules/pkg/.env')));
  assert.ok(existsSync(join(wt, '.git/.env')));
  assert.ok(!existsSync(join(wt, '.env')));
});

/**
 * AT MOST ONCE PER PROCESS, and silent unless it removed something.
 *
 * It is a migration, not a sweep — nothing can put these files back — so a
 * second pass has nothing to do, and a line saying "cleaned up nothing" on
 * every start for ever on every box that never ran the vault is the
 * standing-readout noise this daemon deletes everywhere else.
 */
test('the boot-path sweep runs once, logs only when it acted, and never throws', () => {
  const said = [];
  const h = home({ cache: true });
  const wt = tree({ '.env': `${HEADER}A=ours\n` });

  const first = sweepVaultArtefactsOnce({ home: h, roots: [wt], log: (m) => said.push(m) });
  assert.equal(first.cacheRemoved, true);
  assert.equal(first.filesRemoved.length, 1);
  assert.equal(said.length, 1, 'one line, because it actually removed something');
  assert.match(said[0], /encrypted env cache/);
  assert.match(said[0], /1 materialized \.env file\b/);

  // A SECOND CALL DOES NOTHING AT ALL — not even a walk.
  const second = tree({ '.env': `${HEADER}B=would-have-gone\n` });
  assert.equal(sweepVaultArtefactsOnce({ home: h, roots: [second], log: (m) => said.push(m) }), null);
  assert.equal(said.length, 1, 'and it says nothing the second time');
  assert.ok(existsSync(join(second, '.env')), 'the second tree is untouched');
});

test('a sweep with nothing to do says nothing', () => {
  // A fresh module instance, because the once-guard above has already fired.
  const fresh = tree({ '.env': 'HAND_WRITTEN=untouched\n' });
  const said = [];
  const res = removeVaultArtefacts({ home: home(), roots: [fresh] });
  assert.equal(res.cacheRemoved, false);
  assert.deepEqual(res.filesRemoved, []);
  assert.deepEqual(said, []);
  assert.ok(existsSync(join(fresh, '.env')));
});
