/**
 * A FENCED CLAUDE TURN TAKES ITS PERMISSIONS AND HOOKS FROM FLOWVIANT ALONE
 * (2026-09-29, the owner, asked whether an agent's fence should ignore the
 * person's own permission settings: "yes, the agent's fence can ignore").
 *
 * A 3D-model agent under the design posture, whose whole shell is
 * `Bash(ls:*)`, ran `google-chrome` and Playwright scripts. Every fenced lane
 * read the person's `~/.claude/settings.json` — an agent turn through
 * `--setting-sources user`, the pre-review, planner, intake, wiki and capture
 * chat by naming no source at all, which ALSO reads the cwd's
 * `.claude/settings*.json`, and the pre-review's cwd is the agent's own
 * worktree. A settings file is a second author of the posture. MEASURED on
 * Claude Code 2.1.284 — see claudePersonal.test.mjs for the probes and the
 * offline check that pins them on the real CLI. In short: a personal
 * `permissions.allow` rule admitted a command the list refused, a personal
 * `defaultMode: "bypassPermissions"` turned the fenced turn into a bypass, and
 * personal and worktree hooks fired; under `--setting-sources ''` none of them
 * loaded, and the turn ran on the same login.
 *
 * AN EMPTY SOURCE LIST DROPS THE WHOLE USER SOURCE, not only its permissions:
 * `~/.claude/CLAUDE.md`, personal skills and subagents went too (measured),
 * and with the file go the plugins it enables. No flag keeps half of it — a
 * flag setting's allow rules only add to the person's. On a fenced lane that
 * is the right loss: the posture and the contract are Flowviant's, the base
 * branch's instructions and skills arrive through the prompt and the reviewed
 * plugin (`--plugin-dir` still loads, measured), and a personal plugin brings
 * hooks of its own. Codex's fenced postures are hermetic the same way
 * (`--ignore-user-config`, runtimeCodex.mjs).
 *
 * WHAT IS KEPT is what makes the CLI the person's CLI, never what it may do:
 * how it signs in and reaches its provider, how a model the turn does not pin
 * runs, and how long the person's own store is kept. An ALLOWLIST, so a key a
 * later CLI adds — a sandbox auto-allow, a permission mode — never rides by
 * default. It rides INSIDE the posture's own `--settings`, because the CLI
 * reads one: given two, only the last one's hook fired (measured).
 */
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { MACHINE_CREDENTIAL_ENV } from './machineEnv.mjs';
import { WINDOW_ENV_REMOVED, withoutWindows } from './noWindowEnv.mjs';

/** The flag pair that loads no settings file — user, project or local.
 *  Managed (policy) settings and `--settings` still apply. */
export const NO_SETTING_SOURCES = Object.freeze(['--setting-sources', '']);

/**
 * The personal settings a fenced turn keeps, by key.
 *
 *  · THE LOGIN — the helpers the CLI runs to authenticate and where it signs
 *    in, and `env`, where a login routes (ANTHROPIC_BASE_URL,
 *    CLAUDE_CODE_USE_BEDROCK, AWS_PROFILE). `env` gives the person's file no
 *    more reach than the operator's shell, which every turn inherits already;
 *    what a turn's environment promises is still removed from it
 *    (`keptEnv`).
 *  · HOW AN UNPINNED MODEL RUNS ("Machine default uses the CLI's own
 *    setting"): per-model effort, thinking, the model map a provider needs.
 *    `model` itself is not here: every Claude turn names `--model`, the
 *    daemon's pin when the card has none (config.mjs), so the person's
 *    default model never reached a daemon turn before either.
 *  · THE PERSON'S OWN STORE: how long transcripts live and whether memory is
 *    kept, so a fenced turn's start never prunes or writes on a default the
 *    person turned off.
 */
export const PERSONAL_KEPT = Object.freeze([
  'apiKeyHelper',
  'proxyAuthHelper',
  'awsAuthRefresh',
  'awsCredentialExport',
  'gcpAuthRefresh',
  'forceLoginMethod',
  'forceLoginOrgUUID',
  'forceLoginGatewayUrl',
  'env',
  'modelOverrides',
  'modelSettings',
  'effortLevel',
  'maxEffortLevel',
  'alwaysThinkingEnabled',
  'fallbackModel',
  'cleanupPeriodDays',
  'autoMemoryEnabled',
]);

/** What a turn nobody is sitting at has set or removed (noWindowEnv.mjs) and
 *  the machine credential (machineEnv.mjs): never put back by a settings file. */
const TURN_OWNED_ENV = new Set([
  ...MACHINE_CREDENTIAL_ENV,
  ...WINDOW_ENV_REMOVED,
  ...Object.keys(withoutWindows({}, '/')),
]);
function keptEnv(env) {
  if (!env || typeof env !== 'object' || Array.isArray(env)) return null;
  const out = {};
  for (const [k, v] of Object.entries(env)) if (typeof v === 'string' && !TURN_OWNED_ENV.has(k)) out[k] = v;
  return Object.keys(out).length ? out : null;
}

/** Far past any real settings file; a bigger one is not read. */
const SETTINGS_MAX_BYTES = 1024 * 1024;

/**
 * The person's user settings file — `$CLAUDE_CONFIG_DIR/settings.json`, else
 * `~/.claude/settings.json`, where the CLI itself looks — reduced to
 * PERSONAL_KEPT. `{}` when it is absent, unreadable or not a JSON object: the
 * turn then runs on the CLI's stored login and defaults, and the fence is the
 * same either way.
 */
export function personalClaudeSettings(env = process.env) {
  const dir = env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), '.claude');
  const path = join(dir, 'settings.json');
  let raw;
  try {
    if (statSync(path).size > SETTINGS_MAX_BYTES) return {};
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return {};
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const key of PERSONAL_KEPT) {
    if (!Object.hasOwn(raw, key) || raw[key] == null) continue;
    if (key !== 'env') out[key] = raw[key];
    else {
      const kept = keptEnv(raw.env);
      if (kept) out.env = kept;
    }
  }
  return out;
}

/**
 * `perm` with `kept` folded into its `--settings` — the posture's keys win, so
 * a kept key a posture ever names is the fence's word. A posture with no
 * `--settings` gets one before its lists (`--allowedTools` is variadic). With
 * nothing kept, `perm` is returned as it was.
 */
export function withPersonalSettings(perm, kept) {
  const personal = kept && typeof kept === 'object' && !Array.isArray(kept) ? kept : {};
  if (!Object.keys(personal).length) return [...perm];
  const at = perm.indexOf('--settings');
  if (at < 0) return ['--settings', JSON.stringify(personal), ...perm];
  const posture = JSON.parse(perm[at + 1]);
  return [...perm.slice(0, at), '--settings', JSON.stringify({ ...personal, ...posture }), ...perm.slice(at + 2)];
}
