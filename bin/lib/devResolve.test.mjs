/**
 * PICKING A COMMAND OUT OF WHAT A MODEL SAID.
 *
 * This is the one part of the resolve path that runs without a CLI, so it is
 * the one part a test can hold to account. Everything else about the turn —
 * whether it installs, whether it reads the right file — is the model's job and
 * the server's parser is what stands behind it.
 *
 * THE BIAS IS DELIBERATELY TOWARD ACCEPTING. Whatever comes out of here goes
 * through `parseDevCommand` on the server, which refuses anything outside the
 * policy and names what was proposed while doing it. Being strict here converts
 * a model that wrapped its answer in backticks into a dead end the asker cannot
 * act on, after they have already paid for the turn. Being loose here costs one
 * clear refusal.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickCommand, resolvePrompt, NO_COMMAND } from './devResolve.mjs';

test('takes a bare command', () => {
  assert.equal(pickCommand('npm run dev'), 'npm run dev');
});

test('unwraps a fenced block', () => {
  assert.equal(pickCommand('```sh\npnpm dev\n```'), 'pnpm dev');
});

test('unwraps inline backticks', () => {
  assert.equal(pickCommand('`bun dev`'), 'bun dev');
});

// A model that explains before complying puts the answer last; one that
// complies exactly has only the one line anyway.
test('takes the LAST plausible line when the model explains first', () => {
  assert.equal(pickCommand('I checked package.json.\n\nnpm run dev'), 'npm run dev');
});

test('strips list decoration', () => {
  assert.equal(pickCommand('- make serve'), 'make serve');
});

test('keeps a repo-relative script, which is the escape hatch for anything else', () => {
  assert.equal(pickCommand('./scripts/dev.sh'), './scripts/dev.sh');
});

test('keeps arguments', () => {
  assert.equal(pickCommand('bun --hot src/index.ts'), 'bun --hot src/index.ts');
});

/**
 * THE HONEST FAILURES. "Could not work it out" and "proposed something the
 * policy refuses" are different sentences to whoever pressed the button, and
 * only one of them means the policy might be too narrow for their stack — so
 * prose must never be forwarded as a proposal.
 */
test('the sentinel is not a command', () => {
  assert.equal(pickCommand(NO_COMMAND), null);
});

test('a sentence is not a command', () => {
  assert.equal(pickCommand('I could not determine how to start this project.'), null);
});

test('a long line is not a command', () => {
  assert.equal(pickCommand('first you need to install the deps and then run the thing ok'), null);
});

test('nothing at all is not a command', () => {
  assert.equal(pickCommand(''), null);
  assert.equal(pickCommand(null), null);
  assert.equal(pickCommand(undefined), null);
});

/**
 * The prompt names the allowlist NOT as a security control — the server
 * enforces it regardless — but because a model that knows the shape of an
 * acceptable answer gives one, and a refused proposal costs the asker a whole
 * round trip to learn nothing.
 */
test('the prompt names the argv0 allowlist and the sentinel', () => {
  const p = resolvePrompt();
  for (const bin of ['npm', 'pnpm', 'bun', 'cargo', 'make', 'dotnet']) {
    assert.ok(p.includes(bin), `prompt should name ${bin}`);
  }
  assert.ok(p.includes(NO_COMMAND), 'prompt should name the give-up sentinel');
  // The install permission is the whole reason a fresh worktree works at all.
  assert.match(p, /install/i);
  // …and it must not answer with something that detaches, or the supervisor
  // loses the process it is meant to own.
  assert.match(p, /background/i);
});
