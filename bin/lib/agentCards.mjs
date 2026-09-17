/**
 * THE CARD SPECS AN AGENT WAS ACTUALLY GIVEN, kept on the box that gave them
 * (2026-09-16).
 *
 * The AI pre-review reads a branch at review entry and has to answer "does this
 * diff do what each card asked for" — which needs the cards. Nothing on the
 * machine holds them: an agent turn is fed ONE card at a time, the server types
 * the next when the previous lands, and the daemon composes the prompt and
 * forgets it. By the time the queue empties, the only trace of card one on this
 * disk is whatever its commits happen to say about themselves, and a commit
 * message is a CLAIM about the work rather than the work's specification.
 *
 * So each turn appends the spec it typed. It is the daemon's own text — the same
 * `AGENT_TASK_SPEC` block the agent read, so the reviewer reads what the agent
 * read rather than a second rendering of the card that can drift from it.
 *
 * ── WHERE IT LIVES, AND WHY THAT IS THE WHOLE LIFECYCLE ──
 *
 * The worktree's PRIVATE git dir (`sessionMetaPath`), scoped by agent id. Three
 * properties come free with that choice and none of them needs code:
 *
 *   · it is INVISIBLE to `git status`, so a stash can never make a worktree
 *     dirty — which would refuse a ship, the exact trap a marker file in the
 *     working tree fell into;
 *   · it DIES with `git worktree remove`, so retiring an agent's worktree
 *     retires its stash. There is no sweep to write and none to forget;
 *   · it is per-BOX by construction, which is the honest answer to a machine
 *     handover: a box that adopted an agent mid-run holds only the prompts IT
 *     typed. The reviewer prompt SAYS how many it is missing rather than
 *     inventing the specs it does not have.
 *
 * ── IT IS A STASH, NOT A LEDGER ──
 *
 * Nothing reads it but the precheck, nothing is decided by it, and losing it
 * costs one label nobody was promised. Every failure here is swallowed for that
 * reason: a turn must never fail because a note about it could not be written.
 */

import { appendFileSync, readFileSync } from 'node:fs';

/**
 * How many card specs one agent may accumulate.
 *
 * A bound on a MACHINE — an agent's queue is a handful of cards, and this exists
 * so a pathological agent (a card re-delivered fifty times, an agent grown past
 * its budget) cannot turn a prompt into a file read. The NEWEST are kept, which
 * is the same tail-is-what-matters rule the trace keeps.
 */
export const MAX_STASHED_CARDS = 40;
/** The most one spec may contribute. A brief is written by whoever filed the
 *  card and the server caps it, but this file is composed into a prompt and a
 *  bound it owns is a bound that cannot be argued away upstream. */
export const MAX_SPEC_CHARS = 8_000;

/**
 * Write down the spec this turn is about to hand the agent.
 *
 * ONE JSON OBJECT PER LINE, APPENDED. Append rather than rewrite because two
 * turns of one agent never run at once (an agent's place is taken as a WRITER)
 * but a crash between read and write of a whole-file rewrite would lose every
 * earlier card — and because an append is atomic enough at this size that a
 * half-written line is the only damage a kill can do, which the reader drops.
 *
 * A re-delivered card appends a SECOND line for the same id; the reader keeps
 * the last, because that is the spec the agent most recently worked from.
 */
export function stashCard(path, taskId, spec) {
  if (!path) return false;
  const id = String(taskId ?? '').trim();
  const text = String(spec ?? '');
  if (!id || !text.trim()) return false;
  try {
    appendFileSync(
      path,
      JSON.stringify({ taskId: id.slice(0, 64), prompt: text.slice(0, MAX_SPEC_CHARS) }) + '\n'
    );
    return true;
  } catch {
    // A stash that could not be written costs the precheck one card's spec,
    // which it will say it could not check rather than guess at.
    return false;
  }
}

/**
 * What this box holds, newest spec per card, in the order the cards were worked.
 *
 * MALFORMED LINES ARE DROPPED ALONE — the boundary rule this repo states for
 * every relayed list: one truncated line (a daemon killed mid-append) must not
 * throw away the thirty-nine good specs beside it.
 */
export function readStash(path) {
  if (!path) return [];
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return []; // no file: this agent has run no card turn on this box
  }
  /** taskId → spec. A Map, so the LAST write per card wins while the insertion
   *  order stays the order the cards were first handed out — which is the order
   *  the branch was built in, and the order a reviewer reads them in. */
  const byId = new Map();
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let v;
    try {
      v = JSON.parse(line);
    } catch {
      continue;
    }
    if (!v || typeof v !== 'object') continue;
    const taskId = typeof v.taskId === 'string' ? v.taskId.trim() : '';
    const prompt = typeof v.prompt === 'string' ? v.prompt : '';
    if (!taskId || !prompt.trim()) continue;
    byId.set(taskId, prompt.slice(0, MAX_SPEC_CHARS));
  }
  const all = [...byId].map(([taskId, prompt]) => ({ taskId, prompt }));
  // The NEWEST cards when there are too many — a reviewer reading a grown
  // agent's branch is reading the work at its end.
  return all.slice(-MAX_STASHED_CARDS);
}
