/**
 * The frame rules, headers in → headers out, no server running.
 * `authproxy.test.mjs` proves the proxy APPLIES them to a real response; this
 * file pins what they say.
 *
 * Run: node --test bin/lib/previewFramePolicy.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appOriginOf, grantCookieSite, rewriteFramePolicy } from './previewFramePolicy.mjs';

const APP = 'https://app.flowviant.com';
const OURS = `frame-ancestors 'self' ${APP}`;

test('the app origin comes from the authorize URL, only in grant mode', () => {
  assert.equal(appOriginOf(true, 'https://app.flowviant.com/api/preview/authorize?x=1'), APP);
  assert.equal(appOriginOf(false, 'https://app.flowviant.com/api/preview/authorize'), null);
  // An unparseable URL is no origin — and no origin rewrites nothing.
  assert.equal(appOriginOf(true, 'not a url'), null);
});

test('a framed navigation gets a Partitioned None cookie; everything else Lax', () => {
  for (const dest of ['iframe', 'frame', 'embed', 'object', 'IFRAME']) {
    assert.equal(grantCookieSite(dest), 'SameSite=None; Partitioned', dest);
  }
  // Safari 18.5–26.1 drops any cookie carrying Partitioned, so a top-level
  // visit — or a browser too old to say — never gets it.
  for (const dest of ['document', '', undefined, null, 'empty']) {
    assert.equal(grantCookieSite(dest), 'SameSite=Lax', String(dest));
  }
});

test('no app origin (password-only) rewrites nothing — the same object comes back', () => {
  const h = { 'x-frame-options': 'DENY', 'content-security-policy': "frame-ancestors 'none'" };
  assert.equal(rewriteFramePolicy(h, null), h);
  assert.deepEqual(h, { 'x-frame-options': 'DENY', 'content-security-policy': "frame-ancestors 'none'" });
});

test('an existing directive is REWRITTEN in place and XFO is dropped', () => {
  const h = {
    'x-frame-options': 'DENY',
    'content-security-policy': "default-src 'self'; frame-ancestors 'none'; img-src data:",
    'content-type': 'text/html',
  };
  const out = rewriteFramePolicy(h, APP);
  assert.equal(out['x-frame-options'], undefined);
  assert.equal(out['content-security-policy'], `default-src 'self'; ${OURS}; img-src data:`);
  assert.equal(out['content-type'], 'text/html');
  // The input is not edited — the caller's headers object stays the origin's.
  assert.equal(h['x-frame-options'], 'DENY');
});

test('no frame-ancestors anywhere → ours is APPENDED as its own policy', () => {
  assert.deepEqual(rewriteFramePolicy({}, APP), { 'content-security-policy': OURS });
  assert.deepEqual(rewriteFramePolicy({ 'content-security-policy': "default-src 'self'" }, APP), {
    'content-security-policy': ["default-src 'self'", OURS],
  });
  assert.deepEqual(rewriteFramePolicy({ 'content-security-policy': ["default-src 'self'"] }, APP), {
    'content-security-policy': ["default-src 'self'", OURS],
  });
});

test('comma-joined policies are split on both levels — the neighbour keeps its head', () => {
  const out = rewriteFramePolicy(
    { 'content-security-policy': "script-src 'self'; frame-ancestors 'none', default-src 'self'; img-src data:" },
    APP
  );
  assert.equal(
    out['content-security-policy'],
    `script-src 'self'; ${OURS}, default-src 'self'; img-src data:`
  );
});

test('an array of CSP headers is rewritten element by element', () => {
  const out = rewriteFramePolicy(
    { 'content-security-policy': ["frame-ancestors 'none'", "default-src 'self'"] },
    APP
  );
  assert.deepEqual(out['content-security-policy'], [` ${OURS}`, "default-src 'self'"]);
});

test('Report-Only is left alone — rewriting a report channel edits telemetry', () => {
  const out = rewriteFramePolicy({ 'content-security-policy-report-only': "frame-ancestors 'none'" }, APP);
  assert.equal(out['content-security-policy-report-only'], "frame-ancestors 'none'");
  // …and, having seen no enforced directive, ours is still added.
  assert.equal(out['content-security-policy'], OURS);
});
