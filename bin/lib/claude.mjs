/**
 * Driving Claude Code: the operating-contract system prompts, the permission
 * posture, and one `claude -p` turn. The hard rule baked into both prompts:
 * there is no interactive user — the only channel to a human is the blocker loop.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SAFE } from './config.mjs';

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
4. Before finishing: for EACH acceptance criterion, call attach_evidence with concrete
   proof it is met. This is what the human reviews instead of the diff.
5. Ship: on a revision, \`git push\` to the SAME existing branch (the PR updates in place)
   and re-call attach_pr with that PR URL; otherwise open ONE draft PR (git push +
   \`gh pr create --draft\`) and call attach_pr. Then complete. NEVER merge — the human
   approves the PR in Flowviant.
6. Return to step 1.

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
4. Before finishing: for EACH acceptance criterion call attach_evidence with concrete
   proof it is met.
5. Ship: if this is a revision, \`git push\` to the SAME existing branch (the open PR
   updates in place) and re-call attach_pr with that same PR URL. Otherwise open ONE
   draft PR (git push + \`gh pr create --draft\`) and call attach_pr. Then complete.
   NEVER merge. Then output exactly DONE on its own line and stop.

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

// One Claude Code turn. Output is captured (for sentinel detection) and streamed
// through, line-prefixed with the worker label so a fleet stays legible.
export function runTurn({ prompt, resume, system, cwd, mcpConfig, label, onSpawn }) {
  return new Promise((resolve) => {
    const args = [];
    if (resume) args.push('--continue');
    args.push('-p', prompt, '--mcp-config', mcpConfig, '--append-system-prompt', system, ...PERM);
    const child = spawn('claude', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    onSpawn?.(child);
    let out = '';
    const pfx = label ? `${label} ` : '';
    const onChunk = (d) => {
      const s = d.toString();
      out += s;
      process.stdout.write(pfx ? s.replace(/\n/g, `\n${pfx}`) : s);
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
