/**
 * THE MACHINE SAYS WHICH CONNECTORS NEED A LOGIN (2026-09-23, 0.97.0).
 *
 * Claude Code's `system.init` event carries `mcp_servers: [{name, status,
 * source}]` — measured on 2.1.281 with `claude -p hi --model haiku
 * --output-format stream-json --verbose`: ten claude.ai connectors, seven
 * `connected` and three `needs-auth`, each named `claude.ai <Name>` with
 * `source: "claudeai"`; a server mounted with `--mcp-config` arrives with
 * `source: "dynamic"`. The daemon relays the list on the poll so the app can
 * name the connector that needs a sign-in AT THE BOX before a turn fails on it.
 *
 * Pinned: the harvest off BOTH readers of the init event (the turn's stream
 * parser and the probe's line reader), the exclusion of this daemon's own
 * `flowviant` server, the closed status vocabulary with `other`, the caps, the
 * three states, and the poll param.
 *
 * Run: node --test bin/lib/mcpServers.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parseInitLine,
  recordMcpServers,
  knownMcpServers,
  MAX_MCP_SERVERS,
  MCP_NAME_MAX,
} from './runtimes.mjs';
import { handleStreamLine } from './claude.mjs';

const src = (f) => readFileSync(new URL(`./${f}`, import.meta.url), 'utf8');
const slice = (s, from, to) => {
  const a = s.indexOf(from);
  const b = s.indexOf(to, a + from.length);
  assert.ok(a >= 0, `anchor missing: ${from}`);
  assert.ok(b > a, `anchor missing: ${to}`);
  return s.slice(a, b);
};

/** The measured shape, abridged. */
const INIT = {
  type: 'system',
  subtype: 'init',
  session_id: 'd4745778-022b-4a71-9167-fd0c33ce3442',
  skills: ['docx'],
  mcp_servers: [
    { name: 'claude.ai Gmail', status: 'connected', source: 'claudeai' },
    { name: 'claude.ai Google Drive', status: 'needs-auth', source: 'claudeai' },
    { name: 'flowviant', status: 'connected', source: 'dynamic' },
    { name: 'local-db', status: 'failed', source: 'project' },
  ],
};

test('a machine no turn has taught reports NULL — the param is not sent', () => {
  assert.equal(knownMcpServers(), null);
});

test('the turn stream parser hands the init event\'s mcp_servers to onInit', () => {
  let got = null;
  handleStreamLine(JSON.stringify(INIT), {
    cwd: '/x',
    emit: () => {},
    appendText: () => {},
    onInit: (i) => {
      got = i;
    },
  });
  assert.ok(got);
  assert.equal(got.mcpServers.length, 4);
  assert.deepEqual(got.skills, ['docx']);
  // An init event carrying ONLY the servers is still reported.
  let only = null;
  handleStreamLine(JSON.stringify({ type: 'system', subtype: 'init', mcp_servers: [] }), {
    cwd: '/x',
    emit: () => {},
    appendText: () => {},
    onInit: (i) => {
      only = i;
    },
  });
  assert.deepEqual(only.mcpServers, []);
});

test('the probe\'s line reader carries them too', () => {
  const init = parseInitLine(JSON.stringify(INIT));
  assert.equal(init.mcpServers.length, 4);
  assert.equal(parseInitLine(JSON.stringify({ type: 'system', subtype: 'init' })).mcpServers, null);
});

test('recorded: flowviant excluded, CONNECTED excluded, statuses kept, sorted, compact {n, s}', () => {
  recordMcpServers(INIT.mcp_servers);
  assert.deepEqual(knownMcpServers(), [
    { n: 'claude.ai Google Drive', s: 'needs-auth' },
    { n: 'local-db', s: 'failed' },
  ]);
  assert.ok(!knownMcpServers().some((e) => e.n === 'flowviant'), 'our own server is never relayed');
});

test('a connected server never leaves the box — the operator\'s signed-in services are nobody\'s read', () => {
  recordMcpServers([
    { name: 'claude.ai Gmail', status: 'connected', source: 'claudeai' },
    { name: 'claude.ai Robinhood', status: 'connected', source: 'claudeai' },
    { name: 'claude.ai Google Drive', status: 'needs-auth', source: 'claudeai' },
  ]);
  assert.deepEqual(knownMcpServers(), [{ n: 'claude.ai Google Drive', s: 'needs-auth' }]);
  // Signed in at the box: the next init reports it connected, and it LEAVES —
  // an all-connected turn is `[]`, which clears the stale line server-side.
  recordMcpServers([
    { name: 'claude.ai Gmail', status: 'connected' },
    { name: 'claude.ai Google Drive', status: 'connected' },
  ]);
  assert.deepEqual(knownMcpServers(), []);
});

test('a status off the closed list is relayed as `other`, never dropped', () => {
  recordMcpServers([
    { name: 'a', status: 'pending' },
    { name: 'b', status: 'reconnecting' },
    { name: 'c' },
  ]);
  assert.deepEqual(knownMcpServers(), [
    { n: 'a', s: 'pending' },
    { n: 'b', s: 'other' },
    { n: 'c', s: 'other' },
  ]);
});

test(`capped at ${MAX_MCP_SERVERS} entries and names at ${MCP_NAME_MAX} characters`, () => {
  const many = Array.from({ length: 70 }, (_, i) => ({ name: `srv-${String(i).padStart(2, '0')}`, status: 'failed' }));
  // Connected ones are dropped BEFORE the cap, so they never crowd out one
  // that needs something.
  many.unshift(...Array.from({ length: 50 }, (_, i) => ({ name: `a-ok-${i}`, status: 'connected' })));
  recordMcpServers([...many, { name: 'z'.repeat(200), status: 'failed' }]);
  const got = knownMcpServers();
  assert.equal(got.length, MAX_MCP_SERVERS);
  assert.ok(got.every((e) => e.s === 'failed'), 'no connected entry took a slot');
  recordMcpServers([{ name: `  ${'y'.repeat(200)}  `, status: 'failed' }]);
  assert.equal(knownMcpServers()[0].n.length, MCP_NAME_MAX);
});

test('[] is a fact and is recorded; a non-array leaves what we knew', () => {
  recordMcpServers([{ name: 'flowviant', status: 'connected' }]);
  assert.deepEqual(knownMcpServers(), [], 'only our own server mounted = none of the person\'s own');
  recordMcpServers([{ name: 'x', status: 'failed' }]);
  recordMcpServers(undefined);
  recordMcpServers('nope');
  assert.deepEqual(knownMcpServers(), [{ n: 'x', s: 'failed' }]);
});

test('every reader of an init event records the servers beside the skills', () => {
  const r = src('runtimes.mjs');
  const probe = slice(r, 'export function probeSkillsOnce(', 'finish(init.sessionId);');
  assert.match(probe, /if \(init\.skills\) recordSkills\(init\.skills\);/); // canary
  assert.match(probe, /if \(init\.mcpServers\) recordMcpServers\(init\.mcpServers\);/);
  const w = src('work.mjs');
  const tab = slice(w, 'onInit: (i) => {\n                recordSkills(i.skills);', 'seenClaudeSession = i.sessionId.trim();');
  assert.match(tab, /recordMcpServers\(i\.mcpServers\);/);
  // The AGENT lane too (2026-09-23): a box that only runs agents otherwise
  // learned its skills and connectors once, from the startup probe, forever.
  const agent = slice(w, 'const runAgentTurn = async (job', 'const lastAgentBeat = new Map();');
  assert.match(agent, /AGENT_TASK_KICKOFF\(/); // canary: this is the agent lane
  assert.match(agent, /onInit: \(i\) => \{\s*recordSkills\(i\.skills\);\s*recordMcpServers\(i\.mcpServers\);\s*\},/);
  assert.equal(w.split('recordMcpServers(i.mcpServers);').length - 1, 2, 'the tab lane and the agent lane');
  const f = src('fleet.mjs');
  assert.equal(f.split('recordMcpServers(i.mcpServers);').length - 1, 2, 'both wiki lanes');
  assert.equal(f.split('recordSkills(i.skills);').length - 1, 2, 'canary: the two wiki lanes are the ones');
});

test('the poll sends `mcp` as JSON only once something has been learned', () => {
  const f = src('fleet.mjs');
  const block = slice(f, "const skills = knownSkills();", '// THIS BOX\'S IDENTITY');
  assert.match(block, /url\.searchParams\.set\('skills'/); // canary
  assert.match(block, /const mcp = knownMcpServers\(\);\s*if \(mcp !== null\) url\.searchParams\.set\('mcp', JSON\.stringify\(mcp\)\);/);
});
