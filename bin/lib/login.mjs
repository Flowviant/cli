/**
 * `flowviant login` — device-auth, like `gh auth login`. Removes the
 * paste-a-secret-into-your-shell friction: the daemon shows a short code, you
 * approve it in Flowviant (in a project), and the freshly-minted fleet
 * credential is stored locally at ~/.flowviant/credentials.json. After that,
 * plain `flowviant` just runs — no token, no env var.
 */

import { FLEET_URL, USER_AGENT, VERSION } from './config.mjs';
import { saveLogin, detectRepoRoot, projectLabel, safeName, listStoredProjects, boundElsewhere, directoryTakenRefusal } from './credentials.mjs';
import { c, info, ok, warn, fail } from './ui.mjs';
import { sleep } from './claude.mjs';
import { launchCommand, terminalCommand } from './launchCommand.mjs';

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

export async function runLogin({ thenStart = false, json = false, dir = process.cwd() } = {}) {
  const event = (value) => { if (json) process.stdout.write(`${JSON.stringify(value)}\n`); };
  const selectedRepo = json ? detectRepoRoot(dir) : null;
  if (json && !selectedRepo) { event({ event: 'error', message: `No git repository found in ${dir}.` }); return { saved: false }; }
  if (!json) console.log(`\n  ${c.bold(c.cyan('◣ flowviant'))}  ${c.dim(`login · v${VERSION}`)}\n`);
  let start;
  try {
    start = await post(DEVICE_START, {});
  } catch (e) {
    if (json) { event({ event: 'error', message: `couldn't reach Flowviant (${e.message}).` }); return { saved: false }; }
    fail(`couldn't reach Flowviant (${e.message}).`);
    process.exit(1);
  }
  const { deviceCode, userCode, intervalSeconds = 5, expiresInSeconds = 600 } = start;
  if (json && (typeof deviceCode !== 'string' || typeof userCode !== 'string' || userCode.length < 8)) {
    event({ event: 'error', message: 'Flowviant returned an invalid login code.' });
    return { saved: false };
  }
  const pretty = `${userCode.slice(0, 4)}-${userCode.slice(4)}`;
  // Where the control ACTUALLY is. It was "the Agents panel", a settings
  // section deleted 2026-08-17; connecting a machine is offered on the surface
  // you are on when it matters, and for a new operator that is the Workbench —
  // the project's empty state says so before it can show you any sessions.
  if (json) event({ event: 'open_url', url: APP_URL, code: pretty });
  else {
    console.log(`  1. Open ${c.cyan(APP_URL)} → your project → the ${c.bold('Workbench')} → ${c.bold('Connect a machine')}.`);
    console.log(`  2. Enter this code:   ${c.bold(c.green(pretty))}\n`);
    info('waiting for you to approve…');
  }

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
      if (json && (!poll.projectId || !(poll.machineToken ?? poll.fleetToken))) {
        event({ event: 'error', message: 'Flowviant did not return a project credential.' });
        return { saved: false };
      }
      // `machineToken` is the wire's new name; `fleetToken` is the one every
      // published daemon reads. The server dual-sends until DAEMON_MIN clears
      // the release that reads the new one (0.54.2+) — reading both here is
      // what makes retiring the old key possible at all.
      //
      // BOUND to the repo the login was run in: a login is the one moment we
      // know for certain which checkout this project means, and the binding is
      // what lets a multi-project VM resolve `npx flowviant` by DIRECTORY
      // instead of by whichever login happened last.
      const repoRoot = selectedRepo ?? detectRepoRoot(dir);
      const entry = {
        fleetToken: poll.machineToken ?? poll.fleetToken,
        projectId: poll.projectId,
        mcpUrl: poll.mcpUrl,
        name: safeName(poll.projectName),
        repoRoot,
      };
      // A DIRECTORY SERVES ONE PROJECT (2026-09-23). The owner, verbatim: "a
      // directory cannot have more than one project on flowviant. if one
      // already exists, it would warn the user and ask them to delete the
      // project on flowviant first. because 2 projects shouldnt be able to
      // edit a directory at the same time." And his earlier question — "im not
      // sure how it even allowed me to run npx flowviant login twice … on the
      // same repository" — was answered by the fact that login never looked.
      // It looks now, and REFUSES: the approval in the app minted or reused
      // the project's credential either way, and a credential nobody holds is
      // a row, not a machine. The refusal names both projects and the remedy
      // (`directoryTakenRefusal`, shared with the daemon's own start).
      const clash = boundElsewhere(listStoredProjects(), repoRoot, entry.projectId);
      if (clash.length > 0) {
        if (json) { event({ event: 'error', message: directoryTakenRefusal(clash, repoRoot, { incoming: entry }) }); return { saved: false }; }
        console.log('');
        warn(directoryTakenRefusal(clash, repoRoot, { incoming: entry }));
        console.log('');
        return { saved: false };
      }
      try { saveLogin(entry); }
      catch (e) {
        if (json) { event({ event: 'error', message: `Could not save this connection: ${e.message}` }); return { saved: false }; }
        throw e;
      }
      if (json) { event({ event: 'bound', projectId: entry.projectId, name: entry.name, dir: repoRoot }); return { saved: true }; }
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
          : `\n  Now run:  ${c.bold(launchCommand())}\n`
      );
      return { saved: true };
    }
    if (poll.status === 'expired') {
      if (json) { event({ event: 'error', message: 'Login code expired.' }); return { saved: false }; }
      warn(`that code expired — run \`${terminalCommand('login')}\` again.`);
      process.exit(1);
    }
  }
  if (json) { event({ event: 'error', message: 'Login timed out.' }); return { saved: false }; }
  warn(`login timed out — run \`${terminalCommand('login')}\` again.`);
  process.exit(1);
}
