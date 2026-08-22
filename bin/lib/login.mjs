/**
 * `flowviant login` — device-auth, like `gh auth login`. Removes the
 * paste-a-secret-into-your-shell friction: the daemon shows a short code, you
 * approve it in Flowviant (in a project), and the freshly-minted fleet
 * credential is stored locally at ~/.flowviant/credentials.json. After that,
 * plain `flowviant` just runs — no token, no env var.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { FLEET_URL, USER_AGENT, VERSION } from './config.mjs';
import { c, info, ok, warn, fail } from './ui.mjs';
import { sleep } from './claude.mjs';

const CRED_DIR = join(homedir(), '.flowviant');
const CRED_FILE = join(CRED_DIR, 'credentials.json');
const DEVICE_START = FLEET_URL.replace(/\/agents\/?$/, '/device/start');
const DEVICE_POLL = FLEET_URL.replace(/\/agents\/?$/, '/device/poll');
const APP_URL = process.env.FLOWVIANT_APP_URL || 'https://app.flowviant.com';

/** The locally-stored credential from a prior `login`, or null. Read by config. */
export function readStoredCredential() {
  try {
    return JSON.parse(readFileSync(CRED_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function store(cred) {
  mkdirSync(CRED_DIR, { recursive: true });
  writeFileSync(CRED_FILE, JSON.stringify(cred, null, 2), { mode: 0o600 });
}

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
      store({ fleetToken: poll.fleetToken, projectId: poll.projectId, mcpUrl: poll.mcpUrl });
      ok('connected — credential saved to ~/.flowviant/credentials.json');
      // The daemon starts right here unless the caller opted out; telling
      // someone to run a second command was the step that got missed, since by
      // this point they are looking at the browser, not this terminal.
      console.log(
        thenStart
          ? `\n  ${c.dim('starting your agent — leave this running')}\n`
          : `\n  Now run:  ${c.bold('npx flowviant')}\n`
      );
      return;
    }
    if (poll.status === 'expired') {
      warn('that code expired — run `flowviant login` again.');
      process.exit(1);
    }
  }
  warn('login timed out — run `flowviant login` again.');
  process.exit(1);
}
