# flowviant

Run your own coding CLIs as build agents for [Flowviant](https://flowviant.com) — [Claude Code](https://claude.com/claude-code), Codex or Antigravity, on your own credentials. This daemon holds your sessions, keeps a worktree per tab, and ships branches on your word. Flowviant never sees your Claude, Codex or GitHub logins.

```bash
npx flowviant@latest login   # approve the code in Flowviant → connected
```

Login keeps going straight into the daemon — there is no second command to run.

## What it does

A Flowviant project has ONE machine, and this is it: one box, running one Claude (or Codex, or Antigravity) account, serving the whole team's sessions so nobody has to set up their own. Solo and team are the same architecture at N=1 and N>1.

You work in the **Workbench**, where your sessions are TABS — each one a held context plus a persistent git worktree on its own `session/<id>` branch. The browser is a terminal projected onto this machine, so you reach the same session from any device. When you say ship, the tab merges its own branch into base with `--no-ff` — no squash, so the commit shas the work reported still exist on main.

Because it drives the CLIs you're already logged into, **the cost is yours** (your Claude subscription, your GitHub) and **the daemon never handles a credential** — it shells out to tools you authenticated yourself.

## Requirements

On the machine that runs the daemon:

- **at least one coding CLI** installed and signed in — [Claude Code](https://claude.com/claude-code) (`claude`), Codex (`codex`) or Antigravity (`agy`)
- **git**, and **Node 20+**
- **[GitHub CLI](https://cli.github.com)** (`gh`) — optional; the daemon offers to fetch an isolated copy, and `flowviant gh-auth` signs it in
- run it from inside the git repository you want worked

## Connecting

The easy way — device login, like `gh auth login`:

```bash
npx flowviant@latest login
```

It shows a short code. Open your project's **Workbench** in Flowviant and enter the code where it offers to connect a machine. The credential is stored at `~/.flowviant/credentials.json`, and from then on `npx flowviant@latest` just runs.

Prefer an explicit token? Create a machine credential in the app and pass it directly:

```bash
FLOWVIANT_FLEET=fva_… npx flowviant@latest
```

Launch with `@latest` so each start pulls the newest published version — a bare `npx flowviant` can reuse a stale cache. A running daemon also keeps itself current: from **0.58.0** it restarts itself through `npx flowviant@latest` when a new version ships, so npx launches stay up to date the same way a global install does. (Before 0.58.0 that was only true of a global install — under npx the daemon printed a notice and stayed put, which is how machines ended up sitting several releases back.) It only ever restarts when no turn is running. `FLOWVIANT_NO_UPDATE=1` makes it nag-only; `flowviant update` updates now.

## Sessions

Each tab in the Workbench is a persistent Claude session with its own worktree, and it stays where you left it — the branch outlives the tab. The daemon runs each turn in event mode and relays what the CLI is printing (thinking, reads, greps, commands) back to the tab, reports the worktree's branch and diffstat after every turn, and fetches a commit's patch when you click a sha in the app.

Nothing starts work except you opening a tab and typing in it.

## Sharing a preview

You run your dev server yourself, in the session's own worktree, exactly as you would in any terminal. The daemon NOTICES the listening port; ask for a share in the app and it puts a [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) quick tunnel in front of it (auto-fetched if missing, pinned and checksummed) behind a **mandatory password gate**. Flowviant stores only the tunnel URL; your browser talks to it directly.

The daemon never executes anything the repository declares. An earlier version read a `.flowviant/preview.json` from the branch and spawned the command it named — that start path was removed in 0.53.0 and is not coming back; see the header of `bin/lib/preview.mjs` for exactly what it did, so nobody rebuilds it.

## Modes

| Env | What runs |
| --- | --- |
| _(stored login)_ or `FLOWVIANT_FLEET` | **the daemon** — the project's machine, serving its sessions |
| `FLOWVIANT_SAFE=1` | restrict the toolset instead of running unattended |

## Security posture

Every project member with edit access can run turns on this machine — a
Workbench tab executes a coding agent with the daemon's own OS permissions.
Membership is the consent boundary, the same trust plane as the shared
repository: invite people you would give a shell to.

Two knobs bound the blast radius, and both are worth setting on a shared box:

- **Run the daemon under a dedicated OS user** that owns only the repository
  checkout and `~/.flowviant`. This is the single biggest hardening available
  — a session can then only touch that account's files, not your keys, your
  home directory, or the rest of the machine. A plain separate account works;
  a systemd unit with `ProtectHome=read-only` and `ReadWritePaths=` works
  better.
- **`FLOWVIANT_SAFE=1`** narrows the toolset: Claude to an allowlist
  (edit/read/search plus `git`/`gh`/`npm`/`bun` — no arbitrary shell), Codex
  to a workspace-write sandbox. Antigravity has no per-invocation narrowing —
  its permission engine is machine-wide — which is surfaced in the app rather
  than papered over.

The posture is reported on every poll and shown in the project's
Settings → Machine section, so the team can see whether the box runs the
guarded toolset or full permissions.

## License

MIT — see [LICENSE](./LICENSE).
