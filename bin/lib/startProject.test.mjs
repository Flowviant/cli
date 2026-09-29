/**
 * A REFUSED START MOVES NOTHING — by behaviour, through the real entrypoint.
 *
 * startProject.mjs owns which project a bare `flowviant` serves (SOLID audit
 * 2026-09-26, F053, split out of cli.mjs). startBind.test.mjs pins the ORDER
 * as source; this runs the start headless against a throwaway HOME and repo
 * and asserts each refusal exits 1 in its words with the credential store
 * byte-for-byte what it was — no binding written, nothing forgotten.
 *
 * Run: node --test bin/lib/startProject.test.mjs
 */

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cli = new URL('../cli.mjs', import.meta.url).pathname;
const root = realpathSync(mkdtempSync(join(tmpdir(), 'fv-startproject-')));
after(() => rmSync(root, { recursive: true, force: true }));

function repo(name) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', dir]);
  return dir;
}

function home(name, projects) {
  const h = join(root, name);
  mkdirSync(join(h, '.flowviant'), { recursive: true });
  const file = join(h, '.flowviant', 'credentials.json');
  writeFileSync(file, JSON.stringify({ projects }, null, 2));
  return { h, file, before: readFileSync(file, 'utf8') };
}

function start(h, cwd, args = []) {
  const env = { ...process.env, HOME: h, NO_COLOR: '1', FLOWVIANT_NO_UPDATE: '1' };
  for (const k of ['FLOWVIANT_MACHINE_TOKEN', 'FLOWVIANT_FLEET', 'FLOWVIANT_REEXEC']) delete env[k];
  return new Promise((resolve) => {
    execFile(process.execPath, [cli, ...args], { cwd, env, timeout: 30_000 }, (error, stdout, stderr) =>
      resolve({ code: error ? error.code : 0, stdout, stderr })
    );
  });
}

test('headless, two projects and neither bound here: refused in words, store untouched', async () => {
  const here = repo('unbound');
  const elsewhere = repo('elsewhere');
  const { h, file, before } = home('h-nomatch', {
    'aaaa1111-0000': { fleetToken: 'fva_a', name: 'Alpha', repoRoot: elsewhere },
    'bbbb2222-0000': { fleetToken: 'fva_b', name: 'Beta' },
  });
  const out = await start(h, here);
  assert.equal(out.code, 1, out.stderr);
  assert.match(out.stderr, /more than one project is connected on this machine and this repo is not bound to any of them/);
  assert.match(out.stderr, /Alpha/);
  assert.match(out.stderr, /Beta/);
  assert.equal(readFileSync(file, 'utf8'), before, 'no binding was written');
});

test('two projects bound to this directory: the one-directory refusal, store untouched', async () => {
  const here = repo('taken');
  const { h, file, before } = home('h-taken', {
    'cccc3333-0000': { fleetToken: 'fva_c', name: 'Gamma', repoRoot: here },
    'dddd4444-0000': { fleetToken: 'fva_d', name: 'Delta', repoRoot: here },
  });
  const out = await start(h, here);
  assert.equal(out.code, 1, out.stderr);
  assert.match(out.stderr, /is connected to Gamma and Delta\./);
  assert.equal(readFileSync(file, 'utf8'), before, 'nothing forgotten, nothing rebound');
});

test('the tray start refuses a folder its project is not bound to, store untouched', async () => {
  const bound = repo('bound');
  const other = repo('other');
  const { h, file, before } = home('h-tray', {
    'eeee5555-0000': { fleetToken: 'fva_e', name: 'Epsilon', repoRoot: bound },
  });
  const out = await start(h, root, ['--dir', other, '--json-events', '--project', 'eeee5555-0000']);
  assert.equal(out.code, 1, out.stderr);
  assert.match(out.stderr, /this project is not connected to this repository/);
  assert.equal(readFileSync(file, 'utf8'), before, 'the tray folder was not bound');
});

test('no credential at all: the login sentence, and no store is created', async () => {
  const here = repo('fresh');
  const h = join(root, 'h-empty');
  mkdirSync(h, { recursive: true });
  const out = await start(h, here);
  assert.equal(out.code, 1, out.stderr);
  assert.match(out.stderr, /no credential found/);
  assert.throws(() => readFileSync(join(h, '.flowviant', 'credentials.json')), 'nothing written');
});
