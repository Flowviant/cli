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
- **GitHub** — it uses your authenticated `gh` and `git` for branches and PRs.

The only credential the daemon holds is a **Flowviant fleet token**, scoped to a
single project, stored locally at `~/.flowviant/credentials.json` (mode `600`)
after `flowviant login`. It authenticates *to Flowviant*, never to Anthropic or
GitHub.

## What it sends to Flowviant

Over HTTPS to the Flowviant API only: which task it claimed, progress notes, PR
links, acceptance-evidence you can review, blocker questions, and (in live mode)
the agent's streamed output for the task conversation. It talks to no third party
except the CLIs above and, for optional live previews, a `cloudflared` tunnel it
opens to your own dev server (Flowviant stores only the tunnel URL string; your
browser connects to it directly).

## Permissions

By default the agent runs unattended (`claude --dangerously-skip-permissions`) so
it doesn't stall with no terminal. Set `FLOWVIANT_SAFE=1` to restrict it to a
curated toolset instead. Run it only inside a repository you intend agents to
work.

## Reporting a vulnerability

Please report security issues privately to **security@flowviant.com** rather than
opening a public issue.
