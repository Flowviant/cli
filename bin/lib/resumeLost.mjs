/**
 * The resume-lost rule — when a resumed CLI turn found no conversation and
 * runs once more fresh. ONE home for both lanes (the Workbench tab and the
 * agent turn), split out of work.mjs because the agent lane called the
 * classifier without the runtime and init evidence it needs (SOLID F001): a
 * successful Claude answer that mentioned "session … not found" re-ran the
 * whole card in a fresh conversation after the first run had already
 * committed. The evidence is now part of the call's shape, not a default.
 */

/**
 * A RESUME THAT FOUND NO CONVERSATION, in the CLI's own words.
 *
 * "Produced nothing" was the only signal the retry backstop had, and it is not
 * the signal these failures give: Claude Code answers a dead `--resume` id with
 * a result event carrying `errors: ['No conversation found with session ID: …']`
 * AND writes the same line to stderr, so `out` is non-empty, the backstop never
 * fired, and the turn SETTLED SUCCESSFULLY with the error as its answer. Every
 * later message in that tab replied the same way — the marker file still held
 * the dead id, nothing rewrote it (that only happens when an init event is
 * seen, and there is none), and no surface offered a way to clear it. A tab
 * bricked forever by its own CLI pruning its history, which it does on its own
 * schedule.
 *
 * Matched on the CLI's phrasing rather than a code, because neither runtime
 * gives one. Deliberately narrow: it must not swallow a rate limit or a
 * permission refusal, both of which are real answers that should stand.
 */
const RESUME_LOST = [
  /no conversation found/i,
  /no session found/i,
  /session .{0,80}not found/i,
  /conversation .{0,80}not found/i,
  /thread .{0,80}not found/i,
  // Codex 0.156's words for a pinned thread whose rollout file is gone
  // (2026-09-29): "Error: thread/resume: thread/resume failed: no rollout
  // found for thread id <id> (code -32600)" on stderr, exit 1, no event on
  // stdout. Every agent thread filed under a deleted per-turn /tmp home says
  // exactly this, and none of the phrases above matched it.
  /no rollout found/i,
  /trajectory not found/i,
];
/**
 * …BUT ONLY WHEN THE CLI SAID IT, NOT WHEN THE REPLY DID (2026-09-24).
 *
 * Under `answerFromResult` a SUCCESSFUL turn's `out` is Claude's reply, and the
 * patterns above were tested against all of it — so "the session cookie was not
 * found because SameSite dropped it" threw away a real answer and re-ran the
 * same message in a fresh, context-free conversation, whose init id then
 * re-pinned the tab: the first run's edits and commits had already happened,
 * the second repeated or misread them, and the tab's history was gone for good.
 * Web debugging talk says "session … not found" all day.
 *
 * So the text alone is never the evidence. Claude Code emits `system.init` on
 * EVERY turn that reached a conversation, and a dead `--resume` id fails before
 * one is emitted — so for Claude, a lost conversation is the phrase AND no init
 * event. Codex and agy give no such marker to this caller, so for them the
 * phrase must BE the reply: a short line, the shape a CLI error takes, never a
 * paragraph that happens to contain it.
 */
export const RESUME_LOST_MAX_CHARS = 400;
export const resumeConversationLost = (text, { runtime, sawInit } = {}) => {
  const t = String(text || '').trim();
  if (!t || !RESUME_LOST.some((re) => re.test(t))) return false;
  // Claude's evidence is the init event, and it must be SAID: a caller that
  // passes no `sawInit` measured nothing, and an unmeasured init never
  // authorises a second run of a turn that may already have committed.
  if (runtime === 'claude') return sawInit === false;
  // A caller that named no CLI measured nothing either.
  if (typeof runtime !== 'string' || !runtime) return false;
  return t.length <= RESUME_LOST_MAX_CHARS;
};

/**
 * WHETHER A RESUMED TURN RUNS ONCE MORE FRESH — both lanes' whole question.
 *
 * A resume that came back EMPTY, or with only the CLI saying the conversation
 * is gone. `sawInit` is whether THIS spawn's CLI emitted `system.init` (only
 * Claude's does, and only Claude's is read). A fresh turn is never retried:
 * `resume` false answers false whatever the text says.
 */
export const resumeRetriesFresh = ({ resume, out, runtime, sawInit }) =>
  Boolean(resume) && (!String(out || '').trim() || resumeConversationLost(out, { runtime, sawInit }));

/**
 * ONE SPAWN, AND AT MOST ONE FRESH RETRY — the agent lane's whole sequence,
 * with the init evidence measured HERE rather than by a flag each caller must
 * remember to set and reset (the bug F001 was: the lane asked the rule
 * without it). `onInit` is wrapped, so a caller's own init handler still runs;
 * the retry is a fresh conversation (`resume: false`, no pinned thread) in the
 * same place, and `beforeFresh` lets the caller drop what the first spawn
 * taught it. `runTurn` is the caller's (runTurn.mjs); this module imports
 * nothing.
 *
 * The Workbench tab keeps its own sequence: its evidence is the session id it
 * persists, and a fresh retry must NOT clear it (last write heals the marker).
 */
export async function runTurnResumingOnce(runTurn, args, { resume, runtime, beforeFresh } = {}) {
  let sawInit = false;
  const callerInit = args.onInit;
  const measured = {
    ...args,
    onInit: (i) => {
      sawInit = true;
      callerInit?.(i);
    },
  };
  const out = await runTurn({ ...measured, resume });
  if (!resumeRetriesFresh({ resume, out, runtime, sawInit })) return out;
  beforeFresh?.();
  sawInit = false;
  return runTurn({ ...measured, resume: false, resumeThreadId: undefined });
}
