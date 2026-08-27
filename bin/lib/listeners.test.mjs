import { test } from 'node:test';
import assert from 'node:assert/strict';
import { labelFromArgv, isChosenPort, byChosenThenPort } from './listeners.mjs';

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

/**
 * CHOSEN vs KERNEL-ASSIGNED.
 *
 * `wrangler dev` opens nine listening sockets and exactly one is the dev URL.
 * The driver's report of the real thing: "its hard to discern which one is the
 * one to click to view the dev url." A socket opened on port 0 gets whatever
 * the kernel had free; a port outside that range was named by somebody. That is
 * a fact the box states about itself, not a guess about anybody's stack.
 */
test('a chosen port is one the kernel did not hand out', () => {
  const linux = [32768, 60999]; // this box's real range
  // The driver's actual nine, classified.
  assert.equal(isChosenPort(3001, linux), true); // the dev URL
  assert.equal(isChosenPort(9230, linux), true); // node's inspector
  for (const p of [34051, 45593, 41285, 40529, 45947, 46315, 45971])
    assert.equal(isChosenPort(p, linux), false);
  // macOS starts its range much higher, which is exactly why the range is READ
  // rather than assumed: 34051 is a chosen port on a Mac and is not on Linux.
  assert.equal(isChosenPort(34051, [49152, 65535]), true);
});

test('an unreadable range classifies NOTHING — it never defaults to false', () => {
  // Three states, and this is the one that costs a surface its honesty: absent
  // must reach the browser as absent so it renders today's flat list, not as
  // `false` which would mark every port on the box kernel-assigned.
  assert.equal(isChosenPort(3001, null), undefined);
  assert.equal(isChosenPort(3001, undefined), undefined);
});

/**
 * THE CAP MUST NOT EAT THE ROW THAT MATTERS.
 *
 * Ordering was by port number, which is arbitrary with respect to importance —
 * so a dev server on a high port could be the row the cap dropped, silently,
 * with nothing on the wire saying anything had been cut.
 */
test('chosen ports sort first, so the cut falls on the tail nobody opens', () => {
  const rows = [
    { port: 45947, chosen: false },
    { port: 8080, chosen: true },
    { port: 34051, chosen: false },
    { port: 3001, chosen: true },
  ];
  assert.deepEqual(
    [...rows].sort(byChosenThenPort).map((r) => r.port),
    [3001, 8080, 34051, 45947]
  );
});

test('with no classification the order degrades to the old port sort', () => {
  // An older kernel read, or a platform that would not say: `chosen` is absent
  // on every row and this must stay stable rather than becoming arbitrary.
  const rows = [{ port: 45947 }, { port: 3001 }, { port: 9230 }];
  assert.deepEqual(
    [...rows].sort(byChosenThenPort).map((r) => r.port),
    [3001, 9230, 45947]
  );
});
