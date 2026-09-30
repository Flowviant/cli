/**
 * THE RELEASE GATE FOR THE DAEMON'S COPIES OF SERVER RULES (2026-09-26, SOLID
 * F044/F002). Run under bun (it imports the app's TypeScript):
 *
 *   APP=../flowviant bun scripts/check-app-parity.mjs
 *
 * The daemon is published separately and cannot import the app's shared
 * package, so these rules live here as copies of a server home:
 *   1. `bin/lib/artifactPolicy.mjs` — generated from the shared artifact
 *      schema; it must be that render, byte for byte.
 *   2. each `RUNTIMES[id].efforts` (`bin/lib/runtimes.mjs` assembles the rows
 *      from `runtime{Claude,Codex,Antigravity}.mjs`) — the CLI's
 *      effort ladder; it must equal the server's `RUNTIME_EFFORTS` row.
 *   3. the card kinds (2026-09-27, 0.105.0) — `AGENT_TASK_KINDS`'s keys
 *      (`bin/lib/agentTaskKinds.mjs`) must be the shared `TASK_KINDS`, in
 *      order: a kind the server sends that this daemon lacks is refused
 *      into Stuck, and one it has that the server never sends is dead.
 *   4. the kept library's kinds — the daemon's `LIBRARY_KINDS`
 *      (`bin/lib/knowledgeLibrary.mjs`) must give each shared `LIBRARY_KINDS`
 *      kind its `dir` AND its `bundle` flag, in order: the server names
 *      `models/…` and the daemon writes where its table says, and a kind the
 *      server keeps as a folder that the daemon reads as one file has every
 *      kept item refused by the path rule (and its folder reference dropped).
 *   5. the card-thread bounds (2026-09-27, 0.106.0) — `CARD_THREAD_BUDGET`,
 *      `CARD_THREAD_WHO_MAX` and `CARD_THREAD_AT_MAX` (`bin/lib/cardThread.mjs`)
 *      must be the shared ones: the daemon re-applies the server's budget to
 *      the discussion it is handed, and a tighter copy would silently cut
 *      what the server meant an agent to read.
 *   6. the card types (2026-09-27, 0.106.0) — `AGENT_TASK_TYPES`
 *      (`bin/lib/agentTaskTypes.mjs`) must name the shared `TASK_TYPES`, in
 *      order, each with the shared kind (`TASK_TYPE_KIND`) and label
 *      (`TASK_TYPE_LABEL`): a type the server sends that this daemon lacks is
 *      printed as nothing (a Refactor runs as plain code), one printed on
 *      another kind is dropped, and a label that drifted names the work in
 *      words the person never picked.
 *   7. the plan-limit report's bounds (2026-09-28, 0.109.0) —
 *      `RUNTIME_LIMITS_PARAM_MAX`, `RUNTIME_LIMIT_WINDOWS_MAX`,
 *      `RUNTIME_LIMIT_ID_MAX` and `RUNTIME_LIMIT_PLAN_MAX`
 *      (`bin/lib/runtimeLimits.mjs`) must be the shared ones
 *      (`runtimeLimits.ts`): the server re-applies them to the `rtl` param,
 *      so a looser copy here has a report dropped at the boundary and a
 *      tighter one withholds windows the app would have shown.
 *   8. the intake prompt's type menu (2026-09-28) — every id and one-line
 *      meaning must match the app's taskTypes.ts menu.
 *   9. the intake roster key and lease endpoint names — both must still be
 *      declared by the shared intake handout the daemon is built against.
 *      The job, draft and settle field names must also match their interfaces.
 *  10. the agent-turn file caps (2026-09-28, 0.112.0) —
 *      `AGENT_FILES_PER_MESSAGE_MAX` and `CARD_FILES_PER_TURN_MAX`
 *      (`bin/lib/agentFiles.mjs`) must be the shared ones (`fieldCaps.ts`):
 *      the daemon re-applies them to `agentTurnJobs[].attachments`, and a
 *      tighter copy would drop a file the person watched go out.
 *  11. the chat-file ceiling (2026-09-29, 0.113.0) — `ATTACHMENT_MAX_BYTES`
 *      (`bin/lib/workAttachments.mjs`) must be the shared one (`fieldCaps.ts`):
 *      the download loop skips any file over it, on both lanes, so a tighter
 *      copy silently drops a file the upload door took.
 *  12. the turn model's shape (2026-09-29) — `TURN_MODEL_MAX` and
 *      `TURN_MODEL_RE` (`bin/lib/turnModel.mjs`) must be the shared ones
 *      (`turnModel.ts`): the server re-applies them to a settle's `model`, so
 *      a looser copy here has the model dropped at the boundary and a tighter
 *      one withholds a model the app would have named.
 *  13. the CLIs each card kind runs on (2026-09-29, 0.114.0; a set since
 *      0.115.0) — the server accepts a container only on a CLI that runs
 *      every card in it (`KIND_RUNTIMES[kind].runs`: images on Codex,
 *      write-ups on Claude, mockups, 3D models and decks on Claude or Codex)
 *      and resolves an unpicked one to the kind's `default`, and the daemon
 *      runs a kind only on a runtime that DECLARES its posture
 *      (`RUNTIMES[id].profiles`). Each non-code kind's posture must be
 *      declared by exactly the server's set, and the default must be one of
 *      them: a CLI the server allows that the daemon does not declare is a
 *      container refused into Stuck on its first turn, and one the daemon
 *      declares that the server does not is a posture nobody can pick.
 *  14. the kept library's file types (2026-09-29, 0.114.0) — every extension
 *      the server may keep an item under (its kind's `mimes`/`mime`, through
 *      the artifact allowlist) must be one the daemon's `LIBRARY_KINDS[kind]
 *      .ext` accepts: a kept WebP the daemon's path rule refuses is a picture
 *      the Library lists and no agent is ever shown.
 *
 * The app checkout is REQUIRED here (no skip): the node:test parity cases skip
 * when the app is absent, and that is exactly why a release runs this instead.
 * build-binaries.sh and `npm publish` (prepublishOnly) both call it.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const cliRoot = resolve(import.meta.dir ?? new URL('.', import.meta.url).pathname, '..');
const appDir = resolve(process.env.FLOWVIANT_APP_DIR ?? process.env.APP ?? join(cliRoot, '..', 'flowviant'));
const shared = join(appDir, 'packages/shared/src/schemas');
if (!existsSync(join(shared, 'daemonArtifactPolicy.ts'))) {
  console.error(`check-app-parity: no app checkout at ${appDir} — set APP to the flowviant repo.`);
  process.exit(1);
}

const failures = [];
const { renderDaemonArtifactPolicy } = await import(pathToFileURL(join(shared, 'daemonArtifactPolicy.ts')).href);
const snapshot = readFileSync(join(cliRoot, 'bin/lib/artifactPolicy.mjs'), 'utf8');
if (snapshot !== renderDaemonArtifactPolicy()) {
  failures.push('bin/lib/artifactPolicy.mjs is not the current render — run `bun scripts/write-daemon-artifact-policy.ts` in the app repo.');
}

const { RUNTIME_EFFORTS } = await import(pathToFileURL(join(shared, 'agent-runner.schema.ts')).href);
const { RUNTIMES } = await import(pathToFileURL(join(cliRoot, 'bin/lib/runtimes.mjs')).href);
for (const id of new Set([...Object.keys(RUNTIME_EFFORTS), ...Object.keys(RUNTIMES)])) {
  const server = JSON.stringify(RUNTIME_EFFORTS[id] ?? null);
  const daemon = JSON.stringify(RUNTIMES[id]?.efforts ?? null);
  if (server !== daemon) failures.push(`RUNTIMES.${id}.efforts is ${daemon}; the server's RUNTIME_EFFORTS.${id} is ${server}.`);
}

const { TASK_KINDS } = await import(pathToFileURL(join(shared, 'taskKind.ts')).href);
const { AGENT_TASK_KINDS } = await import(pathToFileURL(join(cliRoot, 'bin/lib/agentTaskKinds.mjs')).href);
if (JSON.stringify([...TASK_KINDS]) !== JSON.stringify(Object.keys(AGENT_TASK_KINDS))) {
  failures.push(`AGENT_TASK_KINDS is ${JSON.stringify(Object.keys(AGENT_TASK_KINDS))}; the server's TASK_KINDS is ${JSON.stringify([...TASK_KINDS])}.`);
}

const { LIBRARY_KINDS } = await import(pathToFileURL(join(shared, 'libraryKinds.ts')).href);
const { LIBRARY_KINDS: DAEMON_LIBRARY_KINDS } = await import(pathToFileURL(join(cliRoot, 'bin/lib/knowledgeLibrary.mjs')).href);
const folders = (table) => Object.fromEntries(Object.entries(table).map(([k, v]) => [k, { dir: v.dir, bundle: v.bundle }]));
const serverFolders = folders(LIBRARY_KINDS);
const daemonFolders = folders(DAEMON_LIBRARY_KINDS);
if (JSON.stringify(serverFolders) !== JSON.stringify(daemonFolders)) {
  failures.push(`the daemon's LIBRARY_KINDS folders are ${JSON.stringify(daemonFolders)}; the server's LIBRARY_KINDS are ${JSON.stringify(serverFolders)}.`);
}

const serverWire = await import(pathToFileURL(join(shared, 'agent-runner.schema.ts')).href);
const daemonThread = await import(pathToFileURL(join(cliRoot, 'bin/lib/cardThread.mjs')).href);
for (const name of ['CARD_THREAD_BUDGET', 'CARD_THREAD_WHO_MAX', 'CARD_THREAD_AT_MAX']) {
  const server = JSON.stringify(serverWire[name] ?? null);
  const daemon = JSON.stringify(daemonThread[name] ?? null);
  if (server !== daemon) failures.push(`bin/lib/cardThread.mjs ${name} is ${daemon}; the server's is ${server}.`);
}

const serverTypes = await import(pathToFileURL(join(shared, 'taskType.ts')).href);
const { AGENT_TASK_TYPES } = await import(pathToFileURL(join(cliRoot, 'bin/lib/agentTaskTypes.mjs')).href);
const typeRows = (ids, kindOf, labelOf) => ids.map((id) => [id, kindOf(id), labelOf(id)]);
const serverTypeRows = typeRows([...serverTypes.TASK_TYPES], (t) => serverTypes.TASK_TYPE_KIND[t], (t) => serverTypes.TASK_TYPE_LABEL[t]);
const daemonTypeRows = typeRows(Object.keys(AGENT_TASK_TYPES), (t) => AGENT_TASK_TYPES[t].kind, (t) => AGENT_TASK_TYPES[t].label);
if (JSON.stringify(serverTypeRows) !== JSON.stringify(daemonTypeRows)) {
  failures.push(`AGENT_TASK_TYPES is ${JSON.stringify(daemonTypeRows)}; the server's TASK_TYPES (id, kind, label) are ${JSON.stringify(serverTypeRows)}.`);
}

// The intake prompt offers the app's exact type menu. A changed one-line
// meaning must be reviewed before the machine drafts cards under old words.
const { TASK_TYPE_WORDS } = await import(pathToFileURL(join(appDir, 'apps/web/src/task/taskTypes.ts')).href);
const { INTAKE_TASK_TYPE_MEANINGS } = await import(pathToFileURL(join(cliRoot, 'bin/lib/prompts.mjs')).href);
const serverIntakeTypes = [...serverTypes.TASK_TYPES].map((id) => [id, TASK_TYPE_WORDS[id].sub]);
const daemonIntakeTypes = Object.entries(INTAKE_TASK_TYPE_MEANINGS);
if (JSON.stringify(serverIntakeTypes) !== JSON.stringify(daemonIntakeTypes)) {
  failures.push(`INTAKE_TASK_TYPE_MEANINGS is ${JSON.stringify(daemonIntakeTypes)}; the app's task type meanings are ${JSON.stringify(serverIntakeTypes)}.`);
}

// These are the daemon's only intake wire names. The app's committed handout
// names the roster key and both lease routes; a rename must change both ends.
const {
  INTAKE_ROSTER_KEY, INTAKE_CLAIM_ENDPOINT, INTAKE_DONE_ENDPOINT,
  INTAKE_JOB_FIELDS, INTAKE_DONE_FIELDS, INTAKE_OUTCOMES,
} = await import(pathToFileURL(join(cliRoot, 'bin/lib/workIntake.mjs')).href);
const { INTAKE_DRAFT_FIELDS } = await import(pathToFileURL(join(cliRoot, 'bin/lib/intakeDraft.mjs')).href);
const { stripComments } = await import(pathToFileURL(join(appDir, 'packages/shared/src/test/stripComments.ts')).href);
const rosterContract = readFileSync(join(shared, 'agent-runner.schema.ts'), 'utf8');
const intakeContract = readFileSync(join(shared, 'intake.ts'), 'utf8');
if (!rosterContract.includes(`${INTAKE_ROSTER_KEY}?: IntakeJob[]`)) failures.push(`the app roster does not declare ${INTAKE_ROSTER_KEY}: IntakeJob[].`);
for (const name of [INTAKE_CLAIM_ENDPOINT, INTAKE_DONE_ENDPOINT]) {
  if (!rosterContract.includes(`POST /fleet/${name}`) || !intakeContract.includes(`POST /fleet/${name}`)) {
    failures.push(`the app intake contract does not name POST /fleet/${name}.`);
  }
}
const intakeShape = stripComments(intakeContract, 'intake.ts');
function interfaceFields(name) {
  const start = `export interface ${name} {`;
  const at = intakeShape.indexOf(start);
  const end = at < 0 ? -1 : intakeShape.indexOf('\n}', at + start.length);
  if (at < 0 || end < 0) {
    failures.push(`the app intake contract has no complete ${name} interface.`);
    return [];
  }
  // TypeScript's printer uses four spaces for an interface's direct fields;
  // the recurrenceOf object's taskId/title are nested wire names below it.
  return [...intakeShape.slice(at + start.length, end).matchAll(/^ {4}(\w+)\??\s*:/gm)].map((m) => m[1]);
}
for (const [name, daemonFields] of [
  ['IntakeJob', INTAKE_JOB_FIELDS],
  ['IntakeDraft', INTAKE_DRAFT_FIELDS],
  ['IntakeDoneBody', INTAKE_DONE_FIELDS],
]) {
  const appFields = interfaceFields(name);
  if (JSON.stringify(appFields) !== JSON.stringify(daemonFields)) {
    failures.push(`${name} fields are ${JSON.stringify(daemonFields)} in the daemon; the app's are ${JSON.stringify(appFields)}.`);
  }
}
const outcomeLine = intakeShape.match(/^ {4}outcome: ([^;]+);$/m)?.[1];
const appOutcomes = outcomeLine ? [...outcomeLine.matchAll(/"([^"]+)"/g)].map((m) => m[1]) : [];
if (JSON.stringify(appOutcomes) !== JSON.stringify(Object.values(INTAKE_OUTCOMES))) {
  failures.push(`the daemon's intake outcomes are ${JSON.stringify(Object.values(INTAKE_OUTCOMES))}; the app's are ${JSON.stringify(appOutcomes)}.`);
}

const serverLimits = await import(pathToFileURL(join(shared, 'runtimeLimits.ts')).href).catch(() => ({}));
const daemonLimits = await import(pathToFileURL(join(cliRoot, 'bin/lib/runtimeLimits.mjs')).href);
for (const name of ['RUNTIME_LIMITS_PARAM_MAX', 'RUNTIME_LIMIT_WINDOWS_MAX', 'RUNTIME_LIMIT_ID_MAX', 'RUNTIME_LIMIT_PLAN_MAX']) {
  const server = JSON.stringify(serverLimits[name] ?? null);
  const daemon = JSON.stringify(daemonLimits[name] ?? null);
  if (server !== daemon) failures.push(`bin/lib/runtimeLimits.mjs ${name} is ${daemon}; the server's is ${server}.`);
}

const serverCaps = await import(pathToFileURL(join(shared, 'fieldCaps.ts')).href);
const daemonFiles = await import(pathToFileURL(join(cliRoot, 'bin/lib/agentFiles.mjs')).href);
for (const name of ['AGENT_FILES_PER_MESSAGE_MAX', 'CARD_FILES_PER_TURN_MAX']) {
  const server = JSON.stringify(serverCaps[name] ?? null);
  const daemon = JSON.stringify(daemonFiles[name] ?? null);
  if (server !== daemon) failures.push(`bin/lib/agentFiles.mjs ${name} is ${daemon}; the server's is ${server}.`);
}

const daemonAttachments = await import(pathToFileURL(join(cliRoot, 'bin/lib/workAttachments.mjs')).href);
{
  const server = JSON.stringify(serverCaps.ATTACHMENT_MAX_BYTES ?? null);
  const daemon = JSON.stringify(daemonAttachments.ATTACHMENT_MAX_BYTES ?? null);
  if (server !== daemon) failures.push(`bin/lib/workAttachments.mjs ATTACHMENT_MAX_BYTES is ${daemon}; the server's is ${server}.`);
}

const serverTurnModel = await import(pathToFileURL(join(shared, 'turnModel.ts')).href).catch(() => ({}));
const daemonTurnModel = await import(pathToFileURL(join(cliRoot, 'bin/lib/turnModel.mjs')).href);
{
  const server = JSON.stringify([serverTurnModel.TURN_MODEL_MAX ?? null, serverTurnModel.TURN_MODEL_RE?.source ?? null]);
  const daemon = JSON.stringify([daemonTurnModel.TURN_MODEL_MAX ?? null, daemonTurnModel.TURN_MODEL_RE?.source ?? null]);
  if (server !== daemon) failures.push(`bin/lib/turnModel.mjs TURN_MODEL_MAX/TURN_MODEL_RE are ${daemon}; the server's are ${server}.`);
}

// 13. Which CLIs run each non-code kind: the server's set and default, the
// daemon's declarations. Code runs anywhere (null), declared by build. An app
// with no set (older than 0.115.0's) is a failure, never a skip.
{
  const { KIND_RUNTIMES } = await import(pathToFileURL(join(shared, 'taskKind.ts')).href);
  if (!KIND_RUNTIMES) failures.push("the server's taskKind.ts exports no KIND_RUNTIMES (the CLIs each kind runs on).");
  for (const kind of KIND_RUNTIMES ? [...TASK_KINDS] : []) {
    const row = KIND_RUNTIMES[kind];
    const posture = AGENT_TASK_KINDS[kind]?.posture;
    if (!row || row.runs === null || !posture) continue;
    const declared = Object.keys(RUNTIMES).filter((id) => (RUNTIMES[id].profiles ?? []).includes(posture)).sort();
    const want = [...row.runs].sort();
    if (JSON.stringify(declared) !== JSON.stringify(want)) {
      failures.push(`a ${kind} card's posture '${posture}' is declared by ${JSON.stringify(declared)} here; the server runs it on ${JSON.stringify(want)} (KIND_RUNTIMES).`);
    }
    if (!declared.includes(row.default)) {
      failures.push(`a ${kind} card defaults to ${JSON.stringify(row.default)} on the server, which does not declare its posture '${posture}' here.`);
    }
  }
}

// 14. Every extension the server keeps a library item under, the daemon's
// path rule accepts.
{
  const { ARTIFACT_TYPES } = await import(pathToFileURL(join(shared, 'artifact.schema.ts')).href);
  for (const [kind, row] of Object.entries(LIBRARY_KINDS)) {
    const mimes = row.mimes ?? [row.mime];
    const exts = Object.entries(ARTIFACT_TYPES).filter(([, t]) => mimes.includes(t.mime)).map(([ext]) => `.${ext}`);
    const accepted = DAEMON_LIBRARY_KINDS[kind]?.ext ?? [];
    const missing = exts.filter((e) => !accepted.includes(e));
    if (missing.length) {
      failures.push(`the daemon's LIBRARY_KINDS.${kind}.ext lacks ${JSON.stringify(missing)}, which the server keeps ${kind} items under.`);
    }
  }
}

if (failures.length) {
  for (const f of failures) console.error(`check-app-parity: ${f}`);
  process.exit(1);
}
console.log(`check-app-parity: artifact policy, effort ladders, card kinds, library folders, card-thread bounds, card types, intake types/wire, plan-limit bounds, agent-file caps, the chat-file ceiling, the turn model's shape, each kind's CLI and the library's file types match ${appDir}`);
