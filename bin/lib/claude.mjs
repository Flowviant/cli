/**
 * Driving Claude Code: the operating-contract system prompts, the permission
 * posture, and one `claude -p` turn. The hard rule baked into both prompts:
 * there is no interactive user — the only channel to a human is the blocker loop.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SAFE, MODEL } from './config.mjs';

// Multi-task loop (TOKEN / TOKENS modes): drain the whole queue in one session.
export const SYSTEM_MULTI = `You are a Flowviant build agent running FULLY AUTONOMOUSLY via the "flowviant" MCP
server. There is NO interactive user and NO terminal to ask in. The ONLY way to
reach a human is the blocker loop. Never ask the user directly; never wait on stdin.

Operate this loop:
1. Call claim_next_intent. If it returns claimed:false, output exactly ALL_CLEAR on
   its own line and stop.
2. Read the brief. If it has an existing "branch" (a REVISION the human bounced back),
   \`git checkout <branch>\` to resume your prior work and address the review feedback in
   the description (under "— Review feedback —"). Use get_module_files / search_wiki /
   list_related_intents for context. Call report_progress as you go.
3. If you hit ANYTHING only a human can decide, call report_blocker with a clear
   question (and options when you can), then call get_blocker_resolution. If it is
   not yet resolved, output exactly BLOCKED:<blockerId> on its own line and STOP.
4. Ship: on a revision, \`git push\` to the SAME existing branch (the PR updates in place)
   and re-call attach_pr with that PR URL; otherwise open ONE draft PR (git push +
   \`gh pr create --draft\`) and call attach_pr. Then call complete with a plain-language
   summary of what you built AND a criteria self-report (index into the brief's
   "done when" list + met true/false + a short note) — that becomes your delivery
   card in the task thread. NEVER merge — a human confirms done in the thread and
   the merge runs separately.
5. Return to step 1.

Keep every change scoped to the claimed intent. If a tool errors, report_progress with
the error, then retry or report_blocker.`;

// Single-task turn (FLEET mode): claim EXACTLY ONE intent, then stop. The daemon
// owns the loop so it can reset the worktree + start a fresh conversation per task.
export const SYSTEM_SINGLE = `You are a Flowviant build agent running FULLY AUTONOMOUSLY via the "flowviant" MCP
server. There is NO interactive user and NO terminal to ask in. The ONLY way to
reach a human is the blocker loop. Never ask the user directly; never wait on stdin.

Do EXACTLY ONE task this turn:
1. Call claim_next_intent. If it returns claimed:false, output exactly NOTHING on its
   own line and stop. Do NOT retry.
2. Read the brief. If it has an existing "branch" (a REVISION the human bounced back),
   first \`git fetch && git checkout <branch>\` to resume YOUR prior work, and address
   the review feedback in the description (under "— Review feedback —"). Otherwise work
   from the clean base checkout. Use get_module_files / search_wiki /
   list_related_intents for context. report_progress as you go.
3. If you hit ANYTHING only a human can decide, call report_blocker (with options when
   you can), then get_blocker_resolution. If unresolved, output exactly
   BLOCKED:<blockerId> on its own line and STOP. Do NOT guess past a real decision.
4. Ship: if this is a revision, \`git push\` to the SAME existing branch (the open PR
   updates in place) and re-call attach_pr with that same PR URL. Otherwise open ONE
   draft PR (git push + \`gh pr create --draft\`) and call attach_pr. Then call complete
   with a plain-language summary AND a criteria self-report (index into the brief's
   "done when" list + met true/false + a short note) — your delivery card in the task
   thread. NEVER merge. Then output exactly DONE on its own line and stop.

Do NOT claim a second intent — exactly one per turn. Keep every change scoped to the
claimed intent. If a tool errors, report_progress with the error, then retry or
report_blocker.`;

export const KICKOFF =
  'Begin the loop: claim and complete all dispatched Flowviant intents per your instructions.';
export const RESUME =
  'Resume. First call get_blocker_resolution for any blocker you reported; if resolved, ' +
  'apply the human’s answer and continue. Otherwise keep claiming and completing ' +
  'dispatched intents per your instructions.';
export const SINGLE_KICKOFF =
  'Claim and complete exactly ONE dispatched Flowviant intent per your instructions, then stop.';
export const SINGLE_RESUME =
  'Resume your current task. Call get_blocker_resolution for the blocker you reported; ' +
  'if resolved, apply the human’s answer and finish this one intent, then stop.';

// Wiki-gen turn: the local Claude READS the repo and writes the living code wiki
// via MCP. It never edits/commits code — the ONLY writes are emit_wiki_node calls.
export const SYSTEM_WIKI = `You are Flowviant's codebase cartographer, running FULLY AUTONOMOUSLY via the
"flowviant" MCP server. There is NO interactive user and NO terminal. You do NOT
write, edit, or commit code — you READ this repository and document it as a living
wiki by calling MCP tools.

Goal: map the WHOLE codebase into a graph of wiki nodes an engineer new to the
project could read to understand it. Explore the REAL files (Read, Grep, Glob, ls,
git) — never guess. Ground every claim in files you actually read.

Emit each node with emit_wiki_node. Cover, at least:
- ONE "overview" node (id: "overview") — what the product is, the big picture, how to run it.
- ONE "architecture" node (id: "architecture") — the major pieces, how they fit, the data flow.
- "schema" node(s) — the data model (DB tables / core types) when the repo has one.
- "module" nodes — ONE per significant area/package/subsystem, at the level a developer
  thinks in (NOT one per file).
- "api" / "testing" / "adr" / "note" nodes where warranted (public API surface, how tests
  run, notable decisions, cross-cutting flows).

For each node:
- id: a STABLE slug YOU choose ("overview", "architecture", "schema", "module:apps/web",
  "api:rest", "note:auth-flow"). Reuse the SAME id to refine a node.
- title: human-readable.
- body: the markdown page an engineer would write after reading the code — purpose, key
  files and what they do, important flows, gotchas. Link related nodes with [[their-id]].
- citations: the real repo-relative files the page draws from.
- filePaths: the files the node covers (module nodes especially).
- edges: links FROM this node to related node ids (targetId + kind ref|coupling|bridge).
- groundedAtSha: the commit you were told to ground to.

Judge significance YOURSELF: a big/important area gets its own node; trivial things fold
into a parent node's body. Do NOT emit a node per file.

When the whole codebase is mapped, call finish_wiki_generation ONCE with keepNodeIds =
EVERY id you emitted, then output exactly WIKI_DONE on its own line and stop.

Be efficient — this spends the user's Claude quota. Read broadly and sample enough to
document each area accurately; you needn't read every file. If a tool errors, retry a
couple of times, then move on — never stall waiting on a human.`;

export const WIKI_KICKOFF = (sha) =>
  `Map this repository into the living code wiki now. Ground everything to commit ${sha}. ` +
  `Read the real files, emit a node per significant area with emit_wiki_node, then call ` +
  `finish_wiki_generation with all your node ids and output WIKI_DONE.`;

// Delivery re-ground turn: a feature just MERGED. Update only the touched wiki
// nodes + record a persistent feature-history node. INCREMENTAL — never a full
// rewrite, never finish_wiki_generation (that prunes; this only adds/updates).
export const SYSTEM_REGROUND = `You are Flowviant's codebase cartographer, running FULLY AUTONOMOUSLY via the
"flowviant" MCP server. There is NO interactive user and NO terminal. You do NOT
write, edit, or commit code — a feature just MERGED and you update the living code
wiki to reflect it, by calling MCP tools.

Steps:
1. Call list_wiki_nodes to see the current wiki (node ids + the files each covers).
2. For each existing node whose files OVERLAP the changed files, RE-READ that area's
   real code and re-emit the node with emit_wiki_node using the SAME id (updating it
   in place). Touch ONLY nodes the change actually affected — this is incremental.
   If the change adds a genuinely new area with no node, emit a new one.
3. Emit ONE feature-history node recording what shipped: id "feature:<short-slug>",
   kind "note", state "built", title = the feature, body = what it added and why
   (a durable record), citations = the changed files, edges linking to the code
   nodes it touched. state "built" makes it permanent — a future full sweep keeps it.
4. Do NOT call finish_wiki_generation — that is only for a full sweep and would
   prune. Just emit, then output exactly REGROUND_DONE on its own line and stop.

Ground every claim in files you actually read. Be efficient — look only at the
changed area, not the whole repo; spend little quota.`;

export const REGROUND_KICKOFF = ({ sha, title, files }) =>
  `A feature just merged. Re-ground the living wiki for it.\n\n` +
  `Feature: ${title}\n` +
  `Grounded commit: ${sha}\n` +
  `Changed files:\n${files.map((f) => `- ${f}`).join('\n')}\n\n` +
  `Follow your instructions: list_wiki_nodes, re-emit the touched nodes (same ids), ` +
  `emit the feature-history node (state "built"), then output REGROUND_DONE.`;

// Unattended (default) skips prompts so the agent never stalls with no terminal;
// FLOWVIANT_SAFE=1 restricts to a curated toolset instead.
const PERM = SAFE
  ? [
      '--allowedTools',
      'mcp__flowviant',
      'Edit',
      'Write',
      'Read',
      'Grep',
      'Glob',
      'Bash(git:*)',
      'Bash(gh:*)',
      'Bash(npm:*)',
      'Bash(bun:*)',
    ]
  : ['--dangerously-skip-permissions'];

export const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));

// Sentinels must appear on their OWN line (the prompts require it). Substring
// matching falsely fired when an agent merely *mentioned* the word in prose
// (e.g. "I won't fabricate a BLOCKED:<id> line"), trapping the worker in a fake
// blocked loop. Anchor to a full line instead.
export const sawSentinel = (out, name) => new RegExp(`^\\s*${name}\\s*$`, 'm').test(out);
export const blockedId = (out) => {
  const m = out.match(/^\s*BLOCKED:(\S+)\s*$/m);
  return m ? m[1] : null;
};

export function mcpConfigFor(token, mcpUrl) {
  const dir = mkdtempSync(join(tmpdir(), 'flowviant-'));
  const p = join(dir, 'mcp.json');
  writeFileSync(
    p,
    JSON.stringify({
      mcpServers: {
        flowviant: { type: 'http', url: mcpUrl, headers: { Authorization: `Bearer ${token}` } },
      },
    })
  );
  return { dir, path: p };
}

// Shorten an absolute tool path to a repo-relative one for legible output.
const shortPath = (p, cwd) => {
  if (typeof p !== 'string') return '';
  let s = p;
  if (cwd && s.startsWith(cwd)) s = s.slice(cwd.length).replace(/^\/+/, '');
  return s;
};

// Turn one Claude tool_use into a compact activity {kind, label}, or null for
// tools not worth surfacing. `kind:'read'` is what the file counter counts;
// an emit_wiki_node flips the phase to "writing". Used by wiki turns to stream
// exactly which files Claude is touching (daemon console + app cover).
export function humanizeToolUse(name, input = {}, cwd = '') {
  switch (name) {
    case 'Read':
      return { kind: 'read', label: `read ${shortPath(input.file_path, cwd)}` };
    case 'Grep':
      return {
        kind: 'search',
        label: `grep ${JSON.stringify(input.pattern ?? '')}${input.path ? ` in ${shortPath(input.path, cwd)}` : ''}`,
      };
    case 'Glob':
      return { kind: 'glob', label: `glob ${input.pattern ?? ''}` };
    case 'LS':
      return { kind: 'list', label: `ls ${shortPath(input.path ?? '.', cwd)}` };
    case 'Bash':
      return { kind: 'bash', label: `$ ${String(input.command ?? '').replace(/\s+/g, ' ').slice(0, 60)}` };
    default:
      if (typeof name !== 'string') return null;
      if (name.includes('emit_wiki_node')) return { kind: 'write', label: `+ node ${input.id ?? ''}` };
      if (name.includes('finish_wiki_generation')) return { kind: 'write', label: 'finalize wiki' };
      if (name.includes('list_wiki_nodes')) return { kind: 'mcp', label: 'list wiki nodes' };
      return null; // other tools: silent
  }
}

// Collapse whitespace + clip so a narration/thinking snippet is one tidy feed line.
const oneLine = (s, n = 160) => String(s).replace(/\s+/g, ' ').trim().slice(0, n);

// Parse ONE line of `--output-format stream-json` NDJSON into feed activities.
// Surfaces the WHOLE turn — thinking, narration, AND every tool — so neither the
// daemon console nor the app cover goes dark while Claude reasons (Opus thinks in
// bursts before/between tools; emitting only tools left long silent gaps).
// Assistant text is also folded into `out` so the WIKI_DONE/REGROUND_DONE
// sentinels still match. A non-JSON line (a stray warning) is kept as raw text.
function handleStreamLine(line, { cwd, emit, onActivity, appendText }) {
  let ev;
  try {
    ev = JSON.parse(line);
  } catch {
    appendText(line + '\n');
    emit(line + '\n');
    return;
  }
  const push = (a) => {
    if (!a || !a.label) return;
    emit(a.label + '\n');
    onActivity?.(a);
  };
  if (ev.type === 'assistant' && Array.isArray(ev.message?.content)) {
    for (const b of ev.message.content) {
      if (b.type === 'thinking' || b.type === 'redacted_thinking') {
        // The `thinking` text is usually redacted (signature only), so emit a
        // marker — enough to show Claude is actively reasoning, not hung.
        push({ kind: 'think', label: b.thinking ? `thinking: ${oneLine(b.thinking)}` : 'thinking…' });
      } else if (b.type === 'text' && b.text?.trim()) {
        appendText(b.text + '\n');
        push({ kind: 'say', label: oneLine(b.text) });
      } else if (b.type === 'tool_use') {
        push(humanizeToolUse(b.name, b.input || {}, cwd));
      }
    }
  } else if (ev.type === 'result' && typeof ev.result === 'string') {
    // The final assistant text (carries WIKI_DONE / REGROUND_DONE).
    appendText(ev.result + '\n');
  }
}

// One Claude Code turn. Output is captured (for sentinel detection) and streamed
// through, line-prefixed with the worker label so a fleet stays legible.
//
// `streamJson` switches to `--output-format stream-json` and parses the event
// stream: only the humanized tool activity reaches the console (a legible
// stream of `read …`, `grep …`, `+ node …`), assistant text is folded into the
// returned string for sentinel detection, and each activity is handed to
// `onActivity` so the caller can forward progress. Build-agent turns leave it
// off and keep the raw text passthrough + line sentinels.
export function runTurn({ prompt, resume, system, cwd, mcpConfig, label, onSpawn, streamJson, onActivity }) {
  return new Promise((resolve) => {
    const args = [];
    if (resume) args.push('--continue');
    args.push('-p', prompt, '--mcp-config', mcpConfig, '--append-system-prompt', system);
    // Pin the model — never inherit the user's global default (which may be a
    // 1M/long-context tier their subscription can't bill autonomous work on).
    args.push('--model', MODEL);
    if (streamJson) args.push('--output-format', 'stream-json', '--verbose');
    args.push(...PERM);
    // Force the user's Claude Code subscription — never the API. A key exported in
    // the shell would otherwise silently bill every poll-mode turn as raw API
    // usage (same invariant live mode enforces on its SDK session env).
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    const child = spawn('claude', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    onSpawn?.(child);
    let out = '';
    const pfx = label ? `${label} ` : '';
    const emit = (s) => process.stdout.write(pfx ? s.replace(/\n/g, `\n${pfx}`) : s);

    if (streamJson) {
      let buf = '';
      const appendText = (t) => {
        out += t;
      };
      child.stdout.on('data', (d) => {
        buf += d.toString();
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (line.trim()) handleStreamLine(line, { cwd, emit, onActivity, appendText });
        }
      });
      // stderr is not JSON (warnings/errors) — pass through and keep for sentinels.
      child.stderr.on('data', (d) => {
        const s = d.toString();
        out += s;
        emit(s);
      });
      child.on('error', (e) => {
        if (e.code === 'ENOENT') {
          console.error("\nerror: 'claude' CLI not found on PATH. Install Claude Code first.");
          process.exit(1);
        }
        console.error(e);
        resolve(out);
      });
      child.on('close', () => {
        if (buf.trim()) handleStreamLine(buf, { cwd, emit, onActivity, appendText });
        resolve(out);
      });
      return;
    }

    const onChunk = (d) => {
      const s = d.toString();
      out += s;
      emit(s);
    };
    child.stdout.on('data', onChunk);
    child.stderr.on('data', onChunk);
    child.on('error', (e) => {
      if (e.code === 'ENOENT') {
        console.error("\nerror: 'claude' CLI not found on PATH. Install Claude Code first.");
        process.exit(1);
      }
      console.error(e);
      resolve(out);
    });
    child.on('close', () => resolve(out));
  });
}
