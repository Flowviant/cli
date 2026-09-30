/**
 * WHAT A CODEX TURN'S OWN WORDS SAY WENT WRONG, SAID IN THE MACHINE'S WORDS
 * (2026-09-29) — for the Terminal tab and the New task chat, whose reply is
 * whatever the turn printed.
 *
 * Two failures the owner met on a Codex New task chat, both measured on
 * codex-cli 0.156.1:
 *  · NO LOGIN. The request went out with no credentials and the provider
 *    refused it: `unexpected status 401 Unauthorized: Missing bearer or basic
 *    authentication in header`, five retries on the websocket and five on
 *    HTTPS, then `turn.failed` — and the chat's reply was that retry log. A
 *    login the provider REFUSED reads `unexpected status 401 Unauthorized:
 *    Incorrect API key provided: …` instead (measured with a made-up key).
 *  · A TOOL CALL NOBODY COULD APPROVE. An MCP tool Codex holds to need
 *    approval, under an approval policy that cannot ask, fails the call with
 *    `MCP tool call requires approval, but approval policy is never` — and
 *    the chat said only whatever the model made of it, with nothing staged.
 *
 * Literal matches on those sentences, like cliLimit.mjs: a trigger, never a
 * classifier. The sentence names what was measured and the one remedy the
 * machine's own CLI offers; Codex's own words stay beside it.
 */
import { scrub as envScrub } from './uplinkScrub.mjs';
import { CODEX_RUNTIME } from './runtimeCodex.mjs';

const NO_LOGIN = /unexpected status 401 Unauthorized: Missing bearer or basic authentication/;
const REFUSED_LOGIN = /unexpected status 401 Unauthorized/;
export const APPROVAL_REFUSED = /MCP tool call requires approval, but approval policy is never/;

/** 'missing' | 'refused' | null — what a turn's output says of its login. */
export function codexLoginFailure(out) {
  const s = String(out ?? '');
  if (NO_LOGIN.test(s)) return 'missing';
  if (REFUSED_LOGIN.test(s)) return 'refused';
  return null;
}

/** The sentence for `codexLoginFailure`'s answer; `login` is the registry's
 *  own sign-in command. */
export function codexLoginSentence(failure, login = CODEX_RUNTIME.login) {
  if (failure === 'missing')
    return `Codex isn't signed in for this chat on the machine — it sent the request with no login, and the provider refused it (401 Unauthorized). Run \`${login}\` there, then send the message again.`;
  if (failure === 'refused')
    return `Codex's login on the machine was refused for this chat (401 Unauthorized) — run \`${login}\` there, then send the message again.`;
  return null;
}

/** The sentence for tool calls Codex refused for want of an approval, named
 *  as the turn named them (`server.tool`). Null when there were none. */
export function codexApprovalSentence(refused) {
  const names = [...new Set((refused ?? []).filter(Boolean))];
  const n = (refused ?? []).length;
  if (!n) return null;
  const which = names.length ? ` (${names.join(', ')})` : '';
  return `Codex on the machine refused ${n} tool call${n === 1 ? '' : 's'} in this turn${which} — "MCP tool call requires approval, but approval policy is never" — so nothing ${n === 1 ? 'it' : 'they'} would have done was done.`;
}

/** A reply with the sentence first and Codex's own words kept under it,
 *  scrubbed like every reply and cut to the lane's cap. */
export function withRelay(sentence, raw, cap = 16000) {
  const words = envScrub(String(raw ?? '')).trim();
  return (words ? `${sentence}\n\n${words}` : sentence).slice(0, cap);
}
