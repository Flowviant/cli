/**
 * Live mode (phase 2, opt-in via FLOWVIANT_LIVE=1). Instead of one-shot
 * `claude -p` turns + sentinels, each task runs a PERSISTENT Agent-SDK session:
 * the daemon claims, seeds the session with the brief, mirrors the model's
 * streamed reply into the task channel (stream_turn), injects human @-messages
 * as new turns, and bridges blockers (the session idle-parks; the daemon polls
 * the human's answer and injects it to resume in place). Same session = the
 * iterating loop, hosted through Flowviant.
 *
 * Auth invariant: the SDK runs the user's own Claude Code (subscription), never
 * the API — we strip ANTHROPIC_API_KEY from the session env so a key in the
 * user's shell can't silently divert to API billing.
 *
 * NOTE: the SDK mechanics here (streaming-input continuity, tool_use visibility,
 * one result per turn) are validated by spikes; the end-to-end task loop needs a
 * live fleet + repo to shake out. Old (poll/sentinel) mode is untouched.
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import {
  MCP_URL,
  SAFE,
  POLL_SECONDS,
  IDLE_SECONDS,
  PARK_TIMEOUT_SECONDS,
  FLEET_URL,
  FLEET_TOKEN,
  USER_AGENT,
} from './config.mjs';
import { c, info, ok, warn } from './ui.mjs';
import { sleep } from './claude.mjs';
import { git, resetWorktree } from './git.mjs';
import { loadPreviewConfig, startPreview } from './preview.mjs';

// Register a branch preview's tunnel URL with Flowviant (fleet-authed). The
// reviewer then drives it via "Open live preview" in the node.
const LIVE_TARGET_URL = FLEET_URL.replace(/\/agents\/?$/, '/live-target');
async function registerLiveTarget(intentId, kind, url) {
  try {
    await fetch(LIVE_TARGET_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${FLEET_TOKEN}`,
        'User-Agent': USER_AGENT,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ intentId, kind, url }),
    });
  } catch {
    /* best-effort — the tunnel still works; it just isn't linked in the app */
  }
}

// Safe mode's curated toolset. Bash is scoped to the specific CLIs the agent
// needs (git/gh/npm/bun) — NOT bare `Bash`, which would auto-approve arbitrary
// shell (rm -rf, curl|sh, reading ~/.ssh) and defeat the point of safe mode.
const SAFE_TOOLS = [
  'Edit',
  'Write',
  'Read',
  'Grep',
  'Glob',
  'Bash(git:*)',
  'Bash(gh:*)',
  'Bash(npm:*)',
  'Bash(bun:*)',
  'mcp__flowviant',
];

// Appended to Claude Code's preset. The reliable copy of the contract also
// rides in the seed message below, so this degrades gracefully if the preset
// shape shifts between SDK versions.
const SYSTEM_LIVE = `You are a Flowviant build agent working ONE task inside a live, shared task
channel. START by stating your approach in plain language (a short plan) BEFORE
you touch any code — the whole team watches this channel and may redirect you.
A human teammate may message you mid-task; treat any injected "The human
answered…" or teammate line as a new instruction and adapt. There is NO terminal
and NO interactive prompt — your only channel to a human is the flowviant MCP
tools. When you hit a decision only a human can make, call report_blocker (with
options when you can) and then STOP your turn — do not spin or guess; you will be
resumed with the answer. When the work is done: open ONE draft PR (git push +
gh pr create --draft), call attach_pr, then call complete with a plain-language
summary of what you built AND a criteria self-report (index into the brief's
"done when" list + met true/false + a short note per item). That summary +
self-report becomes your DELIVERY CARD in the task thread — it's what the team
reads to confirm done, so write it for them, not for a log. A live preview of
your branch is started for you automatically — you do NOT need to open a tunnel
or register a live target. NEVER merge — a human confirms done in the thread
(the merge card) and the merge runs separately.`;

function seedPrompt(runId, brief, transcript) {
  return [
    `Your run id is ${runId}. Use it for every flowviant MCP tool call.`,
    brief?.branch
      ? `This is a REVISION — your prior branch "${brief.branch}" is checked out; address the review feedback and push to the SAME branch (the PR updates in place).`
      : `Start from the clean base checkout and open a fresh draft PR when done.`,
    ``,
    `Task brief:`,
    JSON.stringify(brief ?? {}, null, 2),
    ...(transcript
      ? [``, `Conversation so far (you may be resuming — pick up where this left off):`, transcript]
      : []),
    ``,
    `${transcript ? 'Continue' : 'Begin'}. Post a short plan first, then: report_progress as you go; report_blocker + stop if you hit a human decision; open a draft PR, attach_pr, then complete (summary + criteria self-report — your delivery card) when done.`,
  ].join('\n');
}

// ── MCP JSON-RPC client (the daemon's own calls, outside the session) ───────
// The flowviant MCP endpoint handles tools/call statelessly with a bearer
// worker token — no handshake — so this is all the daemon needs.
let rpcId = 0;
async function mcpCall(mcpUrl, token, name, args) {
  const res = await fetch(mcpUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      // Required: Node's default UA trips Cloudflare Bot Fight Mode (403) —
      // without this every live MCP call fails against api.flowviant.com.
      'User-Agent': USER_AGENT,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: ++rpcId,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  if (!res.ok) throw new Error(`mcp ${name} ${res.status}`);
  const body = await res.json();
  const text = body?.result?.content?.[0]?.text;
  if (typeof text !== 'string') return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

// Flatten a tool_result's content (string | array of {type:'text',text}) to text.
function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content))
    return content.map((b) => (b?.type === 'text' ? b.text : '')).join('');
  return '';
}
const BLOCKER_ID_RE = /"blockerId"\s*:\s*"([^"]+)"/;

// A streaming-input controller: seed message first, then push() more turns as
// they arrive (human @-messages, injected blocker answers). close() ends it.
function makeInput(seedText) {
  const q = [{ type: 'user', message: { role: 'user', content: seedText }, parent_tool_use_id: null }];
  let waker = null;
  let closed = false;
  return {
    push(text, priority) {
      q.push({
        type: 'user',
        message: { role: 'user', content: text },
        parent_tool_use_id: null,
        ...(priority ? { priority } : {}),
      });
      if (waker) { waker(); waker = null; }
    },
    close() {
      closed = true;
      if (waker) { waker(); waker = null; }
    },
    async *stream() {
      while (true) {
        if (q.length === 0) {
          if (closed) return;
          await new Promise((r) => (waker = r));
          if (closed && q.length === 0) return;
        }
        while (q.length) yield q.shift();
      }
    },
  };
}

// A stop word from any teammate halts the agent (interrupt at the next boundary,
// then hold for direction) — the "stop, you're going the wrong way" valve.
const STOP_RE = /(^|\W)stop(\W|$)/i;

// Idle-park on a blocker: the session is idle (zero tokens); poll the human's
// answer. Bounded by PARK_TIMEOUT — after that we tear the session down (free
// the Claude process) and resume later, rather than hold it open forever.
// Returns {status:'resolved',answer} | {status:'timeout'} | {status:'aborted'}.
async function waitForResolution(mcpUrl, token, blockerId, isAlive) {
  if (!blockerId) return { status: 'aborted' };
  const deadline = Date.now() + PARK_TIMEOUT_SECONDS * 1000;
  while (isAlive()) {
    await sleep(POLL_SECONDS);
    const r = await mcpCall(mcpUrl, token, 'get_blocker_resolution', { blockerId }).catch(() => null);
    if (r?.resolved) return { status: 'resolved', answer: r.resolution ?? {} };
    if (Date.now() >= deadline) return { status: 'timeout' };
  }
  return { status: 'aborted' };
}

// Park awaiting the next human message (used after a stop — no nudging).
// Returns the message, or null on shutdown/timeout.
async function waitForMessage(mcpUrl, token, runId, afterId, isAlive) {
  const deadline = Date.now() + PARK_TIMEOUT_SECONDS * 1000;
  while (isAlive()) {
    await sleep(POLL_SECONDS);
    const poll = await mcpCall(mcpUrl, token, 'poll_channel', {
      runId,
      ...(afterId ? { afterId } : {}),
    }).catch(() => null);
    const fresh = (poll?.messages ?? []).filter((x) => x.role === 'user');
    if (fresh.length) return fresh[fresh.length - 1];
    if (Date.now() >= deadline) return null;
  }
  return null;
}

// One task: claim → seed → stream/mirror/inject/park → complete. Returns
// { outcome: 'nothing' | 'done' | 'blocked' | 'stalled' | 'error' }.
export async function runLiveTask({ mcpUrl, token, cwd, baseRef, isAlive, resumeIntentId, onChild }) {
  const claim = await mcpCall(mcpUrl, token, 'claim_next_intent', {}).catch(() => null);
  if (!claim || claim.claimed !== true) return { outcome: 'nothing' };
  const { runId, intentId } = claim;
  const brief = claim.brief ?? {};
  const title = brief.title ?? 'a task';
  // Re-claiming the SAME intent this worker was just working (parked on a blocker,
  // now resuming) — its worktree holds hours of uncommitted work. Do NOT reset.
  const resuming = !!resumeIntentId && intentId === resumeIntentId;

  // Revision resumes its PR branch; a genuinely fresh task gets a clean base
  // checkout; a resume keeps its dirty worktree untouched.
  if (brief.branch) {
    try {
      git(['fetch', 'origin', '--quiet'], cwd);
      git(['checkout', brief.branch], cwd);
    } catch {
      if (!resuming) resetWorktree(cwd, baseRef);
    }
  } else if (!resuming) {
    resetWorktree(cwd, baseRef);
  }

  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY; // force the user's Claude Code subscription

  // Prior channel transcript — present when resuming a parked/re-claimed task;
  // seed it so a fresh session picks up where the conversation left off. afterId
  // starts at the last existing message so we never re-inject old ones as "new".
  const prior = await mcpCall(mcpUrl, token, 'poll_channel', { runId }).catch(() => null);
  const priorMsgs = prior?.messages ?? [];
  const transcript = priorMsgs
    .map((m) => `${m.authorName || m.role}: ${m.content}`)
    .join('\n');
  let afterId = priorMsgs.length ? priorMsgs[priorMsgs.length - 1].id : null;

  const input = makeInput(seedPrompt(runId, brief, transcript));
  const session = query({
    prompt: input.stream(),
    options: {
      cwd,
      env,
      permissionMode: SAFE ? 'default' : 'bypassPermissions',
      ...(SAFE ? { allowedTools: SAFE_TOOLS } : {}),
      systemPrompt: { type: 'preset', preset: 'claude_code', append: SYSTEM_LIVE },
      mcpServers: {
        flowviant: {
          type: 'http',
          url: mcpUrl,
          headers: { Authorization: `Bearer ${token}`, 'User-Agent': USER_AGENT },
        },
      },
    },
  });

  // Mark this worker BUSY for the daemon's reconcile loop: buildHave keeps the
  // worker's token while a session is live (never rotate a credential out from
  // under it), and teardown/agent-removal can interrupt the SDK session via this
  // marker's kill(). Cleared in finally. Mirrors poll mode's onChild(child).
  onChild?.({
    kill: () => {
      try {
        session.interrupt?.();
      } catch {
        /* already ending */
      }
      try {
        session.return?.();
      } catch {
        /* already closed */
      }
    },
  });

  let turnId = null;
  let turnText = '';
  let turnAt = null;
  let completed = false;
  let sawBlocker = false;
  let blockerId = null;
  let nudges = 0;
  let held = false; // asked to stop — park for direction, don't nudge

  const flush = async () => {
    if (turnId && turnText.trim())
      await mcpCall(mcpUrl, token, 'stream_turn', {
        runId,
        turnId,
        text: turnText.trim(),
        createdAt: turnAt,
      }).catch(() => {});
  };
  const inject = (msgs) => {
    afterId = msgs[msgs.length - 1].id;
    input.push(msgs.map((f) => (f.authorName ? `${f.authorName}: ` : '') + f.content).join('\n'));
  };

  try {
    for await (const m of session) {
      if (!isAlive()) return { outcome: 'blocked', title, intentId };

      if (m.type === 'assistant') {
        if (!turnId) {
          turnId = `t-${runId}-${Date.now()}`;
          turnAt = new Date().toISOString();
          turnText = '';
        }
        for (const b of m.message?.content ?? []) {
          if (b.type === 'text' && b.text) turnText += b.text;
          else if (b.type === 'tool_use') {
            const n = String(b.name ?? '');
            if (n.endsWith('complete')) completed = true;
            else if (n.endsWith('report_blocker')) sawBlocker = true;
          }
        }
        await flush();
      } else if (m.type === 'user') {
        // tool_result echoes — capture the blockerId report_blocker returned.
        for (const b of m.message?.content ?? []) {
          if (b?.type === 'tool_result') {
            const hit = BLOCKER_ID_RE.exec(resultText(b.content));
            if (hit) blockerId = hit[1];
          }
        }
      } else if (m.type === 'result') {
        await flush();
        turnId = null;

        if (completed) return { outcome: 'done', title, intentId };

        if (sawBlocker) {
          const res = await waitForResolution(mcpUrl, token, blockerId, isAlive);
          if (res.status === 'resolved') {
            input.push(`The human answered your blocker: ${JSON.stringify(res.answer)}\nApply it and continue.`);
            sawBlocker = false;
            blockerId = null;
            nudges = 0;
            continue;
          }
          if (res.status === 'timeout') return { outcome: 'parked', title, intentId };
          return { outcome: 'blocked', title, intentId }; // aborted (shutdown)
        }

        // Pick up new human @-messages (this is also where a stop lands — the
        // checkpoint model: halt at the boundary, not a hard mid-tool kill).
        const poll = await mcpCall(mcpUrl, token, 'poll_channel', {
          runId,
          ...(afterId ? { afterId } : {}),
        }).catch(() => null);
        // Torn down out from under us (restart / reassign in Flowviant): the
        // server killed this run — abandon the session, don't keep building.
        if (poll && poll.ok === false && poll.reason === 'run_not_active') {
          return { outcome: 'torn_down', title, intentId };
        }
        const fresh = (poll?.messages ?? []).filter((x) => x.role === 'user');

        if (fresh.some((f) => STOP_RE.test(f.content))) {
          if (fresh.length) afterId = fresh[fresh.length - 1].id;
          held = true;
          input.push('A teammate asked you to STOP. Halt, summarize where you are in one line, and wait for direction — do not continue until told.');
          continue;
        }
        if (fresh.length) {
          inject(fresh);
          nudges = 0;
          held = false;
          continue;
        }

        // Held after a stop — park for the next human message; never nudge.
        if (held) {
          const next = await waitForMessage(mcpUrl, token, runId, afterId, isAlive);
          if (!next) return { outcome: 'parked', title, intentId };
          held = false;
          nudges = 0;
          inject([next]);
          continue;
        }

        // Idle turn with no completion — nudge a couple of times, then stop.
        if (nudges < 2) {
          nudges++;
          input.push('Continue until the task is complete: open a draft PR and call complete, or report a blocker.');
          continue;
        }
        return { outcome: 'stalled', title, intentId };
      }
    }
    return { outcome: completed ? 'done' : 'stalled', title, intentId };
  } catch (e) {
    return { outcome: 'error', error: e?.message ?? String(e), title, intentId };
  } finally {
    onChild?.(null); // no longer busy — token may rotate between tasks
    input.close();
    try {
      await session.interrupt?.();
    } catch {
      /* session already ended */
    }
    try {
      await session.return?.();
    } catch {
      /* generator already closed */
    }
  }
}

// Per-agent loop — same signature/scaffolding as runFleetWorker, but each task
// is a persistent SDK session instead of a one-shot claude turn.
export async function runLiveWorker({
  agentId,
  label,
  cwd,
  baseRef,
  getToken,
  getHasWork,
  getMcpUrl,
  isAlive,
  onTokenSuspect,
  onChild,
}) {
  // The intent this worker is holding across iterations. When a task parks on a
  // blocker its worktree keeps uncommitted work; on the resume claim we must NOT
  // reset it. Cleared once the task finishes or the worker goes idle.
  let lastIntentId = null;
  let phase = '';
  const enter = (p, fn, msg) => {
    if (phase !== p) {
      phase = p;
      fn(`${label} ${msg}`);
    }
  };

  // One live preview at a time — the branch of the task most recently finished,
  // kept up while it's in review (a gated agent parks, so it lives until review
  // resolves). Replaced when the next task finishes; torn down on shutdown.
  let preview = null;
  const stopPreview = () => {
    if (preview) {
      try {
        preview.stop();
      } catch {
        /* already gone */
      }
      preview = null;
    }
  };
  const startReviewPreview = async (intentId) => {
    stopPreview();
    const cfg = loadPreviewConfig(cwd);
    const kind = cfg?.ui ? 'ui' : cfg?.api ? 'api' : null;
    const entry = kind ? cfg[kind] : null;
    if (!entry || !intentId) return; // no preview config → captured evidence only
    info(`${label} ${c.dim('starting a live preview of the branch for review…')}`);
    preview = await startPreview({
      worktree: cwd,
      kind,
      cmd: entry.cmd,
      port: entry.port,
      log: (m) => info(`${label} ${c.dim(m)}`),
    });
    if (preview) {
      await registerLiveTarget(intentId, kind, preview.url);
      ok(`${label} ${c.dim('live preview ready — open the node to drive it in your review')}`);
    }
  };

  while (isAlive()) {
    const token = getToken(agentId);
    if (!token) {
      await sleep(IDLE_SECONDS);
      continue;
    }
    if (!getHasWork(agentId)) {
      enter('idle', info, 'idle — no work assigned');
      await sleep(IDLE_SECONDS);
      continue;
    }
    let res;
    try {
      res = await runLiveTask({
        mcpUrl: getMcpUrl() ?? MCP_URL,
        token,
        cwd,
        baseRef,
        isAlive,
        resumeIntentId: lastIntentId,
        onChild,
      });
    } catch (e) {
      enter('error', warn, `${c.yellow('error')} ${c.dim(`— ${e?.message ?? e}`)}`);
      await sleep(IDLE_SECONDS);
      continue;
    }
    if (!isAlive()) break;
    // Keep the held intent only while a task is genuinely in flight (parked /
    // stalled / errored → same worktree resumes). Finishing or finding no work
    // clears it so the next fresh task starts from a clean base.
    lastIntentId =
      res.outcome === 'parked' || res.outcome === 'stalled' || res.outcome === 'error'
        ? res.intentId
        : null;
    if (res.outcome === 'nothing') {
      enter('idle', info, 'idle — no work assigned');
      await sleep(IDLE_SECONDS);
      continue;
    }
    if (res.outcome === 'done') {
      ok(`${label} ${c.dim(`finished "${res.title}" — PR opened for your review`)}`);
      phase = '';
      await startReviewPreview(res.intentId);
      continue;
    }
    if (res.outcome === 'torn_down') {
      // The human restarted/reassigned the task in Flowviant. Drop everything —
      // the next fresh claim resets the worktree to base.
      info(`${label} ${c.dim(`"${res.title}" was restarted/reassigned — abandoned this attempt`)}`);
      phase = '';
      continue;
    }
    if (res.outcome === 'parked') {
      // Idle-parked too long on a blocker: we freed the Claude process. The intent
      // stays claimed; a later poll re-claims + resumes (with transcript) once the
      // human answers. Idle, don't hard-stop the worker.
      enter('parked', info, `${c.dim('parked — freed the session; resumes when you answer in Flowviant')}`);
      await sleep(IDLE_SECONDS);
      continue;
    }
    if (res.outcome === 'blocked') {
      // Only reached on shutdown mid-park; the intent stays claimed and resumes
      // on reconnect. Nothing to do but stop cleanly.
      break;
    }
    // stalled / error — usually a stale token or a stuck turn. Refresh + retry.
    enter('reconnect', warn, `${c.yellow(res.outcome)} ${c.dim('— refreshing token, retrying')}`);
    onTokenSuspect?.(agentId);
    phase = '';
    await sleep(IDLE_SECONDS);
  }
  stopPreview();
  info(`${label} stopped`);
}
