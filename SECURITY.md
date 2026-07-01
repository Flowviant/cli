# Security

This is the open-source daemon that runs Flowviant's build agents **on your own
machine, on your own credentials**. It's public precisely so you can verify what
it does before running it — nothing here should be taken on trust.

## What it does with your credentials: nothing

The daemon **never sees, stores, or transmits** your Claude or GitHub logins. It
drives CLIs *you* authenticated yourself by shelling out to them:

- **Claude** — it invokes your locally signed-in `claude` (via the Claude Agent
  SDK / CLI). Your Claude subscription pays for the work; no API key is handled
  by this daemon, and `ANTHROPIC_API_KEY` is explicitly stripped from the child
  environment so a key in your shell can't divert usage.
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
