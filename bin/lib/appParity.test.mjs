/**
 * THE DAEMON'S COPIES OF SERVER RULES MATCH THEIR HOMES (2026-09-26, SOLID
 * F044/F002). `scripts/check-app-parity.mjs` is the release gate (required app
 * checkout, run by build-binaries.sh and prepublishOnly); this runs the same
 * gate from the suite when the app repo and bun are both on the box, and pins
 * that the gate actually covers the effort ladders — each `RUNTIMES[id].efforts`
 * is a copy of the server's `RUNTIME_EFFORTS` row, read by `brainFor`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { RUNTIMES } from './runtimes.mjs';

const cliRoot = resolve(new URL('../..', import.meta.url).pathname);
const gate = join(cliRoot, 'scripts/check-app-parity.mjs');
const appDir = process.env.FLOWVIANT_APP_DIR ?? resolve(cliRoot, '..', 'flowviant');
const haveApp = existsSync(join(appDir, 'packages/shared/src/schemas/agent-runner.schema.ts'));
let haveBun = true;
try {
  execFileSync('bun', ['--version'], { stdio: 'ignore' });
} catch {
  haveBun = false;
}

test('every runtime declares an effort ladder, and the release gate reads it and the kinds', () => {
  for (const [id, rt] of Object.entries(RUNTIMES)) {
    assert.ok(Array.isArray(rt.efforts) && rt.efforts.length > 0, id);
  }
  const src = readFileSync(gate, 'utf8');
  assert.match(src, /RUNTIMES\[id\]\?\.efforts/);
  assert.match(src, /renderDaemonArtifactPolicy\(\)/);
  // The card kinds and the library folders (0.105.0) are gated too.
  assert.match(src, /JSON\.stringify\(\[\.\.\.TASK_KINDS\]\) !== JSON\.stringify\(Object\.keys\(AGENT_TASK_KINDS\)\)/);
  // …the library's kinds by folder AND bundle flag, not the folder alone.
  assert.match(src, /const folders = \(table\) => Object\.fromEntries\(Object\.entries\(table\)\.map\(\(\[k, v\]\) => \[k, \{ dir: v\.dir, bundle: v\.bundle \}\]\)\);/);
  assert.match(src, /JSON\.stringify\(serverFolders\) !== JSON\.stringify\(daemonFolders\)/);
  // …and the card-thread bounds (0.106.0), all three.
  assert.match(src, /for \(const name of \['CARD_THREAD_BUDGET', 'CARD_THREAD_WHO_MAX', 'CARD_THREAD_AT_MAX'\]\)/);
  assert.match(src, /bin\/lib\/cardThread\.mjs/);
  // …and the card types (0.106.0): ids in order, each with its kind and label.
  assert.match(src, /bin\/lib\/agentTaskTypes\.mjs/);
  assert.match(src, /typeRows\(\[\.\.\.serverTypes\.TASK_TYPES\], \(t\) => serverTypes\.TASK_TYPE_KIND\[t\], \(t\) => serverTypes\.TASK_TYPE_LABEL\[t\]\)/);
  assert.match(src, /JSON\.stringify\(serverTypeRows\) !== JSON\.stringify\(daemonTypeRows\)/);
  // …and the plan-limit report's bounds (0.109.0), all four, off the shared file.
  assert.match(src, /for \(const name of \['RUNTIME_LIMITS_PARAM_MAX', 'RUNTIME_LIMIT_WINDOWS_MAX', 'RUNTIME_LIMIT_ID_MAX', 'RUNTIME_LIMIT_PLAN_MAX'\]\)/);
  assert.match(src, /join\(shared, 'runtimeLimits\.ts'\)/);
  assert.match(src, /bin\/lib\/runtimeLimits\.mjs/);
  // …and the agent-turn file caps (0.112.0), both, off the shared fieldCaps.
  assert.match(src, /for \(const name of \['AGENT_FILES_PER_MESSAGE_MAX', 'CARD_FILES_PER_TURN_MAX'\]\)/);
  assert.match(src, /join\(shared, 'fieldCaps\.ts'\)/);
  assert.match(src, /bin\/lib\/agentFiles\.mjs/);
  // …and the turn model's shape (2026-09-29), its cap and its pattern.
  assert.match(src, /join\(shared, 'turnModel\.ts'\)/);
  assert.match(src, /TURN_MODEL_RE\?\.source/);
  // …and (0.114.0; a set since 0.115.0) the CLIs each non-code kind runs on
  // — the server's KIND_RUNTIMES against the runtimes that declare the kind's
  // posture, its default among them, a missing table a failure — and every
  // extension the server keeps a library item under.
  assert.match(src, /const \{ KIND_RUNTIMES \} = await import\(pathToFileURL\(join\(shared, 'taskKind\.ts'\)\)\.href\);/);
  assert.match(src, /if \(!KIND_RUNTIMES\) failures\.push\(/);
  assert.match(src, /JSON\.stringify\(declared\) !== JSON\.stringify\(want\)/);
  assert.match(src, /if \(!declared\.includes\(row\.default\)\)/);
  assert.match(src, /const accepted = DAEMON_LIBRARY_KINDS\[kind\]\?\.ext \?\? \[\];/);
  assert.match(readFileSync(join(cliRoot, 'scripts/build-binaries.sh'), 'utf8'), /bun scripts\/check-app-parity\.mjs/);
  assert.equal(JSON.parse(readFileSync(join(cliRoot, 'package.json'), 'utf8')).scripts.prepublishOnly, 'bun scripts/check-app-parity.mjs');
});

test(
  'the effort ladders and the artifact snapshot match the app beside this one',
  { skip: (!haveApp && 'no app checkout beside this one') || (!haveBun && 'no bun on this box') },
  () => {
    const out = execFileSync('bun', [gate], { env: { ...process.env, FLOWVIANT_APP_DIR: appDir }, encoding: 'utf8' });
    assert.match(out, /match/);
  }
);
