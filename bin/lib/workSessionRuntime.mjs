/**
 * WHICH CLI A TAB SPEAKS, AND WHICH CONVERSATION IT RESUMES — the runtime pin
 * and the shapes a resume id must have before it rides argv.
 *
 * Split out of work.mjs (2026-09-26, SOLID F037). The pin and the id guards
 * change together (a new CLI brings both), and none of it is about running a
 * turn: the session lane asks `sessionRuntime` before it spawns. The two id
 * guards are pure and module-level: both turn lanes import them, so the
 * manager never carries a constant between lanes.
 */
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { canRun, RUNTIMES } from './runtimes.mjs';
import { detectRuntimes } from './runtimeDetection.mjs';

/**
 * The shape a codex thread id must have before it is written to disk or —
 * decisive — pushed into argv as `resume <id>`. Conservative on purpose:
 * alphanumeric plus dash/underscore, never a leading dash (an argv that
 * parses as a flag), never whitespace. Anything else is dropped and the
 * session simply runs fresh in its own worktree.
 */
export const CODEX_THREAD_RE = /^[0-9a-zA-Z][0-9a-zA-Z_-]{7,63}$/;

/** agy conversation ids are plain UUIDs (the db filename IS the identity —
 *  measured: a renamed copy fails "trajectory not found"). Guarded the same
 *  way as the codex id: it rides in argv as `--conversation <id>`. */
export const AGY_CONV_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createWorkSessionRuntime({ sessionMetaPath }) {
  /**
   * WHICH CLI drives this session — picked ONCE, on the first turn, and pinned
   * in the worktree's meta dir. The held context belongs to the CLI that made
   * it: `--continue` under a different binary is a different brain wearing the
   * session's half-finished state (the dispatch path pins heldRuntime for the
   * same reason). If the pinned CLI has left the machine, the turn settles
   * honestly instead of substituting. A retired-and-reattached directory has
   * no marker and no held context either, so re-picking there is correct.
   *
   * THE SERVER'S WORD COMES FIRST. A tab is created AS a runtime's tab
   * (`job.runtime`; null/absent = Claude, which is what every tab ran on until
   * now), so on the first turn a named runtime IS the pick — never a
   * preference the machine may override. And a named runtime that DISAGREES
   * with an existing pin is an identity change mid-life: something upstream
   * now calls this tab a different brain's, and the only honest move is to
   * settle the turn and say so ({ mismatch }), because a held context must
   * never be answered by a different brain.
   *
   * Returns { id } | { id: null } (nothing installed) | { missing: label } |
   * { unsupported: label } (a runtime no session can run on) |
   * { mismatch: { pin, runtime } } (labels, for the caller's sentence).
   *
   * SESSION-CAPABLE means rt.mcp is truthy — the session tools ride a real
   * per-invocation MCP config — OR the runtime runs tabs PLAIN (Antigravity):
   * no MCP at all, no cards, no streaming; the final answer is delivered by
   * the daemon's own report and ship-time reconciliation keeps the ledger
   * whole. `pickRuntimeFor('build')` is still the WRONG question here — it
   * says yes to the mediated DISPATCH path without saying how a tab would
   * speak, and a session pinned by it once threw in mcpFor on every turn.
   */
  const sessionCapable = (rid) =>
    (Boolean(RUNTIMES[rid]?.mcp) || rid === 'antigravity') && canRun(RUNTIMES[rid], 'build');
  const sessionRuntime = (wt, jobRuntime, sessionId) => {
    // SCOPED: two tabs standing in one directory may run different CLIs, and an
    // unscoped pin would hand the second one the first one's runtime.
    const marker = sessionMetaPath(wt, 'flowviant-runtime', sessionId);
    let pinned = null;
    if (marker && existsSync(marker)) {
      try {
        pinned = readFileSync(marker, 'utf8').trim() || null;
      } catch {
        /* unreadable marker — re-pin below */
      }
    }
    if (pinned && RUNTIMES[pinned]) {
      if (jobRuntime && jobRuntime !== pinned) {
        return {
          mismatch: {
            pin: RUNTIMES[pinned].label || pinned,
            runtime: RUNTIMES[jobRuntime]?.label || jobRuntime,
          },
        };
      }
      // A pin that names a non-session-capable runtime is settled honestly by
      // the caller, not silently re-picked: re-picking would hand the held
      // context to a different brain, which is the exact substitution the pin
      // exists to prevent.
      if (!sessionCapable(pinned)) return { unsupported: RUNTIMES[pinned].label || pinned };
      const installed = detectRuntimes().find((r) => r.id === pinned)?.installed;
      return installed ? { id: pinned } : { missing: RUNTIMES[pinned].label || pinned };
    }
    // First turn, and the server named the brain: that IS the pick, gated the
    // same two ways as a pin — not session-capable and not installed both
    // settle honestly via the caller's existing paths, never substituted.
    if (jobRuntime) {
      if (!sessionCapable(jobRuntime))
        return { unsupported: RUNTIMES[jobRuntime]?.label || jobRuntime };
      const installed = detectRuntimes().find((r) => r.id === jobRuntime)?.installed;
      if (!installed) return { missing: RUNTIMES[jobRuntime]?.label || jobRuntime };
      if (marker) {
        try {
          writeFileSync(marker, jobRuntime);
        } catch {
          /* best-effort — an unpinnable session just re-picks next turn */
        }
      }
      return { id: jobRuntime };
    }
    // The fresh pick — Claude first when it qualifies, for the reason
    // pickRuntimeFor gives: the prompts were tuned against it. DELIBERATELY
    // NARROWER than sessionCapable: a PLAIN tab (Antigravity — no cards, no
    // streaming) is a degraded mode someone CHOOSES, so it is honored only
    // when the server names it, never handed out as a default.
    const rows = detectRuntimes();
    const okFor = (rid) =>
      Boolean(RUNTIMES[rid]?.mcp) &&
      sessionCapable(rid) &&
      Boolean(rows.find((r) => r.id === rid)?.installed);
    const id = okFor('claude') ? 'claude' : (Object.keys(RUNTIMES).find(okFor) ?? null);
    if (!id) return { id: null };
    if (marker) {
      try {
        writeFileSync(marker, id);
      } catch {
        /* best-effort — an unpinnable session just re-picks next turn */
      }
    }
    return { id };
  };

  /** agy's own cwd registry — {cwd → the conversation that ran there LAST}.
   *  Read once, right after a fresh agy turn, to learn the id the turn just
   *  created; from then on the tab's marker is the identity and this registry
   *  is never consulted again (a dispatch sharing the machine may overwrite
   *  the cwd's entry between turns). */
  const agyRegistryLookup = (cwd) => {
    try {
      const raw = readFileSync(
        join(homedir(), '.gemini', 'antigravity-cli', 'cache', 'last_conversations.json'),
        'utf8'
      );
      const map = JSON.parse(raw);
      if (!map || typeof map !== 'object') return null;
      // agy keys by the cwd as IT resolved it — try our literal path and its
      // realpath, so a symlinked home doesn't orphan the lookup.
      let keys = [cwd];
      try {
        keys.push(realpathSync(cwd));
      } catch {
        /* the literal alone, then */
      }
      for (const k of keys) {
        const id = map[k];
        if (typeof id === 'string' && AGY_CONV_RE.test(id)) return id;
      }
      return null;
    } catch {
      return null;
    }
  };

  return { sessionRuntime, agyRegistryLookup };
}
