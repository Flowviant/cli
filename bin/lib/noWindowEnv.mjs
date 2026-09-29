/**
 * A TURN NOBODY IS SITTING AT PUTS NO WINDOW ON ANYBODY'S SCREEN (2026-09-29).
 *
 * The owner, on WSL: Chrome "kept opening on my desktop … but me as the user
 * didnt click anything". Board agents checking their three.js pages started
 * Chrome themselves, and an inherited environment gives such a process three
 * roads to the person's screen:
 *  · a Chrome started without --user-data-dir takes the DEFAULT profile, and
 *    while the person's own Chrome runs on it the new process hands its
 *    command line to that one through the profile's SingletonSocket — taken
 *    before any display is opened (measured) — so the PERSON'S Chrome opens
 *    the window, and no display variable of ours is involved;
 *  · a headed browser, Playwright's `headless: false`, any GUI program draws
 *    wherever DISPLAY / WAYLAND_DISPLAY point, and WSLg points them at the
 *    Windows desktop;
 *  · xdg-open, Python's webbrowser, a dev server's --open honour BROWSER, which
 *    on WSL is usually the Windows browser.
 *
 * So every turn but a Terminal tab's — the one lane where a person at the
 * keyboard may ask for a window — runs with:
 *  · DISPLAY and WAYLAND_SOCKET removed, and WAYLAND_DISPLAY set EMPTY rather
 *    than removed: unset, libwayland falls back to `$XDG_RUNTIME_DIR/wayland-0`
 *    (measured: a client with it unset connected there), and that is exactly
 *    the socket WSLg keeps; empty names no socket, a Chrome that picks Wayland
 *    from it fails "Failed to connect to Wayland display" and exits (measured),
 *    and xdg-open reads empty as no display at all;
 *  · BROWSER=none, childEnv.mjs's word for the same thing;
 *  · a browser home of its own: CHROME_CONFIG_HOME, the root Chrome and
 *    Chromium put their default profile under (chrome_paths_linux.cc), and
 *    CHROME_USER_DATA_DIR, the profile itself (chrome_main_delegate.cc) — the
 *    one a fork like Brave still honours where it ignores the first
 *    (measured) — so a browser the agent starts bare opens a profile nobody
 *    else is running and can never reach the person's.
 *
 * Nothing that runs here needs what is removed: the CLIs' own headless modes
 * (`claude -p`, `codex exec`) and headless browsers run without a display
 * (measured). XDG_CONFIG_HOME is deliberately NOT moved: it is where Claude,
 * Codex and git keep their own configuration.
 *
 * What an environment cannot stop is an agent that runs a Windows program on
 * purpose through WSL interop (`explorer.exe`, `cmd.exe /c start`); the kind
 * contracts ask it not to (artifactContracts.mjs, `NO_WINDOW`).
 */
import { lstatSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Removed outright; WAYLAND_DISPLAY is kept but emptied (see above). */
export const WINDOW_ENV_REMOVED = Object.freeze(['DISPLAY', 'WAYLAND_SOCKET']);

/** A copy of `env` a turn nobody is sitting at runs with. Never mutates its
 *  input. `browserHome` is the directory its browsers keep their profile in. */
export function withoutWindows(env, browserHome = null) {
  const out = { ...(env ?? {}) };
  for (const k of WINDOW_ENV_REMOVED) delete out[k];
  out.WAYLAND_DISPLAY = '';
  out.BROWSER = 'none';
  if (browserHome) {
    out.CHROME_CONFIG_HOME = browserHome;
    out.CHROME_USER_DATA_DIR = join(browserHome, 'user-data');
  }
  return out;
}

/**
 * AN AGENT'S BROWSER HOME is kept beside its Codex home, in its worktree's
 * private git dir: never committed, the same profile turn after turn, and
 * removed with the worktree when the agent retires. The pre-review and the
 * project check stand in the same worktree for the same agent, and take it
 * too. Null when there is no git dir to hold it.
 */
export const agentBrowserHome = (sessionMetaPath, wt, agentId) =>
  sessionMetaPath?.(wt, 'flowviant-agent-browser', agentId) ?? null;

/**
 * The directory, made: `kept` when a lane has one (0700, never removed here),
 * else one of this turn's own that `cleanup` removes. A kept path that is not
 * a real directory is replaced, never followed; one that cannot be made falls
 * back to a turn's own. Never throws — the turn runs without a browser home
 * sooner than not at all, and its display variables are gone either way.
 */
export function openBrowserHome(kept) {
  if (kept) {
    try {
      try { if (!lstatSync(kept).isDirectory()) rmSync(kept, { force: true }); } catch { /* absent */ }
      mkdirSync(kept, { recursive: true, mode: 0o700 });
      return { dir: kept, cleanup: () => {} };
    } catch { /* fall through to a turn's own */ }
  }
  try {
    const dir = mkdtempSync(join(tmpdir(), 'flowviant-browser-'));
    let removed = false;
    return {
      dir,
      cleanup: () => {
        if (removed) return;
        removed = true;
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
      },
    };
  } catch {
    return { dir: null, cleanup: () => {} };
  }
}
