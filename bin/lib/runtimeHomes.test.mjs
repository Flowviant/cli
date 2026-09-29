/**
 * THE RUNTIME REGISTRY'S NEIGHBOURS, EACH WITH ONE HOME (2026-09-26, SOLID
 * F045).
 *
 * runtimes.mjs once held four reasons to change in 1,592 lines: the argv
 * registry, the vendors' stream parsers, the `--version` detection, and the
 * skills/MCP caches with their one-shot probe. The last three moved out —
 * runtimeEvents.mjs, runtimeDetection.mjs, runtimeCapabilities.mjs — and each
 * vendor's row went to its own runtime{Claude,Codex,Antigravity}.mjs. This
 * file pins that each rule lives in exactly one of them (a copy coming back
 * fails here), that the registry stays free of I/O and state, and that the
 * registry still hands each adapter the parser that now lives next door.
 *
 * Run: node --test bin/lib/runtimeHomes.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { RUNTIMES } from './runtimes.mjs';
import { CLAUDE_RUNTIME } from './runtimeClaude.mjs';
import { CODEX_RUNTIME } from './runtimeCodex.mjs';
import { ANTIGRAVITY_RUNTIME } from './runtimeAntigravity.mjs';
import { parseCodexLine, parseAgyLine } from './runtimeEvents.mjs';
import { pickRuntimeFor } from './runtimeDetection.mjs';

/** CODE ONLY — comments name the symbols they explain. */
const code = (file) =>
  readFileSync(new URL(`./${file}`, import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .join('\n');

const sources = readdirSync(new URL('.', import.meta.url)).filter(
  (f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs')
);

/**
 * A DEFINITION OF `name`, in whatever shape it comes back as: exported or not,
 * a function, an arrow on a `const`, a `let`, a class. Keyed on the name being
 * DEFINED, so an import or a call is not a copy.
 */
const definesName = (name) =>
  new RegExp(`(?:^|[^\\w$.])(?:async\\s+)?(?:function\\*?|const|let|var|class)\\s+${name}(?![\\w$])`, 'm');

/** The modules runtimes.mjs was split into — the scope the old file covered. */
const RUNTIME_MODULES = [
  'runtimes.mjs',
  'runtimeEvents.mjs',
  'runtimeDetection.mjs',
  'runtimeCapabilities.mjs',
  'runtimeClaude.mjs',
  'runtimeCodex.mjs',
  'runtimeAntigravity.mjs',
];

test('the definition matcher sees a copy in every shape it could come back as', () => {
  const m = definesName('toolEventOf');
  for (const copy of [
    'export function toolEventOf(name, input) {',
    'function toolEventOf(name, input) {',
    'const toolEventOf = (name) => null;',
    'let toolEventOf = null;',
    'export async function toolEventOf() {}',
  ])
    assert.ok(m.test(copy), `a copy spelled \`${copy}\` is seen`);
  for (const use of [
    "import { toolEventOf } from './runtimeEvents.mjs';",
    'const ev = toolEventOf(n, i, cwd);',
    'const toolEventOfClaude = 1;',
    'x.toolEventOf = f;',
  ])
    assert.ok(!m.test(use), `\`${use}\` is not a definition`);
});

test('each moved rule is defined in exactly one module, the one named for it', () => {
  // Canary: the walk sees the daemon's modules, the registry among them.
  assert.ok(sources.length > 50, `walked ${sources.length} modules`);
  for (const f of RUNTIME_MODULES) assert.ok(sources.includes(f), `the walk sees ${f}`);
  const homes = {
    // What a CLI's stream MEANT.
    THINK_MARKER: 'runtimeEvents.mjs',
    shortPath: 'runtimeEvents.mjs',
    SCRUB_WINDOW: 'runtimeEvents.mjs',
    humanizeClaudeTool: 'runtimeEvents.mjs',
    toolEventOf: 'runtimeEvents.mjs',
    CLAUDE_TOOL_PROSE_KINDS: 'runtimeEvents.mjs',
    humanizeCodexItem: 'runtimeEvents.mjs',
    parseCodexLine: 'runtimeEvents.mjs',
    humanizeAgyTool: 'runtimeEvents.mjs',
    parseAgyLine: 'runtimeEvents.mjs',
    // Which CLIs this box has, and which runs an unmentioned job.
    DETECT_TTL_MS: 'runtimeDetection.mjs',
    detectRuntimes: 'runtimeDetection.mjs',
    runtimesReport: 'runtimeDetection.mjs',
    pickRuntimeFor: 'runtimeDetection.mjs',
    // The skills and MCP servers a CLI reported, and the probe that learns them.
    MCP_STATUSES: 'runtimeCapabilities.mjs',
    MAX_MCP_SERVERS: 'runtimeCapabilities.mjs',
    MCP_NAME_MAX: 'runtimeCapabilities.mjs',
    recordSkills: 'runtimeCapabilities.mjs',
    knownSkills: 'runtimeCapabilities.mjs',
    recordMcpServers: 'runtimeCapabilities.mjs',
    knownMcpServers: 'runtimeCapabilities.mjs',
    parseInitLine: 'runtimeCapabilities.mjs',
    transcriptCandidates: 'runtimeCapabilities.mjs',
    removeProbeTranscript: 'runtimeCapabilities.mjs',
    probeSkillsOnce: 'runtimeCapabilities.mjs',
    // Each vendor's row and its MCP mint.
    CLAUDE_RUNTIME: 'runtimeClaude.mjs',
    claudeMcp: 'runtimeClaude.mjs',
    CODEX_RUNTIME: 'runtimeCodex.mjs',
    codexMcp: 'runtimeCodex.mjs',
    ANTIGRAVITY_RUNTIME: 'runtimeAntigravity.mjs',
    // The registry: assembly, lookup, the per-profile drivability rule.
    RUNTIMES: 'runtimes.mjs',
    runtimeById: 'runtimes.mjs',
    PROFILE_NEEDS_MCP: 'runtimes.mjs',
    mediated: 'runtimes.mjs',
    mediatedSafeGap: 'runtimes.mjs',
    canRun: 'runtimes.mjs',
    drivableHere: 'runtimes.mjs',
  };
  const text = Object.fromEntries(sources.map((f) => [f, code(f)]));
  for (const [name, home] of Object.entries(homes)) {
    const holders = sources.filter((f) => definesName(name).test(text[f]));
    assert.deepEqual(holders, [home], `${name} is defined in ${home} alone`);
  }
  // Two names are common local helpers with OTHER rules elsewhere, each held
  // before the split: `oneLine` in claudeStream.mjs (a 160-char clip, out of
  // claude.mjs since SOLID F046) and prompts.mjs
  // (newlines only), `countLines` in worktreeDiff.mjs (a diff's count of a
  // buffer: a trailing newline adds none, a NUL is binary). Within what
  // runtimes.mjs used to be, each has one home.
  for (const name of ['oneLine', 'countLines']) {
    const holders = RUNTIME_MODULES.filter((f) => definesName(name).test(text[f]));
    assert.deepEqual(holders, ['runtimeEvents.mjs'], `${name} is defined in runtimeEvents.mjs alone`);
  }
});

test("the bare thinking marker is spelled once, in runtimeEvents.mjs; everyone else imports it", () => {
  // Any spelling of the literal: the real ellipsis, its escape, or three dots.
  const marker = /['"`]thinking(?:…|\\u2026|\.\.\.)['"`]/;
  const text = Object.fromEntries(sources.map((f) => [f, code(f)]));
  const spellers = sources.filter((f) => marker.test(text[f]));
  assert.deepEqual(spellers, ['runtimeEvents.mjs'], 'THINK_MARKER is the one spelling');
  // Canary: the readers of the marker import it rather than go without.
  assert.ok(text['claudeStream.mjs'].includes('THINK_MARKER'));
});

test('the registry does no I/O of its own and keeps no state', () => {
  const r = code('runtimes.mjs');
  assert.ok(r.includes('export const RUNTIMES = {'), 'canary: this is the registry');
  // Detection execs, the probe spawns, parsers parse — none of them here.
  assert.ok(!/\bexecFileSync\b/.test(r), 'detection lives in runtimeDetection.mjs');
  assert.ok(!/\bspawn\(/.test(r), 'the probe lives in runtimeCapabilities.mjs');
  assert.ok(!/JSON\.parse\(/.test(r), 'stream parsing lives in runtimeEvents.mjs');
  assert.ok(!/^let /m.test(r), 'no module-level cache: those are machine reports');
  assert.ok(!/\bwriteFileSync\b/.test(r), "Claude's MCP config file is minted in runtimeClaude.mjs");
  // …and the one importer direction: the registry never reaches for the box.
  assert.ok(!r.includes("from './runtimeDetection.mjs'"));
  assert.ok(!r.includes("from './runtimeCapabilities.mjs'"));
});

test('each adapter is handed the parser that moved next door, and it still parses', () => {
  assert.equal(RUNTIMES.codex.parse, parseCodexLine);
  assert.equal(RUNTIMES.antigravity.parse, parseAgyLine);
  assert.equal(RUNTIMES.claude.parse, null, 'claudeStream.mjs owns its own stream loop');
  // End to end through the registry: a codex message and an agy result.
  const said = RUNTIMES.codex.parse(
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'DONE' } }),
    '/wt'
  );
  assert.equal(said.text, 'DONE\n');
  assert.equal(said.answer, 'DONE');
  assert.equal(said.activity.kind, 'say');
  const agy = RUNTIMES.antigravity.parse(JSON.stringify({ event: 'result', result: { response: 'NOTHING' } }), '/wt');
  assert.equal(agy.text, 'NOTHING\n');
  assert.equal(agy.activity, null);
});

test('pickRuntimeFor joins the registry with the measured rows: Claude first, else any that can', () => {
  const rows = (ids) => Object.keys(RUNTIMES).map((id) => ({ id, installed: ids.includes(id) }));
  assert.equal(pickRuntimeFor('wiki', { detected: rows(['claude', 'codex']) }), 'claude');
  assert.equal(pickRuntimeFor('wiki', { detected: rows(['codex']) }), 'codex');
  // Antigravity cannot plan (the profile is absent on purpose), so it is never picked for one.
  assert.equal(pickRuntimeFor('plan', { detected: rows(['antigravity']) }), null);
  assert.equal(pickRuntimeFor('design', { detected: rows(['codex', 'antigravity']) }), null);
  assert.equal(pickRuntimeFor('consult', { detected: rows([]) }), null);
});

test('the registry assembles the vendor rows, in the order the picker walks them', () => {
  assert.deepEqual(Object.keys(RUNTIMES), ['claude', 'codex', 'antigravity']);
  assert.equal(RUNTIMES.claude, CLAUDE_RUNTIME);
  assert.equal(RUNTIMES.codex, CODEX_RUNTIME);
  assert.equal(RUNTIMES.antigravity, ANTIGRAVITY_RUNTIME);
  for (const [id, rt] of Object.entries(RUNTIMES)) assert.equal(rt.id, id, `${id}'s row answers to its key`);
});
