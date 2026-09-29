/**
 * THE WORK MODULES, WALKED — the one list every source ban over "the work
 * manager" reads (test-only: *.test.mjs never ships in the package, and this
 * file holds no tests of its own).
 *
 * work.mjs was split into its work*.mjs lanes (2026-09-26, SOLID F037). A ban
 * that hand-lists the files it guards goes blind to the next lane split out:
 * the adversarial review appended a second credential list, a raw
 * resume-lost classifier and a hand-spelled kind branch to workRetire.mjs and
 * every hand-listed ban still passed. So a ban walks the directory — every
 * `work<Capital>*.mjs`, the manager itself and turnLock.mjs — and a walk that
 * lost the manager or its biggest lanes throws (the canary) rather than
 * passing over nothing.
 */
import { readdirSync } from 'node:fs';

export const WORK_MODULE_RE = /^work[A-Z]\w*\.mjs$/;

/** Every work module's file name, sorted; never a test file. */
export function workModuleFiles() {
  const files = readdirSync(new URL('./', import.meta.url))
    .filter((f) => (WORK_MODULE_RE.test(f) || f === 'work.mjs' || f === 'turnLock.mjs') && !f.endsWith('.test.mjs'))
    .sort();
  for (const f of ['work.mjs', 'turnLock.mjs', 'workSessionTurns.mjs', 'workAgentTurns.mjs', 'workRetire.mjs'])
    if (!files.includes(f)) throw new Error(`canary: the work-module walk lost ${f}`);
  return files;
}
