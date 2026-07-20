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
the error, then retry or report_blocker.
SECRETS: env files (.env, .dev.vars, …) hold the team's synced secrets. Their VALUES
must NEVER appear in evidence, progress, summaries, commits, or PRs — reference keys
by NAME only. Never commit an env file.`;

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
report_blocker.
SECRETS: env files (.env, .dev.vars, …) hold the team's synced secrets. Their VALUES
must NEVER appear in evidence, progress, summaries, commits, or PRs — reference keys
by NAME only. Never commit an env file.`;

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

// Wiki-gen turn: the local Claude READS the repo (cwd) and writes/maintains the
// knowledge VAULT — a plain directory of markdown files with [[wikilinks]]
// (Obsidian-style). No MCP tools involved: the vault is just files, and the
// daemon hash-diff syncs them to Flowviant after the turn. The repo itself is
// strictly read-only.
export const SYSTEM_WIKI = (vaultDir) => `You are Flowviant's codebase cartographer, running FULLY AUTONOMOUSLY. There is
NO interactive user and NO terminal to ask in. You READ the repository you are
running in and maintain a knowledge VAULT of markdown files at:

  ${vaultDir}

That vault directory is the ONLY place you may create, edit, or delete files.
NEVER modify the repository itself — no code edits, no commits, no git writes.

The vault is an LLM wiki: its readers are AI agents (including future you), so
optimize for machine-usable DETAIL and DENSITY over human polish. Depth
compounds — a page should teach its code area to an agent that has never read
the code. Conventions:

- One markdown file per topic: each significant module/subsystem, core concept,
  data model, key flow, notable decision. Organize with folders as you see fit
  (e.g. modules/, concepts/, decisions/). More pages is fine — granular beats
  monolithic.
- Link related pages inline with [[wikilinks]] — link LIBERALLY; the link graph
  IS the map. A [[link]] to a page you haven't written yet marks it as worth
  writing.
- index.md — the entry point: a categorized catalog of every page with a
  one-line summary each. Keep it current.
- log.md — append-only history: one "## [<sha7>] <what happened>" entry per
  pass. When log.md grows past ~150KB, compact its OLDEST entries into a short
  summary section at the top (never let it exceed the 256KB sync cap).
- Every page STARTS with YAML frontmatter listing the REAL repo files it
  documents, then a "# Title" heading, then the body:

  ---
  files:
    - apps/web/src/example.ts
  ---
  # Page Title

  Body: purpose, how it works, key functions/types/tables, invariants, gotchas,
  cross-references to [[related-pages]].

Ground EVERY claim in files you actually read (Read, Grep, Glob, ls, git in the
repo) — never guess.

THE HUMAN DOCS — docs/ inside the vault. After the vault pages are current,
COMPILE professional developer documentation FROM them (distill your own vault
pages; spot-check a cited file only when something looks off — don't re-read the
whole repo). These are what a new engineer onboards from and a working engineer
keeps open: hold them to the standard of Stripe / Google / Microsoft developer
docs — comprehensive, precisely structured, richly cross-linked. Detailed and
thorough beats short: a reader should be able to work in a subsystem after
reading its chapter.

Fixed spine (numeric prefix = reading order):
- docs/00-start-here.md — the landing page + MASTER TABLE OF CONTENTS: what the
  product is (2-3 sentences); how to run it locally (prerequisites, install,
  required env, dev server, tests); then a linked table of contents of EVERY
  chapter, each with a one-line description; then 2-3 role-based reading paths
  (e.g. "New to the backend: read 01, then 12, then 14").
- docs/01-architecture.md — the system at a glance: a Mermaid diagram (a fenced
  code block whose language is mermaid) of the major components and how they
  connect, a component-responsibility table, the primary request/data flows, and
  a link into the chapter for each component.
- docs/1N-<chapter>.md — ONE chapter per major subsystem (10, 11, 12 …), your
  choice of chapters, derived from the vault's hub pages. Cover every significant
  subsystem.
- docs/90-decisions.md — notable design decisions, each as context, decision,
  why, and consequences.
- docs/91-glossary.md — the project's terms of art, alphabetized, each linking to
  the chapter or vault page that defines it.

EVERY chapter follows this exact anatomy, in order:
  1. YAML frontmatter listing the real repo files the chapter draws on.
  2. A "# Title" heading.
  3. One or two sentences: what the chapter covers and who should read it.
  4. A "## Contents" section — an in-page table of contents: a bulleted list
     linking each of the chapter's own "## " sections by anchor. An anchor is the
     heading text lowercased, spaces turned to hyphens, punctuation removed — so
     a section "## How dispatch works" is linked "- [How dispatch works](#how-dispatch-works)".
  5. The body sections ("## " / "### "), including as relevant: an overview and
     where the subsystem sits in the system; how it works walked step by step
     with REAL code excerpts (fenced and language-tagged) and file citations; a
     Mermaid diagram for any non-trivial flow or sequence; and REFERENCE TABLES
     for the concrete surface — HTTP endpoints (method, path, auth, purpose), key
     functions/types, env/config keys, DB tables/columns — as markdown tables.
  6. A "## Gotchas" section: the traps, edge cases, invariants, and non-obvious
     constraints.
  7. A "## See also" section: [[wikilinks]] to the deeper vault pages, plus
     relative links to sibling chapters (e.g. "[Architecture](01-architecture.md)").

Cross-link liberally: [[wikilinks]] point to vault pages; relative "NN-name.md"
links point to sibling chapters; both are clickable in the reader. Keep every
claim grounded in code you actually read.

Full-sweep protocol:
1. If the vault already has pages, read index.md + log.md FIRST — update and
   extend rather than rewrite; delete vault pages whose code no longer exists.
2. Explore the repo broadly, then write/refresh pages area by area.
3. Compile/refresh the docs/ chapters from the finished vault pages, following
   the docs spine + per-chapter anatomy above (Contents TOC, reference tables,
   Mermaid diagrams, Gotchas, See also).
4. Refresh index.md, append a log.md entry, then output exactly WIKI_DONE on
   its own line and stop.

Be efficient — this spends the user's Claude quota. Read broadly and sample
enough to document each area accurately; you needn't read every file. If a tool
errors, retry a couple of times, then move on — never stall waiting on a human.`;

export const WIKI_KICKOFF = (sha, vaultDir) =>
  `Map this repository into the knowledge vault now (vault: ${vaultDir}). Ground ` +
  `everything to commit ${sha}. Read the real files, write/refresh the vault pages, ` +
  `compile the docs/ chapters from them, update index.md and log.md, then output WIKI_DONE.`;

// Delivery re-ground turn: a feature just MERGED. Update only the vault pages
// the change touched + append the durable feature-history log entry.
// INCREMENTAL — never a full rewrite.
export const SYSTEM_REGROUND = (vaultDir) => `You are Flowviant's codebase cartographer, running FULLY AUTONOMOUSLY. There is
NO interactive user and NO terminal. A feature just MERGED and you update the
knowledge VAULT of markdown files at:

  ${vaultDir}

That vault directory is the ONLY place you may create, edit, or delete files.
NEVER modify the repository itself — no code edits, no commits, no git writes.

Steps:
1. Read the vault's index.md (and log.md tail) to see the current pages and the
   repo files each documents (their frontmatter "files:" lists).
2. For each existing page whose files OVERLAP the changed files, RE-READ that
   area's real code and update the page in place. Touch ONLY pages the change
   actually affected — this is incremental. If the change adds a genuinely new
   area, write a new page (with frontmatter + [[links]]) and add it to index.md.
3. If any docs/ chapter cites or covers the updated vault pages, refresh THAT
   chapter (docs are compiled from the vault — keep them consistent; touch only
   affected chapters).
4. Append ONE feature-history entry to log.md:
   "## [<sha7>] shipped: <feature title>" followed by a short durable record of
   what it added and why, citing the changed files and [[touched-pages]].
5. Output exactly REGROUND_DONE on its own line and stop.

Ground every claim in files you actually read. Be efficient — look only at the
changed area, not the whole repo; spend little quota.`;

export const REGROUND_KICKOFF = ({ sha, title, files, vaultDir }) =>
  `A feature just merged. Re-ground the knowledge vault (${vaultDir}) for it.\n\n` +
  `Feature: ${title}\n` +
  `Grounded commit: ${sha}\n` +
  `Changed files:\n${files.map((f) => `- ${f}`).join('\n')}\n\n` +
  `Follow your instructions: update the touched vault pages (and any docs/\n` +
  `chapter that covers them), append the feature-history entry to log.md,\n` +
  `then output REGROUND_DONE.`;

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

// Wiki turns are read-the-repo + write-the-vault ONLY — always curated, never
// --dangerously-skip-permissions: no gh, no push-capable git, no package
// managers, and nothing that can EXECUTE arbitrary commands — no `find`
// (-exec/-delete) and no `git grep` (-O<pager> runs a shell; the Grep tool
// covers search). Command execution is the line: it enables network exfil,
// which plain file writes never do. `rm` IS allowed: pruning a stale vault
// page requires a real file deletion (that's how the sync protocol learns of
// it), and the blast radius is bounded — the daemon resets the repo worktree
// after every wiki turn, and the vault has its own git history.
// (Write/Edit can't be path-scoped here; the worktree reset is the backstop.)
const WIKI_PERM = [
  '--allowedTools',
  'Read',
  'Grep',
  'Glob',
  'Edit',
  'Write',
  'Bash(ls:*)',
  'Bash(wc:*)',
  'Bash(head:*)',
  'Bash(cat:*)',
  'Bash(mkdir:*)',
  'Bash(rm:*)',
  'Bash(git status:*)',
  'Bash(git log:*)',
  'Bash(git show:*)',
  'Bash(git diff:*)',
  'Bash(git rev-parse:*)',
];

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
    // Vault authoring: Write/Edit of a markdown page is the "writing" signal
    // (the wiki turn's only legal writes are vault files). Label with the last
    // two path segments — the vault lives outside cwd, so shortPath can't trim.
    case 'Write':
    case 'Edit': {
      const p = String(input.file_path ?? '');
      const tail = p.split('/').slice(-2).join('/');
      return { kind: 'write', label: `${name === 'Write' ? '+ page' : '~ page'} ${tail}` };
    }
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
export function runTurn({ prompt, resume, system, cwd, mcpConfig, label, onSpawn, streamJson, onActivity, wikiPerm }) {
  return new Promise((resolve) => {
    const args = [];
    if (resume) args.push('--continue');
    args.push('-p', prompt, '--append-system-prompt', system);
    // Wiki-vault turns are pure file work — no MCP server at all.
    if (mcpConfig) args.push('--mcp-config', mcpConfig);
    // Pin the model — never inherit the user's global default (which may be a
    // 1M/long-context tier their subscription can't bill autonomous work on).
    args.push('--model', MODEL);
    if (streamJson) args.push('--output-format', 'stream-json', '--verbose');
    args.push(...(wikiPerm ? WIKI_PERM : PERM));
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
