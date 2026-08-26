import { test } from 'node:test';
import assert from 'node:assert/strict';
import { labelFromArgv } from './listeners.mjs';

/**
 * WHAT TO CALL A LISTENING PROCESS.
 *
 * `basename(argv[0])` names the RUNTIME, not the program — so half the rows in
 * a JavaScript repo read `node`. "a non developer wouldnt know what node is or
 * workerd."
 *
 * The fix is NOT a lookup table. Mapping `workerd` → "Cloudflare Worker" is the
 * `DEV_ARGV0` shape: a hardcoded list that is wrong for every stack nobody
 * enumerated. argv[1] is always there and needs no list.
 */
test('a label names the program, not just the runtime', () => {
  assert.equal(labelFromArgv(['node', '/p/node_modules/.bin/vite']), 'node vite');
  assert.equal(labelFromArgv(['/usr/bin/node', '/app/server.js']), 'node server.js');
  // A distinctive argv[0] needs no help — and must not be doubled.
  assert.equal(labelFromArgv(['rojo', 'serve']), 'rojo serve');
  assert.equal(labelFromArgv(['/usr/local/bin/workerd']), 'workerd');
});

test('a flag is skipped rather than guessed past', () => {
  // `python3 -m http.server` must not claim to be called `-m`.
  assert.equal(labelFromArgv(['python3', '-m', 'http.server']), 'python3');
  assert.equal(labelFromArgv(['node', '--inspect', 'x.js']), 'node');
});

test('it never relays more than the program name', () => {
  // The whole command line is what `processes.mjs` reports, deliberately and
  // scrubbed. This is a chip in a tab strip; it reads two argv elements and
  // stops, so a long argument list cannot become the label.
  const long = labelFromArgv(['node', 'app.js', '--token', 'hunter2', '--verbose']);
  assert.equal(long, 'node app.js');
  assert.ok(!long.includes('hunter2'));
});

test('a degenerate argv is null, not an empty label', () => {
  assert.equal(labelFromArgv([]), null);
  assert.equal(labelFromArgv(['']), null);
});
