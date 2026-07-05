# flowviant

Run your own [Claude Code](https://claude.com/claude-code) as headless build agents for [Flowviant](https://flowviant.com). You manage a team of agents in the app; this daemon runs them on your machine, on your own credentials — Flowviant never sees your Claude or GitHub logins.

```bash
npx flowviant login      # approve the code in Flowviant → connected
npx flowviant            # run your fleet
```

## What it does

You create named agents in Flowviant and dispatch work to them. This daemon, running on a machine you control, gives each agent its own git worktree and drives **your** locally-authenticated `claude` to do the work — it claims a task, works it, captures evidence for each acceptance criterion, opens a pull request, and routes any question it can't answer back to you as a blocker. You review and merge in the app.

Because it drives the CLIs you're already logged into, **the cost is yours** (your Claude subscription, your GitHub) and **the daemon never handles a credential** — it shells out to tools you authenticated yourself.

## Requirements

On the machine that runs the daemon:

- **[Claude Code](https://claude.com/claude-code)** installed and signed in (`claude`)
- **[GitHub CLI](https://cli.github.com)** authenticated (`gh auth login`) — for opening PRs
- **git**, and **Node 20+**
- run it from inside the git repository you want worked

## Connecting

The easy way — device login, like `gh auth login`:

```bash
npx flowviant login
```

It shows a short code; enter it in Flowviant under **Agents → Connect a machine**. The credential is stored at `~/.flowviant/credentials.json`, and from then on `npx flowviant` just runs.

Prefer an explicit token? Create a fleet credential in the app and pass it directly:

```bash
FLOWVIANT_FLEET=fva_… npx flowviant
```

## Live mode (the default)

Each task runs a **persistent** Claude session you can talk to mid-task from the app: the agent streams its work into the task's conversation, you `@`-mention it to steer or answer questions, and it resumes in place. Blockers park the session at zero cost until you answer. When it finishes, it posts a delivery card (summary + checklist self-report) in the thread — a human confirms done by merging there.

Prefer the legacy one-shot poll mode (no streaming, no previews)? Escape hatch:

```bash
FLOWVIANT_POLL=1 npx flowviant
```

### Live previews

For UI/API tasks, the daemon can start the branch's dev server in the agent's worktree and open a [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) quick tunnel so you can drive the real running change during review — no Cloudflare account needed (it's auto-fetched if missing). Configure it once per repo, or let it infer common setups:

```json
// .flowviant/preview.json
{ "ui": { "cmd": "npm run dev", "port": 5173 } }
```

Flowviant only stores the tunnel URL; your browser talks to it directly.

## Modes

| Env | What runs |
| --- | --- |
| _(stored login)_ or `FLOWVIANT_FLEET` | **Fleet daemon** — one worktree + worker per agent on your roster, managed in the app |
| `FLOWVIANT_TOKEN` | a single agent in the current checkout |
| `FLOWVIANT_TOKENS=a,b,c` | a static fleet, one worktree each |
| `FLOWVIANT_SAFE=1` | restrict the toolset instead of running unattended |

## License

MIT — see [LICENSE](./LICENSE).
