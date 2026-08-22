# Security

This is the open-source daemon that runs Flowviant's build agents **on your own
machine, on your own credentials**. It's public precisely so you can verify what
it does before running it — nothing here should be taken on trust.

## What it does with your credentials: nothing

The daemon **never sees, stores, or transmits** your Claude or GitHub logins. It
drives CLIs *you* authenticated yourself by shelling out to them:

- **Claude** — it invokes your locally signed-in `claude` (via the Claude Agent
  SDK / CLI). Whatever that machine is signed in with is what pays for the work,
  and the daemon does not pick: the child inherits your environment as-is,
  `ANTHROPIC_API_KEY` included. It used to be stripped, to force the
  subscription path — right when the daemon ran on one developer's laptop and a
  stray key would silently bill every turn as raw API usage. On a machine the
  whole project shares, an inherited org key is the POINT, and deleting it would
  be the daemon overriding the credential its operator deliberately configured.
  Which credential is correct, and whether an account may be shared, is between
  the operator and the vendor (see `bin/lib/claude.mjs`, the comment above the
  spawn).
- **GitHub** — it uses your `git` (and your authenticated `gh`, where it is
  installed) for branches, commits and pushes.

The only credential the daemon holds is a **Flowviant machine token**, scoped to
a single project, stored locally at `~/.flowviant/credentials.json` (mode `600`)
after `flowviant login`. It authenticates *to Flowviant*, never to Anthropic or
GitHub.

## What it sends to Flowviant

Over HTTPS to the Flowviant API only:

- **session activity** — the humanized tail of what the CLI is printing during a
  turn (thinking, reads, commands), relayed so the tab reads like the terminal
- **work-turn results** — the agent's reply for the session that asked for it
- **card writes** — the ledger the agent keeps as it works (tasks filed, work
  logged, deliveries with their commit shas)
- **ship results** — what the merge did, and the branch's commits, when you ship
- **worktree diffstats** — branch, commits ahead of base, and per-file +/− counts
- **commit diffs** — the patch for one commit, fetched only when somebody clicks
  that sha in the app
- **local-session presence metadata** — that a Claude Code session is held at
  this machine's own keyboard in this repo, and its title. Never its transcript
- **wiki vault syncs** — the generated codebase notes

It talks to no third party except the CLIs above and, for a shared preview, a
`cloudflared` tunnel it opens in front of a dev server *you* started (Flowviant
stores only the tunnel URL string; your browser connects to it directly, through
a mandatory password gate).

## Permissions

By default the agent runs unattended (`claude --dangerously-skip-permissions`) so
it doesn't stall with no terminal. Set `FLOWVIANT_SAFE=1` to restrict it to a
curated toolset instead. Run it only inside a repository you intend agents to
work.

**Every project member with edit access executes code on this machine, with the
daemon's own OS permissions.** A project has ONE machine serving the whole team's
sessions, so opening a Workbench tab runs a coding agent here as whichever OS
user started the daemon. Membership is the consent boundary — the same trust
plane as the shared repository. Invite people you would give a shell to, and see
[README.md](./README.md#security-posture) for the two knobs that bound the blast
radius (a dedicated OS user, and `FLOWVIANT_SAFE=1`).

## Reporting a vulnerability

Please report security issues privately to **security@flowviant.com** rather than
opening a public issue.
