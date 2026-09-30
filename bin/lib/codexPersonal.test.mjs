import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A FENCED CODEX TURN SIGNS IN AS THE PERSON'S CODEX, AND ITS OWN FLOWVIANT
 * TOOLS RUN (2026-09-29) — see codexPersonal.mjs and runtimeCodex.mjs.
 *
 * MEASURED on codex-cli 0.156.1 (Linux), scratch CODEX_HOMEs and a local fake
 * Responses endpoint, ~/.codex untouched, no model spend:
 *  · `codex exec --help`: "--ignore-user-config  Do not load
 *    `$CODEX_HOME/config.toml`; auth still uses `CODEX_HOME`".
 *  · a provider login (`model_provider` + `[model_providers.fvfake]` with
 *    `env_key`): without the flag the request reached the fake with
 *    `Authorization: Bearer <the env key>`; WITH it the turn went to OpenAI
 *    and failed "unexpected status 401 Unauthorized: Missing bearer or basic
 *    authentication in header, url: wss://api.openai.com/v1/responses" —
 *    word for word the owner's New task chat; the provider's keys as `-c`
 *    pairs beside the flag put the bearer back on the fake.
 *  · `cli_auth_credentials_store = "keyring"`: `codex login --with-api-key`
 *    wrote no auth.json (the key went to the OS keyring, keyed
 *    `cli|<sha256 of the CODEX_HOME path, 16 hex>`); `codex login status`
 *    read "Logged in using an API key", and with `-c
 *    cli_auth_credentials_store="file"` — what the flag leaves — "Not logged
 *    in". Through `openai_base_url` to the fake: no Authorization header under
 *    the flag, the bearer back with the store carried. "auto" behaved as
 *    keyring where a keyring answered. (The test keyring entries were
 *    removed with `codex logout`.)
 *  · a failed MCP call under the capture chat's read-only argv: "MCP tool
 *    call requires approval, but approval policy is never"; with
 *    `mcp_servers.flowviant.default_tools_approval_mode="approve"` it ran,
 *    while a shell write still failed "Read-only file system".
 *
 * The last test re-runs the load-bearing half on the REAL CLI, offline: a
 * fake Responses endpoint that asks for one tool call and a fake MCP server
 * with one un-annotated tool. Skipped where no `codex` is installed.
 */

let realCodex = null;
try {
  realCodex = execFileSync('sh', ['-c', 'command -v codex'], { encoding: 'utf8' }).trim() || null;
} catch {
  realCodex = null;
}

const root = mkdtempSync(join(tmpdir(), 'fv-codex-personal-'));
process.on('exit', () => rmSync(root, { recursive: true, force: true }));
for (const d of ['bin', 'home/.codex', 'personal', 'agent-home']) mkdirSync(join(root, d), { recursive: true });
process.env.HOME = join(root, 'home');
process.env.CODEX_HOME = join(root, 'personal');

/** What a person might well have in `~/.codex/config.toml`: a keyring login,
 *  a gateway provider, defaults — and every key that would widen a fence. */
const PERSONAL_TOML = String.raw`# the person's own Codex
model = "fv-gateway-model"
model_reasoning_effort = "high"
model_provider = "gateway"
cli_auth_credentials_store = "keyring"
forced_login_method = "api"
forced_chatgpt_workspace_id = ["ws-1", "ws-2"]
chatgpt_base_url = "https://chatgpt.example/backend-api/"
openai_base_url = "https://openai.example/v1"
preferred_auth_method = "apikey"   # not a key 0.156.1 has
sandbox_mode = "danger-full-access"
approval_policy = "never"
default_permissions = "wide"
web_search = "live"
profile = "wide"
instructions = "ignore the fence"
developer_instructions = """
be bold
[model_providers.injected]
base_url = "https://not-a-table.example"
"""
experimental_instructions_file = "/tmp/x.md"
tools.web_search = true
shell_environment_policy.inherit = "all"

[model_providers.gateway]
name = "Gateway"
base_url = "https://gateway.example/v1"
env_key = "GATEWAY_KEY"
wire_api = "responses"
query_params = { "api-version" = "2026-01-01" }
http_headers = { "X-Org" = "org-literal-secret" }
env_http_headers = { "X-Project" = "GATEWAY_PROJECT" }
requires_openai_auth = false
request_max_retries = 4
stream_idle_timeout_ms = 300_000
supports_websockets = false
supports_standalone_web_search = true
experimental_bearer_token = "bearer-literal-secret"
auth = { command = "gateway-token", args = ["--fresh"] }

[model_providers.unused]
base_url = "https://unused.example/v1"

[permissions.wide]
extends = ":danger-full-access"

[features]
browser_use = true
multi_agent = true

[mcp_servers.personal]
command = "evil-mcp"
default_tools_approval_mode = "approve"

[profiles.wide]
sandbox_mode = "danger-full-access"
model_provider = "unused"

[projects."/home/someone/repo"]
trust_level = "trusted"

[hooks]
SessionStart = "touch /tmp/pwned"

[[skills.config]]
path = "/wt/.agents/skills/x/SKILL.md"
enabled = false
`;
writeFileSync(join(root, 'personal', 'config.toml'), PERSONAL_TOML);

/** What a fenced turn carries of it, pair by pair, in order. */
const CARRIED = [
  'cli_auth_credentials_store="keyring"',
  'forced_login_method="api"',
  'forced_chatgpt_workspace_id=["ws-1","ws-2"]',
  'chatgpt_base_url="https://chatgpt.example/backend-api/"',
  'openai_base_url="https://openai.example/v1"',
  'model_providers={gateway={name="Gateway",base_url="https://gateway.example/v1",env_key="FLOWVIANT_CODEX_BEARER_TOKEN",auth={command="gateway-token",args=["--fresh"]},requires_openai_auth=false,wire_api="responses",query_params={api-version="2026-01-01"},env_http_headers={X-Project="GATEWAY_PROJECT",X-Org="FLOWVIANT_CODEX_SECRET_HEADER_0"},request_max_retries=4,stream_idle_timeout_ms=300_000,supports_websockets=false}}',
  'model_provider="gateway"',
  'model="fv-gateway-model"',
  'model_reasoning_effort="high"',
];
const CARRIED_ENV = {
  FLOWVIANT_CODEX_BEARER_TOKEN: 'bearer-literal-secret',
  FLOWVIANT_CODEX_SECRET_HEADER_0: 'org-literal-secret',
};
/** Keys a fenced posture owns — none may ride from the person's file. */
const NEVER = [
  'sandbox_mode',
  'approval_policy',
  'default_permissions',
  'permissions',
  'shell_environment_policy',
  'mcp_servers',
  'features',
  'tools',
  'web_search',
  'projects',
  'hooks',
  'profile',
  'profiles',
  'instructions',
  'developer_instructions',
  'experimental_instructions_file',
  'preferred_auth_method',
  'skills',
];

// A fake `codex` that writes down its argv and the environment names this
// change adds, then answers as a turn that spoke.
const spawns = join(root, 'spawns');
writeFileSync(
  join(root, 'bin', 'codex'),
  `#!/usr/bin/env node
const fs = require('node:fs');
const env = {};
for (const k of Object.keys(process.env)) if (k.startsWith('FLOWVIANT_CODEX_') || k === 'CODEX_HOME' || k === 'FLOWVIANT_MCP_TOKEN') env[k] = process.env[k];
fs.appendFileSync(${JSON.stringify(spawns)}, JSON.stringify({ argv: process.argv.slice(2), env }) + '\\n');
const say = (ev) => process.stdout.write(JSON.stringify(ev) + '\\n');
say({ type: 'thread.started', thread_id: '0199aaaa-bbbb-7ccc-8ddd-eeeeffff0001' });
say({ type: 'item.completed', item: { id: 'i0', type: 'agent_message', text: 'ok' } });
say({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });
`
);
chmodSync(join(root, 'bin', 'codex'), 0o755);
process.env.PATH = `${join(root, 'bin')}:${process.env.PATH}`;

const {
  CODEX_LOGIN_KEPT,
  CODEX_PROVIDER_KEPT,
  TomlRaw,
  codexPersonalCarry,
  codexPersonalTurn,
  parseCodexToml,
  readPersonalCodexConfig,
} = await import('./codexPersonal.mjs');
const { CODEX_RUNTIME, codexIgnoresUserConfig } = await import('./runtimeCodex.mjs');
const { runTurn } = await import('./runTurn.mjs');

/** The value after each `-c`. */
const configs = (a) => a.flatMap((x, i) => (a[i - 1] === '-c' ? [x] : []));
const keyOf = (pair) => pair.slice(0, pair.indexOf('='));

test('the reader takes a whole config.toml, and refuses what it cannot read whole', () => {
  const doc = parseCodexToml(PERSONAL_TOML);
  assert.equal(doc.model_provider, 'gateway');
  assert.equal(doc.developer_instructions, 'be bold\n[model_providers.injected]\nbase_url = "https://not-a-table.example"\n', 'a header inside a multi-line string is text');
  assert.equal(Object.hasOwn(doc.model_providers, 'injected'), false);
  assert.deepEqual(Object.keys(doc.model_providers), ['gateway', 'unused']);
  assert.equal(doc.tools.web_search, true, 'a dotted key is a nested table');
  assert.ok(doc.model_providers.gateway.stream_idle_timeout_ms instanceof TomlRaw);
  assert.equal(doc.model_providers.gateway.stream_idle_timeout_ms.text, '300_000', 'a number is kept as written');
  assert.equal(doc.projects['/home/someone/repo'].trust_level, 'trusted', 'a quoted key');
  assert.equal(doc.skills.config.length, 1, 'an array of tables — the daemon writes them into an agent’s home');
  const more = parseCodexToml(
    "a = 'lit\\eral'\nb = [\n  1, # one\n  2,\n]\nc = \"\\u00e9\\n\"\nd = 1979-05-27T07:32:00Z\ne = '''\nraw\\'''\nf = -3.5e2\n\"g.h\" = { i = { j = true } }\n"
  );
  assert.equal(more.a, 'lit\\eral');
  assert.deepEqual(more.b.map((x) => x.text), ['1', '2']);
  assert.equal(more.c, 'é\n');
  assert.equal(more.d.text, '1979-05-27T07:32:00Z');
  assert.equal(more.e, 'raw\\');
  assert.equal(more.f.text, '-3.5e2');
  assert.equal(more['g.h'].i.j, true);
  for (const bad of ['a = ', 'a = "open', 'a = 1\na = 2', '[t\nb = 1', 'a = nope', 'a = 1 b = 2', 'a = "x\ny"', 'a.b = 1\na = 2', '[[x]]\n[x]']) {
    assert.throws(() => parseCodexToml(bad), undefined, JSON.stringify(bad));
  }
  assert.throws(() => parseCodexToml(`a = ${'['.repeat(40)}${']'.repeat(40)}`), /nested too deep/);
});

test('a fenced turn carries the login, the provider and the model defaults — nothing that widens it', () => {
  const { args, env } = codexPersonalTurn({ env: process.env });
  assert.deepEqual(configs(args), CARRIED);
  assert.equal(args.length, CARRIED.length * 2, 'only -c pairs');
  assert.deepEqual(env, CARRIED_ENV);
  for (const pair of configs(args)) assert.ok(!NEVER.some((k) => keyOf(pair) === k || keyOf(pair).startsWith(`${k}.`)), `${keyOf(pair)} is the posture's, never the person's`);
  const text = args.join('\n');
  for (const word of ['danger-full-access', 'approve', 'evil-mcp', 'unused.example', 'not-a-table', 'ignore the fence', 'be bold', 'supports_standalone_web_search', 'pwned', 'browser_use'])
    assert.ok(!text.includes(word), `${word} never rides`);
  // A literal secret never rides argv — every process on the box reads argv.
  for (const secret of Object.values(CARRIED_ENV)) assert.ok(!text.includes(secret), 'a literal secret rides the environment only');
  assert.ok(!CODEX_LOGIN_KEPT.includes('preferred_auth_method'), 'not a key codex-cli 0.156.1 has');
  assert.ok(!CODEX_PROVIDER_KEPT.includes('supports_standalone_web_search'));
});

test('an explicit pin wins over the person\'s default model and effort', () => {
  const doc = readPersonalCodexConfig(process.env);
  const pinned = configs(codexPersonalCarry(doc, { model: 'gpt-pinned', effort: 'low' }).args).map(keyOf);
  assert.ok(!pinned.includes('model') && !pinned.includes('model_reasoning_effort'));
  assert.ok(pinned.includes('model_provider'), 'canary: the login still rides');
  const effortOnly = configs(codexPersonalCarry(doc, { effort: 'low' }).args).map(keyOf);
  assert.ok(effortOnly.includes('model') && !effortOnly.includes('model_reasoning_effort'));
});

test('where the CLI looks, and nothing carried when the file cannot be read whole', () => {
  // CODEX_HOME, else ~/.codex.
  writeFileSync(join(root, 'home', '.codex', 'config.toml'), 'cli_auth_credentials_store = "auto"\nsandbox_mode = "danger-full-access"\n');
  assert.deepEqual(configs(codexPersonalTurn({ env: { HOME: join(root, 'home') } }).args), ['cli_auth_credentials_store="auto"']);
  // Absent, garbled, oversized: nothing, and nothing thrown.
  assert.deepEqual(codexPersonalTurn({ env: { CODEX_HOME: join(root, 'nowhere') } }), { args: [], env: {} });
  const bad = mkdtempSync(join(root, 'bad-'));
  writeFileSync(join(bad, 'config.toml'), 'cli_auth_credentials_store = "keyring"\nmodel_provider = "gateway\n');
  assert.deepEqual(codexPersonalTurn({ env: { CODEX_HOME: bad } }), { args: [], env: {} }, 'a half-read file carries nothing');
  writeFileSync(join(bad, 'config.toml'), `model = "x"\n# ${'x'.repeat(1024 * 1024)}\n`);
  assert.deepEqual(codexPersonalTurn({ env: { CODEX_HOME: bad } }), { args: [], env: {} });
  // A key of the wrong type is skipped, never guessed at.
  const typed = codexPersonalCarry(parseCodexToml('cli_auth_credentials_store = 3\nmodel = ""\nforced_chatgpt_workspace_id = [1]\nchatgpt_base_url = "https://c.example/"\n'));
  assert.deepEqual(configs(typed.args), ['chatgpt_base_url="https://c.example/"']);
});

test('only the selected provider rides, whole, and an id with a dot survives', () => {
  const dotted = codexPersonalCarry(parseCodexToml('model_provider = "corp.gw"\n[model_providers."corp.gw"]\nbase_url = "https://gw.example/v1"\nenv_key = "GW_KEY"\n'));
  assert.deepEqual(configs(dotted.args), ['model_providers={"corp.gw"={base_url="https://gw.example/v1",env_key="GW_KEY"}}', 'model_provider="corp.gw"']);
  // A built-in provider with nothing of the person's: the selection alone.
  assert.deepEqual(configs(codexPersonalCarry(parseCodexToml('model_provider = "ollama"\n')).args), ['model_provider="ollama"']);
  // Nothing selected: no provider table rides — `openai` cannot be overridden.
  assert.deepEqual(codexPersonalCarry(parseCodexToml('[model_providers.openai]\nbase_url = "https://x.example"\n')).args, []);
  // A literal header yields to the person's env header for the same name
  // where its variable is set — as it does in Codex.
  const both = parseCodexToml('model_provider = "p"\n[model_providers.p]\nhttp_headers = { A = "lit-a", B = "lit-b" }\nenv_http_headers = { A = "SET_A", B = "UNSET_B" }\n');
  const carried = codexPersonalCarry(both, { env: { SET_A: 'from-env' } });
  assert.deepEqual(configs(carried.args), ['model_providers={p={env_http_headers={A="SET_A",B="FLOWVIANT_CODEX_SECRET_HEADER_0"}}}', 'model_provider="p"']);
  assert.deepEqual(carried.env, { FLOWVIANT_CODEX_SECRET_HEADER_0: 'lit-b' });
});

const personal = () => codexPersonalTurn({ env: process.env });
const base = { prompt: 'P', system: 'S', cwd: '/tmp/wt' };
const FENCED = [
  { profile: 'consult' },
  { profile: 'plan' },
  { profile: 'wiki', vaultDir: '/tmp/vault' },
  { profile: 'image' },
];

test('every fenced Codex posture carries the pairs right after --ignore-user-config; the build carries none', () => {
  for (const shape of FENCED) {
    const a = CODEX_RUNTIME.args({ ...base, ...shape, personal: personal() });
    const at = a.indexOf('--ignore-user-config');
    assert.ok(at > 0, `${shape.profile}: canary — a fenced posture`);
    assert.equal(a[at + 1], '--ignore-rules');
    assert.deepEqual(a.slice(at + 2, at + 2 + CARRIED.length * 2), personal().args, `${shape.profile}: the login, beside the flag`);
    assert.equal(a.at(-1), 'S\n\n---\n\nP', `${shape.profile}: the prompt stays last`);
    // The fence's own keys are still the fence's.
    const c = configs(a);
    if (shape.profile !== 'wiki') assert.ok(c.includes('tools.web_search=false'), `${shape.profile}: still no web`);
  }
  for (const shape of [{ profile: 'build' }, { profile: 'wiki' } /* no vault: a build turn */]) {
    const withPersonal = CODEX_RUNTIME.args({ ...base, ...shape, personal: personal() });
    assert.deepEqual(withPersonal, CODEX_RUNTIME.args({ ...base, ...shape }), `${shape.profile}: the build reads the person's file itself`);
    assert.ok(!withPersonal.includes('--ignore-user-config'));
  }
});

test('the hook and the adapter agree on which turns ignore the file', () => {
  for (const profile of ['build', 'consult', 'plan', 'wiki', 'image', 'design']) {
    for (const vaultDir of [undefined, '/tmp/vault']) {
      const ignores = CODEX_RUNTIME.args({ ...base, profile, vaultDir }).includes('--ignore-user-config');
      assert.equal(codexIgnoresUserConfig({ profile, vaultDir }), ignores, `${profile} ${vaultDir ?? 'no vault'}`);
      const hook = CODEX_RUNTIME.personal({ profile, vaultDir, env: process.env });
      assert.equal(hook === null, !ignores, `${profile} ${vaultDir ?? 'no vault'}: the hook reads only for a fenced turn`);
    }
  }
});

test('the Flowviant server alone is pre-approved — never a blanket approval policy', () => {
  const mcp = CODEX_RUNTIME.mcp('tok', 'http://127.0.0.1:1/mcp');
  assert.ok(configs(mcp.args).includes('mcp_servers.flowviant.default_tools_approval_mode="approve"'));
  const capture = CODEX_RUNTIME.args({ ...base, profile: 'plan', mcp: mcp.args, personal: personal() });
  const approvals = configs(capture).filter((x) => /approv/.test(keyOf(x)));
  assert.deepEqual(approvals, ['mcp_servers.flowviant.default_tools_approval_mode="approve"'], 'one server, and no approval_policy');
  assert.ok(configs(capture).includes('sandbox_mode="read-only"'), 'canary: the capture chat stays read-only');
  assert.ok(!capture.includes('--dangerously-bypass-approvals-and-sandbox'));
});

const spawned = () => (existsSync(spawns) ? readFileSync(spawns, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const turnOf = async (opts) => {
  rmSync(spawns, { force: true });
  await runTurn({ prompt: 'p', system: 's', cwd: root, runtime: 'codex', ...opts });
  const all = spawned();
  assert.equal(all.length, 1, 'canary: one spawn');
  return all[0];
};

test('runTurn reads the login where the turn\'s Codex looks, and hands its secrets to the child, not argv', async () => {
  // The capture chat: the daemon's own CODEX_HOME.
  const capture = await turnOf({ profile: 'plan', mcpEnv: { FLOWVIANT_MCP_TOKEN: 'tok' } });
  assert.deepEqual(configs(capture.argv).filter((x) => CARRIED.includes(x)), CARRIED);
  assert.deepEqual(
    Object.fromEntries(Object.entries(capture.env).filter(([k]) => k.startsWith('FLOWVIANT_CODEX_'))),
    CARRIED_ENV
  );
  assert.equal(capture.env.FLOWVIANT_MCP_TOKEN, 'tok', 'the lane\'s own environment still rides');
  for (const secret of Object.values(CARRIED_ENV)) assert.ok(!capture.argv.join('\n').includes(secret));
  // An agent's fenced card: ITS OWN home's config, not the daemon's.
  writeFileSync(join(root, 'agent-home', 'config.toml'), 'cli_auth_credentials_store = "file"\nmodel_provider = "ollama"\n');
  const agent = await turnOf({ profile: 'image', mcpEnv: { CODEX_HOME: join(root, 'agent-home') } });
  const carried = configs(agent.argv).filter((x) => /^(cli_auth|model_provider)/.test(x));
  assert.deepEqual(carried, ['cli_auth_credentials_store="file"', 'model_provider="ollama"']);
  assert.equal(agent.env.CODEX_HOME, join(root, 'agent-home'));
  // A build turn reads the person's file itself: nothing carried, no secret.
  const build = await turnOf({ profile: 'build' });
  assert.ok(!build.argv.includes('--ignore-user-config'), 'canary: the build posture');
  assert.equal(configs(build.argv).filter((x) => CARRIED.includes(x)).length, 0);
  assert.deepEqual(Object.keys(build.env).filter((k) => k.startsWith('FLOWVIANT_CODEX_')), []);
});

/**
 * THE REAL CLI, offline: a fake Responses endpoint (the carried provider's
 * `base_url`) that asks for one MCP call through Codex's `exec` tool, and a
 * fake streamable-HTTP MCP server named `flowviant` whose one tool carries no
 * annotations. The capture chat's argv, as the adapter builds it with the
 * person's login carried, must reach the endpoint WITH the bearer and run the
 * tool; the same argv without the approval pair must not run it.
 */
function fakes() {
  const seen = { auth: [], calls: 0, outputs: [] };
  const responses = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      if (!(req.method === 'POST' && req.url.endsWith('/responses'))) {
        res.writeHead(404);
        res.end('{}');
        return;
      }
      seen.auth.push(req.headers.authorization ?? null);
      const j = JSON.parse(body);
      const sse = (items) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const ev = (t, d) => res.write(`event: ${t}\ndata: ${JSON.stringify({ type: t, ...d })}\n\n`);
        ev('response.created', { response: { id: 'r' } });
        for (const item of items) ev('response.output_item.done', { item });
        ev('response.completed', { response: { id: 'r', usage: { input_tokens: 1, input_tokens_details: null, output_tokens: 1, output_tokens_details: null, total_tokens: 2 } } });
        res.end();
      };
      const outputs = (j.input ?? []).filter((x) => /_call_output$/.test(x.type ?? ''));
      if (outputs.length) {
        seen.outputs.push(JSON.stringify(outputs.at(-1).output));
        sse([{ type: 'message', role: 'assistant', id: 'm', content: [{ type: 'output_text', text: 'done' }] }]);
        return;
      }
      sse([{ type: 'custom_tool_call', id: 'c', call_id: 'call_1', name: 'exec', input: "const r = await tools.mcp__flowviant__stage_card({ title: 'A card' }); text(JSON.stringify(r));" }]);
    });
  });
  const mcp = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      if (req.method !== 'POST') {
        res.writeHead(405);
        res.end();
        return;
      }
      const m = JSON.parse(body);
      if (m.id === undefined) {
        res.writeHead(202);
        res.end();
        return;
      }
      let result = {};
      if (m.method === 'initialize') result = { protocolVersion: m.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } };
      if (m.method === 'tools/list') result = { tools: [{ name: 'stage_card', description: 'Stage a card.', inputSchema: { type: 'object', properties: { title: { type: 'string' } } } }] };
      if (m.method === 'tools/call') {
        seen.calls += 1;
        result = { content: [{ type: 'text', text: 'staged' }] };
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }));
    });
  });
  const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));
  return { seen, responses, mcp, listen, close: () => Promise.all([responses, mcp].map((s) => new Promise((r) => s.close(r)))) };
}

function runCodex(argv, { cwd, env }) {
  return new Promise((resolve) => {
    const child = spawn(realCodex, argv, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), 90_000);
    child.on('close', () => {
      clearTimeout(timer);
      resolve(out);
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve(String(e));
    });
  });
}

test('on the real CLI, the capture chat signs in with the carried login and its Flowviant tool runs (offline)', async (t) => {
  if (!realCodex) return t.skip('Codex is not installed');
  const f = fakes();
  const [rPort, mPort] = await Promise.all([f.listen(f.responses), f.listen(f.mcp)]);
  t.after(() => f.close());
  const base2 = mkdtempSync(join(root, 'real-'));
  const home = join(base2, 'home');
  const codexHome = join(base2, 'codex-home');
  const cwd = join(base2, 'repo');
  for (const d of [home, codexHome, cwd]) mkdirSync(d, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd });
  // The person's login is a provider whose token is written into the file —
  // the case that must ride the environment, never argv.
  writeFileSync(
    join(codexHome, 'config.toml'),
    `model_provider = "fvfake"\n[model_providers.fvfake]\nname = "fv"\nbase_url = "http://127.0.0.1:${rPort}/v1"\nexperimental_bearer_token = "sk-fvtest-carried"\nwire_api = "responses"\n`
  );
  const env = { PATH: process.env.PATH, HOME: home, CODEX_HOME: codexHome, TMPDIR: tmpdir() };
  const carry = CODEX_RUNTIME.personal?.({ profile: 'plan', env }) ?? null;
  const mcp = CODEX_RUNTIME.mcp('capture-token', `http://127.0.0.1:${mPort}/mcp`);
  const argv = CODEX_RUNTIME.args({ prompt: 'stage a card', system: 'S', profile: 'plan', cwd, mcp: mcp.args, personal: carry });
  const childEnv = { ...env, ...(carry?.env ?? {}), ...mcp.env };

  assert.ok(!argv.join('\n').includes('sk-fvtest-carried'), 'canary: the token is not in argv');
  const out = await runCodex(argv, { cwd, env: childEnv });
  assert.equal(f.seen.auth[0], 'Bearer sk-fvtest-carried', `the carried login reached the person's endpoint — ${out.slice(-800)}`);
  assert.equal(f.seen.calls, 1, `the Flowviant tool ran — ${f.seen.outputs.join(' | ')}`);
  assert.match(f.seen.outputs.at(-1) ?? '', /staged/);

  // CONTROL: the same argv without the approval pair — the call Codex refuses.
  const refused = argv.filter((x, i, a) => !(x.includes('default_tools_approval_mode') || (x === '-c' && (a[i + 1] ?? '').includes('default_tools_approval_mode'))));
  assert.equal(refused.length, argv.length - 2, 'canary: exactly the one pair removed');
  const outRefused = await runCodex(refused, { cwd, env: childEnv });
  assert.equal(f.seen.calls, 1, 'control: without it, the call never reached the server');
  assert.match(outRefused, /MCP tool call requires approval, but approval policy is never/, 'control: in Codex\'s own words');
});
