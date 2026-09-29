/**
 * THE MACHINE CREDENTIAL NEVER RIDES AN INHERITED ENVIRONMENT — one home for
 * the removal rule every child built from the daemon's own environment obeys
 * (a CLI turn's `cliEnv` in runTurn.mjs, the project check's `checkEnv` in
 * workAgentCheck.mjs). Split out (SOLID F042) because the two lists were
 * hand-copied: a third credential name added to one would have left the other
 * lane handing it to a repo-controlled command.
 *
 * A DENYLIST ON PURPOSE, unlike `childEnv`'s allowlist: these children need
 * the operator's shell whole (the CLI's own sign-in, the toolchain a test run
 * needs), so stripping everything else would manufacture failures. Nothing
 * they run needs the credential the daemon authenticates with, so exactly
 * these names go. Imports nothing.
 */
export const MACHINE_CREDENTIAL_ENV = Object.freeze(['FLOWVIANT_MACHINE_TOKEN', 'FLOWVIANT_FLEET']);

/** A copy of `env` without the machine credential. Never mutates its input. */
export function withoutMachineCredentials(env) {
  const out = { ...(env ?? {}) };
  for (const k of MACHINE_CREDENTIAL_ENV) delete out[k];
  return out;
}
