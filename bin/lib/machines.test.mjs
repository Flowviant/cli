/**
 * HOW MANY DAEMONS DO I HAVE RUNNING — the box registry's daemon half (0.91.0):
 * the machine ask on the poll, the two `/fleet/boxes` requests
 * (`machines.mjs`) and the `machines` command's wiring in machinesCommand.mjs.
 *
 * The owner, verbatim: "we need to design a solution for when users lose track
 * of how many daemons are connected in their device… is there a way to view ALL
 * the connected flowviants? because im not sure if i have any duplicate or
 * redundant daemons running". Production the same day held four daemons on two
 * boxes and two projects with the SAME NAME bound to the same checkout, which
 * is why the picker there offered two identical rows.
 *
 *  · THE ASK IS SPENT ONCE, AND ONLY ON A DELIVERED POLL. One ask per process
 *    is the entire reason `claim=1` cannot make two boxes trade a machine back
 *    and forth; spending it on an ATTEMPTED poll would silently lose the claim
 *    of a daemon that started while the wire was down.
 *  · EVERY ANSWER IS A SHAPE, never a throw, and a rejected credential, an edge
 *    page and an older server are three different shapes.
 *
 * The listing's tests live in machineListing.test.mjs, the disconnect's in
 * machineDisconnect.test.mjs, and the stored-credential rules (picker label,
 * --forget) in credentials.test.mjs — each beside the module it tests (SOLID
 * audit 2026-09-26, F056).
 *
 * Run: node --test bin/lib/machines.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { boxesUrlFrom, classifyMachineResponse, fetchBoxesFor, leaveBoxFor, leaveUrlFrom } from './machines.mjs';
import { machineAskPending, spendMachineAsk } from './fleetRoster.mjs';

/** CODE ONLY — the comments quote the shapes they replaced, and a source pin
 *  that matches its own documentation trains the next person to weaken it.
 *  The poll and its machine ask live in fleetRoster.mjs; the loop that calls
 *  it is fleet.mjs (split 2026-09-26, SOLID F038). */
const codeOf = (file) =>
  readFileSync(new URL(`./${file}`, import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .join('\n');
const rosterSource = () => codeOf('fleetRoster.mjs');
const fleetSource = () => codeOf('fleet.mjs');

/** BOTH anchors asserted before the cut: an `indexOf` that missed returns -1,
 *  and an empty slice passes every `includes` you can write against it. */
const between = (src, from, to, what) => {
  const a = src.indexOf(from);
  assert.ok(a >= 0, `${what}: anchor not found — ${from}`);
  const b = src.indexOf(to, a + 1);
  assert.ok(b > a, `${what}: closing anchor not found after it — ${to}`);
  return src.slice(a, b);
};

const box = (o = {}) => ({
  boxId: 'B1',
  boxName: 'vm-dev-1',
  checkoutPath: '/home/dev/northwind-one',
  daemonVersion: '0.91.0',
  pid: 4242,
  processStartedAt: null,
  firstHeardAt: new Date(0).toISOString(),
  lastHeardAt: new Date().toISOString(),
  role: 'serving',
  fresh: true,
  behind: false,
  ...o,
});
const entry = (o = {}) => ({
  projectId: 'f1000003-1111-2222-3333-444455556666',
  fleetToken: 'fva_x',
  name: 'Northwind One',
  repoRoot: '/home/dev/code/northwind-one',
  savedAt: null,
  ...o,
});

// ── the ask ─────────────────────────────────────────────────────────────────

test('the machine ask is pending until a DELIVERED poll spends it, then never again', () => {
  // The default: a process that has not polled yet is asking. This is what puts
  // `claim=1` on the first poll and what the owner's "it should kill the first
  // one and take over" reduces to on the wire.
  assert.equal(machineAskPending(), true);
  // Asking does not consume — a poll that never reached the server must keep
  // the claim, or the box somebody walked over to and started never takes the
  // machine and nothing anywhere says why.
  assert.equal(machineAskPending(), true);
  spendMachineAsk();
  assert.equal(machineAskPending(), false);
  // Idempotent: a second delivered poll cannot un-spend it.
  spendMachineAsk();
  assert.equal(machineAskPending(), false);
});

test('the poll sets claim from the PENDING read and spends it only after res.ok', () => {
  const src = rosterSource();
  // The param is gated on the non-consuming read…
  assert.ok(
    src.includes("if (machineAskPending()) url.searchParams.set('claim', '1');"),
    'the claim param is set from the pending read'
  );
  // …and the spend happens after the response was accepted, never where the
  // param is built. Both anchors asserted; the region is the delivery check.
  const region = between(
    src,
    'if (!res.ok) throw new Error(`fleet poll failed',
    'const body = await res.json();',
    'the ask is spent on a delivered poll'
  );
  assert.ok(region.includes('spendMachineAsk();'), 'spent after the poll was answered');
  // A single spend site: two would mean one of them is on a path that did not
  // deliver, which is the bug this ordering exists to prevent. `toBe`-shaped,
  // never "at most one" — `<=` cannot tell one writer from a pattern that
  // stopped matching.
  // The semicolon is what separates the CALL from the `export function
  // spendMachineAsk() {` declaration two hundred lines up.
  assert.equal(src.split('spendMachineAsk();').length - 1, 1);
});

test('the poll reports the checkout, the pid and the process start', () => {
  const src = rosterSource();
  const region = between(
    src,
    "url.searchParams.set('mh', MACHINE_HOST)",
    "url.searchParams.set('claim', '1')",
    'the box-identity params'
  );
  // `cp` is what makes two daemons on ONE box legible — the owner runs a daemon
  // per project directory on purpose — and it is BOUNDED, because a query
  // string is not a log.
  assert.ok(region.includes("url.searchParams.set('cp', String(repoRoot).slice(0, 256))"));
  assert.ok(region.includes("url.searchParams.set('pid', String(process.pid))"));
  assert.ok(region.includes("url.searchParams.set('st', PROCESS_STARTED_AT)"));
  // The checkout is PASSED IN, never re-derived: running git on every poll to
  // re-learn a value resolved once at startup would be a syscall for a readout.
  assert.ok(/repoRoot = null,\s*\n\s*baseRef = null\s*\n\s*\) \{/.test(src), 'repoRoot and baseRef are fetchRoster parameters');
  assert.ok(fleetSource().includes('admit(\'churn\'),\n        repoRoot,\n        getBaseRef()\n      );'), 'the loop passes it');
});

// ── the requests ────────────────────────────────────────────────────────────

test('the boxes URL is the roster URL with its last segment swapped', () => {
  assert.equal(boxesUrlFrom('https://api.flowviant.com/api/fleet/agents'), 'https://api.flowviant.com/api/fleet/boxes');
  assert.equal(boxesUrlFrom('https://x/api/v2/fleet/agents/'), 'https://x/api/v2/fleet/boxes');
});

test('a fetch failure is a SHAPE, never a throw — one dead project keeps the listing', async () => {
  const seen = [];
  const fake = (status, body) => async (url) => {
    seen.push(String(url));
    return {
      status,
      ok: status >= 200 && status < 300,
      headers: { get: () => 'application/json' },
      json: async () => body,
    };
  };
  assert.deepEqual(
    await fetchBoxesFor(entry(), { url: 'https://x/fleet/boxes', fetchImpl: fake(401, { success: false, error: {} }) }),
    { rejected: true }
  );
  assert.deepEqual(await fetchBoxesFor(entry(), { url: 'https://x/fleet/boxes', fetchImpl: fake(404) }), {
    unsupported: true,
  });
  assert.deepEqual(await fetchBoxesFor(entry(), { url: 'https://x/fleet/boxes', fetchImpl: fake(500) }), {
    error: 'HTTP 500',
  });
  // A 200 with the wrong shape is not boxes — the roster poll's own rule.
  assert.deepEqual(
    await fetchBoxesFor(entry(), { url: 'https://x/fleet/boxes', fetchImpl: fake(200, { data: {} }) }),
    { error: 'unexpected answer shape' }
  );
  const ok = await fetchBoxesFor(entry(), {
    url: 'https://x/fleet/boxes',
    envpub: 'PUB',
    fetchImpl: fake(200, { data: { boxes: [box()], latest: '0.91.0', me: 'PUB' } }),
  });
  assert.equal(ok.boxes.length, 1);
  assert.equal(ok.me, 'PUB');
  // The caller's own box id rides the query, so the server can echo it back and
  // the listing can mark "← this box" without matching base64 by hand.
  assert.ok(seen.some((u) => u.includes('envpub=PUB')));
  // And a thrown fetch is caught into the same shape.
  const boom = await fetchBoxesFor(entry(), {
    url: 'https://x/fleet/boxes',
    fetchImpl: async () => {
      throw new Error('ENOTFOUND');
    },
  });
  assert.match(boom.error, /ENOTFOUND/);
});

test('the leave URL is the boxes URL with the verb on the end', () => {
  assert.equal(leaveUrlFrom('https://api.flowviant.com/api/fleet/agents'), 'https://api.flowviant.com/api/fleet/boxes/leave');
});

/**
 * FOUR ANSWERS FROM THE SERVER, FOUR SHAPES — and the two that matter most are
 * the ones a lazy collapse would merge: a 404 is an OLDER SERVER that has the
 * read and not the verb (the row goes quiet on its own), a 401 is a credential
 * the app already killed (nothing to leave). Never a throw: one failed leave
 * must not abort the forget that follows it.
 */
test('leaving a project posts our own box id and answers in shapes, never throws', async () => {
  const calls = [];
  const fetchImpl = (status, body) => async (url, init) => {
    calls.push({ url: String(url), init });
    return {
      status,
      ok: status >= 200 && status < 300,
      headers: { get: (h) => (h.toLowerCase() === 'content-type' ? 'application/json' : null) },
      json: async () => body,
    };
  };
  const e = entry();
  const ok = await leaveBoxFor(e, { url: 'https://x/fleet/boxes/leave', envpub: 'ME', fetchImpl: fetchImpl(200, { data: { removed: true, wasHolder: true } }) });
  assert.deepEqual(ok, { removed: true, wasHolder: true });
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(JSON.parse(calls[0].init.body).envpub, 'ME');
  assert.match(calls[0].init.headers.Authorization, /^Bearer fva_x$/);
  assert.deepEqual(await leaveBoxFor(e, { url: 'https://x', envpub: 'ME', fetchImpl: fetchImpl(401, { success: false, error: { message: 'Token revoked' } }) }), { rejected: true });
  // An edge 403 (an HTML challenge page) is not the app rejecting the
  // credential, and must not read as "already disconnected".
  const edge = async () => ({ status: 403, ok: false, headers: { get: () => 'text/html' }, json: async () => { throw new Error('html'); } });
  assert.deepEqual(await leaveBoxFor(e, { url: 'https://x', envpub: 'ME', fetchImpl: edge }), { error: 'HTTP 403 from something in front of the app' });
  assert.deepEqual(await leaveBoxFor(e, { url: 'https://x', envpub: 'ME', fetchImpl: fetchImpl(404, {}) }), { unsupported: true });
  assert.deepEqual(await leaveBoxFor(e, { url: 'https://x', envpub: 'ME', fetchImpl: fetchImpl(500, {}) }), { error: 'HTTP 500' });
  assert.deepEqual(await leaveBoxFor(e, { url: 'https://x', envpub: 'ME', fetchImpl: fetchImpl(200, { data: {} }) }), { error: 'unexpected answer shape' });
  assert.deepEqual(await leaveBoxFor(e, { url: 'https://x', envpub: 'ME', fetchImpl: async () => { throw new Error('ECONNRESET'); } }), { error: 'ECONNRESET' });
  // NO IDENTITY, NO CALL: a box that never ran a daemon never polled, so there
  // is no row to remove and nothing to send.
  assert.deepEqual(await leaveBoxFor(e, { url: 'https://x', envpub: null, fetchImpl: async () => { throw new Error('must not be called'); } }), { skipped: true });
});

// ── the two things the review caught, each of which shipped green ───────────

/**
 * A RESTART IS NOT A PERSON — the auto-update that stole a machine.
 *
 * `update.mjs` re-execs with `FLOWVIANT_REEXEC='1'` after an UNATTENDED update,
 * which is on by default. Born asking, the new process would have taken the
 * project's machine off a live holder in the middle of the night and settled
 * its running turns as moved, because npm published a patch. The ask belongs to
 * a person typing `npx flowviant`; a re-exec is that same start continuing.
 */
test('a re-executed daemon is born with the machine ask already spent', async () => {
  const before = process.env.FLOWVIANT_REEXEC;
  try {
    // A distinct module URL is a distinct module instance — the only way to
    // watch a module-level `let` being initialised twice in one process.
    process.env.FLOWVIANT_REEXEC = '1';
    const reexeced = await import('./fleetRoster.mjs?fv-reexec=1');
    assert.equal(reexeced.machineAskPending(), false, 'a re-exec asks for nothing');

    delete process.env.FLOWVIANT_REEXEC;
    const started = await import('./fleetRoster.mjs?fv-reexec=0');
    assert.equal(started.machineAskPending(), true, 'a person starting it still asks');

    // Anything other than the literal '1' is not a re-exec: the env var is
    // written by us, and a truthiness read here would let a stray value in
    // somebody's shell silently disarm the claim.
    process.env.FLOWVIANT_REEXEC = 'yes';
    const odd = await import('./fleetRoster.mjs?fv-reexec=odd');
    assert.equal(odd.machineAskPending(), true);
  } finally {
    if (before === undefined) delete process.env.FLOWVIANT_REEXEC;
    else process.env.FLOWVIANT_REEXEC = before;
  }
});

test('the updater is what sets the variable the ask reads', () => {
  // THE COUPLING, pinned at the other end: this fix is worth nothing if the
  // re-exec ever stops carrying the flag, and that is one line in a file
  // nobody editing fleetRoster.mjs is looking at.
  const update = readFileSync(new URL('./update.mjs', import.meta.url), 'utf8');
  assert.ok(update.includes("FLOWVIANT_REEXEC: '1'"), 'the re-exec still marks itself');
});

/**
 * LISTING MUST NOT ENROL. `flowviant machines` called `ensureKeypair()`, which
 * on a box with no keypair MINTS one — a 0600 write establishing that machine's
 * durable identity — from a command whose entire job is to print a list. The
 * view-only narrowness is what allowed a third terminal command to exist at
 * all.
 */
test('reading this box’s public key creates nothing', async () => {
  const before = process.env.HOME;
  const home = mkdtempSync(join(tmpdir(), 'fv-pubread-'));
  try {
    process.env.HOME = home;
    const env = await import(`./boxIdentity.mjs?fv-pub=${Date.now()}`);
    // No file, no directory: null, and nothing on disk.
    assert.equal(env.readStoredPubB64(), null);
    assert.equal(existsSync(join(home, '.flowviant', 'env-keypair.json')), false);

    mkdirSync(join(home, '.flowviant'), { recursive: true });
    writeFileSync(
      join(home, '.flowviant', 'env-keypair.json'),
      JSON.stringify({ pub: 'PUBKEY_B64', priv: 'PRIVKEY_B64' })
    );
    assert.equal(env.readStoredPubB64(), 'PUBKEY_B64');

    // Malformed is NULL, never a throw and never a rewrite: the only cost of
    // not knowing is that no row wears "← this box".
    writeFileSync(join(home, '.flowviant', 'env-keypair.json'), '{not json');
    assert.equal(env.readStoredPubB64(), null);
    assert.equal(readFileSync(join(home, '.flowviant', 'env-keypair.json'), 'utf8'), '{not json');
  } finally {
    if (before === undefined) delete process.env.HOME;
    else process.env.HOME = before;
  }
});

/**
 * THE `machines` COMMAND'S BODY, comments stripped. It lives in
 * machinesCommand.mjs since the SOLID split (2026-09-26, F053); cli.mjs only
 * dispatches to it, and is asserted to keep none of the body.
 */
const stripComments = (src) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l))
    .join('\n');
const machinesSource = () => stripComments(readFileSync(new URL('./machinesCommand.mjs', import.meta.url), 'utf8'));
const machinesBranch = (src) => between(src, 'export async function runMachinesCommand() {', '\n}\n', 'the machines command');

test('cli.mjs dispatches `machines` to its module and keeps none of the body', () => {
  const cli = stripComments(readFileSync(new URL('../cli.mjs', import.meta.url), 'utf8'));
  const handler = between(cli, 'async function machinesCommand() {', '\n}\n', 'the machines handler');
  assert.ok(handler.includes("await import('./lib/machinesCommand.mjs')"), 'it imports the module');
  assert.ok(handler.includes('await runMachinesCommand();'), 'and runs it');
  for (const body of ['disconnectHere(', 'selectMenu(', 'forgetStoredProject(', 'fetchBoxesFor(', 'readStoredPubB64(']) {
    assert.ok(!cli.includes(body), `no copy of ${body} in cli.mjs`);
  }
});

test('the `machines` command never reaches for a keypair it would have to create', () => {
  const cli = machinesSource();
  const branch = machinesBranch(cli);
  assert.ok(branch.includes('readStoredPubB64()'), 'it reads the stored key');
  assert.ok(!branch.includes('ensureKeypair'), 'and never mints one');
});

// ── the command's wiring ───────────────────────────────────────────────────

/**
 * THE CLI'S WIRING: the menu is gated on BOTH `canPrompt()` and
 * `menuSupported()` (a pipe gets the listing and the flags, a backgrounded
 * job is never asked), `--remove` runs the same `disconnectHere` the menu
 * does, and the listing is RE-ASKED of the server after a verb rather than
 * redrawn from what this process hoped happened.
 */
test('the `machines` menu exists only where a person can drive it, and re-asks the server after a verb', () => {
  const cli = machinesSource();
  const branch = machinesBranch(cli);
  assert.ok(branch.includes('if (!(canPrompt() && menuSupported())) {'), 'both gates, together');
  // The non-menu exit prints the flags, so a script's reader learns the verbs.
  const noMenu = between(branch, 'if (!(canPrompt() && menuSupported())) {', 'process.exit(0);', 'the no-menu exit');
  assert.ok(noMenu.includes('MACHINES_FLAGS_FOOTER'));
  // One disconnect implementation for the flag and the menu.
  assert.equal(branch.split('disconnectHere(').length - 1, 2, '--remove and the menu, nothing else');
  // After a verb, the server is asked again.
  const loop = between(branch, 'for (;;) {', 'for (const line of MACHINES_FOOTER) console.log(line);', 'the menu loop');
  assert.ok(loop.includes('await listing();'), 're-fetched, never redrawn from hope');
  assert.ok(loop.includes('entries = creds.listStoredProjects();'), 're-read the store too');
  // Two verbs and a way back, in that order — the destructive one first is what
  // the person came for, and "back" is never the default row.
  assert.ok(/disconnect this box from \$\{who\}[\s\S]*forget \$\{who\} here only[\s\S]*'back',/.test(loop));
  // --remove refuses ambiguity through the same matcher --project uses.
  assert.ok(branch.includes("creds.matchStoredProject(process.argv[removeAt + 1])"));
});

// ── one classification for both requests (SOLID audit 2026-09-26, F170) ─────

/**
 * THE READ AND THE LEAVE CLASSIFY A REFUSAL THE SAME WAY. They used to spell
 * the five decisions twice; `classifyMachineResponse` is the one home now, and
 * this pairs the two doors over every refusal so a third spelling, or a drift
 * in one, fails here.
 */
test('the boxes read and the leave classify every refusal identically', async () => {
  const json = (status, body) => async () => ({
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (h) => (h.toLowerCase() === 'content-type' ? 'application/json' : null) },
    json: async () => body,
  });
  const edge = async () => ({ status: 403, ok: false, headers: { get: () => 'text/html' }, json: async () => { throw new Error('html'); } });
  const cases = [
    ['app rejection', json(401, { success: false, error: {} }), { rejected: true }],
    ['edge 403', edge, { error: 'HTTP 403 from something in front of the app' }],
    ['older server', json(404, {}), { unsupported: true }],
    ['server error', json(502, {}), { error: 'HTTP 502' }],
    ['transport', async () => { throw new Error('ENOTFOUND api'); }, { error: 'ENOTFOUND api' }],
  ];
  for (const [what, fetchImpl, want] of cases) {
    const read = await fetchBoxesFor(entry(), { url: 'https://x/fleet/boxes', fetchImpl });
    const leave = await leaveBoxFor(entry(), { url: 'https://x/fleet/boxes/leave', envpub: 'ME', fetchImpl });
    assert.deepEqual(read, want, `read: ${what}`);
    assert.deepEqual(leave, want, `leave: ${what}`);
  }
  // An OK is not a refusal: the caller reads its own body.
  assert.equal(await classifyMachineResponse(await json(200, { data: {} })()), null);
});

test('the refusal classification has exactly one home', () => {
  const code = readFileSync(new URL('./machines.mjs', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .join('\n');
  assert.match(code, /export async function classifyMachineResponse\(res\)/, 'reading the real module');
  assert.equal(code.split('credentialRejected(res)').length - 1, 1, 'one credential check');
  assert.equal(code.split('from something in front of the app').length - 1, 1, 'one edge sentence');
  assert.equal(code.split('res.status === 404').length - 1, 1, 'one older-server rule');
});
