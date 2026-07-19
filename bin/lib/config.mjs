/** Parsed configuration: env vars, CLI flags, and the chosen credentials. */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const VERSION = '0.26.0';

// The model EVERY daemon Claude turn runs on — pinned so autonomous work never
// inherits your interactive `~/.claude/settings.json` default. That matters: a
// default of `opus[1m]` puts big prompts (wiki-gen over a whole repo, >200K
// tokens) onto the 1M long-context premium tier, which a Max plan does NOT cover
// — the turn dies with "usage credits required for this model". Standard `opus`
// is fully covered. Override with FLOWVIANT_MODEL (e.g. `sonnet` for cheaper/faster).
export const MODEL = process.env.FLOWVIANT_MODEL || 'opus';

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
// Push channel: the daemon holds this WebSocket open and the server nudges it
// the instant a job lands, so dispatch is ~a round-trip instead of a full poll.
// Derived from FLEET_URL (…/fleet/agents → …/fleet/stream, http→ws) unless set.
export const STREAM_URL =
  process.env.FLOWVIANT_STREAM_URL ||
  FLEET_URL.replace(/\/agents(\/?)$/, '/stream$1').replace(/^http/, 'ws');
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
// Self-update: a running daemon updates itself to the latest published version
// (at startup + when idle) and re-execs. On by default; FLOWVIANT_NO_UPDATE=1
// keeps it nag-only (it still tells you to update, never installs). Below the
// server's MIN version it updates regardless, since live mode won't work.
export const AUTO_UPDATE = process.env.FLOWVIANT_NO_UPDATE !== '1';
// Live mode (DEFAULT since 0.8.0): persistent Agent-SDK session per task —
// streams into the task channel, injectable mid-task, blocker-parks in place,
// delivery card on complete, branch preview tunnels. The legacy poll/sentinel
// path (one-shot `claude -p` turns) survives behind FLOWVIANT_POLL=1 as the
// escape hatch; FLOWVIANT_LIVE=1 is still honored for old scripts.
export const LIVE = process.env.FLOWVIANT_POLL !== '1';
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
