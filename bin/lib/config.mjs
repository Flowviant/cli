/** Parsed configuration: env vars, CLI flags, and the chosen credentials. */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const VERSION = '0.7.0';

// Credential stored by `flowviant login` (device auth) — the no-token,
// no-env-var path. An explicit --fleet flag or FLOWVIANT_FLEET env still wins.
function readStoredCredential() {
  try {
    return JSON.parse(readFileSync(join(homedir(), '.flowviant', 'credentials.json'), 'utf8'));
  } catch {
    return null;
  }
}
const stored = readStoredCredential();

function argFlag(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const API_BASE = process.env.FLOWVIANT_API_URL || 'https://api.flowviant.com/api/v2';
export const MCP_URL = process.env.FLOWVIANT_MCP_URL || `${API_BASE}/mcp`;
export const FLEET_URL = process.env.FLOWVIANT_FLEET_URL || `${API_BASE}/fleet/agents`;
export const POLL_SECONDS = Number(process.env.POLL_SECONDS || 20);
export const IDLE_SECONDS = Number(process.env.IDLE_SECONDS || 30);
// Live mode: after this long idle-parked on a blocker, tear the session down to
// free the Claude process (the intent stays claimed; it resumes when answered).
export const PARK_TIMEOUT_SECONDS = Number(process.env.PARK_TIMEOUT_SECONDS || 900);
export const RECONCILE_SECONDS = Number(process.env.RECONCILE_SECONDS || 10);
// Proactively refresh a worker token this many seconds before its lease lapses,
// so a long-lived daemon never silently 401s on an expired token.
export const REFRESH_BEFORE_SECONDS = Number(process.env.REFRESH_BEFORE_SECONDS || 3600);
export const SAFE = process.env.FLOWVIANT_SAFE === '1';
// Opt-in phase-2 live mode: persistent Agent-SDK session per task (streams into
// the task channel, injectable, blocker-parks in place) instead of one-shot
// `claude -p` turns. Off = the proven poll/sentinel path, untouched.
export const LIVE = process.env.FLOWVIANT_LIVE === '1';
// Sent on the daemon's own HTTP calls so Cloudflare Bot Fight Mode doesn't 403
// them (Node's default UA is treated as a bot). Claude Code sends its own UA.
export const USER_AGENT = `flowviant/${VERSION}`;

// One of: a fleet credential (recommended), one worker token, or a comma list.
export const FLEET_TOKEN =
  argFlag('--fleet') || process.env.FLOWVIANT_FLEET || stored?.fleetToken || '';
const rawTokens =
  argFlag('--tokens') ||
  process.env.FLOWVIANT_TOKENS ||
  argFlag('--token') ||
  process.env.FLOWVIANT_TOKEN ||
  '';
export const tokens = rawTokens.split(',').map((t) => t.trim()).filter(Boolean);
