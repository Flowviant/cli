/**
 * `likelyChoiceIndex` — the picker's default row. It PRE-SELECTS and must never
 * be able to auto-serve, so the contract under test is exactly: a UNIQUE
 * name/slug match wins, anything ambiguous or absent returns -1 (start at the
 * top, ask the human).
 *
 * Run: node --test bin/lib/credentials.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { likelyChoiceIndex, projectRowLabel } from './credentials.mjs';

const P = (name) => ({ name, projectId: name ?? 'x' });

test('a unique match on the repo folder name wins', () => {
  const choices = [P('Calendar'), P('Contoso'), P('Ledger')];
  assert.equal(likelyChoiceIndex(choices, { repoBasename: 'contoso' }), 1);
});

test('normalisation collapses spaces, case and punctuation', () => {
  const choices = [P('My Project'), P('other')];
  assert.equal(likelyChoiceIndex(choices, { repoBasename: 'my-project' }), 0);
  assert.equal(likelyChoiceIndex([P('pebble-paws')], { repoBasename: 'PebblePaws' }), 0);
});

test('the github repo-name is a second signal', () => {
  const choices = [P('Mainstreet'), P('Emailleable')];
  // Folder is a generic clone dir, but the origin slug names it.
  assert.equal(
    likelyChoiceIndex(choices, { repoBasename: 'work', repoSlugName: 'emailleable' }),
    1
  );
});

test('two projects with the same name are NOT a hint', () => {
  const choices = [P('api'), P('api')];
  assert.equal(likelyChoiceIndex(choices, { repoBasename: 'api' }), -1);
});

test('no match returns -1', () => {
  const choices = [P('one'), P('two')];
  assert.equal(likelyChoiceIndex(choices, { repoBasename: 'three' }), -1);
});

test('no signal at all returns -1', () => {
  assert.equal(likelyChoiceIndex([P('one')], {}), -1);
  assert.equal(likelyChoiceIndex([P('one')], { repoBasename: null, repoSlugName: null }), -1);
});

test('an unnamed project can never be the hint', () => {
  // name null must not match a null/empty want and pre-select a nameless row.
  assert.equal(likelyChoiceIndex([{ name: null, projectId: 'z' }], { repoBasename: '' }), -1);
});

// ── 0.95.0: two projects on one repo ────────────────────────────────────────

import { boundElsewhere, repoCollisions } from './credentials.mjs';

const E = (projectId, repoRoot, name = 'Acme App') => ({ projectId, repoRoot, name });

/**
 * THE DUPLICATE THE OWNER MET was two PROJECTS bound to ONE checkout, and the
 * store's answer is a fact about the repo: which entries name the same
 * directory. Compared by realpath like every path here; unbound entries
 * collide with nothing, because nothing has decided about them yet.
 */
test('repoCollisions groups entries bound to one directory and ignores the rest', () => {
  const a = E('fa000001', '/home/dev/acme-app');
  const b = E('fb000002', '/home/dev/acme-app/');
  const other = E('f1000003', '/home/dev/code/northwind-one', 'Northwind One');
  const unbound = E('deadbeef', null);
  const groups = repoCollisions([other, a, unbound, b]);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].entries.map((e) => e.projectId), ['fa000001', 'fb000002']);
  assert.equal(groups[0].repoRoot, '/home/dev/acme-app');
  assert.deepEqual(repoCollisions([other, a, unbound]), []);
  assert.deepEqual(repoCollisions([]), []);
});

/**
 * WHAT LOGIN ASKS ABOUT: the projects ALREADY bound to the repo it is running
 * in, other than the one just approved. Re-logging into the same project is an
 * upsert and asks nothing; a login outside any repo has nothing to clash with.
 */
test('boundElsewhere names the other projects on this repo, never the one being logged into', () => {
  const a = E('fa000001', '/home/dev/acme-app');
  const b = E('fb000002', '/home/dev/acme-app');
  const other = E('f1000003', '/home/dev/code/northwind-one', 'Northwind One');
  assert.deepEqual(boundElsewhere([a, other], '/home/dev/acme-app', 'fb000002').map((e) => e.projectId), ['fa000001']);
  assert.deepEqual(boundElsewhere([a, b, other], '/home/dev/acme-app', 'fa000001').map((e) => e.projectId), ['fb000002']);
  assert.deepEqual(boundElsewhere([a, other], '/home/dev/acme-app', 'fa000001'), []);
  assert.deepEqual(boundElsewhere([a, other], null, 'zzz'), []);
  assert.deepEqual(boundElsewhere([a, other], '/somewhere/else', 'zzz'), []);
});

// ── server-supplied names reach a terminal ───────────────────────────────────

import { safeName, projectLabel } from './credentials.mjs';

test('a project name carrying terminal control sequences is printed and stored without them', async () => {
  const osc52 = 'Acme\x1b]52;c;Y3VybCBldmlsfHNoCg==\x07 App\x9b2J';
  assert.equal(safeName(osc52), 'Acme]52;c;Y3VybCBldmlsfHNoCg== App2J');
  assert.ok(!/[\x00-\x1f\x7f-\x9f]/.test(projectLabel({ name: osc52, projectId: 'p1234567890' })));
  // Nothing left is no name, so the id speaks instead of an empty label.
  assert.equal(safeName('\x1b\x07'), null);
  assert.equal(projectLabel({ name: '\x1b\x07', projectId: 'p1234567890' }), 'project p1234567…');
  // …AND THE BIDI/FORMAT CONTROLS A C0/C1-ONLY SCRUB MISSES (2026-09-24, the
  // audit's A3 CROSS 8a): `printable()` extended safeName's own class rather
  // than being re-derived beside it — a name carrying a right-to-left
  // override can visually reorder itself on a bidi-aware terminal.
  assert.equal(safeName('evil‮txt.crt⁦'), 'eviltxt.crt');

  // …and the STORE never keeps the raw form, whichever writer it arrives by.
  const { mkdtempSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const before = process.env.HOME;
  const home = mkdtempSync(join(tmpdir(), 'fv-names-'));
  try {
    process.env.HOME = home;
    const creds = await import(`./credentials.mjs?names=${Date.now()}`);
    creds.saveLogin({ fleetToken: 'fva_x', projectId: 'p-login', name: osc52 });
    creds.saveLogin({ fleetToken: 'fva_y', projectId: 'p-roster', name: 'plain' });
    creds.setStoredProjectName('p-roster', osc52);
    const raw = readFileSync(join(home, '.flowviant', 'credentials.json'), 'utf8');
    assert.ok(!raw.includes('\\u001b') && !raw.includes('\\u0007') && !raw.includes('\x9b'), raw);
  } finally {
    if (before === undefined) delete process.env.HOME;
    else process.env.HOME = before;
  }
});

const entry = (o = {}) => ({
  projectId: 'f1000003-1111-2222-3333-444455556666',
  fleetToken: 'fva_x',
  name: 'Northwind One',
  repoRoot: '/home/dev/code/northwind-one',
  savedAt: null,
  ...o,
});

// ── the picker ──────────────────────────────────────────────────────────────

test('only COLLIDING picker rows gain the id — an ordinary store stays clean', () => {
  const a = entry({ projectId: 'fa000001-aaaa', name: 'Acme App', savedAt: '2026-08-01T12:00:00.000Z' });
  const b = entry({ projectId: 'fb000002-bbbb', name: 'Acme App', savedAt: '2026-09-16T12:00:00.000Z' });
  const c = entry({ projectId: 'c0ffee00-cccc', name: 'Northwind One' });
  const all = [a, b, c];
  assert.match(projectRowLabel(a, all), /^Acme App \(id fa000001…, connected Aug 1\)$/);
  assert.match(projectRowLabel(b, all), /^Acme App \(id fb000002…, connected Sep 16\)$/);
  // The row nothing collides with is untouched: an id on every row is noise on
  // the ordinary case, and noise is what makes the one row that matters
  // unfindable.
  assert.equal(projectRowLabel(c, all), 'Northwind One');
  assert.equal(projectRowLabel(c, [c]), 'Northwind One');
  // A collision with no stored date still gets the id — the id is the
  // disambiguator, the date is only the human-friendly half.
  const d = entry({ projectId: 'dddddddd-dddd', name: 'Acme App', savedAt: null });
  assert.equal(projectRowLabel(d, [d, a]), 'Acme App (id dddddddd…)');
});

// ── forgetting a credential ─────────────────────────────────────────────────

test('--forget removes one entry, clears the legacy mirror, and refuses ambiguity', async () => {
  // A fake HOME so the real credential store is never touched. `homedir()` on
  // this platform reads $HOME, and the query string makes this import a fresh
  // module that reads it.
  const home = mkdtempSync(join(tmpdir(), 'fv-machines-'));
  const before = process.env.HOME;
  process.env.HOME = home;
  try {
    mkdirSync(join(home, '.flowviant'), { recursive: true });
    const file = join(home, '.flowviant', 'credentials.json');
    writeFileSync(
      file,
      JSON.stringify({
        fleetToken: 'fva_dead',
        projectId: '3f2092aa-dead',
        mcpUrl: 'https://x/mcp',
        projects: {
          '3f2092aa-dead': { fleetToken: 'fva_dead', name: 'Contoso' },
          '3f2092bb-live': { fleetToken: 'fva_live', name: 'Northwind One' },
        },
      })
    );
    const creds = await import(`./credentials.mjs?forget=${Date.now()}`);

    // AMBIGUITY REFUSES rather than guessing — this deletes a credential, and two
    // projects that look alike is the case that produced the whole command.
    assert.match(creds.forgetStoredProject('3f209').error ?? '', /no stored project matches/);
    assert.match(creds.forgetStoredProject('3f2092').error ?? '', /matches 2 stored projects/);
    assert.match(creds.forgetStoredProject('nope').error ?? '', /no stored project matches/);
    assert.match(creds.forgetStoredProject('').error ?? '', /empty/);

    const res = creds.forgetStoredProject('3f2092aa-dead');
    assert.equal(res.entry.projectId, '3f2092aa-dead');
    const after = JSON.parse(readFileSync(file, 'utf8'));
    assert.ok(!after.projects['3f2092aa-dead'], 'the entry is gone');
    assert.ok(after.projects['3f2092bb-live'], 'the other one is untouched');
    // THE LEGACY MIRROR GOES WITH IT. Left behind, `listStoredProjects` surfaces
    // the top-level trio as an entry again and the forget silently did not
    // happen — the worst outcome available here.
    assert.equal(after.projectId, undefined);
    assert.equal(after.fleetToken, undefined);
    assert.equal(creds.listStoredProjects().some((e) => e.projectId === '3f2092aa-dead'), false);
  } finally {
    if (before === undefined) delete process.env.HOME;
    else process.env.HOME = before;
    rmSync(home, { recursive: true, force: true });
  }
});

// ── the stored-id match (SOLID audit 2026-09-26, F169) ─────────────────────

/**
 * LOOKUP AND FORGET MAKE THE SAME ID DECISIONS — the full id, or a prefix of
 * at least six characters, and ambiguity refused — because one private rule
 * (`storedProjectsById`) answers for both. Moved here from credentialDate's
 * tests: it is a credentials rule.
 */
test('lookup and forget make the same id decisions: exact, six-character prefix, ambiguity', async () => {
  const before = process.env.HOME;
  const home = mkdtempSync(join(tmpdir(), 'fv-credmatch-'));
  try {
    process.env.HOME = home;
    mkdirSync(join(home, '.flowviant'), { recursive: true });
    const credFile = join(home, '.flowviant', 'credentials.json');
    writeFileSync(
      credFile,
      JSON.stringify({
        projects: {
          '3f2092aa-dead-0000': { fleetToken: 'fva_a', name: 'Acme App' },
          '3f2092bb-live-0000': { fleetToken: 'fva_b', name: 'Acme App' },
          '9c1d44ee-solo-0000': { fleetToken: 'fva_c', name: 'Northwind One' },
        },
      })
    );
    const creds = await import(`./credentials.mjs?match=${Date.now()}`);
    // Read-only probes first; the forget that succeeds runs last.
    for (const [q, want] of [
      ['3f209', /no stored project matches/], // five characters is not a prefix match
      ['3f2092', /matches 2 stored projects — use the full project id/],
      ['zzzzzzzz', /no stored project matches/],
    ]) {
      assert.match(creds.matchStoredProject(q).error ?? '', want, `match ${q}`);
      assert.match(creds.forgetStoredProject(q).error ?? '', want, `forget ${q}`);
    }
    // A unique six-character prefix names one project at both doors.
    assert.equal(creds.matchStoredProject('9c1d44').entry.projectId, '9c1d44ee-solo-0000');
    // A NAME is a lookup and never a delete.
    assert.equal(creds.matchStoredProject('northwind one').entry.projectId, '9c1d44ee-solo-0000');
    assert.match(creds.forgetStoredProject('Northwind One').error ?? '', /no stored project matches/);
    // Each keeps its own empty-input words.
    assert.match(creds.matchStoredProject('').error, /empty --project value/);
    assert.match(creds.forgetStoredProject('  ').error, /empty --forget value/);
    // …and the unique prefix deletes exactly one.
    assert.equal(creds.forgetStoredProject('9c1d44').entry.projectId, '9c1d44ee-solo-0000');
    const after = JSON.parse(readFileSync(credFile, 'utf8'));
    assert.deepEqual(Object.keys(after.projects).sort(), ['3f2092aa-dead-0000', '3f2092bb-live-0000']);
  } finally {
    if (before === undefined) delete process.env.HOME;
    else process.env.HOME = before;
    rmSync(home, { recursive: true, force: true });
  }
});

/** CODE ONLY — headers quote the shapes they replaced. */
const codeOnly = (src) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l))
    .join('\n');

test('the id-prefix rule has exactly one home', () => {
  const dirs = [new URL('./', import.meta.url), new URL('../', import.meta.url)];
  const files = dirs.flatMap((d) =>
    readdirSync(d)
      .filter((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs'))
      .map((f) => ({ f, src: codeOnly(readFileSync(new URL(f, d), 'utf8')) }))
  );
  assert.ok(files.some((x) => x.f === 'credentials.mjs'), 'the walk found the tree (canary)');
  const prefixHomes = files.filter((x) => /projectId\.startsWith\(/.test(x.src)).map((x) => x.f);
  assert.deepEqual(prefixHomes, ['credentials.mjs']);
  const creds = files.find((x) => x.f === 'credentials.mjs').src;
  assert.equal(creds.match(/projectId\.startsWith\(/g).length, 1, 'one spelling of the prefix rule');
});
