/**
 * `flowviant mcp` — connect YOUR Claude to Flowviant so you can file work from
 * the terminal ("stick that on the board", "file a task for this TODO").
 *
 * This mints a `cli` credential, which is a different principal from the
 * per-session `work` tokens the daemon mints for Workbench tabs. That
 * separation is the point, not bookkeeping: a session's agent reads untrusted
 * repo and issue text all day, so giving THAT principal tools that write to
 * your workspace would mean a hostile string in a README could file work as
 * you. The cli credential sees only the management tools and can never work or
 * ship a card; a session token can never reach create_task.
 *
 * There is deliberately no invite capability on it. Invites grant access to a
 * paid workspace and are guarded by a human browser session — they are sent
 * from the workspace card's gear menu in the app, and never from a CLI
 * credential sitting on a shared machine.
 */

import { FLEET_TOKEN, USER_AGENT, MCP_URL, FLEET_URL } from './config.mjs';

const CLI_TOKEN_URL = FLEET_URL.replace(/\/agents\/?$/, '/cli-token');

export async function runMcpCommand(args = []) {
  if (!FLEET_TOKEN) {
    console.error(
      'error: no credential resolves here. Run `flowviant login` first — or, with\n' +
        'several projects connected on this box, run this inside the project\'s own\n' +
        'repo or pass `--project <name|id>` (`flowviant projects` lists them).'
    );
    process.exit(1);
  }

  let res;
  try {
    res = await fetch(CLI_TOKEN_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${FLEET_TOKEN}`,
        'content-type': 'application/json',
        'user-agent': USER_AGENT,
      },
    });
  } catch (err) {
    console.error(`error: could not reach Flowviant (${err?.message || err})`);
    process.exit(1);
  }

  if (!res.ok) {
    console.error(
      `error: could not mint a CLI credential (${res.status}). ` +
        (res.status === 401 || res.status === 403
          ? 'Your credential may have been revoked — try `flowviant login` again.'
          : 'Try again in a moment.')
    );
    process.exit(1);
  }

  const body = await res.json().catch(() => null);
  const token = body?.data?.token;
  if (!token) {
    console.error('error: Flowviant returned no token. Try again.');
    process.exit(1);
  }

  const cmd =
    `claude mcp add --transport http flowviant ${MCP_URL} ` +
    `--header "Authorization: Bearer ${token}"`;

  // --print for piping into a shell; otherwise explain what this does, since
  // pasting a credential into a command deserves a sentence of context.
  if (args.includes('--print')) {
    console.log(cmd);
    return;
  }

  console.log('');
  console.log('Run this to connect your Claude to Flowviant:');
  console.log('');
  console.log(`  ${cmd}`);
  console.log('');
  console.log('Then, in any Claude session: "file a task in Flowviant for …".');
  console.log('Tasks land as drafts on the board — nothing runs until you open');
  console.log('a session tab in the Workbench and type in it.');
  console.log('');
}
