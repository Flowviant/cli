/**
 * `flowviant login` — device-auth, like `gh auth login`. Removes the
 * paste-a-secret-into-your-shell friction: the daemon shows a short code, you
 * approve it in Flowviant (in a project), and the freshly-minted fleet
 * credential is stored locally at ~/.flowviant/credentials.json. After that,
 * plain `flowviant` just runs — no token, no env var.
 */

import { FLEET_URL, USER_AGENT, VERSION } from './config.mjs';
import { saveLogin, detectRepoRoot, projectLabel, listStoredProjects, boundElsewhere } from './credentials.mjs';
import { c, info, ok, warn, fail } from './ui.mjs';
import { sleep } from './claude.mjs';

const DEVICE_START = FLEET_URL.replace(/\/agents\/?$/, '/device/start');
const DEVICE_POLL = FLEET_URL.replace(/\/agents\/?$/, '/device/poll');
const APP_URL = process.env.FLOWVIANT_APP_URL || 'https://app.flowviant.com';

async function post(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(30_000),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  return j.data ?? j;
}

/**
 * THE THREE ANSWERS to "this repo is already connected to another project",
 * as menu rows — pure, so the wording is provable. Each row says its whole
 * consequence, the same rule the `machines` menu keeps: a verb whose outcome
 * lives in a manual is one you have to be sure about before you can use it.
 *
 *  keep     both stay; `npx flowviant` in this repo asks which to serve.
 *  replace  this repo serves the NEW project; this box is disconnected from
 *           the old one (its daemon here stopped, its row left in the app,
 *           its credential forgotten here) — the whole disconnect, because a
 *           half of it leaves a daemon running on a credential the store no
 *           longer names.
 *  cancel   nothing is saved. The approval in the app minted or reused the
 *           project's credential either way; a credential nobody holds is a
 *           row, not a machine.
 */
export function secondProjectOptions(clash, entry, repoRoot) {
  const olds = clash.map(projectLabel).join(' and ');
  const now = projectLabel(entry);
  return [
    `keep both — every \`npx flowviant\` in ${repoRoot} asks whether to serve ${olds} or ${now}`,
    `replace — ${repoRoot} serves ${now} from now on; this box is disconnected from ${olds} (its daemon here stopped, its credential forgotten here)`,
    `cancel — save nothing; ${repoRoot} stays connected to ${olds}`,
  ];
}

const DECISIONS = ['keep', 'replace', 'cancel'];

/** Ask, on whatever this terminal can draw. No terminal to ask on: KEEP, and
 *  say so — a headless login must not hang, and refusing would strand a
 *  runner that had just been approved in the app. */
async function secondProjectDecision({ clash, entry, repoRoot }) {
  const { canPrompt, menuSupported, selectMenu, askWithTimeout } = await import('./tty.mjs');
  const olds = clash.map(projectLabel).join(' and ');
  console.log('');
  warn(`${repoRoot} is already connected to ${olds} on this box.`);
  if (!canPrompt()) {
    console.log(`  keeping both — every \`npx flowviant\` there will ask which to serve; \`flowviant machines\` removes one.\n`);
    return 'keep';
  }
  const options = secondProjectOptions(clash, entry, repoRoot);
  if (menuSupported()) {
    const res = await selectMenu({ options });
    if (res.cancelled) return 'cancel';
    if (!res.unsupported) return DECISIONS[res.index];
  }
  console.log(options.map((o, i) => `  ${i + 1}. ${o}`).join('\n'));
  const raw = await askWithTimeout('  Which? [1-3] ');
  const n = Number.parseInt(raw ?? '', 10);
  return DECISIONS[n - 1] ?? 'cancel';
}

export async function runLogin({ thenStart = false } = {}) {
  console.log(`\n  ${c.bold(c.cyan('◣ flowviant'))}  ${c.dim(`login · v${VERSION}`)}\n`);
  let start;
  try {
    start = await post(DEVICE_START, {});
  } catch (e) {
    fail(`couldn't reach Flowviant (${e.message}).`);
    process.exit(1);
  }
  const { deviceCode, userCode, intervalSeconds = 5, expiresInSeconds = 600 } = start;
  const pretty = `${userCode.slice(0, 4)}-${userCode.slice(4)}`;
  // Where the control ACTUALLY is. It was "the Agents panel", a settings
  // section deleted 2026-08-17; connecting a machine is offered on the surface
  // you are on when it matters, and for a new operator that is the Workbench —
  // the project's empty state says so before it can show you any sessions.
  console.log(`  1. Open ${c.cyan(APP_URL)} → your project → the ${c.bold('Workbench')} → ${c.bold('Connect a machine')}.`);
  console.log(`  2. Enter this code:   ${c.bold(c.green(pretty))}\n`);
  info('waiting for you to approve…');

  const deadline = Date.now() + expiresInSeconds * 1000;
  while (Date.now() < deadline) {
    await sleep(intervalSeconds);
    let poll;
    try {
      poll = await post(DEVICE_POLL, { deviceCode });
    } catch {
      continue; // transient — keep polling
    }
    if (poll.status === 'approved') {
      // `machineToken` is the wire's new name; `fleetToken` is the one every
      // published daemon reads. The server dual-sends until DAEMON_MIN clears
      // the release that reads the new one (0.54.2+) — reading both here is
      // what makes retiring the old key possible at all.
      //
      // BOUND to the repo the login was run in: a login is the one moment we
      // know for certain which checkout this project means, and the binding is
      // what lets a multi-project VM resolve `npx flowviant` by DIRECTORY
      // instead of by whichever login happened last.
      const repoRoot = detectRepoRoot();
      const entry = {
        fleetToken: poll.machineToken ?? poll.fleetToken,
        projectId: poll.projectId,
        mcpUrl: poll.mcpUrl,
        name: typeof poll.projectName === 'string' && poll.projectName ? poll.projectName : null,
        repoRoot,
      };
      // A SECOND PROJECT ON A REPO IS A QUESTION, NEVER A SILENT SAVE
      // (2026-09-23). The owner: "im not sure how it even allowed me to run
      // npx flowviant login twice and init a daemon twice on the same
      // project/repository/directory in the first place." It allowed it
      // because it never looked: the approval names a project, this repo was
      // already bound to a different one, and both landed in the store — after
      // which every start here was a picker between two rows that read alike.
      // Asked while the person is still at the terminal; headless, the save
      // goes ahead and the fact is printed, because a CI runner cannot answer
      // and a login that silently refused would be worse than one that said.
      const clash = boundElsewhere(listStoredProjects(), repoRoot, entry.projectId);
      if (clash.length > 0) {
        const decision = await secondProjectDecision({ clash, entry, repoRoot });
        if (decision === 'cancel') {
          console.log(`\n  nothing saved — ${repoRoot} stays connected to ${clash.map(projectLabel).join(' and ')}.\n`);
          return { saved: false };
        }
        if (decision === 'replace') {
          const { disconnectHere, realDisconnectDeps, leaveUrlFrom } = await import('./machines.mjs');
          const deps = await realDisconnectDeps({ url: leaveUrlFrom(FLEET_URL), log: (m) => console.log(`  ${m}`) });
          for (const old of clash) await disconnectHere(old, deps, { log: (m) => console.log(`  ${m}`) });
        }
      }
      saveLogin(entry);
      ok(
        `connected to ${c.bold(projectLabel(entry))}` +
          `${repoRoot ? ` for ${c.dim(repoRoot)}` : ''} — saved to ~/.flowviant/credentials.json`
      );
      // The daemon starts right here unless the caller opted out; telling
      // someone to run a second command was the step that got missed, since by
      // this point they are looking at the browser, not this terminal.
      console.log(
        thenStart
          ? `\n  ${c.dim('starting your agent — leave this running')}\n`
          : `\n  Now run:  ${c.bold('npx flowviant')}\n`
      );
      return { saved: true };
    }
    if (poll.status === 'expired') {
      warn('that code expired — run `flowviant login` again.');
      process.exit(1);
    }
  }
  warn('login timed out — run `flowviant login` again.');
  process.exit(1);
}
