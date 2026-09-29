/** Claude Code's own auth verdict for the local desktop contract.
 *
 * The credential file is only a context clue (claudeAuth.mjs): on some boxes
 * Claude stores a working login in a keychain. Only `claude auth status --json`
 * can say signed out. This probe never reads or relays a token. Its small disk
 * cache survives the short-lived `flowviant status` process polled by the tray.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { claudeAuthContext } from './claudeAuth.mjs';

const UNKNOWN = Object.freeze({ signedIn: null, billing: null, subscriptionType: null });
const TTL_MS = 90_000;
const SUBSCRIPTIONS = new Set(['pro', 'max', 'team', 'enterprise']);

export function parseClaudeAuthStatus(raw) {
  let value;
  try { value = JSON.parse(raw); } catch { return UNKNOWN; }
  if (!value || typeof value !== 'object' || typeof value.loggedIn !== 'boolean') return UNKNOWN;
  if (!value.loggedIn) return { signedIn: false, billing: null, subscriptionType: null };
  const method = typeof value.authMethod === 'string' ? value.authMethod.toLowerCase() : '';
  const subscription = typeof value.subscriptionType === 'string' && SUBSCRIPTIONS.has(value.subscriptionType.toLowerCase())
    ? value.subscriptionType.toLowerCase() : null;
  const api = /console|api.?key|bedrock|vertex|foundry/.test(method);
  const plan = !api && (/claude.?ai|subscription/.test(method) || subscription !== null);
  return { signedIn: true, billing: api ? 'api' : plan ? 'subscription' : null,
    subscriptionType: plan ? subscription : null };
}

export function readClaudeAuthStatus({ bin = 'claude', cachePath = join(homedir(), '.flowviant', 'claude-auth-status.json'),
  refresh = false, timeoutMs = 3_000, now = Date.now(), spawn = spawnSync, contextFor = claudeAuthContext } = {}) {
  if (!refresh) {
    try {
      const cached = JSON.parse(readFileSync(cachePath, 'utf8'));
      if (cached.bin === bin && Number.isFinite(cached.at) && now >= cached.at && now - cached.at < TTL_MS &&
          [true, false, null].includes(cached.result?.signedIn) &&
          [null, 'api', 'subscription'].includes(cached.result?.billing)) return cached.result;
    } catch { /* no cache, or unreadable cache: ask the CLI */ }
  }
  let result = UNKNOWN;
  try {
    const child = spawn(bin, ['auth', 'status', '--json'], {
      encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (!child.error && (child.status === 0 || child.status === 1)) result = parseClaudeAuthStatus(child.stdout);
    if (result.signedIn === true && result.billing === 'subscription' && result.subscriptionType === null) {
      const context = contextFor();
      if (context.source === 'file' && SUBSCRIPTIONS.has(context.subscriptionType)) {
        result = { ...result, subscriptionType: context.subscriptionType };
      }
    }
  } catch { /* A failed probe means unknown, not signed out. */ }
  try {
    mkdirSync(dirname(cachePath), { recursive: true, mode: 0o700 });
    writeFileSync(cachePath, JSON.stringify({ bin, at: now, result }), { mode: 0o600 });
  } catch { /* Caching is optional; never break status. */ }
  return result;
}
