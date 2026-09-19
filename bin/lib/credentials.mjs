/**
 * THE CREDENTIAL STORE — one file, MANY projects (v2, 2026-08-23).
 *
 * ~/.flowviant/credentials.json used to hold exactly one credential, and
 * `flowviant login` overwrote it — so `npx flowviant` in ANY directory served
 * whatever project was logged into last. A user standing in their calendar
 * repo watched the banner say another project's name, and the only thing that
 * saved them from serving the wrong repo was the instance lock's same-repo
 * refusal. One VM is allowed to run one daemon per project (the lock is keyed
 * per credential and the header of instance.mjs says so out loud); the store
 * was the only thing pretending otherwise.
 *
 * THE FILE SHAPE, and why it is two shapes at once:
 *
 *   {
 *     fleetToken, projectId, mcpUrl,          // the LEGACY MIRROR
 *     projects: {                             // v2: every connected project
 *       [projectId]: { fleetToken, mcpUrl, name, repoRoot, savedAt }
 *     }
 *   }
 *
 * The top-level trio is what every daemon before 0.55.0 reads, and the CLI is
 * the one component a deploy cannot upgrade — so it stays, always mirroring
 * the ACTIVE (most recently logged-in or explicitly picked) project. An old
 * version keeps working with that project; a new one resolves by REPO.
 *
 * WHICH CREDENTIAL A START USES — resolution, in order:
 *   --fleet / FLOWVIANT_FLEET     the operator said, verbatim (config.mjs).
 *   --project <name|id>           an entry, named without a prompt.
 *   the entry BOUND to this repo  repoRoot recorded at login/confirm, compared
 *                                 by realpath — the no-ambiguity path.
 *   one unbound entry             served, with a one-time TTY confirm that
 *                                 binds it (headless keeps the old behaviour —
 *                                 a systemd restart must not hang on a prompt).
 *   anything else                 a CHOICE, never a guess: the CLI lists every
 *                                 stored project and asks (cli.mjs), or — with
 *                                 no TTY — refuses in words that name them all.
 *
 * The repoRoot binding is a SAFETY line, not bookkeeping: serving project X
 * from a repo that is not X's checkout materializes X's session worktrees and
 * decrypted env inside the wrong repository. Binding happens only at moments a
 * HUMAN was present (login, an answered confirm, an explicit pick) — never
 * silently on a headless start, where cementing the wrong repo would make the
 * mistake permanent.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CRED_DIR = join(homedir(), '.flowviant');
const CRED_FILE = join(CRED_DIR, 'credentials.json');

function readFile() {
  try {
    const v = JSON.parse(readFileSync(CRED_FILE, 'utf8'));
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

/** Atomic write (tmp + rename), 0600 — this file is credentials. */
function writeFile(v) {
  mkdirSync(CRED_DIR, { recursive: true });
  const tmp = `${CRED_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(v, null, 2), { mode: 0o600 });
  renameSync(tmp, CRED_FILE);
}

/** The repo root of `cwd`, realpath'd, or null when not inside a git repo. */
export function detectRepoRoot(cwd = process.cwd()) {
  try {
    const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    }).trim();
    return root ? realpathSync(root) : null;
  } catch {
    return null;
  }
}

/** Same directory whatever it is spelled as — the instance.mjs rule. */
function samePath(a, b) {
  if (!a || !b) return false;
  const norm = (v) => {
    try {
      return realpathSync(v);
    } catch {
      return String(v).replace(/\/+$/, '');
    }
  };
  return norm(a) === norm(b);
}

/**
 * Every stored project, NORMALIZED: the v2 map, plus the legacy trio surfaced
 * as an entry when no map row carries its token (a pre-0.55.0 file is one
 * project with no name and no binding — real, and listed as such). `active`
 * marks the entry the legacy mirror points at.
 */
export function listStoredProjects() {
  const f = readFile();
  if (!f) return [];
  const out = new Map();
  for (const [projectId, e] of Object.entries(f.projects ?? {})) {
    if (!e || typeof e.fleetToken !== 'string' || !e.fleetToken) continue;
    out.set(projectId, {
      projectId,
      fleetToken: e.fleetToken,
      mcpUrl: e.mcpUrl ?? null,
      name: typeof e.name === 'string' && e.name ? e.name : null,
      repoRoot: typeof e.repoRoot === 'string' && e.repoRoot ? e.repoRoot : null,
      savedAt: e.savedAt ?? null,
    });
  }
  if (typeof f.fleetToken === 'string' && f.fleetToken && typeof f.projectId === 'string' && f.projectId && !out.has(f.projectId)) {
    out.set(f.projectId, {
      projectId: f.projectId,
      fleetToken: f.fleetToken,
      mcpUrl: f.mcpUrl ?? null,
      name: null,
      repoRoot: null,
      savedAt: null,
    });
  }
  return [...out.values()].map((e) => ({ ...e, active: e.projectId === f.projectId }));
}

/** What a project is CALLED on a terminal: its name, or an id you can grep. */
export function projectLabel(e) {
  return e?.name ?? (e?.projectId ? `project ${e.projectId.slice(0, 8)}…` : 'an unnamed project');
}

/**
 * THE SAME LABEL, DISAMBIGUATED — for a list where two rows can read alike
 * (2026-09-19).
 *
 * Two projects genuinely named the same thing is not a hypothetical: production
 * held two called "BRIF AI", both bound to the same checkout on one box, so
 * `npx flowviant` there offered two IDENTICAL picker rows and the only way to
 * choose between them was to guess. A picker whose options cannot be told apart
 * is not a picker.
 *
 * THE SUFFIX IS ONLY ON THE COLLIDING ROWS. An id on every row would be noise
 * on the ordinary case — one project per repo, nothing ambiguous — and noise is
 * what makes the one row that matters unfindable. The DATE rides beside the id
 * because it is the fact a person can actually match against their own memory
 * ("I set that one up last month"), where two random-looking hex prefixes are
 * two things to compare character by character.
 *
 * `flowviant machines` deliberately does the OPPOSITE and prints the id on
 * every row: there you are reconciling a whole box's worth of credentials, and
 * a suffix you have to notice before you know it matters has already made you
 * do the work the listing exists to do for you.
 */
export function projectRowLabel(e, entries) {
  const label = projectLabel(e);
  const collides =
    Array.isArray(entries) &&
    entries.filter((x) => x !== e && projectLabel(x) === label).length > 0;
  if (!collides) return label;
  const d = e?.savedAt ? new Date(e.savedAt) : null;
  const when =
    d && !Number.isNaN(d.getTime())
      ? `, connected ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
      : '';
  return `${label} (id ${String(e?.projectId ?? '').slice(0, 8)}…${when})`;
}

/** Collapse a name or slug for loose comparison: "My Project", "my-project"
 *  and "myproject" all become "myproject". */
function normalizeName(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/**
 * WHICH stored project most likely goes with this repo — a HINT for the
 * picker's default, and DELIBERATELY not a licence to serve it. `resolveStored
 * Credential` matches by repo PATH and refuses to guess past that, because
 * serving a project the path did not name is the "it said skadooble in my
 * calendar repo" surprise this whole file exists to prevent. A name that
 * matches the repo's folder or its github repo-name is softer evidence — good
 * enough to put the cursor on that row so the answer is one keypress, never
 * good enough to skip the human. Two names can collide (a project "api" and a
 * repo "api"), which is exactly why this only pre-selects.
 *
 * Returns the index of a UNIQUE match, or -1 when nothing matches or more than
 * one does — an ambiguous hint is not a hint, and a default that is as likely
 * wrong as right is worse than starting at the top.
 */
export function likelyChoiceIndex(choices, { repoBasename, repoSlugName } = {}) {
  const wants = new Set([normalizeName(repoBasename), normalizeName(repoSlugName)].filter(Boolean));
  if (wants.size === 0) return -1;
  const hits = [];
  choices.forEach((e, i) => {
    const n = normalizeName(e?.name);
    if (n && wants.has(n)) hits.push(i);
  });
  return hits.length === 1 ? hits[0] : -1;
}

function mutate(fn) {
  const f = readFile() ?? {};
  if (!f.projects || typeof f.projects !== 'object') f.projects = {};
  // Surface a legacy trio into the map before any edit, so nothing loses it.
  if (typeof f.fleetToken === 'string' && f.fleetToken && typeof f.projectId === 'string' && f.projectId && !f.projects[f.projectId]) {
    f.projects[f.projectId] = { fleetToken: f.fleetToken, mcpUrl: f.mcpUrl ?? null };
  }
  fn(f);
  writeFile(f);
  return f;
}

/** A fresh login: upsert the entry AND point the legacy mirror at it. */
export function saveLogin({ fleetToken, projectId, mcpUrl, name, repoRoot }) {
  mutate((f) => {
    f.projects[projectId] = {
      ...(f.projects[projectId] ?? {}),
      fleetToken,
      mcpUrl: mcpUrl ?? null,
      ...(name ? { name } : {}),
      ...(repoRoot ? { repoRoot } : {}),
      savedAt: new Date().toISOString(),
    };
    f.fleetToken = fleetToken;
    f.projectId = projectId;
    f.mcpUrl = mcpUrl ?? null;
  });
}

/** An explicit human pick: repoint the legacy mirror, and — when the pick was
 *  made standing in a repo — bind the entry there. A pick IS the confirmation;
 *  binding on anything less would cement a guess. */
export function selectStoredProject(projectId, { bindRepoRoot } = {}) {
  mutate((f) => {
    const e = f.projects[projectId];
    if (!e) return;
    if (bindRepoRoot) e.repoRoot = bindRepoRoot;
    f.fleetToken = e.fleetToken;
    f.projectId = projectId;
    f.mcpUrl = e.mcpUrl ?? null;
  });
}

/**
 * FORGET A STORED CREDENTIAL — `flowviant machines --forget <id>` (2026-09-19).
 *
 * The one write this otherwise view-only command can make, and it edits THIS
 * BOX'S credential file and nothing else: no server is called, no daemon is
 * stopped, no project is deleted. It exists because a credential whose project
 * was disconnected or deleted in the app 401s forever from here, and until now
 * the only way to clear one was to hand-edit JSON under `~/.flowviant`.
 *
 * IT CLEARS THE LEGACY MIRROR TOO when the mirror names the entry being
 * removed. Leaving it would resurrect the row on the next read —
 * `listStoredProjects` surfaces the top-level trio as an entry whenever no map
 * row carries its token — so the forget would silently not have happened, which
 * is the worst outcome available here.
 *
 * MATCHES BY FULL ID OR A PREFIX OF AT LEAST SIX, the same rule
 * `matchStoredProject` keeps, and AMBIGUITY IS A REFUSAL rather than a coin
 * flip: this deletes a credential, and the case that produced the whole command
 * is two projects that look alike.
 */
export function forgetStoredProject(ref) {
  const q = String(ref ?? '').trim();
  if (!q) return { error: 'empty --forget value' };
  const hits = listStoredProjects().filter(
    (e) => e.projectId === q || (q.length >= 6 && e.projectId.startsWith(q))
  );
  if (hits.length === 0) return { error: `no stored project matches "${q}"` };
  if (hits.length > 1) {
    return { error: `"${q}" matches ${hits.length} stored projects — use the full project id` };
  }
  const gone = hits[0];
  mutate((f) => {
    delete f.projects[gone.projectId];
    if (f.projectId === gone.projectId) {
      delete f.projectId;
      delete f.fleetToken;
      delete f.mcpUrl;
    }
  });
  return { entry: gone };
}

export function bindStoredRepo(projectId, repoRoot) {
  if (!repoRoot) return;
  mutate((f) => {
    if (f.projects[projectId]) f.projects[projectId].repoRoot = repoRoot;
  });
}

/** The roster names the project on every poll; remember it so the picker and
 *  `flowviant projects` can say a NAME instead of an id. */
export function setStoredProjectName(projectId, name) {
  if (!projectId || typeof name !== 'string' || !name) return;
  const entries = listStoredProjects();
  const e = entries.find((x) => x.projectId === projectId);
  if (!e || e.name === name) return;
  mutate((f) => {
    if (f.projects[projectId]) f.projects[projectId].name = name;
  });
}

/** Match `--project <ref>` against the store: exact id, id prefix (≥6), or
 *  case-insensitive name. Ambiguity is an error, never a coin flip. */
export function matchStoredProject(ref) {
  const entries = listStoredProjects();
  const q = String(ref ?? '').trim();
  if (!q) return { error: 'empty --project value' };
  const byId = entries.filter(
    (e) => e.projectId === q || (q.length >= 6 && e.projectId.startsWith(q))
  );
  const byName = entries.filter((e) => e.name && e.name.toLowerCase() === q.toLowerCase());
  const hits = byId.length > 0 ? byId : byName;
  if (hits.length === 1) return { entry: hits[0] };
  if (hits.length > 1) return { error: `"${q}" matches ${hits.length} stored projects — use the full project id` };
  return { error: `no stored project matches "${q}"` };
}

/**
 * Resolve which stored credential this invocation should use. PURE over the
 * store + argv + cwd; every refusal and prompt above it is built from what
 * this returns. Shapes:
 *   { entry, source: 'project-flag' | 'repo' | 'only', needsConfirm? }
 *   { choices, reason: 'no-match' | 'multiple-bound' | 'outside-repo', repoRoot }
 *   { none: true }
 *   { error }
 *
 * Deliberately NO mirror fallback once more than one project is stored: the
 * mirror is whichever login happened last, and serving it because it was
 * recent is exactly the calendar-says-skadooble surprise this file exists to
 * end. Two projects means the answer is a QUESTION (or --project, or the
 * repo binding), never recency.
 */
export function resolveStoredCredential(argv = process.argv, cwd = process.cwd()) {
  const i = argv.indexOf('--project');
  const projectArg = i >= 0 ? argv[i + 1] : undefined;
  if (projectArg !== undefined) {
    const m = matchStoredProject(projectArg);
    return m.entry ? { entry: m.entry, source: 'project-flag' } : { error: m.error };
  }
  const entries = listStoredProjects();
  if (entries.length === 0) return { none: true };
  const repoRoot = detectRepoRoot(cwd);

  if (repoRoot) {
    const bound = entries.filter((e) => samePath(e.repoRoot, repoRoot));
    if (bound.length === 1) return { entry: bound[0], source: 'repo', repoRoot };
    if (bound.length > 1) return { choices: bound, reason: 'multiple-bound', repoRoot };
  }

  // ONE stored project with no binding: the pre-0.55.0 world. Serve it — a
  // headless restart must not hang — but flag it, so a TTY start asks ONCE and
  // binds, which is what turns "it said skadooble in my calendar repo" into a
  // question instead of a surprise.
  if (entries.length === 1 && !entries[0].repoRoot) {
    return { entry: entries[0], source: 'only', needsConfirm: Boolean(repoRoot), repoRoot };
  }

  return { choices: entries, reason: repoRoot ? 'no-match' : 'outside-repo', repoRoot };
}
