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
import * as prompts from './prompts.mjs';
import { parseTurnResult } from './agentPlan.mjs';
import { DESIGN_PERM, RESEARCH_PERM } from './claude.mjs';
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
  assert.equal(prompts.agentTaskKindOf(undefined), 'code');
  assert.equal(prompts.agentTaskKindOf(null), 'code');
  assert.equal(prompts.agentTaskKindOf('Design'), 'code');
  assert.equal(prompts.agentTaskKindOf('design'), 'design');
  assert.equal(prompts.agentTaskKindOf('research'), 'research');
});

test('the capture chat reads a kind off the words, and asks when two fit', () => {
  const s = prompts.SYSTEM_CAPTURE;
  assert.match(s, /EVERY CARD HAS A KIND/);
  // The param the staging verbs actually take.
  assert.match(s, /pass it as `kind` on stage_card/);
  for (const k of ['"design"', '"research"', '"code"']) assert.ok(s.includes(k), `names ${k}`);
  // The cue words the owner gave, on the right kinds.
  assert.match(s, /"design": a mockup[\s\S]*?"Mockup", "design page X"/);
  assert.match(s, /"research": a write-up[\s\S]*?"Find out", "research", "compare"/);
  // The ambiguous classic is a QUESTION, both readings named — rule 5.
  assert.match(s, /"Redesign\s+the landing page" is the classic: ask whether/);
  assert.match(s, /changed in the code \(code\) or a mockup to look at first \(design\)/);
  assert.match(s, /Never stage a guessed kind/);
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

test('the kickoff keeps the trailer for code and drops it for the two that commit nothing', () => {
  const task = { id: 't1', title: 'x', criteria: [] };
  const code = prompts.AGENT_TASK_KICKOFF({ agentName: 'a', task, position: 1, total: 2 });
  assert.match(code, /Flowviant-Task: t1/);
  assert.match(code, /Do it, commit it, and end with the JSON object\.$/);
  for (const taskKind of ['design', 'research']) {
    const k = prompts.AGENT_TASK_KICKOFF({ agentName: 'a', task: { ...task, taskKind }, position: 1, total: 2 });
    assert.ok(!k.includes('Flowviant-Task'), `${taskKind}: no trailer`);
    assert.ok(!/commit it/.test(k), `${taskKind}: never told to commit`);
    assert.match(k, /\.flowviant\/artifacts\//);
    assert.match(k, /Do it, and end with the JSON object\.$/);
  }
});

test('the selector: code is SYSTEM_AGENT itself, the other two their own contracts', () => {
  assert.equal(prompts.SYSTEM_AGENT_FOR(undefined), prompts.SYSTEM_AGENT);
  assert.equal(prompts.SYSTEM_AGENT_FOR('code'), prompts.SYSTEM_AGENT);
  assert.equal(prompts.SYSTEM_AGENT_FOR('nonsense'), prompts.SYSTEM_AGENT);
  assert.equal(prompts.SYSTEM_AGENT_FOR('design'), prompts.SYSTEM_AGENT_DESIGN);
  assert.equal(prompts.SYSTEM_AGENT_FOR('research'), prompts.SYSTEM_AGENT_RESEARCH);
});

test('all three agent contracts end in JSON the one parser reads', () => {
  for (const [name, sys] of [
    ['SYSTEM_AGENT', prompts.SYSTEM_AGENT],
    ['SYSTEM_AGENT_DESIGN', prompts.SYSTEM_AGENT_DESIGN],
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
  assert.match(d, /ONE self-contained HTML file under \.flowviant\/artifacts\//);
  assert.match(d, /cdnjs\.cloudflare\.com, cdn\.jsdelivr\.net\/npm or\s+unpkg\.com/);
  assert.match(d, /CHANGE NO REPOSITORY FILE AND COMMIT NOTHING/);
  assert.match(d, /frontend-design skill/);
  assert.match(d, /real copy|the real copy|the brand, the\s+design tokens/);
  assert.ok(!d.includes('Flowviant-Task'), 'no trailer — there is nothing to commit');
  const r = prompts.SYSTEM_AGENT_RESEARCH;
  assert.match(r, /ONE Markdown file under \.flowviant\/artifacts\//);
  assert.match(r, /CITE WHAT YOU\s+READ/);
  assert.match(r, /CHANGE NO REPOSITORY FILE AND COMMIT NOTHING/);
  assert.ok(!r.includes('Flowviant-Task'));
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
    assert.equal(perm[0], '--allowedTools', `${name}: a curated list, never skip-permissions`);
    assert.ok(perm.includes(scoped), `${name}: the one scoped write`);
    // No UNSCOPED write of any spelling, and no shell that could commit.
    for (const bad of ['Write', 'Edit', '--dangerously-skip-permissions', 'Bash(git:*)', 'Bash(git commit:*)', 'mcp__flowviant']) {
      assert.ok(!perm.includes(bad), `${name} must not carry ${bad}`);
    }
    // The probe's finding, pinned: a `Write(...)` path rule is NOT a scoped
    // write on 2.1.281 — it denied both files — so it must not be the one used.
    assert.ok(!perm.some((x) => x.startsWith('Write(')), `${name}: never the Write(...) spelling`);
  }
  assert.ok(RESEARCH_PERM.includes('WebSearch') && RESEARCH_PERM.includes('WebFetch'));
  assert.ok(!DESIGN_PERM.some((x) => x.startsWith('Web')), 'a design card draws THIS product');
});

test('runTurn picks the posture by name, ahead of every older branch', () => {
  const c = src('claude.mjs');
  const body = slice(c, 'export function runTurn(', 'const args = rt.args({');
  assert.match(body, /posture === 'design' \|\| posture === 'research'\s*\?\s*posture\s*:\s*planPerm \? 'plan'/);
  const perm = slice(c, 'const args = rt.args({', '// Handed to the adapter rather than appended here');
  assert.match(perm, /profile === 'design'\s*\?\s*DESIGN_PERM\s*:\s*profile === 'research'\s*\?\s*RESEARCH_PERM/);
  // Canary: the untouched arm is still there, so the slice is the real one.
  assert.match(perm, /planPerm \? PLAN_PERM : readOnly \? CONSULT_PERM : wikiPerm \? WIKI_PERM : PERM/);
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
  const w = src('work.mjs');
  const turn = slice(w, 'const runAgentTurn = async (job', 'const lastAgentBeat = new Map();');
  // Canary: this IS the agent lane.
  assert.match(turn, /AGENT_TASK_KICKOFF\(/);
  assert.match(turn, /const taskKind = agentTaskKindOf\(job\.task\?\.taskKind\);/);
  assert.match(turn, /const posture = taskKind === 'code' \? 'build' : taskKind;/);
  assert.match(turn, /if \(!canRun\(RUNTIMES\[rt\], posture\)\)/);
  assert.ok(turn.includes("'design and research cards run on Claude on this machine'"));
  assert.match(turn, /system: withProjectContext\(SYSTEM_AGENT_FOR\(taskKind\),/);
  assert.ok(turn.includes("...(posture !== 'build' ? { posture } : {}),"));
  // The measured check — the snapshot taken before the spawn, the scan after.
  const check = slice(turn, "if (res.outcome === 'delivered' && taskKind !== 'code') {", 'const reply = await postAgentTurn({');
  assert.match(check, /taskKind === 'design' \? \/\\\.html\?\$\/i : \/\\\.md\$\/i/);
  assert.match(check, /changedArtifacts\(artifactsBefore, standing\)/);
  assert.match(check, /job\.kind !== 'task' && standing\.some/);
  assert.match(check, /outcome: 'nothing'/);
  assert.ok(check.includes("'the turn ended without writing a mockup under .flowviant/artifacts/'"));
  assert.ok(check.includes("'the turn ended without writing a write-up under .flowviant/artifacts/'"));
  // Commits are still reported — a report never lies by omission.
  assert.ok(check.includes('...(commits.length ? { commits } : {}),'));
  // …and the check sits AFTER the snapshot is taken and BEFORE the one settle
  // that could say delivered.
  assert.ok(turn.indexOf('const artifactsBefore = beforeArtifacts(wt);') < turn.indexOf(check));
});
