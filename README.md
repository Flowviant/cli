# flowviant

Run your own coding CLIs as build agents for [Flowviant](https://flowviant.com) — [Claude Code](https://claude.com/claude-code), Codex or Antigravity, on your own credentials. This daemon holds your sessions, keeps a worktree per tab, and ships branches on your word. Flowviant never sees your Claude, Codex or GitHub logins.

```sh
curl -fsSL https://api.flowviant.com/install.sh | sh
flowviant   # approve the code in Flowviant → connected
```

Login keeps going straight into the daemon — there is no second command to run.

## What it does

A Flowviant project has ONE machine, and this is it: one box, running one Claude (or Codex, or Antigravity) account, serving the whole team's sessions so nobody has to set up their own. Solo and team are the same architecture at N=1 and N>1.

You work in the **Workbench**, where your sessions are TABS — each one a held context plus a persistent git worktree on its own `session/<id>` branch. The browser is a terminal projected onto this machine, so you reach the same session from any device. When you say ship, the tab merges its own branch into base with `--no-ff` — no squash, so the commit shas the work reported still exist on main.

Because it drives the CLIs you're already logged into, **the cost is yours** (your Claude subscription, your GitHub) and **the daemon never handles a credential** — it shells out to tools you authenticated yourself.

## Requirements

On the machine that runs the daemon:

- **at least one coding CLI** installed and signed in — [Claude Code](https://claude.com/claude-code) (`claude`), Codex (`codex`) or Antigravity (`agy`)
- **git** (Node 20+ is needed only for a Node-based install)
- **[GitHub CLI](https://cli.github.com)** (`gh`) — optional; the daemon offers to fetch an isolated copy, and `flowviant gh-auth` signs it in
- run it from inside the git repository you want worked

## Connecting

Download the standalone binary, then start it in your checkout:

```sh
curl -fsSL https://api.flowviant.com/install.sh | sh
flowviant
```

It shows a short code. Open your project's **Workbench** in Flowviant and enter the code where it offers to connect a machine. The credential is stored at `~/.flowviant/credentials.json`, and from then on `flowviant` just runs. The installer prints a PATH hint if needed; `FLOWVIANT_INSTALL_DIR` changes its destination. It verifies SHA-256 and never uses sudo.

Prefer an explicit token? Create a machine credential in the app and pass it directly:

```bash
FLOWVIANT_MACHINE_TOKEN=fva_… flowviant   # FLOWVIANT_FLEET still works
```

With Node already installed, a global install also gives you the same command:

```bash
npm i -g flowviant
flowviant login
```

The binary and global npm installs update when idle. The binary fetches the release manifest and verifies the new executable before replacing itself. The global install refreshes from npm before restarting. `flowviant update` checks on demand. `FLOWVIANT_NO_UPDATE=1` makes updates manual.

## Uninstall

`flowviant uninstall` stops local daemons and removes installed copies. It keeps logins and local state in `~/.flowviant`, so reinstalling resumes them. Use `flowviant uninstall --purge` to disconnect this box from stored projects and delete that local data too. Add `--yes` to skip confirmation.

## Machines on this box

One box can serve several projects — one daemon per repository directory, each connected with its own `flowviant login` run inside that repo. `flowviant machines` lists every project connected on this box with the id and date it was connected, and under each one every computer that has polled it (the app's Home lists the same across your whole account). Two projects bound to one repository are named out loud at the foot of the listing, because that is the one shape that reads as "the same project connected twice" and is not — and a directory serves one project, so `flowviant` there refuses to start until one of them goes.

On a terminal the listing is a menu: ↑/↓ over the projects, enter for what you can do about one, esc to leave. Two verbs, each acting on **this box's own connection** and nothing else:

- **disconnect this box from it** — stops the daemon serving that project here (that one credential's daemon, never the others), removes this box from the project's machines list in the app, and forgets the credential here. `flowviant machines --remove <project id>` is the same thing for a script.
- **forget it here only** — the credential is dropped from `~/.flowviant/credentials.json` and nothing else happens; the app keeps listing this box until it goes quiet. `--forget <project id>` for a script.

Stopping or removing a daemon on **another** computer is done in the app (project settings → Machines), where the person pressing it can see what they are changing.

**A directory serves one project.** `flowviant login` refuses to bind a second project to a repository that is already connected to one, and a store that already holds two projects for one repository refuses to start there — both name the projects and the remedy: delete the project you do not mean in Flowviant (project settings → General → Delete project), or disconnect this box from it with `flowviant machines`, then try again.

## Sessions

Each tab in the Workbench is a persistent Claude session with its own worktree, and it stays where you left it — the branch outlives the tab. The daemon runs each turn in event mode and relays what the CLI is printing (thinking, reads, greps, commands) back to the tab, reports the worktree's branch and diffstat after every turn, and fetches a commit's patch when you click a sha in the app.

Nothing starts a session except you opening a tab and typing in it.

## Agents

Press **Deploy** on the board and this machine runs a read-only scratch turn that proposes how the selected cards should be split across agents; accepting the proposal is what cuts worktrees and starts work. From **0.79.0** that planning turn is relayed the same way a session turn is — the reads, greps and thoughts the daemon was already printing behind `[plan]` now reach the press itself, along with the two facts only this side can see: the CLI actually starting, and the press waiting for the checkout while a ship or another turn holds it. A planning CLI that wedges is stopped after fifteen minutes and the press is reported failed in the machine's own words, rather than sitting silent until the server expires it half an hour later.

From **0.86.0**, a project whose owner turns on **Publish agent branches** has each agent's branch pushed to your `origin` under `flowviant/<name>-<id>` as it works — the same commits that are already on the agent's local `session/a-<id>`, under a name you can see in your host. The push is tail work after the turn settles: it never blocks or fails a turn, and a push that fails is reported back in git's own words. The app composes the name and this machine only ever pushes to the one it was given. Two things follow from it: work an agent did on a box that has gone away can be fetched and continued on another one (the commits, not the CLI's conversation — the next turn re-reads the card), and the remote branch is deleted once its work lands on your base branch — on a project that merges through pull requests it is also the branch the PR is opened from, so there is one branch per agent rather than two. Each push leases against the sha this daemon last saw at that ref, so a second machine pushing to the same name is reported back to you rather than overwritten. With the setting off, nothing is pushed anywhere.

## Sharing a preview

You run your dev server yourself, in the session's own worktree, exactly as you would in any terminal. The daemon NOTICES the listening port; ask for a share in the app and it puts a [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) quick tunnel in front of it (auto-fetched if missing, pinned and checksummed) behind a **mandatory password gate**. Flowviant stores only the tunnel URL; your browser talks to it directly. Since 0.72.0 the gate also lets the Workbench embed the share in a frame: it rewrites the response's frame policy to permit exactly the app's origin, and a framed sign-in gets a partitioned cookie so it works where third-party cookies are blocked.

The daemon never executes anything the repository declares. An earlier version read a `.flowviant/preview.json` from the branch and spawned the command it named — that start path was removed in 0.53.0 and is not coming back; see the header of `bin/lib/preview.mjs` for exactly what it did, so nobody rebuilds it.

## Modes

| Env | What runs |
| --- | --- |
| _(stored login)_ or `FLOWVIANT_MACHINE_TOKEN` (`FLOWVIANT_FLEET` still read) | **the daemon** — the project's machine, serving its sessions |
| `FLOWVIANT_SAFE=1` | restrict the toolset instead of running unattended |

## Not freezing the box

Since 0.83.0 the daemon looks at the machine before it starts another CLI. It counts the turns it is already running against `FLOWVIANT_MAX_CONCURRENT` (default: what the box's memory and cores can hold), and reads free memory and load. When either says no it simply does not spawn — the job stays queued server-side and is offered again on the next poll, and the app is told the machine's own measured reason ("low memory — 612 MB of 16.0 GB available") at whatever is waiting. Nothing is ever killed, and nothing is parked; pressure clears on its own.

Unattended work (agent turns, a Deploy plan, the wiki sweep) yields first. A Workbench turn — somebody watching a composer — holds out until the box is genuinely about to fall over.

| Env | Default | What it does |
| --- | --- | --- |
| `FLOWVIANT_MIN_FREE_MB` | `1024` | free memory below this (or below 6% of total, whichever is larger) defers unattended work |
| `FLOWVIANT_MAX_LOAD_PER_CORE` | `4` | 1-minute load above `cores × this` defers unattended work |
| `FLOWVIANT_CRITICAL_FREE_MB` | `400` | free memory below this defers a session turn too |
| `FLOWVIANT_NO_PRESSURE_GUARD=1` | — | turn the memory/load guard off entirely (the concurrency ceiling still holds) |

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

With Node: `npx flowviant@latest login` runs without a global install and updates by restarting through the package runner when idle.

## License

MIT — see [LICENSE](./LICENSE).
