import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

/**
 * A TURN NOBODY IS SITTING AT PUTS NO WINDOW ON ANYBODY'S SCREEN (2026-09-29),
 * measured on what a spawned CLI actually sees: a fake `codex` on PATH writes
 * down its environment, and the real lanes run it — an agent's turn and a
 * capture chat get no display, BROWSER=none and a browser profile of their own;
 * a Terminal tab, where a person at the keyboard may ask for a window, gets its
 * environment untouched. The old spawn handed every turn the daemon's display
 * and BROWSER, and no browser home at all.
 *
 * A file of its own, because the fake rides PATH and the display variables
 * ride process.env for the whole process. HOME, TMPDIR and CODEX_HOME are
 * scratch ones.
 */
const scratch = mkdtempSync(join(tmpdir(), 'fv-nowin-'));
process.on('exit', () => rmSync(scratch, { recursive: true, force: true }));
for (const d of ['bin', 'home', 'tmp', 'personal/sessions']) mkdirSync(join(scratch, d), { recursive: true });
process.env.HOME = join(scratch, 'home');
process.env.TMPDIR = join(scratch, 'tmp');
process.env.CODEX_HOME = join(scratch, 'personal');
const PERSON = { DISPLAY: ':7', WAYLAND_DISPLAY: 'wayland-7', WAYLAND_SOCKET: '9', BROWSER: 'wslview', XDG_CONFIG_HOME: join(scratch, 'home', '.config') };
Object.assign(process.env, PERSON);
const seen = join(scratch, 'seen');
const NAMES = ['DISPLAY', 'WAYLAND_DISPLAY', 'WAYLAND_SOCKET', 'BROWSER', 'CHROME_CONFIG_HOME', 'CHROME_USER_DATA_DIR', 'XDG_CONFIG_HOME'];
writeFileSync(
  join(scratch, 'bin', 'codex'),
  `#!/usr/bin/env node
const fs = require('node:fs');
const env = {};
for (const k of ${JSON.stringify(NAMES)}) env[k] = k in process.env ? process.env[k] : null;
env.browserHomeExists = env.CHROME_CONFIG_HOME ? fs.existsSync(env.CHROME_CONFIG_HOME) : null;
// Turns only: the daemon's own model-list probe runs \`codex\` too, and is no turn.
if (process.argv[2] !== 'exec') process.exit(0);
fs.appendFileSync(${JSON.stringify(seen)}, JSON.stringify(env) + '\\n');
const say = (ev) => process.stdout.write(JSON.stringify(ev) + '\\n');
say({ type: 'thread.started', thread_id: require('node:crypto').randomUUID() });
say({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ status: 'delivered', summary: 'done' }) } });
say({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });
`
);
chmodSync(join(scratch, 'bin', 'codex'), 0o755);
process.env.PATH = `${join(scratch, 'bin')}:${process.env.PATH}`;
const { createWorkManager } = await import('./work.mjs');
const { runTurn } = await import('./runTurn.mjs');
const { withoutWindows, openBrowserHome, WINDOW_ENV_REMOVED } = await import('./noWindowEnv.mjs');

const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function managerIn(t) {
  const repoRoot = mkdtempSync(join(scratch, 'repo-'));
  git(['init', '-q', '-b', 'main'], repoRoot);
  git(['config', 'user.email', 't@t.t'], repoRoot);
  git(['config', 'user.name', 'T'], repoRoot);
  writeFileSync(join(repoRoot, 'a.txt'), 'one');
  git(['add', '-A'], repoRoot);
  git(['commit', '-qm', 'base'], repoRoot);
  const baseDir = mkdtempSync(join(scratch, 'base-'));
  const m = createWorkManager({ repoRoot, baseDir, getBaseRef: () => 'main', getMcpUrl: () => 'http://127.0.0.1:0/mcp', getLeaseTtl: () => 60 });
  t.after(() => {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(baseDir, { recursive: true, force: true });
  });
  return { m, baseDir };
}
function stubFetch(t) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), body: typeof opts.body === 'string' ? JSON.parse(opts.body) : null });
    // A session credential for the tab lane's mint; every other POST accepted.
    return { ok: true, status: 200, json: async () => ({ data: { claimed: true, token: 'fva_tab' } }) };
  };
  t.after(() => {
    globalThis.fetch = real;
  });
  return calls;
}
const until = async (cond, ms = 10_000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
};
const envs = () => (existsSync(seen) ? readFileSync(seen, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
const underTmp = (p) => p.startsWith(tmpdir() + sep);

test('withoutWindows takes every way to a window, keeps everything else, and never mutates', () => {
  const env = { ...PERSON, PATH: '/usr/bin', XDG_RUNTIME_DIR: '/run/user/1000', ANTHROPIC_API_KEY: 'k' };
  const out = withoutWindows(env, '/x/browser');
  for (const k of WINDOW_ENV_REMOVED) assert.ok(!(k in out), k);
  // EMPTY, not absent: unset, libwayland connects to $XDG_RUNTIME_DIR/wayland-0.
  assert.equal(out.WAYLAND_DISPLAY, '');
  assert.equal(out.BROWSER, 'none');
  assert.equal(out.CHROME_CONFIG_HOME, '/x/browser');
  assert.equal(out.CHROME_USER_DATA_DIR, '/x/browser/user-data');
  // Claude's, Codex's and git's own config stay where they are.
  assert.equal(out.XDG_CONFIG_HOME, PERSON.XDG_CONFIG_HOME);
  assert.equal(out.XDG_RUNTIME_DIR, '/run/user/1000');
  assert.equal(out.ANTHROPIC_API_KEY, 'k');
  assert.equal(env.DISPLAY, ':7', 'the input is untouched');
  assert.ok(!('CHROME_CONFIG_HOME' in withoutWindows(env)), 'no home named, none invented');
});

test('a browser home is the kept one when a lane has it, else a turn\'s own that goes with it', () => {
  const kept = join(scratch, 'kept-browser');
  const k = openBrowserHome(kept);
  assert.equal(k.dir, kept);
  assert.equal(statSync(kept).mode & 0o777, 0o700);
  k.cleanup();
  assert.ok(existsSync(kept), 'a kept home is never removed by a turn');
  // A kept path that is a link is replaced, never followed.
  const elsewhere = join(scratch, 'elsewhere');
  mkdirSync(elsewhere);
  writeFileSync(join(elsewhere, 'keep.txt'), 'x');
  const linked = join(scratch, 'linked-browser');
  symlinkSync(elsewhere, linked);
  openBrowserHome(linked);
  assert.ok(lstatSync(linked).isDirectory() && !lstatSync(linked).isSymbolicLink());
  assert.ok(existsSync(join(elsewhere, 'keep.txt')));
  const own = openBrowserHome(null);
  assert.ok(underTmp(own.dir));
  own.cleanup();
  assert.ok(!existsSync(own.dir));
});

test("an agent's turn has no display, BROWSER=none, and its own browser profile beside its Codex home", async (t) => {
  const { m, baseDir } = managerIn(t);
  const calls = stubFetch(t);
  rmSync(seen, { force: true });
  m.processAgentTurnJobs([{ id: 'at-1', agentId: 'ag1', placeId: 'a-ag1', runtime: 'codex', agentName: 'Ada', kind: 'task', task: { id: 'c1', title: 'x' } }]);
  await until(() => calls.some((c) => c.url.includes('agent-turn-done')) && !m.workBusy());
  const [env] = envs();
  assert.equal(env.DISPLAY, null);
  assert.equal(env.WAYLAND_SOCKET, null);
  assert.equal(env.WAYLAND_DISPLAY, '');
  assert.equal(env.BROWSER, 'none');
  const home = join(git(['rev-parse', '--absolute-git-dir'], join(baseDir, 'sessions', 'a-ag1')), 'flowviant-agent-browser-ag1');
  assert.equal(env.CHROME_CONFIG_HOME, home, "in the worktree's private git dir, beside the Codex home");
  assert.equal(env.CHROME_USER_DATA_DIR, join(home, 'user-data'));
  assert.equal(env.browserHomeExists, true);
  assert.ok(!underTmp(home));
  assert.equal(env.XDG_CONFIG_HOME, PERSON.XDG_CONFIG_HOME);
});

test('a Terminal tab keeps the person\'s display; a capture chat does not', async (t) => {
  const { m } = managerIn(t);
  const calls = stubFetch(t);
  rmSync(seen, { force: true });
  const done = () => calls.filter((c) => c.url.includes('work-turn-done')).length;
  m.processWorkTurns([{ id: 'turn-1', body: 'hello', sessionId: 'sess-tab', runtime: 'codex' }]);
  await until(() => done() === 1 && !m.workBusy());
  m.processWorkTurns([{ id: 'turn-2', body: 'a card for the login bug', sessionId: 'sess-cap', runtime: 'codex', capture: true }]);
  await until(() => done() === 2 && !m.workBusy());
  const [tab, capture] = envs();
  assert.deepEqual(
    { DISPLAY: tab.DISPLAY, WAYLAND_DISPLAY: tab.WAYLAND_DISPLAY, WAYLAND_SOCKET: tab.WAYLAND_SOCKET, BROWSER: tab.BROWSER, XDG_CONFIG_HOME: tab.XDG_CONFIG_HOME },
    PERSON,
    'the tab runs with the environment it always had'
  );
  assert.equal(tab.CHROME_CONFIG_HOME, null);
  assert.equal(tab.CHROME_USER_DATA_DIR, null);
  assert.equal(capture.DISPLAY, null);
  assert.equal(capture.WAYLAND_DISPLAY, '');
  assert.equal(capture.BROWSER, 'none');
  assert.ok(underTmp(capture.CHROME_CONFIG_HOME), "the capture chat's browser home is the turn's own");
  assert.equal(capture.browserHomeExists, true);
  assert.ok(!existsSync(capture.CHROME_CONFIG_HOME), '…and it goes when the CLI closes');
});

test('a lane that says nothing — the planner, the wiki, intake — gets no window', async () => {
  rmSync(seen, { force: true });
  await runTurn({ prompt: 'p', system: 's', cwd: scratch, runtime: 'codex', profile: 'consult', streamJson: true, answerFromResult: true });
  const [env] = envs();
  assert.equal(env.DISPLAY, null);
  assert.equal(env.WAYLAND_DISPLAY, '');
  assert.equal(env.BROWSER, 'none');
  assert.ok(underTmp(env.CHROME_CONFIG_HOME));
  await until(() => !existsSync(env.CHROME_CONFIG_HOME));
});
