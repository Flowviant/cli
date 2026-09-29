/**
 * A TURN'S FILES, AS THE WIRE HANDS THEM OVER (0.112.0) — the owner,
 * 2026-09-28: "im unable to paste pictures or add files for the conversations
 * in working or stuck or review".
 *
 * The server hands an agent turn its files on `agentTurnJobs[].attachments`:
 * `{ id, name, size, from }`, where `from` is `message` (attached to THIS
 * turn's words — an answer, a send-back) or `card` (attached to notes on the
 * card the turn is about). Absent is none; the server sends the key only to a
 * daemon at `DAEMON_AGENT_FILES_MIN` and parks the turn below it, which is why
 * this release reads it.
 *
 * THE WIRE IS NOT TRUSTED, the card thread's rule (cardThread.mjs): the server
 * capped each origin (`AGENT_FILES_PER_MESSAGE_MAX`, `CARD_FILES_PER_TURN_MAX`
 * in the app's fieldCaps.ts) and this module applies the SAME numbers again —
 * copies the release gate holds to the server's (`scripts/check-app-parity.mjs`,
 * rule 10), because a tighter copy would silently drop a file the person
 * watched go out. An entry with no id, or from an origin this daemon cannot
 * place in a prompt, is dropped alone; one file named twice (an answer's
 * screenshot that is also on the card's thread) is kept once, where it came
 * first — the person's own message.
 *
 * Pure data and pure functions, like cardThread.mjs: prompts imports it.
 */

/** The server's `AGENT_FILES_PER_MESSAGE_MAX` — one message's files. */
export const AGENT_FILES_PER_MESSAGE_MAX = 4;
/** The server's `CARD_FILES_PER_TURN_MAX` — the card's newest files, per turn. */
export const CARD_FILES_PER_TURN_MAX = 8;

/**
 * THE LONGEST LINE ONE FILE ADDS TO A PROMPT. A landed file is
 * `.flowviant/uploads/<name>` with the name at most `SAFE_NAME_MAX` (80) plus
 * a collision's `-<id6>`; a missed one is its safe name. The renderer cuts at
 * this regardless, so the bound below holds by construction, not by trust.
 */
export const AGENT_FILE_LINE_MAX = 160;

/**
 * THE MOST THE CARD'S FILES CAN ADD TO A CARD SPEC, rendered — so the spec
 * stash (agentCards.mjs `MAX_SPEC_CHARS`) holds the note whole beside the
 * discussion, and the pre-review is handed the files the agent was. A header
 * line and its blank line, then one line per file. `agentFiles.test.mjs`
 * renders the worst case against it.
 */
export const CARD_FILES_RENDER_MAX = 200 + CARD_FILES_PER_TURN_MAX * (AGENT_FILE_LINE_MAX + 1);

/**
 * The files off the wire, message files first then the card's, each origin at
 * its cap, as `{ id, name, size, from }`. Never throws; anything that is not a
 * list is none.
 */
export function readAgentFiles(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const pick = (from, max) => {
    const out = [];
    for (const a of raw) {
      if (out.length >= max) break;
      if (!a || typeof a !== 'object' || a.from !== from) continue;
      if (typeof a.id !== 'string' || !a.id || seen.has(a.id)) continue;
      seen.add(a.id);
      out.push({ id: a.id, name: typeof a.name === 'string' ? a.name : '', size: a.size, from });
    }
    return out;
  };
  return [...pick('message', AGENT_FILES_PER_MESSAGE_MAX), ...pick('card', CARD_FILES_PER_TURN_MAX)];
}
