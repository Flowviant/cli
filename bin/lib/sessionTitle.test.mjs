/**
 * THE TITLE CLAUDE GAVE ITS OWN CONVERSATION — `titleForSession`.
 *
 * A tab was born "session 3" and stayed that way, so this relays the name the
 * CLI already wrote into its own transcript. Three things are pinned, and each
 * one is a way the relay could go quietly wrong rather than loudly:
 *
 *  - THE LAST `ai-title` WINS. Titles get rewritten as a conversation turns
 *    into something else; taking the first would pin every tab to whatever it
 *    was about in its opening minute, which is the exact staleness the feature
 *    exists to fix.
 *  - ONLY `ai-title` RECORDS. The first user message is transcript CONTENT and
 *    a tab NAME is read by nobody but its owner — but the name is written into
 *    a shared record, so a message quoted into it is a leak with a long life.
 *  - A WRONG ID READS NOTHING. The id is per-tab; if the munge or the id were
 *    ever loose enough to hit a sibling's transcript, tab B would wear tab A's
 *    name and look exactly like a working feature.
 *
 * Run: node --test bin/lib/sessionTitle.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = mkdtempSync(join(tmpdir(), 'fv-title-home-'));
const CWD = mkdtempSync(join(tmpdir(), 'fv-title-place-'));
process.env.HOME = HOME;

const { titleForSession } = await import('./localSessions.mjs');

/** Write a transcript exactly where Claude Code would put one for `cwd`. */
function transcript(cwd, id, lines) {
  const dir = join(HOME, '.claude', 'projects', cwd.replace(/[/.]/g, '-'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n'));
}

const ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

test('relays the title the CLI wrote', () => {
  transcript(CWD, ID, [
    { type: 'user', message: 'hello' },
    { type: 'ai-title', aiTitle: 'Fixing the ship race' },
  ]);
  assert.equal(titleForSession(CWD, ID), 'Fixing the ship race');
});

test('the LAST ai-title wins — a conversation gets retitled', () => {
  transcript(CWD, ID, [
    { type: 'ai-title', aiTitle: 'First guess' },
    { type: 'user', message: 'actually about something else' },
    { type: 'ai-title', aiTitle: 'Per-user worktrees' },
  ]);
  assert.equal(titleForSession(CWD, ID), 'Per-user worktrees');
});

test('a transcript with no ai-title relays NOTHING — never the message', () => {
  transcript(CWD, ID, [
    { type: 'user', message: 'my api key is sk-secret-value' },
    { type: 'assistant', message: 'sure' },
  ]);
  const t = titleForSession(CWD, ID);
  assert.equal(t, null, 'an untitled conversation must report no title');
});

test('another tab in the same directory is not this tab', () => {
  transcript(CWD, ID, [{ type: 'ai-title', aiTitle: 'Tab A' }]);
  const other = 'ffffffff-1111-2222-3333-444444444444';
  assert.equal(titleForSession(CWD, other), null, 'a tab must never wear a sibling title');
  transcript(CWD, other, [{ type: 'ai-title', aiTitle: 'Tab B' }]);
  assert.equal(titleForSession(CWD, ID), 'Tab A');
  assert.equal(titleForSession(CWD, other), 'Tab B');
});

test('a directory nobody has a transcript for reports nothing', () => {
  assert.equal(titleForSession(join(tmpdir(), 'fv-title-nowhere'), ID), null);
});

test('refuses a malformed id rather than building a path from it', () => {
  transcript(CWD, ID, [{ type: 'ai-title', aiTitle: 'Tab A' }]);
  // The id is interpolated into a path, so the refusal must be proved against a
  // file that IS there: asserting null over a path that happens not to exist
  // passes with the guard deleted, which is how this test read on its first cut.
  const elsewhere = mkdtempSync(join(tmpdir(), 'fv-title-other-'));
  transcript(elsewhere, ID, [{ type: 'ai-title', aiTitle: 'SOMEBODY ELSES TAB' }]);
  const escape = `../${elsewhere.replace(/[/.]/g, '-')}/${ID}`;
  assert.equal(titleForSession(CWD, escape), null, 'a ../ id must not reach another directory');
  for (const bad of ['', 'short', null, undefined, 42, `${ID}/../../${ID}`]) {
    assert.equal(titleForSession(CWD, bad), null, `must refuse ${String(bad)}`);
  }
  // …and the control: the well-formed id still works, so the refusals above are
  // the guard talking and not a broken fixture.
  assert.equal(titleForSession(CWD, ID), 'Tab A');
});

test('a torn last line does not lose the title before it', () => {
  const dir = join(HOME, '.claude', 'projects', CWD.replace(/[/.]/g, '-'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${ID}.jsonl`),
    `${JSON.stringify({ type: 'ai-title', aiTitle: 'Survives' })}\n{"type":"ai-title","aiTi`
  );
  assert.equal(titleForSession(CWD, ID), 'Survives');
});
