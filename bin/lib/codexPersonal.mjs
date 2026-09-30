/**
 * A FENCED CODEX TURN STILL SIGNS IN AS THE PERSON'S CODEX (2026-09-29).
 *
 * The owner's New task chat on Codex failed on their WSL machine with
 * `401 Unauthorized: Missing bearer or basic authentication in header` — Codex
 * sent the request with no login at all — while their Codex agents' build
 * turns ran. Every fenced Codex posture (consult, plan and the capture chat,
 * wiki, image) passes `--ignore-user-config` so no personal config can widen a
 * posture asserted on the person's behalf (runtimeCodex.mjs). Codex 0.156.1's
 * own words for that flag: "Do not load `$CODEX_HOME/config.toml`; auth still
 * uses `CODEX_HOME`". The FILE of credentials is still found; everything
 * config.toml says about WHERE the login lives and WHICH endpoint it signs
 * into is dropped with the rest. MEASURED on codex-cli 0.156.1 with scratch
 * CODEX_HOMEs and a local fake Responses endpoint (~/.codex untouched):
 *  · `cli_auth_credentials_store = "keyring"` (or "auto" where a keyring
 *    answers): `codex login` stores the login in the OS keyring and writes no
 *    auth.json. Under the flag the store is the default "file", the file is
 *    not there, and the request went out with no Authorization header;
 *    `-c cli_auth_credentials_store="keyring"` beside the flag put the bearer
 *    back.
 *  · a custom `model_provider` with its `[model_providers.<id>]` table: under
 *    the flag the turn went to api.openai.com/v1/responses with no login —
 *    word for word the owner's error; the provider's keys as `-c` pairs put
 *    it back on the person's endpoint with its `env_key` bearer.
 *  · `openai_base_url` routes the built-in provider and `chatgpt_base_url` a
 *    ChatGPT login's workspace discovery; both were dropped by the flag.
 *
 * So each fenced posture carries back ONLY what makes the CLI the person's
 * CLI — how it signs in, which provider and endpoint it reaches, and the
 * model it runs when the turn pins none — as `-c` overrides beside the flag.
 * An ALLOWLIST, the Claude mirror's rule (claudePersonal.mjs): sandbox and
 * approval settings, permission profiles, the shell environment policy, MCP
 * servers, features, tools and web search, projects, hooks, profiles and
 * instructions never ride, and a key a later Codex adds never rides by
 * default. A config that does not parse carries nothing, which is the turn as
 * it ran before this.
 *
 * A LITERAL SECRET NEVER RIDES ARGV. Every process on the box can read
 * another's command line, and the daemon already keeps its own MCP token in
 * the environment for that reason (runtimeCodex.mjs `codexMcp`). A header
 * value or a bearer token written into config.toml rides in the turn's
 * ENVIRONMENT instead, named by the CLI's own indirection (`env_http_headers`,
 * `env_key`). The environment is kept from the box's other users; argv is
 * not. It is NOT kept from the turn's own model, and cannot usefully be: `env`
 * in a fenced turn's shell listed every variable Codex was started with (a
 * provider key and FLOWVIANT_MCP_TOKEN among them — measured), Codex's shell
 * snapshot put back a name `shell_environment_policy.exclude` had removed
 * (measured), and the read-only sandbox reads `~/.codex/config.toml`, where
 * the literal is written, anyway.
 *
 * STATED, NOT CLOSED: a login chosen by a legacy `profile = "…"` table is not
 * carried (profiles never ride), and Codex keys a keyring login by its
 * CODEX_HOME's path, so a keyring login is invisible from an agent's own
 * CODEX_HOME whichever posture it runs (measured: another home with the same
 * config read "Not logged in").
 */
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { toml } from './projectToolRuntimes.mjs';

/** Where the login lives and which endpoint it signs into — top-level keys,
 *  each confirmed in codex-cli 0.156.1 (`preferred_auth_method` is not one:
 *  0.156.1 has no such key, so it is not carried). */
export const CODEX_LOGIN_KEPT = Object.freeze([
  'cli_auth_credentials_store',
  'forced_login_method',
  'forced_chatgpt_workspace_id',
  'chatgpt_base_url',
  'openai_base_url',
]);

/**
 * The selected provider's table, field by field (0.156.1's ModelProviderInfo):
 * its name and endpoint, how it authenticates (`env_key`, the command helper
 * `auth`, `aws`, `gateway_oauth`, `requires_openai_auth`, headers), and how it
 * is reached. Not `supports_standalone_web_search` — web search is exactly
 * what a fenced turn switches off — and not `model_catalog_url`.
 */
export const CODEX_PROVIDER_KEPT = Object.freeze([
  'name',
  'base_url',
  'env_key',
  'env_key_instructions',
  'experimental_bearer_token',
  'auth',
  'aws',
  'gateway_oauth',
  'requires_openai_auth',
  'wire_api',
  'query_params',
  'http_headers',
  'env_http_headers',
  'request_max_retries',
  'stream_max_retries',
  'stream_idle_timeout_ms',
  'websocket_connect_timeout_ms',
  'supports_websockets',
]);

/** The environment names a literal secret rides under (see above). */
export const CODEX_BEARER_ENV = 'FLOWVIANT_CODEX_BEARER_TOKEN';
export const CODEX_HEADER_ENV_PREFIX = 'FLOWVIANT_CODEX_SECRET_HEADER_';

/** Far past any real config.toml; a bigger one is not read. */
const CONFIG_MAX_BYTES = 1024 * 1024;
/** Arrays and inline tables nest no deeper than this in a file we read. */
const MAX_DEPTH = 32;

/** A number, date or time, kept as written so it is carried as written. */
export class TomlRaw {
  constructor(text) {
    this.text = text;
  }
}
const newTable = () => Object.create(null);
const isTable = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof TomlRaw);

const BARE = /[A-Za-z0-9_-]+/y;
// First match wins, so the forms that begin like an integer come first.
const SCALAR =
  /[+-]?(?:inf|nan)|0x[0-9A-Fa-f](?:_?[0-9A-Fa-f])*|0o[0-7](?:_?[0-7])*|0b[01](?:_?[01])*|\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[Zz]|[+-]\d{2}:\d{2})?)?|\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?|[+-]?\d(?:_?\d)*(?:\.\d(?:_?\d)*)?(?:[eE][+-]?\d(?:_?\d)*)?/y;

/**
 * A BOUNDED TOML READER — the repo carries no TOML library, and the one file
 * it reads is Codex's own config. Whole documents: tables, arrays of tables
 * (the daemon's own `[[skills.config]]` in an agent's home), dotted and quoted
 * keys, the four string forms, arrays, inline tables, booleans, and numbers,
 * dates and times kept as written. Anything else throws, and the caller
 * carries nothing — a partial read is never a license to guess.
 */
export function parseCodexToml(text) {
  const src = String(text).replace(/^﻿/, '');
  const n = src.length;
  let i = 0;
  const fail = (why) => {
    throw new Error(`config.toml: ${why} at offset ${i}`);
  };
  const ws = () => {
    while (i < n && (src[i] === ' ' || src[i] === '\t')) i++;
  };
  const comment = () => {
    if (src[i] === '#') while (i < n && src[i] !== '\n') i++;
  };
  const newline = () => {
    if (src[i] === '\n') return (i += 1), true;
    if (src[i] === '\r' && src[i + 1] === '\n') return (i += 2), true;
    return false;
  };
  /** Blank lines, comments and whitespace, as between array items. */
  const gap = () => {
    for (;;) {
      ws();
      comment();
      if (!newline()) return;
    }
  };
  const endOfLine = () => {
    ws();
    comment();
    if (i < n && !newline()) fail('expected the end of the line');
  };
  const hexChar = (len) => {
    const h = src.slice(i, i + len);
    if (h.length !== len || !/^[0-9A-Fa-f]+$/.test(h)) fail('bad escape');
    i += len;
    const cp = parseInt(h, 16);
    if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) fail('bad escape');
    return String.fromCodePoint(cp);
  };
  const escape = () => {
    const e = src[i + 1];
    i += 2;
    switch (e) {
      case 'b': return '\b';
      case 't': return '\t';
      case 'n': return '\n';
      case 'f': return '\f';
      case 'r': return '\r';
      case 'e': return '\x1b';
      case '"': return '"';
      case '\\': return '\\';
      case 'x': return hexChar(2);
      case 'u': return hexChar(4);
      case 'U': return hexChar(8);
      default: return fail('bad escape');
    }
  };
  const basicString = () => {
    i += 1;
    let s = '';
    for (;;) {
      if (i >= n) fail('unterminated string');
      const ch = src[i];
      if (ch === '"') return (i += 1), s;
      if (ch === '\n' || ch === '\r') fail('newline in a string');
      if (ch === '\\') s += escape();
      else (s += ch), (i += 1);
    }
  };
  const literalString = () => {
    const end = src.indexOf("'", i + 1);
    if (end < 0) fail('unterminated string');
    const s = src.slice(i + 1, end);
    if (/[\r\n]/.test(s)) fail('newline in a string');
    i = end + 1;
    return s;
  };
  const LINE_END_BACKSLASH = /\\[ \t]*\r?\n/y;
  const multiline = (quote, escapes) => {
    i += 3;
    newline(); // a newline straight after the opening quotes is not content
    let s = '';
    for (;;) {
      if (i >= n) fail('unterminated string');
      if (src.startsWith(quote.repeat(3), i)) {
        let q = 3;
        while (q < 5 && src[i + q] === quote) q++; // up to two belong to the content
        s += quote.repeat(q - 3);
        i += q;
        return s;
      }
      if (escapes && src[i] === '\\') {
        LINE_END_BACKSLASH.lastIndex = i;
        if (LINE_END_BACKSLASH.test(src)) {
          i = LINE_END_BACKSLASH.lastIndex;
          while (i < n && /[ \t\r\n]/.test(src[i])) i++;
        } else s += escape();
      } else (s += src[i]), (i += 1);
    }
  };
  const key = () => {
    const parts = [];
    for (;;) {
      ws();
      if (src[i] === '"') {
        if (src.startsWith('"""', i)) fail('a multi-line key');
        parts.push(basicString());
      } else if (src[i] === "'") {
        if (src.startsWith("'''", i)) fail('a multi-line key');
        parts.push(literalString());
      } else {
        BARE.lastIndex = i;
        const m = BARE.exec(src);
        if (!m) fail('expected a key');
        parts.push(m[0]);
        i = BARE.lastIndex;
      }
      ws();
      if (src[i] !== '.') return parts;
      i += 1;
    }
  };
  const assign = (target, path, v) => {
    let t = target;
    for (const k of path.slice(0, -1)) {
      if (!Object.hasOwn(t, k)) t[k] = newTable();
      else if (!isTable(t[k])) fail(`"${k}" is not a table`);
      t = t[k];
    }
    const last = path.at(-1);
    if (Object.hasOwn(t, last)) fail(`"${last}" is defined twice`);
    t[last] = v;
  };
  let depth = 0;
  const nested = (open) => {
    if (++depth > MAX_DEPTH) fail('nested too deep');
    try {
      return open();
    } finally {
      depth -= 1;
    }
  };
  const array = () => {
    i += 1;
    const out = [];
    for (;;) {
      gap();
      if (src[i] === ']') return (i += 1), out;
      out.push(value());
      gap();
      if (src[i] === ',') i += 1;
      else if (src[i] === ']') return (i += 1), out;
      else fail('expected , or ]');
    }
  };
  const inlineTable = () => {
    i += 1;
    const t = newTable();
    for (;;) {
      gap();
      if (src[i] === '}') return (i += 1), t;
      keyValue(t);
      gap();
      if (src[i] === ',') i += 1;
      else if (src[i] === '}') return (i += 1), t;
      else fail('expected , or }');
    }
  };
  const word = (w) => src.startsWith(w, i) && !/[A-Za-z0-9_-]/.test(src[i + w.length] ?? '');
  const value = () => {
    const ch = src[i];
    if (ch === '"') return src.startsWith('"""', i) ? multiline('"', true) : basicString();
    if (ch === "'") return src.startsWith("'''", i) ? multiline("'", false) : literalString();
    if (ch === '[') return nested(array);
    if (ch === '{') return nested(inlineTable);
    if (word('true')) return (i += 4), true;
    if (word('false')) return (i += 5), false;
    SCALAR.lastIndex = i;
    const m = SCALAR.exec(src);
    if (!m) fail('a value this reader does not know');
    i = SCALAR.lastIndex;
    if (/[A-Za-z0-9_.:+-]/.test(src[i] ?? '')) fail('a value this reader does not know');
    return new TomlRaw(m[0]);
  };
  const keyValue = (target) => {
    const path = key();
    if (src[i] !== '=') fail('expected =');
    i += 1;
    ws();
    assign(target, path, value());
  };

  const root = newTable();
  let current = root;
  for (;;) {
    gap();
    if (i >= n) return root;
    if (src[i] !== '[') {
      keyValue(current);
      endOfLine();
      continue;
    }
    const many = src[i + 1] === '[';
    i += many ? 2 : 1;
    const path = key();
    if (many ? !src.startsWith(']]', i) : src[i] !== ']') fail('an unclosed table header');
    i += many ? 2 : 1;
    endOfLine();
    let t = root;
    for (const k of path.slice(0, -1)) {
      if (!Object.hasOwn(t, k)) t[k] = newTable();
      const v = Array.isArray(t[k]) ? t[k].at(-1) : t[k];
      if (!isTable(v)) fail(`"${k}" is not a table`);
      t = v;
    }
    const last = path.at(-1);
    if (many) {
      if (!Object.hasOwn(t, last)) t[last] = [];
      if (!Array.isArray(t[last])) fail(`"${last}" is not an array of tables`);
      current = newTable();
      t[last].push(current);
    } else {
      if (!Object.hasOwn(t, last)) t[last] = newTable();
      else if (!isTable(t[last])) fail(`"${last}" is not a table`);
      current = t[last];
    }
  }
}

/**
 * The person's config.toml, where the turn's Codex would look —
 * `$CODEX_HOME/config.toml` (an agent's own home when its lane keeps one),
 * else `~/.codex/config.toml` — parsed. Null when it is absent, too big or
 * not a document this reader can read whole.
 */
export function readPersonalCodexConfig(env = process.env) {
  const home = env.CODEX_HOME || join(env.HOME || homedir(), '.codex');
  const path = join(home, 'config.toml');
  try {
    if (statSync(path).size > CONFIG_MAX_BYTES) return null;
    return parseCodexToml(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/** One value as TOML, as a `-c` override's value is parsed. */
const bareKeyOr = (k) => (/^[A-Za-z0-9_-]+$/.test(k) ? k : toml(k));
export function tomlValue(v) {
  if (typeof v === 'string') return toml(v);
  if (typeof v === 'boolean') return String(v);
  if (v instanceof TomlRaw) return v.text;
  if (Array.isArray(v)) return `[${v.map(tomlValue).join(',')}]`;
  if (isTable(v)) return `{${Object.keys(v).map((k) => `${bareKeyOr(k)}=${tomlValue(v[k])}`).join(',')}}`;
  throw new Error('not a TOML value');
}

const isString = (v) => typeof v === 'string';
const isStringList = (v) => Array.isArray(v) && v.every(isString);
const nonEmpty = (v) => typeof v === 'string' && v.trim() !== '';

/**
 * The selected provider's kept fields, with its literal secrets moved into
 * `env` (see the header). Mutates nothing it was handed.
 */
function keptProvider(table, env, turnEnv) {
  const out = newTable();
  for (const k of CODEX_PROVIDER_KEPT) if (Object.hasOwn(table, k)) out[k] = table[k];
  if (isString(out.experimental_bearer_token)) {
    // Codex puts this token before `env_key`, so taking `env_key`'s place
    // keeps the person's precedence.
    env[CODEX_BEARER_ENV] = out.experimental_bearer_token;
    out.env_key = CODEX_BEARER_ENV;
  }
  delete out.experimental_bearer_token;
  if (isTable(out.http_headers)) {
    const byEnv = isTable(out.env_http_headers) ? { ...out.env_http_headers } : newTable();
    let n = 0;
    for (const [header, literal] of Object.entries(out.http_headers)) {
      if (!isString(literal)) continue;
      // An env header whose variable is set already wins over the literal in
      // Codex; only where it would not does the literal ride.
      if (Object.hasOwn(byEnv, header) && nonEmpty(turnEnv[byEnv[header]])) continue;
      const name = `${CODEX_HEADER_ENV_PREFIX}${n++}`;
      env[name] = literal;
      byEnv[header] = name;
    }
    if (Object.keys(byEnv).length) out.env_http_headers = Object.assign(newTable(), byEnv);
  }
  delete out.http_headers;
  return out;
}

/**
 * What a fenced turn carries of `config`: `args` — `-c key=value` pairs for
 * the posture's argv — and `env`, the literal secrets they name.
 *
 *  · the login keys, when they hold what Codex takes (a string; the workspace
 *    id may be a list of strings) — a wrong-typed one is skipped, never
 *    guessed at;
 *  · `model_provider` and that provider's table, whole-table form, so an id
 *    with a dot in it survives (`-c` splits a dotted path on every dot); only
 *    the SELECTED provider — the built-in `openai` cannot be overridden (the
 *    CLI refuses the file), and an unselected table signs nothing in;
 *  · `model` and `model_reasoning_effort` ONLY where the turn pins none — an
 *    explicit pin is the argv's own `--model` / effort override and wins. An
 *    unpinned fenced turn then runs on "Machine default" as the person's CLI
 *    means it, and a custom provider gets a model it serves.
 */
export function codexPersonalCarry(config, { model = null, effort = null, env: turnEnv = {} } = {}) {
  const args = [];
  const env = {};
  if (!isTable(config)) return { args, env };
  const push = (k, v) => args.push('-c', `${k}=${tomlValue(v)}`);
  for (const k of CODEX_LOGIN_KEPT) {
    const v = config[k];
    if (isString(v) || (k === 'forced_chatgpt_workspace_id' && isStringList(v))) push(k, v);
  }
  const id = config.model_provider;
  if (isString(id) && id) {
    const table = isTable(config.model_providers) ? config.model_providers[id] : undefined;
    if (isTable(table)) {
      const kept = keptProvider(table, env, turnEnv);
      if (Object.keys(kept).length) push('model_providers', Object.assign(newTable(), { [id]: kept }));
    }
    push('model_provider', id);
  }
  if (!model && nonEmpty(config.model)) push('model', config.model);
  if (!effort && nonEmpty(config.model_reasoning_effort)) push('model_reasoning_effort', config.model_reasoning_effort);
  return { args, env };
}

/** The carry for one turn: the config its Codex would read, reduced. */
export function codexPersonalTurn({ env = process.env, model = null, effort = null } = {}) {
  return codexPersonalCarry(readPersonalCodexConfig(env), { model, effort, env });
}
