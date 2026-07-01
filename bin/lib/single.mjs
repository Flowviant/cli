/**
 * Back-compat single-token + static-fleet modes. A single token drains the whole
 * queue in one continuous Claude session in the current checkout; FLOWVIANT_TOKENS
 * runs one such worker per token, each in its own git worktree.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MCP_URL, POLL_SECONDS, tokens } from './config.mjs';
import { sleep, mcpConfigFor, runTurn, sawSentinel, blockedId, SYSTEM_MULTI, KICKOFF, RESUME } from './claude.mjs';
import { git, repoRootOrDie } from './git.mjs';

export async function runWorker({ token, cwd, label }) {
  const { dir, path: mcpConfig } = mcpConfigFor(token, MCP_URL);
  try {
    let out = await runTurn({ prompt: KICKOFF, resume: false, system: SYSTEM_MULTI, cwd, mcpConfig, label });
    while (!sawSentinel(out, 'ALL_CLEAR')) {
      if (blockedId(out)) {
        console.log(`${label} » waiting on you in Flowviant — answer the blocker. Re-checking in ${POLL_SECONDS}s…`);
      }
      await sleep(POLL_SECONDS);
      out = await runTurn({ prompt: RESUME, resume: true, system: SYSTEM_MULTI, cwd, mcpConfig, label });
    }
    console.log(`${label} » queue clear.`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function runStaticFleet() {
  console.log(`» flowviant fleet → ${tokens.length} workers · ${MCP_URL}`);
  const repoRoot = repoRootOrDie();
  const baseDir = mkdtempSync(join(tmpdir(), 'flowviant-fleet-'));
  const worktrees = [];
  const cleanup = () => {
    for (const wt of worktrees) {
      try {
        git(['worktree', 'remove', '--force', wt], repoRoot);
      } catch {
        /* best-effort */
      }
    }
    try {
      rmSync(baseDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  };
  process.on('SIGINT', () => {
    cleanup();
    process.exit(130);
  });

  const jobs = tokens.map((token, i) => {
    const label = `[w${i + 1}]`;
    const wt = join(baseDir, `worker-${i + 1}`);
    git(['worktree', 'add', '--detach', wt, 'HEAD'], repoRoot);
    worktrees.push(wt);
    console.log(`${label} worktree ready (token fva_…${token.slice(-4)})`);
    return runWorker({ token, cwd: wt, label });
  });
  await Promise.allSettled(jobs);
  cleanup();
  console.log('» fleet done — all queues clear.');
}
