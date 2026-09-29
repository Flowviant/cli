/**
 * WHAT THE CLI SAID IT CAN DO ON THIS MACHINE — the skills and MCP servers
 * learned off Claude Code's `system.init`, and the one-shot probe that learns
 * them on a machine no turn has taught.
 *
 * Split out of runtimes.mjs (2026-09-26, SOLID F045). These are per-process
 * caches of a MACHINE REPORT (they ride the roster poll as `skills` and `mcp`),
 * plus the one place the daemon spawns a CLI for its own purposes; neither is
 * a fact about how a runtime is driven, and a report-shape change is not a
 * reason to edit the registry. Three states throughout: null = no turn has
 * taught us, [] = measured and none, a list = measured.
 */

import { spawn } from 'node:child_process';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { RUNTIMES } from './runtimes.mjs';

/**
 * WHAT THE CLI SAID IT CAN BE ASKED FOR BY NAME — the machine's skills.
 *
 * Learned, never scanned. Claude Code's `system.init` event names its own
 * resolved skill set on every stream-json turn, and the daemon already parses
 * that stream (claudeStream.mjs), so this costs nothing and is authoritative: it has
 * plugins, this repo's `.claude/skills`, and whatever project settings enabled
 * or disabled already folded in. A `~/.claude/skills` scan of our own would be
 * a second implementation of the CLI's resolution rules, and would drift.
 *
 * THE PRICE OF LEARNING RATHER THAN PROBING is that a machine which has not run
 * a turn yet knows nothing, and says nothing. That is the honest answer: the
 * app renders no menu rather than an empty one, and a slash typed into a tab
 * still reaches the CLI either way — the menu is an autocomplete, never a gate.
 * We do NOT probe for it: a `claude -p` run purely to populate a dropdown would
 * spend the operator's quota on a UI affordance.
 *
 * PER MACHINE, not per session. Every session worktree is a checkout of the one
 * repo this daemon serves, so project skills are identical across tabs and
 * personal skills are machine-wide. Last turn wins, which is what makes a skill
 * added mid-run show up on the next poll.
 */
let skillsCache = null;

/** Claude Code's own names: letters, digits, dash, underscore, and the colon a
 *  plugin skill wears (`plugin:skill`). Anything else is not a name we could
 *  put after a `/` anyway, so it is dropped rather than relayed as garbage. */
const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9_:-]{0,63}$/;

/** Record what a turn's init event reported. Bounded and sorted so the poll's
 *  query param has a stable length and a stable order — an unstable order would
 *  make the server write a "change" on every single poll. */
export function recordSkills(names) {
  if (!Array.isArray(names)) return;
  const clean = [...new Set(names.map((n) => String(n).trim()).filter((n) => SKILL_NAME.test(n)))]
    .sort()
    .slice(0, 100);
  // An empty report is a FACT (a machine with no skills installed), so it is
  // recorded as []. Never conflated with null, which stays "no turn has run".
  skillsCache = clean;
}

/** What to send on the roster poll — null until a turn has taught us. */
export function knownSkills() {
  return skillsCache;
}

/**
 * WHICH MCP SERVERS AND CLAUDE.AI CONNECTORS THE CLI MOUNTED, AND HOW EACH
 * STANDS (2026-09-23, 0.97.0) — learned off the same `system.init` event the
 * skills are, so it costs nothing and cannot drift from what a turn reaches.
 *
 * MEASURED on Claude Code 2.1.281 (`claude -p hi --model haiku --output-format
 * stream-json --verbose`): the init event carries `mcp_servers: [{ name,
 * status, source }]` — statuses seen `connected`, `failed`, `needs-auth` and
 * `pending`; a claude.ai connector arrives named `claude.ai <Name>` with
 * `source: "claudeai"`, a server a turn mounts with `--mcp-config` with
 * `source: "dynamic"`. A connector that needs a one-time sign-in AT THIS BOX
 * reads `needs-auth` here long before a turn fails on it, and the app's
 * Machines page names it.
 *
 * `flowviant` IS EXCLUDED: it is the server THIS daemon mounts on every tab
 * turn, always present, and not something a person can act on. A status off
 * the closed list is relayed as `other` rather than dropped — the CLI said
 * something about the server, and silence would be the daemon deciding it did
 * not. Bounded (40 entries, names cut at 60) and sorted, the `recordSkills`
 * discipline: a stable param, so an unchanged report writes nothing.
 *
 * ONLY WHAT IS NOT CONNECTED LEAVES THE BOX (2026-09-23). The first cut
 * relayed every server, connected ones included — so the operator's whole set
 * of signed-in services (their mail, their brokerage, their calendar) rode the
 * poll to the server and into every teammate's read of the Machines page,
 * which renders only the servers that are NOT connected anyway. A connected
 * connector is good news and good news is not a line; it is also nobody
 * else's business. So `connected` is dropped HERE, before the cap, and what is
 * sent is exactly what the page can say something about.
 *
 * THREE STATES, the skills split: null = no turn has taught us (the param is
 * not sent), [] = nothing of the person's own needs anything (every server is
 * connected, or none is mounted), a list = the ones that do. Last turn wins,
 * so a connector somebody signs into leaves the list on the next turn's init,
 * and an all-connected turn sends `[]`, which clears a stale list server-side.
 */
let mcpServersCache = null;

export const MCP_STATUSES = new Set(['connected', 'failed', 'needs-auth', 'pending']);
export const MAX_MCP_SERVERS = 40;
export const MCP_NAME_MAX = 60;

export function recordMcpServers(list) {
  if (!Array.isArray(list)) return;
  const seen = new Map();
  for (const e of list) {
    if (!e || typeof e !== 'object' || typeof e.name !== 'string') continue;
    const n = e.name.trim().slice(0, MCP_NAME_MAX).trim();
    if (!n || n === 'flowviant' || seen.has(n)) continue;
    if (e.status === 'connected') continue; // see the header: never relayed
    seen.set(n, { n, s: MCP_STATUSES.has(e.status) ? e.status : 'other' });
  }
  mcpServersCache = [...seen.values()]
    .sort((a, b) => (a.n < b.n ? -1 : a.n > b.n ? 1 : 0))
    .slice(0, MAX_MCP_SERVERS);
}

/** What to send on the roster poll as `mcp` — null until a turn has taught us. */
export function knownMcpServers() {
  return mcpServersCache;
}

/**
 * LEARN WHAT `/` CAN OFFER, ON A MACHINE NO TURN HAS TAUGHT.
 *
 * WHY THIS EXISTS. `recordSkills` above is fed from the init event of a tab
 * turn — authoritative and free, but with a hole nobody priced: THE FIRST THING
 * ANYONE DOES IN A NEW TAB IS TYPE `/`, and that is by definition before that
 * machine has run a turn. The menu was guaranteed empty exactly where it is
 * first reached. Not a theoretical hole: checked against production on
 * 2026-08-25, `agent_tokens.skills` was NULL for EVERY machine credential that
 * has ever existed, because the only tab turns ever run predated the release
 * that reports. The feature had never worked for anyone, once.
 *
 * IT COSTS ONE SMALL REQUEST, AND THAT IS THE HONEST NUMBER. This file used to
 * forbid probing outright — "a `claude -p` run purely to populate a dropdown
 * would spend the operator's quota on an affordance" — and that rule was
 * written picturing a COMPLETED TURN. This is not one: Claude Code emits
 * `system.init`, carrying its own fully resolved skill set, within ~0.5s and
 * long before it finishes answering, so the child is killed the moment that
 * event is read. But the request HAS gone out by then — measured on 2.1.245 by
 * reading the transcript a killed probe left behind: 2 input tokens, 4 output,
 * ~6k cache-creation. Two zero-request routes were tried and both failed: an
 * empty prompt errors before init is emitted, and `--input-format stream-json`
 * emits nothing at all until a message arrives. So the cost is one cheap turn,
 * ONCE per daemon process, on the cheapest model, and only on a machine no turn
 * has taught. Do not let this grow into a per-tab or per-poll probe.
 *
 * `--model haiku` for that reason, and it is safe by this repo's own rule: a
 * name lives in AGENT_MODELS only once `claude --model <name>` is known to be
 * accepted on a real install. If it were ever refused the probe simply learns
 * nothing and the machine stays unmeasured — which is exactly today's state, so
 * the failure mode is the status quo rather than a regression.
 *
 * IT SCANS FOR THE INIT EVENT, never assuming it is line 1 — and that is not
 * defensive padding, it is measured. With `--model haiku` the CLI prints a
 * `system/status` line FIRST and init lands on line 2; with the default model
 * init is line 1. A first-line-only reader (the version this replaced) silently
 * learned nothing the moment a model flag was added.
 *
 * IT CLEANS UP AFTER ITSELF, and this is not optional. `claude -p` writes a
 * transcript to `~/.claude/projects/<munged-cwd>/<session-id>.jsonl` the moment
 * it starts, and `claudeSessions.mjs` reports the newest ENDED session per
 * directory to the Workbench as an ADOPTABLE row. Left behind, every daemon
 * start would put a phantom untitled session in the `+` menu offering to adopt
 * a conversation that never happened. The init event names its own session id,
 * so the file is ours by name and is removed by it.
 *
 * IT IS BEST-EFFORT IN EVERY DIRECTION. No claude, no PATH, a CLI that changed
 * its event shape, an unwritable home — all leave `skillsCache` exactly as it
 * was (null, "nobody looked"), which is the honest answer and the one the app
 * already renders correctly. Nothing here may throw, and nothing may block the
 * poll it is called from.
 */

/** Long enough for a cold CLI start on a slow box, short enough that a hung
 *  child is not left holding a session for the life of the daemon. */
const SKILL_PROBE_TIMEOUT_MS = 30_000;

/** Init arrives within the first couple of events or not at all; this is the
 *  guard against parsing a whole turn's output looking for it. */
const SKILL_PROBE_MAX_LINES = 20;

let skillProbeStarted = false;

/** Where Claude Code keeps a transcript for `cwd`: `/` and `.` both become `-`. */
function transcriptCandidates(cwd, sessionId) {
  const base = join(homedir(), '.claude', 'projects');
  const out = [join(base, cwd.replace(/[/.]/g, '-'), `${sessionId}.jsonl`)];
  // The munge is Claude Code's, not ours, so a version that changes it must not
  // leave the file behind: fall back to finding our own session id by name.
  try {
    for (const d of readdirSync(base)) out.push(join(base, d, `${sessionId}.jsonl`));
  } catch {
    /* no project store — nothing was written either */
  }
  return out;
}

/**
 * Delete the transcript a headless `-p` turn left behind.
 *
 * EXPORTED because the skills probe is no longer the only thing that runs one:
 * resolving a project's dev command is a background Claude turn too, and every
 * such turn has the same footprint. `claude -p` writes
 * `~/.claude/projects/<munged-cwd>/<id>.jsonl` at startup, and
 * `claudeSessions.mjs` offers the newest ENDED session per directory as
 * ADOPTABLE — so anything we run for our own purposes would put a phantom
 * untitled session in somebody's `+` menu.
 */
export function removeProbeTranscript(cwd, sessionId) {
  if (!sessionId || !/^[A-Za-z0-9_-]{8,64}$/.test(sessionId)) return;
  for (const f of transcriptCandidates(cwd, sessionId)) {
    try {
      if (existsSync(f)) {
        rmSync(f, { force: true });
        return;
      }
    } catch {
      /* best-effort */
    }
  }
}

/**
 * One line of the probe's stdout → the init event's payload, or null for "not
 * it, keep reading".
 *
 * SEPARATE FROM THE SCAN LOOP so the thing that actually broke can be tested
 * without spawning a CLI. The first version of this probe read line 1 and
 * stopped, which was measured-correct with the default model and silently
 * WRONG with `--model haiku`: that path prints a `system/status` line first and
 * puts init on line 2, so the probe learned nothing and reported nothing, which
 * is indistinguishable from the bug it was written to fix.
 *
 * A line that is not JSON is not a failure — a CLI warning on stdout is a line
 * to skip, not a reason to abandon the probe.
 */
export function parseInitLine(line) {
  let ev;
  try {
    ev = JSON.parse(line);
  } catch {
    return null;
  }
  if (!ev || ev.type !== 'system' || ev.subtype !== 'init') return null;
  return {
    // An init event WITHOUT skills is still the init event: stop reading, but
    // record nothing. Conflating the two would keep the probe scanning a whole
    // turn's output on a CLI that does not report them.
    skills: Array.isArray(ev.skills) ? ev.skills : null,
    // The CLI's mounted MCP servers (0.97.0) — `recordMcpServers` normalises.
    mcpServers: Array.isArray(ev.mcp_servers) ? ev.mcp_servers : null,
    sessionId: typeof ev.session_id === 'string' ? ev.session_id : null,
  };
}

/**
 * Kick off the one-shot probe. Returns immediately; the result lands in
 * `skillsCache` and rides the NEXT poll, so nothing waits on it.
 *
 * A no-op once a turn has taught us (`skillsCache !== null`) — a turn's init
 * event and this one say the same thing, and the turn is free.
 */
export function probeSkillsOnce(cwd) {
  if (skillProbeStarted || skillsCache !== null) return;
  skillProbeStarted = true;
  let child;
  try {
    // Claude Code specifically, not the `wiki` profile's runtime pick: `skills`
    // is Claude Code's own field and the `/` tray only renders for claude tabs.
    child = spawn(
      RUNTIMES.claude.bin,
      ['-p', 'x', '--model', 'haiku', '--output-format', 'stream-json', '--verbose'],
      { cwd, stdio: ['ignore', 'pipe', 'ignore'] }
    );
  } catch {
    return; // no claude on PATH — the machine simply stays unmeasured
  }
  let buf = '';
  let lines = 0;
  let settled = false;
  const finish = (sessionId) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
    // AFTER the kill, and on a delay: the transcript is the CHILD's file, so
    // deleting it while the child still lives races a recreate.
    if (sessionId) setTimeout(() => removeProbeTranscript(cwd, sessionId), 750).unref?.();
  };
  const timer = setTimeout(() => finish(null), SKILL_PROBE_TIMEOUT_MS);
  timer.unref?.();
  child.on('error', () => finish(null));
  child.on('exit', () => finish(null));
  // UTF-8 mode on the STREAM, not a per-chunk `.toString()` — a multi-byte
  // character straddling a chunk boundary decodes to mojibake (or a stray
  // replacement byte) when each chunk is decoded on its own; the stream's
  // own decoder holds the partial sequence over to the next chunk instead.
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    if (settled) return;
    buf += d;
    let nl;
    while (!settled && (nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      if (++lines > SKILL_PROBE_MAX_LINES) {
        finish(null);
        return;
      }
      const init = parseInitLine(line);
      if (!init) continue;
      if (init.skills) recordSkills(init.skills);
      if (init.mcpServers) recordMcpServers(init.mcpServers);
      finish(init.sessionId);
      return;
    }
    // A single line this long is not an init event; stop buffering a whole
    // turn's output into memory waiting for one.
    if (!settled && buf.length > 1_000_000) finish(null);
  });
}
