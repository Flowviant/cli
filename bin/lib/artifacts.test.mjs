/**
 * THE ARTIFACT RELAY, against a real temp directory and a fake server
 * (2026-09-22, 0.94.0).
 *
 * Behavioural wherever the claim is behaviour: files go on a disk, a turn
 * "runs" by writing more, and the assertions read what was POSTed — which
 * files, with which fields, scrubbed or not, held or dropped. The one text pin
 * at the foot is over WIRING (both lanes report, capture does not), which only
 * the source can answer without spawning a CLI.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ARTIFACT_DIR,
  artifactMaxBytesFor,
  ARTIFACT_MAX_FILES,
  buildArtifactUpload,
  changedArtifacts,
  scanArtifacts,
  snapshotArtifacts,
} from './artifacts.mjs';
import {
  ARTIFACTS_PARAGRAPH,
  SYSTEM_AGENT,
  SYSTEM_WORK,
  SYSTEM_WORK_PLAIN,
  withProjectContext,
} from './prompts.mjs';
import { ARTIFACT_MAX_BYTES, ARTIFACT_BINARY_MODEL_MAX_BYTES } from './artifactPolicy.mjs';
import { scanEnvForScrub } from './env.mjs';
import { scrub as envScrub, secretIn as envSecretIn } from './uplinkScrub.mjs';

const place = () => {
  const d = mkdtempSync(join(tmpdir(), 'fv-artifacts-'));
  mkdirSync(join(d, ARTIFACT_DIR), { recursive: true });
  return d;
};
const put = (d, name, content, mtimeSec) => {
  const p = join(d, ARTIFACT_DIR, name);
  writeFileSync(p, content);
  if (mtimeSec != null) utimesSync(p, mtimeSec, mtimeSec);
  return p;
};

test('binary models get the larger cap while text model files keep the text cap', () => {
  assert.equal(artifactMaxBytesFor('mesh.glb'), ARTIFACT_BINARY_MODEL_MAX_BYTES);
  assert.equal(artifactMaxBytesFor('buffer.bin'), ARTIFACT_BINARY_MODEL_MAX_BYTES);
  assert.equal(artifactMaxBytesFor('mesh.gltf'), ARTIFACT_MAX_BYTES);
  assert.equal(artifactMaxBytesFor('mesh.obj'), ARTIFACT_MAX_BYTES);
});

test('scans nested relative files, newest first, and never follows a symlink', () => {
  const d = place();
  put(d, 'old.md', '# old', 1_000);
  put(d, 'new.html', '<p>new</p>', 2_000);
  mkdirSync(join(d, ARTIFACT_DIR, 'nested'));
  writeFileSync(join(d, ARTIFACT_DIR, 'nested', 'deep.txt'), 'deep');
  const secret = join(d, 'secret.txt');
  writeFileSync(secret, 'the key');
  symlinkSync(secret, join(d, ARTIFACT_DIR, 'planted.txt'));
  symlinkSync(secret, join(d, ARTIFACT_DIR, 'nested', 'planted.txt'));
  put(d, '.swp', 'x');
  assert.deepEqual(
    scanArtifacts(d).map((e) => e.name),
    ['nested/deep.txt', 'new.html', 'old.md']
  );
});

test('a directory that is itself a symlink is nothing', () => {
  const d = mkdtempSync(join(tmpdir(), 'fv-artifacts-'));
  const elsewhere = mkdtempSync(join(tmpdir(), 'fv-elsewhere-'));
  writeFileSync(join(elsewhere, 'a.md'), '#');
  mkdirSync(join(d, '.flowviant'));
  symlinkSync(elsewhere, join(d, ARTIFACT_DIR));
  assert.deepEqual(scanArtifacts(d), []);
});

test('a .flowviant that is itself a symlink is nothing — the scan never reads through it (2026-09-23)', () => {
  const d = mkdtempSync(join(tmpdir(), 'fv-artifacts-'));
  const elsewhere = mkdtempSync(join(tmpdir(), 'fv-elsewhere-'));
  mkdirSync(join(elsewhere, 'artifacts'));
  writeFileSync(join(elsewhere, 'artifacts', 'outside.md'), '# not the place');
  symlinkSync(elsewhere, join(d, '.flowviant'));
  assert.deepEqual(scanArtifacts(d), []);
});

test(`lists at most ${ARTIFACT_MAX_FILES}, keeping the newest`, () => {
  const d = place();
  for (let i = 0; i < ARTIFACT_MAX_FILES + 5; i++) put(d, `f${i}.txt`, 'x', 1_000 + i);
  const got = scanArtifacts(d);
  assert.equal(got.length, ARTIFACT_MAX_FILES);
  assert.equal(got[0].name, `f${ARTIFACT_MAX_FILES + 4}.txt`);
  assert.ok(!got.some((e) => e.name === 'f0.txt'));
});

test('only what the turn changed is reported — a file already there before it is not', () => {
  const d = place();
  put(d, 'sibling.md', 'a sibling tab drew this', 1_000);
  const before = snapshotArtifacts(d);
  put(d, 'mine.md', 'this turn drew this', 2_000);
  put(d, 'sibling.md', 'a sibling tab drew this', 1_000); // rewritten identically, same mtime
  assert.deepEqual(
    changedArtifacts(before, scanArtifacts(d)).map((e) => e.name),
    ['mine.md']
  );
  put(d, 'sibling.md', 'rewritten by this turn', 3_000);
  assert.deepEqual(
    changedArtifacts(before, scanArtifacts(d)).map((e) => e.name).sort(),
    ['mine.md', 'sibling.md']
  );
});

test('text is scrubbed before it leaves; an image is sent as it is', () => {
  const d = place();
  put(d, 'page.html', '<p>token=sk-live-123</p>');
  writeFileSync(join(d, ARTIFACT_DIR, 'shot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const scrub = (s) => s.replaceAll('sk-live-123', '[REDACTED:KEY]');
  const [html, png] = ['page.html', 'shot.png'].map((n) =>
    buildArtifactUpload(
      scanArtifacts(d).find((e) => e.name === n),
      { sessionId: 's1', turnId: 't1' },
      scrub
    )
  );
  assert.equal(html.bytes.toString('utf8'), '<p>token=[REDACTED:KEY]</p>');
  assert.equal(html.fields.mime, 'text/html');
  assert.equal(html.fields.sessionId, 's1');
  assert.equal(html.fields.turnId, 't1');
  assert.equal(html.fields.bytes, String(html.bytes.byteLength));
  assert.deepEqual([...png.bytes], [0x89, 0x50, 0x4e, 0x47]);
});

test('a nested model keeps its relative path in the upload', () => {
  const d = place();
  mkdirSync(join(d, ARTIFACT_DIR, 'scene'));
  writeFileSync(join(d, ARTIFACT_DIR, 'scene', 'mesh file.glb'), Buffer.from([1, 2]));
  const entry = scanArtifacts(d).find((e) => e.name === 'scene/mesh file.glb');
  const upload = buildArtifactUpload(entry, { agentId: 'a1' });
  assert.equal(upload.fields.name, 'scene/mesh file.glb');
  assert.deepEqual([...upload.bytes], [1, 2]);
});

test('an off-list type and an oversized file are reported by NAME, never read', () => {
  const d = place();
  put(d, 'build.zip', 'PK');
  put(d, 'big.txt', Buffer.alloc(ARTIFACT_MAX_BYTES + 1, 97));
  const entries = scanArtifacts(d);
  const zip = buildArtifactUpload(entries.find((e) => e.name === 'build.zip'), { agentId: 'a1' });
  assert.equal(zip.bytes, null);
  assert.equal(zip.fields.agentId, 'a1');
  assert.equal(zip.fields.tooLarge, undefined);
  const big = buildArtifactUpload(entries.find((e) => e.name === 'big.txt'), { agentId: 'a1' });
  assert.equal(big.bytes, null);
  assert.equal(big.fields.tooLarge, '1');
});

test('an over-long name is reported with the extension surviving the cut, byte-identical to the server’s safeFileName (audit 2026-09-24)', () => {
  // A bare `slice(0, 80)` used to cut mid-extension — a 90-character mockup
  // name stored as `…` with an unrecognised type, its bytes discarded. The
  // wire `name` field is now pre-sanitized the same extension-preserving
  // way the server's own `safeFileName` re-derives it, so the server's pass
  // is a no-op and the two never disagree about the cut.
  const d = place();
  const stem = 'x'.repeat(90);
  put(d, `${stem}.html`, '<p>a mockup</p>');
  const entry = scanArtifacts(d).find((e) => e.name === `${stem}.html`);
  const up = buildArtifactUpload(entry, { agentId: 'a1' });
  assert.ok(up.fields.name.length <= 80, 'stays at or under the 80-char ceiling');
  assert.ok(up.fields.name.endsWith('.html'), 'the extension survives the cut');
  assert.equal(
    up.fields.name,
    'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx-994582ac.html'
  );
  // Type detection and the actual bytes still ride the REAL file, unaffected
  // by the reported name's cut.
  assert.equal(up.fields.mime, 'text/html');
  assert.equal(up.bytes.toString('utf8'), '<p>a mockup</p>');
});

test('the ARTIFACTS paragraph is rendered only when asked for, after the knowledge one', () => {
  for (const sys of [SYSTEM_WORK, SYSTEM_WORK_PLAIN, SYSTEM_AGENT]) {
    assert.equal(withProjectContext(sys, { artifacts: false }), sys);
    assert.equal(withProjectContext(sys, {}), sys);
    const out = withProjectContext(sys, { artifacts: true });
    assert.equal(out, `${sys}\n\n${ARTIFACTS_PARAGRAPH}`);
    const both = withProjectContext(sys, { knowledgeDir: '/k', artifacts: true });
    assert.ok(both.indexOf('PROJECT KNOWLEDGE') < both.indexOf('ARTIFACTS:'));
  }
  assert.match(ARTIFACTS_PARAGRAPH, /under \.flowviant\/artifacts\//);
  assert.match(ARTIFACTS_PARAGRAPH, /under 2 MB/);
});

test('both lanes report, the capture chat never does, and the paragraph follows the roster', () => {
  // The tab lane is workSessionTurns.mjs (SOLID F037); the agent lane's run is
  // workAgentTurnExecution.mjs (SOLID F036).
  const src = ['work.mjs', 'workSessionTurns.mjs', 'workAgentTurnExecution.mjs']
    .map((file) => readFileSync(new URL(`./${file}`, import.meta.url), 'utf8'))
    .join('\n');
  assert.ok(src.includes("if (job.capture !== true) artifactScan = { dir: dir.wt, before: beforeArtifacts(dir.wt) };"));
  assert.ok(src.includes('{ knowledgeDir, artifacts: !captureTab && getArtifactsAccepted() }'));
  assert.ok(src.includes('.report({ placeDir: wt, before: artifactsBefore, agentId, turnId })'));
  assert.ok(/artifacts: getArtifactsAccepted\(\),/.test(src));
  const fleet = readFileSync(new URL('./fleet.mjs', import.meta.url), 'utf8');
  assert.ok(fleet.includes('artifactsAccepted = roster.artifactsAccepted === true;'));
});

test('a Word file, a deck, a sheet and a PDF are artifacts, sent as their bytes (0.97.0)', () => {
  const d = place();
  // A docx is a zip; a "secret" inside one is not text the scrub can match,
  // and rewriting its bytes would corrupt the file.
  const zipBytes = Buffer.from('PK\u0003\u0004sk-live-123', 'latin1');
  const mimes = {
    'brief.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'deck.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'model.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'report.pdf': 'application/pdf',
  };
  for (const n of Object.keys(mimes)) writeFileSync(join(d, ARTIFACT_DIR, n), zipBytes);
  const scrub = (s) => s.replaceAll('sk-live-123', '[REDACTED:KEY]');
  for (const [n, mime] of Object.entries(mimes)) {
    const up = buildArtifactUpload(scanArtifacts(d).find((e) => e.name === n), { sessionId: 's1' }, scrub);
    assert.equal(up.fields.mime, mime, n);
    assert.deepEqual([...up.bytes], [...zipBytes], `${n}: binary, never scrubbed`);
  }
});

test('the ARTIFACTS paragraph names the document types, and the CSP wording beside it is untouched', () => {
  assert.match(ARTIFACTS_PARAGRAPH, /plain text, or a\s+DOCX, PPTX, XLSX or PDF file/);
  assert.match(ARTIFACTS_PARAGRAPH, /a DOCX, PPTX\s+or XLSX is offered as a download/);
  // Canary: the policy sentences another pass made exact today are still there.
  assert.match(ARTIFACTS_PARAGRAPH, /nothing else loads from the network/);
  assert.match(ARTIFACTS_PARAGRAPH, /Keep each under 2 MB\./);
});


// ── A BINARY CARRYING A KNOWN SECRET IS WITHHELD (2026-09-23) ──────────────

test('a binary is checked for a known secret\'s bytes and WITHHELD on a hit — never rewritten', () => {
  const d = place();
  // A PNG's tEXt chunk is plain bytes — exactly where a value can hide.
  writeFileSync(
    join(d, ARTIFACT_DIR, 'chart.png'),
    Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from('tEXtComment\0sk-live-9f8e7d6c5b4a')])
  );
  writeFileSync(join(d, ARTIFACT_DIR, 'clean.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]));
  put(d, 'page.html', '<p>sk-live-9f8e7d6c5b4a</p>');
  const secretIn = (buf) => (buf.includes('sk-live-9f8e7d6c5b4a') ? 'STRIPE_KEY' : null);
  const scrub = (t) => t.replaceAll('sk-live-9f8e7d6c5b4a', '[REDACTED:STRIPE_KEY]');
  const of = (n) => buildArtifactUpload(scanArtifacts(d).find((e) => e.name === n), { agentId: 'a1' }, scrub, secretIn);
  const hit = of('chart.png');
  assert.equal(hit.withheld, 'STRIPE_KEY');
  assert.equal(hit.bytes, undefined, 'no bytes of any kind — never a redacted copy');
  assert.deepEqual([...of('clean.png').bytes], [0x89, 0x50, 0x4e, 0x47, 0, 1, 2], 'a clean binary goes as it is');
  // TEXT is still scrubbed, not withheld: a rewrite cannot corrupt it.
  assert.equal(of('page.html').bytes.toString('utf8'), '<p>[REDACTED:STRIPE_KEY]</p>');
});

test('the real scrub list: secretIn finds a checkout .env value inside binary bytes', () => {
  const repo = mkdtempSync(join(tmpdir(), 'fv-artifacts-env-'));
  writeFileSync(join(repo, '.env'), 'ARTIFACT_PROBE_TOKEN=ghp_Zq81xVb2Lw7Kd4Pn0Ty6\n');
  scanEnvForScrub(repo, null);
  assert.equal(envSecretIn(Buffer.from('PK\u0003\u0004 stored ghp_Zq81xVb2Lw7Kd4Pn0Ty6 entry')), 'ARTIFACT_PROBE_TOKEN');
  assert.equal(envSecretIn(Buffer.from('nothing to see')), null);
  // Canary: the same list is what the text scrub uses.
  assert.equal(envScrub('x ghp_Zq81xVb2Lw7Kd4Pn0Ty6'), 'x [REDACTED:ARTIFACT_PROBE_TOKEN]');
});

test('the work manager hands the reporter the byte check', () => {
  const w = readFileSync(new URL('./work.mjs', import.meta.url), 'utf8');
  const a = w.indexOf('const artifacts = createArtifactReporter({');
  assert.ok(a > -1, 'anchor');
  const b = w.indexOf('});', a);
  assert.ok(b > a, 'terminator');
  const block = w.slice(a, b);
  assert.match(block, /scrub: envScrub,/); // canary
  assert.match(block, /secretIn: envSecretIn,/);
  // …and the disk half and the browser half, by name (SOLID F051).
  assert.match(block, /listChanged: changedSince,/);
  assert.match(block, /buildUpload: buildArtifactUpload,/);
  assert.match(block, /renderPreview: renderDesignPreview,/);
});

test('the disk module neither posts nor screenshots — those live next door (SOLID F051)', () => {
  const src = readFileSync(new URL('./artifacts.mjs', import.meta.url), 'utf8');
  assert.ok(src.includes('export function buildArtifactUpload('), 'canary: the disk half is here');
  assert.ok(!/fetch\(|FormData|captureScreenshot|createArtifactReporter/.test(src.replace(/\/\*[\s\S]*?\*\//g, '')));
});

