/**
 * A CARD HAS A KIND (0.97.0) — code, design, research — and the daemon is the
 * half of that feature a server deploy cannot reach, so its whole contract is
 * pinned here: the capture chat reads the kind off the person's words, the
 * planner and the agent see it, each kind runs its own contract under its own
 * posture, and a non-code turn is not delivered until its artifact exists.
 *
 * Source pins slice between TWO asserted anchors and each carries a canary —
 * a match that must succeed inside the slice — so a moved anchor fails loudly
 * instead of pinning an empty string (the inert-pin class the main repo has
 * recorded five times).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as prompts from './prompts.mjs';
import * as kinds from './agentTaskKinds.mjs';
import * as contracts from './artifactContracts.mjs';
import { parseTurnResult } from './agentPlan.mjs';
import { DESIGN_PERM, RESEARCH_PERM, READ_GUARD_SETTINGS, researchPerm } from './claudePosture.mjs';
import { RUNTIMES, canRun } from './runtimes.mjs';

const src = (f) => readFileSync(new URL(`./${f}`, import.meta.url), 'utf8');
const slice = (text, from, to) => {
  const a = text.indexOf(from);
  assert.ok(a > -1, `slice anchor not found: ${from}`);
  const b = text.indexOf(to, a + from.length);
  assert.ok(b > a, `slice terminator not found after "${from}": ${to}`);
  return text.slice(a, b);
};
/** Every ```json block a contract prints, parsed as the settle would. */
const jsonBlocks = (system) => [...system.matchAll(/```json\n([\s\S]*?)\n```/g)].map((m) => m[1]);

test('the kind is read one way: absent and unknown are code', () => {
  assert.equal(kinds.agentTaskKindOf(undefined), 'code');
  assert.equal(kinds.agentTaskKindOf(null), 'code');
  assert.equal(kinds.agentTaskKindOf('Design'), 'code');
  assert.equal(kinds.agentTaskKindOf('design'), 'design');
  assert.equal(kinds.agentTaskKindOf('research'), 'research');
  assert.equal(kinds.agentTaskKindOf('model'), 'model');
  assert.equal(kinds.agentTaskKindOf('deck'), 'deck');
});

test('…but a turn is never SPAWNED on a kind this daemon does not know (2026-09-23)', () => {
  // Absent, null, empty and the three it runs: nothing to refuse.
  for (const v of [undefined, null, '', 'code', 'design', 'model', 'deck', 'research']) {
    assert.equal(kinds.unknownAgentTaskKind(v), null, String(v));
  }
  // Anything else is relayed back, bounded and stripped of control bytes.
  assert.equal(kinds.unknownAgentTaskKind('Design'), 'Design');
  assert.equal(kinds.unknownAgentTaskKind('video'), 'video');
  assert.equal(kinds.unknownAgentTaskKind('x\ny'), 'xy');
  assert.equal(kinds.unknownAgentTaskKind('z'.repeat(99)).length, 40);
});

test('the capture chat reads a kind off the words, and asks when two fit', () => {
  const s = prompts.SYSTEM_CAPTURE;
  assert.match(s, /EVERY CARD HAS A KIND/);
  // The param the staging verbs actually take.
  assert.match(s, /pass it as `kind` on stage_card/);
  // Rule 7 lists the five end products, in the picker's order, each with
  // its product and its consequence.
  const rule = slice(s, '7. EVERY CARD HAS A KIND', '8. HAND THEM THE CHOICES');
  assert.match(rule, /the END PRODUCT the agent hands back/);
  const listed = [...rule.matchAll(/^ {3}- "(\w+)": /gm)].map((m) => m[1]);
  assert.deepEqual(listed, ['code', 'design', 'model', 'image', 'deck', 'research']);
  assert.deepEqual(listed, Object.keys(kinds.AGENT_TASK_KINDS), 'every kind this daemon runs, and only those');
  assert.match(rule, /"code": a change to the code — commits they review and merge\. The default\./);
  // The cue words, on the right kinds.
  assert.match(rule, /"design": a UI mockup[\s\S]*?"Mockup", "design page X"/);
  assert.match(rule, /"model": a 3D model — one page to turn it around in, downloaded as a\s+\.glb[\s\S]*?"3D model", "mesh", "a chair model", "glTF", "OBJ"/);
  assert.match(rule, /"deck": a presentation — one HTML slide deck[\s\S]*?"Slides",\s+"a deck", "a presentation", "a pitch"/);
  // The image kind (0.114.0): Codex's pictures, and only where the machine's
  // Codex makes them — the staging tool refuses it otherwise, and the chat
  // says so rather than staging a stand-in kind.
  assert.match(rule, /"image": pictures — PNG or WebP images Codex generates; no code changed\./);
  assert.match(rule, /"An illustration", "a hero image", "a photo of", "artwork for"/);
  assert.match(rule, /if stage_card refuses the kind, say so\s+rather than staging another kind in its place\./);
  assert.match(rule, /"research": a write-up[\s\S]*?"Find out", "research", "compare"/);
  // Two products that fit are a QUESTION, in chips, one option per product.
  assert.match(rule, /When the words fit two products, ASK before staging — rule 5 — in chips, one\s+option per product that fits, its description its consequence\./);
  assert.match(rule, /"make a chair for the scene" fits code\s+\(commit the asset\) and model/);
  assert.match(rule, /Never stage a\s+guessed kind/);
  // Rule 5 names the kind as what the card hands back; rule 10 every kept product.
  assert.match(s, /- its KIND — what it hands back — when the words could mean more than one\s+product \(rule 7\);/);
  assert.match(s, /a kept mockup, 3D model,\s+image, deck or write-up/);
});

test('the planner sees every card’s kind, code included', () => {
  const k = prompts.AGENT_PLAN_KICKOFF({
    tasks: [
      { id: 'c1', title: 'Fix login', criteria: [] },
      { id: 'd1', title: 'Landing mockup', taskKind: 'design', criteria: [] },
      { id: 'r1', title: 'Onboarding teardown', taskKind: 'research', criteria: [] },
    ],
    liveAgents: [],
    agentCap: 3,
  });
  assert.match(k, /id: c1\n  title: Fix login\n  kind: code\n/);
  assert.match(k, /id: d1\n  title: Landing mockup\n  kind: design\n/);
  assert.match(k, /id: r1\n  title: Onboarding teardown\n  kind: research\n/);
  assert.match(prompts.SYSTEM_PLAN, /8\. EVERY CARD HAS A KIND/);
  const m = prompts.AGENT_PLAN_KICKOFF({
    tasks: [
      { id: 'm1', title: 'Chair', taskKind: 'model', criteria: [] },
      { id: 'k1', title: 'Pitch', taskKind: 'deck', criteria: [] },
    ],
    liveAgents: [],
    agentCap: 2,
  });
  assert.match(m, /id: m1\n  title: Chair\n  kind: model\n/);
  assert.match(m, /id: k1\n  title: Pitch\n  kind: deck\n/);
  const i = prompts.AGENT_PLAN_KICKOFF({
    tasks: [{ id: 'i1', title: 'Hero banner', taskKind: 'image', criteria: [] }],
    liveAgents: [],
    agentCap: 1,
  });
  assert.match(i, /id: i1\n  title: Hero banner\n  kind: image\n/);
});

test('the planner is told every non-code kind hands back a file and keeps to agents of its own', () => {
  const rule = slice(prompts.SYSTEM_PLAN, '8. EVERY CARD HAS A KIND.', 'ANSWER WITH ONE JSON OBJECT');
  // Canary: this is rule 8.
  assert.match(rule, /A "code" card lands as commits and is merged/);
  const flat = rule.replace(/\s+/g, ' ');
  for (const k of ['"design" (a mockup)', '"model" (a 3D model)', '"image" (pictures)', '"deck" (a presentation)', '"research" (a write-up)']) {
    assert.ok(flat.includes(k), `rule 8 names ${k}`);
  }
  // …and names exactly the kinds this daemon runs, in the table's order —
  // the prose list is a copy of the table, so it is pinned to it.
  const named = [...rule.matchAll(/"(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(named, Object.keys(kinds.AGENT_TASK_KINDS), 'rule 8 lists every kind, and only those');
  assert.match(flat, /hands back a file and changes nothing in the repository/);
  assert.match(flat, /Keep non-code cards in agents of their own/);
  // ONE AGENT IS ONE CLI (0.114.0): an image card runs on Codex, the other
  // non-code kinds on Claude, so the planner never mixes them.
  assert.match(
    flat,
    /An image card runs on Codex and every other non-code kind on Claude, and an agent is one CLI: never put an image card in the same agent as a mockup, 3D model, deck or write-up card\./
  );
});

test('a card spec says its kind when it is news, and a code spec is unchanged', () => {
  const code = { id: 't1', title: 'Fix login', brief: 'b', criteria: ['c'] };
  assert.equal(
    prompts.AGENT_TASK_SPEC(code),
    'id: t1\ntitle: Fix login\n\nbrief:\nb\n\ndone when:\n- c\n'
  );
  assert.ok(!prompts.AGENT_TASK_SPEC({ ...code, taskKind: 'code' }).includes('kind:'));
  assert.match(prompts.AGENT_TASK_SPEC({ ...code, taskKind: 'design' }), /^id: t1\ntitle: Fix login\nkind: design\n/);
  assert.match(prompts.AGENT_TASK_SPEC({ ...code, taskKind: 'research' }), /\nkind: research\n/);
});

/**
 * A KEPT BUNDLE IS REFERENCED AS ITS FOLDER (0.105.0). The server has sent
 * `designs/<slug>-vN/` for a kept design bundle since 0.99.0, and the old
 * reference rule (no trailing slash) dropped it, so "implement design A"
 * never reached the agent; the end-product kinds add `models/` and `decks/`.
 */
test('a card spec prints bundle-folder and every library folder\'s references, and drops what is not a path', () => {
  const spec = prompts.AGENT_TASK_SPEC({
    id: 't1',
    title: 'Add the chair to the codebase',
    references: [
      { name: 'models/chair-v1/', title: 'Reading chair' },
      { name: 'designs/x-v1/', title: 'Landing mockup' },
      { name: 'decks/pitch-v2.html', title: 'Pitch' },
      { name: 'research/teardown-v1.md', title: 'Teardown' },
      { name: '../x', title: 'nope' },
      { name: 'models/../x', title: 'nope' },
      { name: 'models/.hidden/', title: 'nope' },
      { name: 'videos/x-v1/', title: 'nope' },
      { name: 'models/chair-v1//', title: 'nope' },
      // A folder reference only where the kind is kept as a folder.
      { name: 'research/teardown-v1/', title: 'nope' },
      { name: 'decks/pitch-v2/', title: 'nope' },
    ],
  });
  assert.ok(
    spec.endsWith(
      '\nreferences (under the project knowledge directory):\n' +
        '- models/chair-v1/ — Reading chair\n' +
        '- designs/x-v1/ — Landing mockup\n' +
        '- decks/pitch-v2.html — Pitch\n' +
        '- research/teardown-v1.md — Teardown\n'
    ),
    spec
  );
});

test('the knowledge paragraph forbids committing kept work unless the card asks for exactly that', () => {
  const p = prompts.KNOWLEDGE_PARAGRAPH('/k').replace(/\s+/g, ' ');
  // Canary: the paragraph is the one it was.
  assert.match(p, /Read INSTRUCTIONS\.md there first/);
  assert.ok(
    p.endsWith(
      'Never copy them into the repository or commit them unless the card you are working asks for exactly that.'
    ),
    p
  );
});

test('the kickoff keeps the trailer for code and drops it for every kind that commits nothing', () => {
  const task = { id: 't1', title: 'x', criteria: [] };
  const code = prompts.AGENT_TASK_KICKOFF({ agentName: 'a', task, position: 1, total: 2 });
  assert.match(code, /Flowviant-Task: t1/);
  assert.match(code, /Do it, commit it, and end with the JSON object\.$/);
  const fileKinds = Object.keys(kinds.AGENT_TASK_KINDS).filter((k) => k !== 'code');
  assert.deepEqual(fileKinds, ['design', 'model', 'image', 'deck', 'research'], 'canary: every kind that hands back a file');
  for (const taskKind of fileKinds) {
    const k = prompts.AGENT_TASK_KICKOFF({ agentName: 'a', task: { ...task, taskKind }, position: 1, total: 2 });
    assert.ok(!k.includes('Flowviant-Task'), `${taskKind}: no trailer`);
    assert.ok(!/commit it/.test(k), `${taskKind}: never told to commit`);
    assert.match(k, /\.flowviant\/artifacts\//);
    assert.match(k, /Do it, and end with the JSON object\.$/);
  }
});

test('the selector: code is SYSTEM_AGENT itself, every other kind its own contract', () => {
  assert.equal(prompts.SYSTEM_AGENT_FOR(undefined), prompts.SYSTEM_AGENT);
  assert.equal(prompts.SYSTEM_AGENT_FOR('code'), prompts.SYSTEM_AGENT);
  assert.equal(prompts.SYSTEM_AGENT_FOR('nonsense'), prompts.SYSTEM_AGENT);
  assert.equal(prompts.SYSTEM_AGENT_FOR('design'), prompts.SYSTEM_AGENT_DESIGN);
  assert.equal(prompts.SYSTEM_AGENT_FOR('research'), prompts.SYSTEM_AGENT_RESEARCH);
  assert.equal(prompts.SYSTEM_AGENT_FOR('model'), contracts.SYSTEM_AGENT_MODEL);
  assert.equal(prompts.SYSTEM_AGENT_FOR('deck'), contracts.SYSTEM_AGENT_DECK);
  assert.equal(prompts.SYSTEM_AGENT_FOR('image'), contracts.SYSTEM_AGENT_IMAGE);
});

test('every agent contract ends in JSON the one parser reads', () => {
  for (const [name, sys] of [
    ['SYSTEM_AGENT', prompts.SYSTEM_AGENT],
    ['SYSTEM_AGENT_DESIGN', prompts.SYSTEM_AGENT_DESIGN],
    ['SYSTEM_AGENT_MODEL', contracts.SYSTEM_AGENT_MODEL],
    ['SYSTEM_AGENT_DECK', contracts.SYSTEM_AGENT_DECK],
    ['SYSTEM_AGENT_IMAGE', contracts.SYSTEM_AGENT_IMAGE],
    ['SYSTEM_AGENT_RESEARCH', prompts.SYSTEM_AGENT_RESEARCH],
  ]) {
    const blocks = jsonBlocks(sys);
    assert.equal(blocks.length, 2, `${name}: a delivered shape and a blocked shape`);
    const delivered = parseTurnResult('```json\n' + blocks[0] + '\n```');
    const blocked = parseTurnResult('```json\n' + blocks[1] + '\n```');
    assert.equal(delivered?.outcome, 'delivered', `${name} delivered`);
    assert.ok(delivered.progress, `${name}: progress on the delivered shape`);
    assert.equal(blocked?.outcome, 'question', `${name} blocked`);
    assert.ok(blocked.progress, `${name}: progress on the blocked shape`);
  }
});

test('design draws one self-contained page and commits nothing; research cites and commits nothing', () => {
  const d = prompts.SYSTEM_AGENT_DESIGN;
  assert.match(d, /ONE self-contained HTML file directly in \.flowviant\/artifacts\/ \(no\s+subfolders — a file in one is never shown\)/);
  assert.match(d, /cdnjs\.cloudflare\.com, cdn\.jsdelivr\.net\/npm or\s+unpkg\.com/);
  assert.match(d, /CHANGE NO REPOSITORY FILE AND COMMIT NOTHING/);
  assert.match(d, /frontend-design skill/);
  assert.match(d, /real copy|the real copy|the brand, the\s+design tokens/);
  assert.ok(!d.includes('Flowviant-Task'), 'no trailer — there is nothing to commit');
  const r = prompts.SYSTEM_AGENT_RESEARCH;
  assert.match(r, /ONE Markdown file directly in \.flowviant\/artifacts\/ \(no subfolders —\s+a file in one is never shown\)/);
  assert.match(r, /CITE WHAT YOU\s+READ/);
  assert.match(r, /CHANGE NO REPOSITORY FILE AND COMMIT NOTHING/);
  assert.ok(!r.includes('Flowviant-Task'));
});

/**
 * THE TAIL IS SPELLED ONCE (2026-09-27). Rule 3, rule 4's stop-and-ask and the
 * final JSON of every file-handing contract are `ARTIFACT_CONTRACT_TAIL`'s;
 * the design and research contracts render it too, and their bytes are pinned
 * to what 0.104.0 sent (sha256 of the whole string), so moving the tail
 * changed nothing an agent reads. The design contract has since said one
 * thing more (2026-09-29, `LOOK_HEADLESS`, its own paragraph closing rule 2);
 * without that paragraph it is still 0.104.0's, byte for byte.
 */
test('every file-handing contract renders the one tail, and design and research are byte-for-byte 0.104.0', () => {
  const sha = (s) => createHash('sha256').update(s).digest('hex');
  const look = `\n\n   ${contracts.LOOK_HEADLESS}`;
  assert.ok(prompts.SYSTEM_AGENT_DESIGN.includes(`Keep it under 2 MB.${look}\n\n3. CHANGE NO`), 'canary: rule 2 closes on it');
  assert.equal(sha(prompts.SYSTEM_AGENT_DESIGN.replace(look, '')), 'c6bb3a485f9edae9418872f5f23b3ce0cd2c49ab8b13ba2ae653ab77390dc24f');
  assert.equal(sha(prompts.SYSTEM_AGENT_RESEARCH), 'a6615314e5face775e23677c133ce86f8c1e4027f5d5b6ca0a9d069bd4fecc96');
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');
  // Canary: the home spells rule 3.
  assert.ok(strip(src('artifactContracts.mjs')).includes('3. CHANGE NO REPOSITORY FILE AND COMMIT NOTHING.'));
  const p = strip(src('prompts.mjs'));
  assert.ok(!p.includes('CHANGE NO REPOSITORY FILE AND COMMIT NOTHING'), 'prompts.mjs spells no second tail');
  assert.equal(p.match(/\$\{ARTIFACT_CONTRACT_TAIL\(\{/g)?.length, 2, 'design and research render the tail');
  // One import path for the new contracts: prompts.mjs does not re-export them.
  assert.equal(prompts.SYSTEM_AGENT_MODEL, undefined);
  assert.equal(prompts.SYSTEM_AGENT_DECK, undefined);
  assert.equal(prompts.SYSTEM_AGENT_IMAGE, undefined);
});

/**
 * THE IMAGE CONTRACT (0.114.0) — spoken to Codex, whose own image tool makes
 * the pictures. The mechanical step is the COPY out of CODEX_HOME into the one
 * writable directory; a drawing in code is never the delivery, and a missing
 * or refusing tool is a question, never a stand-in. The size limit is the
 * uploader's own (the generated policy), not a second spelling of it.
 */
test('the image contract generates, copies, never draws in code, and asks when the tool is missing', () => {
  const c = contracts.SYSTEM_AGENT_IMAGE;
  assert.ok(c.startsWith("You are the human's own Codex, working one IMAGE card in a git worktree of"));
  assert.match(c, /AN IMAGE CARD HANDS BACK PICTURES, NOT A CHANGE\./);
  assert.match(c, /no project tools, no board, no chat, no web\./);
  assert.match(c, /WITH YOUR IMAGE GENERATION TOOL\. Never\s+draw one in code — no SVG, no canvas, no HTML page, no script that paints\s+pixels/);
  assert.match(c, /The tool saves each image\s+under \$CODEX_HOME\/generated_images\/ and tells you where\. COPY each image you\s+hand back into \.flowviant\/artifacts\//);
  assert.match(c, /as a PNG or a\s+WebP file — one file per image, and nothing else in that directory/);
  assert.match(c, new RegExp(`Keep each file under\\s+${contracts.IMAGE_CAP_WORDS.replace(' ', '\\s+')}; if one is larger, save it as WebP or at a smaller size\\.`));
  assert.equal(contracts.IMAGE_CAP_WORDS, '20 MB', 'the policy gives a png or webp artifact the 20 MB binary ceiling');
  assert.match(c, /if your image tool is not available here, or refuses or fails, STOP and say\s+so in your question, quoting its words — never draw a stand-in some other\s+way\./);
  assert.match(c, /3\. CHANGE NO REPOSITORY FILE AND COMMIT NOTHING/);
  assert.ok(!c.includes('Flowviant-Task'));
  // …and the kind's proof accepts exactly what the contract asks for.
  assert.ok(kinds.AGENT_TASK_KINDS.image.artifact.match.test('hero-banner.png'));
  assert.ok(kinds.AGENT_TASK_KINDS.image.artifact.match.test('hero-banner.webp'));
  const k = prompts.AGENT_TASK_KICKOFF({ agentName: 'a', task: { id: 't1', title: 'x', taskKind: 'image' }, position: 1, total: 1 });
  assert.ok(k.includes('This card is an IMAGE card: it hands back pictures as PNG or WebP files, written under .flowviant/artifacts/'), k);
  assert.match(prompts.AGENT_TASK_SPEC({ id: 't1', title: 'x', taskKind: 'image' }), /\nkind: image\n/);
});

/**
 * THE 3D-MODEL AND PRESENTATION CONTRACTS (0.105.0) share the design
 * contract's bones — rule 3, rule 4's stop-and-ask, the final JSON — through
 * `ARTIFACT_CONTRACT_TAIL`.
 */
test('the model and deck contracts commit nothing and end the way the design contract does', () => {
  for (const [name, c] of [['model', contracts.SYSTEM_AGENT_MODEL], ['deck', contracts.SYSTEM_AGENT_DECK]]) {
    assert.match(c, /3\. CHANGE NO REPOSITORY FILE AND COMMIT NOTHING/, `${name}: commits nothing`);
    assert.match(c, /STOP AND\s+ASK/, `${name}: asks rather than guesses`);
    assert.ok(!c.includes('Flowviant-Task'), `${name}: no trailer`);
    assert.ok(c.startsWith("You are the human's own Claude, working one "), `${name}: the design header`);
    assert.match(c, /Nobody is watching this run\. You have the repo and nothing\s+else — no project tools, no board, no chat\./);
  }
  const m = contracts.SYSTEM_AGENT_MODEL;
  assert.match(m, /A 3D MODEL CARD HANDS BACK A MODEL YOU CAN LOOK AT, NOT A CHANGE\./);
  // ONE page that builds the model in code (0.107.0) — never a pile of files.
  assert.match(m, /Write ONE file, \.flowviant\/artifacts\/<kebab-name>\/index\.html/);
  assert.match(m, /Nothing else goes in that\s+folder: no model files, no textures, no scripts, no notes\./);
  assert.match(m, /BUILDS\s+THE MODEL IN CODE/);
  assert.match(m, /three\.js as ES modules from cdn\.jsdelivr\.net\/npm/);
  assert.match(m, /ONE THREE\.Group named for what it is/);
  assert.match(m, /textures you DRAW ON A CANVAS in the page\s+\(THREE\.CanvasTexture, 1024px or less\) — never an image file\./);
  assert.match(m, /no download or save button of your own/);
  // The target the card names outranks the repo's assets, and is said.
  assert.match(m, /If the card names where the model\s+will be used[\s\S]*meet that target's\s+import rules/);
  assert.match(m, /Otherwise match the scale and units of any 3D assets the repository\s+already has\./);
  // THE HANDSHAKE, word for word: the web keys on these three names.
  for (const word of ["flowviant !== 'export-glb'", "{ flowviant: 'glb', glb }", "flowviant: 'glb-error'", "{ flowviant: 'glb-ready' }"]) {
    assert.ok(m.includes(word), word);
  }
  assert.match(m, /\{ binary: true \}/);
  assert.ok(m.includes("import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';"));
  // Never asked for what the posture cannot write, nor for the old pile.
  assert.ok(!/\.mtl|as \.svg|written as TEXT: a \.obj|data: URI/.test(m), 'no OBJ, MTL, SVG textures or data: buffer');
  // …and the kind's proof accepts what the contract asks for.
  assert.ok(kinds.AGENT_TASK_KINDS.model.artifact.match.test('reading-chair/index.html'));
  const k = contracts.SYSTEM_AGENT_DECK;
  assert.match(k, /A PRESENTATION CARD HANDS BACK A DECK, NOT A CHANGE\./);
  assert.match(k, /ONE self-contained HTML file directly in \.flowviant\/artifacts\//);
  assert.match(k, /cdnjs\.cloudflare\.com, cdn\.jsdelivr\.net\/npm or unpkg\.com/);
  assert.match(k, /Each slide is a <section>; the arrow\s+keys and on-screen previous\/next buttons/);
  assert.match(k, /a counter\s+says which slide/);
  assert.match(k, /@media print rules that put\s+one slide on each page \(break-after: page\)/);
  assert.match(k, /Keep it under 2 MB\./);
});

/**
 * NOBODY IS AT THIS SCREEN (2026-09-29). A board agent looking at its page
 * started Chrome itself, and the window landed on the owner's desktop. Every
 * kind that draws a page says, in rule 2, never to open a window and how to
 * look without one — headless, a profile of its own, a screenshot read back;
 * the image card says the first half. Research draws nothing and says
 * neither; a code card's contract is not a file-handing one.
 */
test('every page-drawing contract says never to open a window, and how to look headless', () => {
  assert.match(contracts.NO_WINDOW, /^Never open a browser window or any desktop application: this is somebody's\s+own screen, and nobody is at it\.$/);
  assert.ok(contracts.LOOK_HEADLESS.startsWith(contracts.NO_WINDOW));
  for (const flag of ['--headless=new', '--user-data-dir="$(mktemp -d)"', '--screenshot=']) {
    assert.ok(contracts.LOOK_HEADLESS.includes(flag), flag);
  }
  assert.match(contracts.LOOK_HEADLESS, /read the PNG/);
  for (const [name, c] of [
    ['design', prompts.SYSTEM_AGENT_DESIGN],
    ['model', contracts.SYSTEM_AGENT_MODEL],
    ['deck', contracts.SYSTEM_AGENT_DECK],
  ]) {
    const at = c.indexOf(contracts.LOOK_HEADLESS);
    assert.ok(at > -1, `${name}: says it`);
    assert.ok(at < c.indexOf('3. CHANGE NO REPOSITORY FILE'), `${name}: inside rule 2, before the tail`);
    assert.equal(c.split(contracts.NO_WINDOW).length - 1, 1, `${name}: once`);
  }
  const image = contracts.SYSTEM_AGENT_IMAGE;
  assert.ok(image.includes(`${contracts.NO_WINDOW} Look at a picture through your own tools,\n   never an image viewer.`));
  assert.ok(!image.includes('google-chrome'), 'the image card draws no page to screenshot');
  assert.ok(!prompts.SYSTEM_AGENT_RESEARCH.includes(contracts.NO_WINDOW), 'research is 0.104.0, byte for byte');
});

test('the kickoff names the 3D-model and presentation products and never asks for a commit', () => {
  const task = { id: 't1', title: 'x', criteria: [] };
  for (const [taskKind, clause] of [
    ['model', 'This card is a 3D MODEL card: it hands back a model to view and download as a .glb, written under .flowviant/artifacts/'],
    ['deck', 'This card is a PRESENTATION card: it hands back an HTML slide deck, written under .flowviant/artifacts/'],
  ]) {
    const k = prompts.AGENT_TASK_KICKOFF({ agentName: 'a', task: { ...task, taskKind }, position: 1, total: 1 });
    assert.ok(k.includes(clause), taskKind);
    assert.ok(!k.includes('Flowviant-Task'), `${taskKind}: no trailer`);
    assert.match(prompts.AGENT_TASK_SPEC({ ...task, taskKind }), new RegExp(`\\nkind: ${taskKind}\\n`));
  }
});

test('the artifacts paragraph no longer says scripts are disabled', () => {
  const p = prompts.ARTIFACTS_PARAGRAPH;
  assert.ok(!/scripts disabled/.test(p));
  assert.match(p, /may run\s+scripts inline or from cdnjs\.cloudflare\.com, cdn\.jsdelivr\.net\/npm or unpkg\.com/);
  assert.match(p, /nothing else loads from the network/);
});

test('the postures: research reads the web, design does not, and neither writes outside artifacts', () => {
  const scoped = 'Edit(.flowviant/artifacts/**)';
  for (const [name, perm] of [['design', DESIGN_PERM], ['research', RESEARCH_PERM]]) {
    // The read guard rides FIRST, before the variadic list could swallow it.
    assert.deepEqual(perm.slice(0, 3), ['--settings', READ_GUARD_SETTINGS, '--allowedTools'], `${name}: guarded, then a curated list`);
    assert.ok(perm.includes(scoped), `${name}: the one scoped write`);
    // No UNSCOPED write of any spelling, and no shell that could commit.
    for (const bad of ['Write', 'Edit', '--dangerously-skip-permissions', 'Bash(git:*)', 'Bash(git commit:*)', 'mcp__flowviant']) {
      assert.ok(!perm.includes(bad), `${name} must not carry ${bad}`);
    }
    // The probe's finding, pinned: a `Write(...)` path rule is NOT a scoped
    // write on 2.1.281 — it denied both files — so it must not be the one used.
    assert.ok(!perm.some((x) => x.startsWith('Write(')), `${name}: never the Write(...) spelling`);
    // `**`, not `*`: the single-level spelling admitted a subfolder write on
    // 2.1.281 exactly as `**` did, so it would only LOOK narrower.
    assert.ok(!perm.includes('Edit(.flowviant/artifacts/*)'), `${name}: never the look-alike single level`);
    // No git reader and no cat/head/wc: each git reader was an `--output`
    // away from a write, and Read covers the rest.
    assert.ok(!perm.some((x) => /^Bash\((git|cat|head|wc)\b/.test(x)), `${name}: no git readers, no cat/head/wc`);
  }
  // DESIGN, exactly: reads the worktree through the fence (bare Read/Grep/Glob
  // reach the whole box — measured, 2026-09-24), no web, `.env*` denied.
  assert.deepEqual(DESIGN_PERM.slice(2), [
    '--allowedTools',
    'Read(./**)',
    'Glob(./**)',
    'Bash(ls:*)',
    scoped,
    '--disallowedTools',
    'Read(./.env*)',
    'Read(./**/.env*)',
  ]);
  for (const bad of ['Read', 'Grep', 'Glob']) assert.ok(!DESIGN_PERM.includes(bad), `design: no bare ${bad}`);
  assert.ok(!DESIGN_PERM.some((x) => x.startsWith('Web')), 'a design card draws THIS product');
  // RESEARCH, exactly: the web, and reading fenced to the worktree — no Grep,
  // no Bash, `.env*` denied by name (measured load-bearing: without the deny,
  // `Read(./**)` read `.env`).
  assert.deepEqual(RESEARCH_PERM.slice(2), [
    '--allowedTools',
    'Read(./**)',
    'Glob(./**)',
    'WebSearch',
    'WebFetch',
    scoped,
    '--disallowedTools',
    'Read(./.env*)',
    'Read(./**/.env*)',
    // Denied BY NAME: off the allow list, the CLI still ran `git log` and
    // `ls` on its own read-only classifier (measured).
    'Bash',
  ]);
  for (const bad of ['Read', 'Grep', 'Glob']) assert.ok(!RESEARCH_PERM.includes(bad), `research: no bare ${bad}`);
  const allowed = RESEARCH_PERM.slice(RESEARCH_PERM.indexOf('--allowedTools'), RESEARCH_PERM.indexOf('--disallowedTools'));
  assert.ok(!allowed.some((x) => x.startsWith('Bash') || x.startsWith('Grep')), 'research: no Bash, no Grep allowed');
});

test('research reads the knowledge library by its absolute path, built at spawn', () => {
  const kd = '/home/op/repo/.flowviant/knowledge';
  const perm = researchPerm(kd);
  assert.ok(perm.includes(`Read(/${kd}/**)`), 'the CLI spells an absolute rule with //');
  assert.ok(perm.includes(`Glob(/${kd}/**)`));
  assert.ok(perm.includes('Read(./**)'), 'canary: the worktree rule is still there');
  // A trailing slash is not doubled; a path the rule syntax cannot carry gets
  // no rule at all (`--add-dir` still admits the directory — measured).
  assert.ok(researchPerm(`${kd}/`).includes(`Read(/${kd}/**)`));
  for (const odd of ['relative/dir', '/has(paren)', '/has*star', null, undefined]) {
    assert.deepEqual(researchPerm(odd), RESEARCH_PERM, String(odd));
  }
});

test('runTurn takes ONE profile by name, and Claude\'s list is looked up by that name', () => {
  const c = src('runTurn.mjs');
  const body = slice(c, 'export function runTurn(opts) {', 'const args = rt.args({');
  // Canary: this is runTurn's head.
  assert.match(body, /const rt = runtimeById\(runtime\);/);
  assert.match(body, /const turnProfile = resolveTurnProfile\(opts\);/);
  assert.match(body, /const offRuntime = turnProfile\.onlyOn\?\.\(rt\);/);
  // No precedence chain: none of the retired switches is read.
  for (const k of ['wikiPerm', 'readOnly', 'planPerm', 'planMode', 'posture ===']) assert.ok(!body.includes(k), k);
  const call = slice(c, 'const args = rt.args({', '// Handed to the adapter rather than appended here');
  assert.ok(call.includes('profile: turnProfile.adapterProfile,'));
  assert.ok(call.includes('perm: claudePermFor(turnProfile.name, knowledgeDir),'));
});

test('only Claude declares the two postures, and they need no MCP', () => {
  assert.ok(canRun(RUNTIMES.claude, 'design'));
  assert.ok(canRun(RUNTIMES.claude, 'research'));
  for (const id of ['codex', 'antigravity']) {
    if (!RUNTIMES[id]) continue;
    assert.ok(!canRun(RUNTIMES[id], 'design'), `${id} cannot run a design card`);
    assert.ok(!canRun(RUNTIMES[id], 'research'), `${id} cannot run a research card`);
  }
});

test('the agent turn: contract and posture from the kind, refusal off Claude, artifact before delivered', () => {
  // The run (split out of workAgentTurns.mjs by SOLID F036).
  const w = src('workAgentTurnExecution.mjs');
  const turn = slice(w, 'const runAgentTurnInPlace = async (job', 'return { runAgentTurnInPlace, commitsBetween };');
  // Canary: this IS the agent lane.
  assert.match(turn, /AGENT_TASK_KICKOFF\(/);
  assert.match(turn, /const taskKind = agentTaskKindOf\(job\.taskKind \?\? job\.task\?\.taskKind\);/);
  // An unknown kind is refused, in its own word, BEFORE the kind is coerced.
  const refuse = slice(turn, 'const strangeKind = unknownAgentTaskKind(job.taskKind ?? job.task?.taskKind);', 'const taskKind = agentTaskKindOf(');
  assert.match(refuse, /if \(strangeKind !== null\) \{\s*await postAgentTurn\(\{\s*turnId,\s*outcome: 'nothing',/);
  assert.ok(refuse.includes("answer: `this daemon does not know the card kind '${strangeKind}' — update it`,"));
  assert.match(refuse, /return;\s*\}\s*$/);
  // Posture and refusal come from the kind's one entry (agentTaskKinds.mjs).
  assert.match(turn, /const kind = AGENT_TASK_KINDS\[taskKind\];\s*const posture = kind\.posture;/);
  assert.match(turn, /if \(!canRun\(RUNTIMES\[rt\], posture\)\)/);
  assert.ok(turn.includes('answer: kind.offRuntime(rt),'));
  for (const k of ['design', 'model', 'deck', 'research']) {
    assert.equal(kinds.AGENT_TASK_KINDS[k].offRuntime('codex'), 'mockup, 3D model, presentation and write-up cards run on Claude on this machine', k);
  }
  assert.equal(kinds.AGENT_TASK_KINDS.code.offRuntime('agy'), 'this machine cannot run agy');
  assert.equal(kinds.AGENT_TASK_KINDS.image.offRuntime('claude'), 'image cards run on Codex on this machine');
  // THE ARTIFACTS DIRECTORY STANDS BEFORE A NON-CODE CARD'S CLI SPAWNS
  // (0.114.0): Codex's image fence cannot create its one writable root, and a
  // symlinked one is refused in words — after the runtime refusal, before the
  // spawn.
  const stand = slice(turn, 'if (kind.artifact && !ensureArtifactDir(wt)) {', 'return;');
  assert.ok(stand.includes("outcome: 'nothing',"));
  assert.ok(stand.includes(`answer: "this worktree's .flowviant/artifacts is not a real directory, so there is nowhere to write what the card hands back",`));
  const refuseAt = turn.indexOf('if (!canRun(RUNTIMES[rt], posture))');
  const standAt = turn.indexOf('if (kind.artifact && !ensureArtifactDir(wt))');
  const spawnAt = turn.indexOf('runTurnResumingOnce(runTurn, agentTurnArgs');
  assert.ok(refuseAt > -1 && standAt > refuseAt && spawnAt > standAt, 'refuse the runtime, make the directory, then spawn');
  assert.match(turn, /system: withProjectContext\(SYSTEM_AGENT_FOR\(taskKind\),/);
  assert.ok(turn.includes('profile: posture,'), 'the kind\'s posture is the one turn profile');
  // The measured check — the snapshot taken before the spawn, the scan after —
  // is the settlement decision's (workAgentTurnOutcome.mjs, SOLID F036).
  const decide = src('workAgentTurnOutcome.mjs');
  const check = slice(decide, "if (res.outcome === 'delivered' && kind.artifact) {", 'return report(\n    {');
  assert.ok(check.includes('const want = kind.artifact.match;'));
  assert.equal(String(kinds.AGENT_TASK_KINDS.design.artifact.match), String(/\.html?$/i));
  assert.equal(String(kinds.AGENT_TASK_KINDS.research.artifact.match), String(/\.md$/i));
  assert.equal(kinds.AGENT_TASK_KINDS.code.artifact, null, 'code delivers commits, not an artifact');
  assert.match(check, /changedArtifacts\(artifactsBefore, standing\)/);
  assert.match(check, /const has = \(l\) => l\.some\(\(e\) => want\.test\(e\.name\)\);/);
  assert.match(check, /\(job\.kind !== 'task' \|\| job\.redo === true\) && has\(standing\)/);
  assert.match(check, /outcome: 'nothing'/);
  assert.ok(check.includes('answer: kind.artifact.missing,'));
  assert.equal(kinds.AGENT_TASK_KINDS.design.artifact.missing, 'the turn ended without writing a mockup under .flowviant/artifacts/');
  assert.equal(kinds.AGENT_TASK_KINDS.research.artifact.missing, 'the turn ended without writing a write-up under .flowviant/artifacts/');
  // Commits are still reported — a report never lies by omission.
  assert.ok(check.includes('...(commits.length ? { commits } : {}),'));
  // …and the check sits AFTER the snapshot is taken (the run hands the
  // snapshot and the kind to the decision once the CLI has exited) and BEFORE
  // the one settle that could say delivered (the decision's last return).
  const snapAt = turn.indexOf('const artifactsBefore = beforeArtifacts(wt);');
  const decideAt = turn.indexOf('agentTurnSettlement({');
  assert.ok(snapAt > -1 && decideAt > snapAt, 'snapshot first, decision after the CLI');
  assert.match(turn.slice(decideAt), /^agentTurnSettlement\(\{[^}]*\bkind,[^}]*\bartifactsBefore,[^}]*\}\)/);
  assert.ok(decide.indexOf(check) < decide.indexOf('outcome: res.outcome,'));
});
