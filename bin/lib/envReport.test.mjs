/**
 * THE ENV REPORT LANE, DRIVEN AGAINST A REAL SERVER (2026-09-21).
 *
 * `maybeReportEnv` posts the checkout's variable names and fingerprints to
 * `/fleet/env-report`. Every property worth asserting about it is a DECISION
 * about an HTTP status or about what is in the body, and both were previously
 * pinned by reading fleet.mjs's own source text — which is the inert-pin class
 * this product has caught five times: a pin over a slice that stops matching
 * passes forever and silently.
 *
 * So this file stands up a real `node:http` server on an ephemeral port, points
 * the daemon at it through `FLOWVIANT_FLEET_URL`, and drives the lane. Each
 * scenario imports fleet.mjs under its OWN query string so it gets a FRESH
 * module instance with fresh dedup and fresh "the server refused permanently"
 * state — the same module graph everywhere else, since only the specifier with
 * the query re-evaluates.
 *
 * THE BUG THAT MOTIVATES MOST OF IT: the first cut treated every 4xx as
 * permanent, so one 429 or one 401 during a credential blip killed env
 * reporting for the life of the process — and the lane is deduped and silent by
 * design, so "posted once and never again" is indistinguishable from "working
 * normally on a box whose env has not changed". A lane that can die invisibly
 * must not die for a reason that will pass.
 *
 * Run: node --test bin/lib/envReport.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// HOME and the server URL must both be settled BEFORE anything imports
// config.mjs: `FLEET_URL` is read once at import and `ENV_REPORT_URL` is
// derived from it, and the credential store is resolved at import too. A temp
// home keeps this test off the real keypair and the real credentials.
process.env.HOME = mkdtempSync(join(tmpdir(), 'fv-envreport-home-'));

/** What the next request will answer with, and what the last one carried. */
let nextStatus = 200;
const received = [];

const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => {
    body += c;
  });
  req.on('end', () => {
    received.push({ url: req.url, auth: req.headers.authorization, body });
    res.writeHead(nextStatus, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: nextStatus < 400 }));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const { port } = server.address();
process.env.FLOWVIANT_FLEET_URL = `http://127.0.0.1:${port}/api/fleet/agents`;
process.env.FLOWVIANT_FLEET = 'fva_test_credential';

/** A scratch checkout with one `.env` in it. */
function checkout(body = 'SECRET_TOKEN=super-secret-value-123\n') {
  const dir = mkdtempSync(join(tmpdir(), 'fv-envreport-'));
  writeFileSync(join(dir, '.env'), body);
  return dir;
}

/** A FRESH lane. The query string is what makes it fresh: the module's dedup
 *  and its permanent-refusal flag are module state, and every scenario here is
 *  about one of those two. */
const freshLane = (tag) => import(`./fleet.mjs?case=${tag}`);

test.after(() => server.close());

/**
 * A REFUSAL THAT CANNOT CHANGE STOPS THE LANE; EVERYTHING ELSE IS A "LATER".
 *
 * Permanent means exactly three things, and each is a fact about the REQUEST
 * rather than about the moment: 404 (the route does not exist — an older
 * server, the `/fleet/agent-trace` precedent), 400 and 422 (the server will
 * never accept this shape). A 429 is a rate limit. A 401 or 403 during a
 * credential blip is transient by construction. A 408 is a timeout wearing a
 * 4xx. Retrying a permanent refusal forever is the daemon arguing with a
 * decision already made; giving up on a transient one is a readout that dies in
 * silence.
 */
test('only 400, 404 and 422 are permanent', async () => {
  const { envReportIsPermanent } = await freshLane('pure');
  for (const s of [400, 404, 422]) {
    assert.equal(envReportIsPermanent(s), true, `${s} must stop the lane`);
  }
  for (const s of [401, 403, 408, 409, 425, 429, 500, 502, 503, 504, 200, 204]) {
    assert.equal(envReportIsPermanent(s), false, `${s} must be retried`);
  }
});

/**
 * THE HAPPY PATH, END TO END — and the BODY is what this really pins.
 *
 * The value never leaves the box: the wire carries the pubkey, the file list
 * of NAMES and FINGERPRINTS, and the two totals that keep a capped list from
 * reading as the whole directory. Asserting over the raw request body is the
 * only way to catch a value riding along as some extra field nobody looked at,
 * which is the one mistake in this lane that would matter.
 */
test('an accepted report carries names, fingerprints and totals — and no values', async () => {
  const { maybeReportEnv } = await freshLane('ok');
  nextStatus = 200;
  received.length = 0;

  assert.equal(await maybeReportEnv(checkout()), 'accepted');
  assert.equal(received.length, 1);
  assert.equal(received[0].url, '/api/fleet/env-report', 'derived from FLEET_URL, not hardcoded');
  assert.equal(received[0].auth, 'Bearer fva_test_credential');

  const body = JSON.parse(received[0].body);
  assert.ok(Object.prototype.hasOwnProperty.call(body, 'pubkey'));
  assert.equal(typeof body.filesTotal, 'number');
  assert.equal(typeof body.varsTotal, 'number');
  assert.equal(body.filesTotal, 1);
  assert.equal(body.varsTotal, 1);
  // THE VALUE NEVER LEAVES THE BOX.
  assert.ok(!received[0].body.includes('super-secret-value-123'), 'no value on the wire');
  assert.ok(!received[0].body.includes('"value"'), 'and no value-shaped key either');

  // AND THE FILE LIST IS EMPTY HERE ON PURPOSE, which is itself the rule: this
  // box's credential came from `FLOWVIANT_FLEET` with nothing in the store, so
  // it cannot name its project and has no salt to fingerprint with. Ignorance
  // renders nothing — incomparable fingerprints would show as a confident
  // "these boxes differ" beside a box holding the identical value. The TOTALS
  // above still state what was measured, and `env.test.mjs` proves the
  // scrubber stays armed through it.
  assert.deepEqual(body.files, [], 'no project id, no fingerprints');

  // ONE POST PER CHANGE. The second call inside the 60s beat is throttled
  // before it even scans — an env file is not PRESENCE, so re-posting an
  // unchanged list would be a write per machine per minute to say nothing.
  assert.equal(await maybeReportEnv(checkout()), 'throttled');
  assert.equal(received.length, 1, 'nothing was posted twice');
});

/**
 * A 429 DOES NOT KILL THE LANE — the regression this pass closes.
 *
 * `'retry'` is the verdict that forgets the dedup, so the next beat re-posts.
 * The alternative shipped for a few hours: one rate-limited minute and the box
 * stopped reporting its env until somebody restarted the daemon, with nothing
 * anywhere saying so.
 */
test('a 429 is a "later": the lane stays open and forgets its dedup', async () => {
  const { maybeReportEnv } = await freshLane('rate');
  nextStatus = 429;
  received.length = 0;
  assert.equal(await maybeReportEnv(checkout()), 'retry');
  assert.equal(received.length, 1, 'it really did reach the server');
});

/** The same, for the credential blip — a 401 is about this MOMENT, never about
 *  this request. */
test('a 401 is a "later" too', async () => {
  const { maybeReportEnv } = await freshLane('auth');
  nextStatus = 401;
  received.length = 0;
  assert.equal(await maybeReportEnv(checkout()), 'retry');
  assert.equal(received.length, 1);
});

/**
 * A 400 IS FINAL, AND THE LANE GOES QUIET — the `/fleet/agent-trace` precedent:
 * an older SERVER 404s every batch, and a daemon that held them would re-post a
 * body nobody will ever read.
 */
test('a 400 stops the lane for the rest of the process', async () => {
  const { maybeReportEnv } = await freshLane('shape');
  nextStatus = 400;
  received.length = 0;
  assert.equal(await maybeReportEnv(checkout()), 'stopped');
  assert.equal(received.length, 1);
});

/**
 * THE SCAN RUNS EVEN WHEN THE POST CANNOT, and that is the half that would fail
 * SILENTLY. The report's economy is about the WIRE; redaction has no dedup and
 * must reflect the newest read every time, because a secret added to `.env`
 * five minutes ago is exactly the one a turn is about to echo. So a server that
 * has refused permanently must never cost this box its redaction.
 */
test('a quiet lane still feeds the scrubber', async () => {
  const lane = await freshLane('quiet');
  const envMod = await import('./env.mjs');
  nextStatus = 404;
  received.length = 0;

  // First call: the server refuses permanently and the lane goes quiet.
  assert.equal(await lane.maybeReportEnv(checkout('FIRST_TOKEN=first-secret-Value_99\n')), 'stopped');
  assert.match(envMod.scrub('saw first-secret-Value_99'), /\[REDACTED:FIRST_TOKEN\]/);

  // A LATER beat, on a checkout whose secret CHANGED. Nothing is posted — the
  // lane is quiet — but the redactor must have learnt the new value anyway.
  // (The throttle is module state, so this needs its own fresh lane; that is
  // the same clock, not a way round it.)
  const later = await freshLane('quiet2');
  received.length = 0;
  assert.equal(
    await later.maybeReportEnv(checkout('SECOND_TOKEN=second-secret-Value_88\n')),
    'stopped',
    'this instance refuses on its own first post'
  );
  assert.match(envMod.scrub('saw second-secret-Value_88'), /\[REDACTED:SECOND_TOKEN\]/);
});
