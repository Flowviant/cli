/**
 * WHAT STARTS THIS PROJECT — asked of a Claude, on the machine, in the
 * background.
 *
 * WHY THIS EXISTS. Starting a dev server used to require a command a human had
 * typed into a sheet, prefilled `npm run dev`. That prefill is a guess about
 * somebody else's stack, and it was called out as one: "the option to run or
 * start the dev server shouldnt be npm run dev or show it as npm run dev
 * because thats not agnostic to everyones set up. no need to show that."
 *
 * The mechanism is the driver's own: "we are literally asking a claude session
 * to start it for us" — and, decisively, "i still want claude to start the
 * server for me but i dont want it to literally open a chat. have it do it in
 * the background." So this is a headless turn. It reaches no transcript, spends
 * no tab, and leaves no message anybody has to read.
 *
 * IT ANSWERS WITH A STRING AND STARTS NOTHING. The server parses what comes
 * back, through the same `parseDevCommand` a human's answer goes through, and
 * hands the machine an ordinary start job on the next poll. That split is the
 * whole safety story: the policy for what may execute has exactly one
 * implementation, and it lives in the component this repo can actually upgrade.
 * A daemon that decided for itself what counted as a legal command would be a
 * second copy of that policy, free to drift, published, and unrecallable.
 *
 * IT MAY INSTALL. That is not a loophole in the install refusal — it is the
 * refusal's own stated remedy. `parseDevCommand` refuses `npm install` because
 * a SPAWNED command runs lifecycle scripts from the repo and every transitive
 * dependency with no agent in the loop; the file says the remedy is "a turn in
 * the tab: a human asking, an agent doing it". This is exactly that turn, with
 * the human asking by pressing the button. And it is the case that matters: a
 * fresh worktree has no `node_modules` (they are gitignored, so they never come
 * across with the branch), which is precisely the dead end that produced "it
 * was stuck on 'working', does it really take that long to run dev?"
 *
 * IT CLEANS UP AFTER ITSELF. A `-p` turn writes a transcript, and
 * `localSessions.mjs` offers the newest ended session per directory as
 * adoptable — left behind, every resolve would drop a phantom untitled session
 * into the `+` menu.
 */

import { runTurn } from './claude.mjs';
import { removeProbeTranscript } from './runtimes.mjs';

/** Long, because an install can sit in front of the answer. The SERVER holds
 *  the real ceiling (`RESOLVE_TTL_MS`); this is the machine giving up first so
 *  a wedged child does not hold a slot until then. */
export const DEV_RESOLVE_TIMEOUT_MS = 10 * 60_000;

/** The sentinel for "I could not tell", so an honest failure is distinguishable
 *  from a model padding an answer it does not have. */
export const NO_COMMAND = 'NONE';

/**
 * The argv0s the server will accept. Named in the prompt NOT as a security
 * control — the server enforces it either way, and would refuse anything else
 * with the parser's own words — but because a model that knows the shape of an
 * acceptable answer gives one, and a refused proposal costs the asker a whole
 * round trip to learn nothing.
 */
const ALLOWED = [
  'npm', 'pnpm', 'yarn', 'bun', 'node', 'deno', 'go', 'python', 'python3',
  'make', 'cargo', 'rails', 'php', 'dotnet',
];

export function resolvePrompt() {
  return [
    'Work out the ONE command that starts this project’s development server, and reply with only that command.',
    '',
    'How to work it out: read the repo. Check package.json scripts, Makefile, Procfile, docker-compose, pyproject.toml, Cargo.toml, README — whatever this project actually uses. Prefer the script the project itself documents for local development.',
    '',
    'You MAY install dependencies first if they are missing (for example a worktree with no node_modules). Do that before answering.',
    '',
    'Rules for the answer:',
    `- It must begin with one of: ${ALLOWED.join(', ')} — or a ./path to a script in this repo.`,
    '- One line. No shell operators (&&, |, ;, >, $, backticks). If the project needs several steps, name a script in the repo that does them.',
    '- Not an install command. Install as part of your work above if needed; the answer is the command that RUNS the server.',
    '- It must not daemonize or background itself. It should stay in the foreground; something else supervises it.',
    `- If you genuinely cannot tell, reply exactly ${NO_COMMAND}.`,
    '',
    'Reply with the command alone — no explanation, no backticks, no prose.',
  ].join('\n');
}

/**
 * Last plausible command line out of whatever the model said.
 *
 * DELIBERATELY FORGIVING, because the cost of being wrong is low and asymmetric:
 * the server parses this and refuses anything outside the policy, naming what
 * was proposed. Being strict here would turn a model that wrapped its answer in
 * backticks into a failure the asker cannot act on, having already paid for the
 * turn.
 */
export function pickCommand(text) {
  const lines = String(text ?? '')
    .split('\n')
    .map((l) => l.trim())
    // Fence markers and bullet/quote decoration, which are formatting rather
    // than part of anybody's command.
    .filter((l) => l && !/^```/.test(l))
    .map((l) => l.replace(/^[-*>\s]+/, '').replace(/^`+|`+$/g, '').trim())
    .filter(Boolean);
  if (lines.length === 0) return null;
  // The LAST such line: a model that explains before complying puts the answer
  // at the end, and one that complies exactly has only one line anyway.
  const last = lines[lines.length - 1];
  if (!last || last === NO_COMMAND) return null;
  // A sentence is not a command. Cheap shape check so obvious prose becomes
  // "could not work it out" rather than a refusal quoting a paragraph back.
  if (last.split(/\s+/).length > 8 || /[.!?]$/.test(last)) return null;
  return last;
}

/**
 * Run the turn. Resolves `{ command }` or `{ error }` — never throws, because
 * the caller's only job with a failure is to relay it, and an exception at this
 * boundary would strand the row.
 */
export async function resolveDevCommandOnMachine({ cwd, model, log, onActivity }) {
  let sessionId = null;
  let timer;
  try {
    const out = await Promise.race([
      runTurn({
        prompt: resolvePrompt(),
        cwd,
        streamJson: true,
        answerFromResult: true,
        model,
        label: 'dev',
        /**
         * THE TURN'S OWN HUMANIZED TAIL, forwarded so a browser can watch it.
         *
         * This is the only feature in the product where a Claude does work
         * nobody can see — no transcript, by design — and the driver's answer
         * to that is the right one: "we could have it stream the output for
         * transparency on the menu." So the same `read …` / `+ npm install …`
         * lines a tab relays are forwarded here. It is the CLI's own stdout
         * humanized, never an inference about it, which is the standing rule
         * for every activity readout in this product.
         */
        onActivity,
        onInit: (i) => {
          if (i?.sessionId) sessionId = i.sessionId;
        },
      }),
      new Promise((r) => {
        timer = setTimeout(() => r(null), DEV_RESOLVE_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
    if (out === null) {
      return { error: 'your Claude did not finish working out how to start this project in time.' };
    }
    const command = pickCommand(out);
    if (!command) {
      return { error: 'your Claude could not work out how to start this project.' };
    }
    log?.(`dev: resolved start command — ${command}`);
    return { command };
  } catch (e) {
    return { error: `your Claude could not be run here: ${e?.message ?? 'unknown error'}` };
  } finally {
    clearTimeout(timer);
    // After the turn, so the delete does not race a child still writing.
    if (sessionId) setTimeout(() => removeProbeTranscript(cwd, sessionId), 750).unref?.();
  }
}
