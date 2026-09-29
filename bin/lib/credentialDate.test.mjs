/**
 * THE CONNECTED DATE — a rule with exactly one home now (SOLID audit
 * 2026-09-26, F168), pinned by behaviour at every door that shows it and by
 * source against a copy coming back. The stored-id match (F169) is a
 * credentials rule and is tested in credentials.test.mjs.
 */

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectedOn } from './credentialDate.mjs';

// A fake HOME before credentials.mjs is imported: `homedir()` reads $HOME, and
// node:test gives this file its own process.
const home = mkdtempSync(join(tmpdir(), 'fv-creddate-'));
process.env.HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));
mkdirSync(join(home, '.flowviant'), { recursive: true });
const credFile = join(home, '.flowviant', 'credentials.json');
const SAVED = '2026-09-16T12:00:00.000Z';
const store = {
  projects: {
    '3f2092aa-dead-0000': { fleetToken: 'fva_a', name: 'Acme App', savedAt: SAVED },
    '3f2092bb-live-0000': { fleetToken: 'fva_b', name: 'Acme App' },
    '9c1d44ee-solo-0000': { fleetToken: 'fva_c', name: 'Northwind One', savedAt: 'not a date' },
  },
};
writeFileSync(credFile, JSON.stringify(store));
const creds = await import('./credentials.mjs');

test('absent and unparseable dates stay absent; a real one is a short month and day', () => {
  assert.equal(connectedOn(undefined), null);
  assert.equal(connectedOn(null), null);
  assert.equal(connectedOn(''), null);
  assert.equal(connectedOn('not a date'), null);
  const want = new Date(Date.parse(SAVED)).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  assert.equal(connectedOn(SAVED), want);
  assert.match(want, /^[A-Z][a-z]{2} \d{1,2}$/);
});

test('the picker suffix carries the same date, and drops the clause where there is none', () => {
  const entries = creds.listStoredProjects();
  const a = entries.find((e) => e.projectId.startsWith('3f2092aa'));
  const b = entries.find((e) => e.projectId.startsWith('3f2092bb'));
  assert.equal(creds.projectRowLabel(a, entries), `Acme App (id 3f2092aa…, connected ${connectedOn(SAVED)})`);
  assert.equal(creds.projectRowLabel(b, entries), 'Acme App (id 3f2092bb…)');
});

test('`flowviant projects` prints the same date, and none for an unparseable stamp', async () => {
  const cli = new URL('../cli.mjs', import.meta.url);
  const out = await new Promise((resolve) => {
    execFile(
      process.execPath,
      [cli.pathname, 'projects'],
      { env: { ...process.env, HOME: home, NO_COLOR: '1', FLOWVIANT_NO_UPDATE: '1' }, timeout: 20_000 },
      (error, stdout) => resolve({ code: error ? error.code : 0, stdout })
    );
  });
  assert.equal(out.code, 0);
  assert.ok(out.stdout.includes(`Acme App  (3f2092aa…, connected ${connectedOn(SAVED)})`), out.stdout);
  assert.ok(out.stdout.includes('Acme App  (3f2092bb…)'), out.stdout);
  assert.ok(out.stdout.includes('Northwind One  (9c1d44ee…)'), out.stdout);
});

/** CODE ONLY — the header above quotes the shape it replaced. */
const code = (src) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l))
    .join('\n');

test('the date format has exactly one home', () => {
  const dirs = [new URL('./', import.meta.url), new URL('../', import.meta.url)];
  const files = dirs.flatMap((d) =>
    readdirSync(d)
      .filter((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs'))
      .map((f) => ({ f, src: code(readFileSync(new URL(f, d), 'utf8')) }))
  );
  assert.ok(files.some((x) => x.f === 'credentials.mjs'), 'the walk found the tree (canary)');
  const dateHomes = files.filter((x) => x.src.includes("month: 'short', day: 'numeric'")).map((x) => x.f);
  assert.deepEqual(dateHomes, ['credentialDate.mjs']);
});
