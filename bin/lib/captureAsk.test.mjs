/**
 * THE CAPTURE CHAT ASKS IN CHIPS, AND SAYS WHAT IT ASSUMED (2026-09-23, 0.97.0).
 *
 * The owner asked whether the New task chat really asks follow-up questions.
 * It did — as prose, under a one-line "clarify before staging", with no rule
 * for WHICH questions and nothing that said what it guessed when it did not
 * ask. These pin the three halves of the fix in the prompt text, because a
 * prompt is exactly the kind of contract nothing else can check:
 *
 *   · the ask FENCE is taught in SYSTEM_CAPTURE with the SAME contract
 *     SYSTEM_WORK teaches — the web has one parser (`askParse.ts`) and the
 *     capture sheet renders what it parses, so a second dialect would render
 *     as a code block;
 *   · rule 5 names what is worth a question and forbids what the repo answers;
 *   · `assumed` is taught on the staging verbs, the param the server takes.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as prompts from './prompts.mjs';

/** The ```flowviant-ask blocks a contract prints, as the web parser anchors
 *  them (line-start fence, possibly indented in the prompt's own list). */
const askBlocks = (system) =>
  [...system.matchAll(/^[ \t]*```flowviant-ask\n([\s\S]*?)\n[ \t]*```/gm)].map((m) => m[1]);

test('the fence is taught in SYSTEM_CAPTURE, under the same contract SYSTEM_WORK teaches', () => {
  const cap = prompts.SYSTEM_CAPTURE;
  const work = prompts.SYSTEM_WORK;
  // Canary: the source of the contract still teaches it, so the comparison
  // below is not two absences agreeing.
  assert.equal(askBlocks(work).length, 1, 'SYSTEM_WORK still teaches one fence');
  assert.equal(askBlocks(cap).length, 1, 'SYSTEM_CAPTURE teaches exactly one fence');
  // The sentences the one parser's behaviour rests on, word for word in both.
  for (const clause of [
    'ONE block per reply, and always the LAST thing in it.',
    'a tradeoff goes in "description", one',
    'multiSelect true only for a genuine',
    'NEVER for an open question',
    'ask the question in prose',
  ]) {
    assert.ok(work.replace(/\s+/g, ' ').includes(clause), `SYSTEM_WORK: ${clause}`);
    assert.ok(cap.replace(/\s+/g, ' ').includes(clause), `SYSTEM_CAPTURE: ${clause}`);
  }
  assert.match(cap, /Do NOT add an "Other" option/);
  assert.match(cap, /Two to four\s+options/);
});

test('the example the capture chat is shown is itself a valid ask', () => {
  const [raw] = askBlocks(prompts.SYSTEM_CAPTURE);
  const ask = JSON.parse(raw);
  assert.equal(typeof ask.question, 'string');
  assert.ok(ask.options.length >= 2 && ask.options.length <= 4, 'two to four options, as taught');
  for (const o of ask.options) {
    const label = typeof o === 'string' ? o : o.label;
    assert.ok(!label.includes(','), `a label is never a comma: ${label}`);
  }
  assert.ok(ask.header.split(/\s+/).length <= 3, 'header is three words at most');
  assert.equal(ask.multiSelect, false);
  // Its subject is the kind ambiguity rule 7 names — the example teaches the
  // one question the owner's loop turns on.
  assert.match(ask.question, /mockup/);
});

test('rule 5 asks only for what shapes the card, and never what the repo answers', () => {
  const s = prompts.SYSTEM_CAPTURE;
  assert.match(s, /ASK ONLY FOR WHAT SHAPES THE CARD/);
  for (const subject of ['its KIND', 'its SCOPE', 'JUDGE IT DONE', 'a CONSTRAINT the repository cannot answer']) {
    assert.ok(s.includes(subject), `rule 5 names ${subject}`);
  }
  assert.match(s, /Never ask what reading the repo answers/);
  assert.match(s, /One question per\s+message/);
  assert.match(s, /A clear ask\s+stages without ceremony/);
  // The one-line predecessor is gone, not left beside its replacement.
  assert.ok(!s.includes('CLARIFY BEFORE STAGING'));
});

test('a guess is SAID through `assumed` on the staging verbs, never buried in the brief', () => {
  const s = prompts.SYSTEM_CAPTURE;
  assert.match(s, /pass `assumed` on stage_card \(or stage_card_edit\)/);
  assert.match(s, /"assumed the mobile layout too"/);
  assert.match(s, /Never bury a guess in the brief/);
  // Still the capture vocabulary only — the work-lane verbs stay unnamed.
  for (const banned of ['file_card', 'log_work', 'deliver_card', 'update_session', 'ship']) {
    assert.ok(!s.includes(banned), `SYSTEM_CAPTURE must not name ${banned}`);
  }
  assert.ok(!s.toLowerCase().includes('points'));
});

test('the artifacts paragraph says exactly what the server’s CSP lets through', () => {
  const p = prompts.ARTIFACTS_PARAGRAPH;
  // script-src: inline + the three CDNs.
  assert.match(p, /may run\s+scripts inline or from cdnjs\.cloudflare\.com, cdn\.jsdelivr\.net\/npm or unpkg\.com/);
  // style-src: inline, the three, and Google Fonts; font-src: its font host.
  assert.match(p, /load stylesheets inline, from those three, or from Google Fonts \(whose font files\s+load too\)/);
  // img-src / font-src otherwise data:; connect-src 'none'.
  assert.match(p, /goes in as a data: URI/);
  assert.match(p, /Nothing can be sent/);
  assert.match(p, /nothing else loads from the network/);
});
