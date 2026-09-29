/**
 * The Flowviant side of driving a coding CLI that is not a posture, a stream
 * or a process: the sentinel protocol (a line the contract prompts require a
 * turn to end on) and the hand-over of the flowviant MCP server to whichever
 * runtime runs the turn. The hard rule baked into the prompts: there is no
 * interactive user — the only channel to a human is the blocker loop.
 *
 * This file used to hold everything about a turn. It was split by reason to
 * change (SOLID 2026-09-26): the contract prompts live in prompts.mjs, the
 * permission lists in claudePosture.mjs, Claude's event-stream reader in
 * claudeStream.mjs, and the spawn-and-supervise of one turn in runTurn.mjs.
 * The argv, the binary and the event shape of each vendor come from each
 * CLI's registry row (runtime{Claude,Codex,Antigravity}.mjs, assembled in
 * runtimes.mjs; the stream's meaning in runtimeEvents.mjs).
 */

import { runtimeById } from './runtimes.mjs';

export const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));

// Sentinels must appear on their OWN line (the prompts require it). Substring
// matching falsely fired when an agent merely *mentioned* the word in prose
// (e.g. "I won't fabricate a BLOCKED:<id> line"), trapping the worker in a fake
// blocked loop. Anchor to a full line instead.
//
// LINE-SPLIT, NEVER A `^...$` REGEX WITH A `\s*` ON BOTH ENDS (audit
// 2026-09-24). `new RegExp('^\\s*NAME\\s*$', 'm')` and
// `/^\s*BLOCKED:(\S+)\s*$/m` are QUADRATIC against a long run of
// whitespace on one line — the same shape `taskIdsFromMessage` already had
// to fix, measured ~0.5s at 40KB here — and a CLI's own stdout is exactly
// the kind of text a stray control sequence or a pasted blob can grow past
// that. A length cap first, then plain string work, same as there.
const SENTINEL_MAX_LINE = 2000;
export const sawSentinel = (out, name) =>
  String(out ?? '')
    .split('\n')
    .some((l) => l.length < SENTINEL_MAX_LINE && l.trim() === name);
export const blockedId = (out) => {
  for (const l of String(out ?? '').split('\n')) {
    if (l.length > SENTINEL_MAX_LINE) continue;
    const t = l.trim();
    if (t.startsWith('BLOCKED:') && /^BLOCKED:\S+$/.test(t)) return t.slice(8);
  }
  return null;
};

/**
 * Hand a runtime the flowviant MCP server, however that runtime wants it.
 *
 * Returns `{ dir, args, env }`: `dir` is a temp directory to delete after the
 * turn (null when the runtime needed no file at all), `args` splice into argv,
 * `env` merges into the child's environment. The shape is identical for every
 * runtime precisely because the mechanism is not — Claude wants a JSON file
 * path, Codex wants two `-c` overrides and reads the token out of the
 * environment. Callers should not have to know which.
 */
export function mcpFor(runtimeId, token, mcpUrl) {
  const rt = runtimeById(runtimeId);
  if (!rt) throw new Error(`runtime '${runtimeId}' is not one this daemon knows — update flowviant`);
  if (!rt.mcp) throw new Error(`runtime '${rt.id}' cannot take an MCP server: ${rt.blocked}`);
  return rt.mcp(token, mcpUrl);
}
