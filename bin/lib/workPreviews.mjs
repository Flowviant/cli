/** Session preview claims, tunnels, and retirement. */
import { FLEET_URL, FLEET_TOKEN, USER_AGENT, DAEMON_INSTANCE } from './config.mjs';
import { isSafePathSegment } from './git.mjs';
import { originFor } from './listeners.mjs';
import { openTunnel } from './preview.mjs';
import { note } from './ui.mjs';

export function createWorkPreviews({ placeDir }) {
  const PREVIEW_DONE_URL = FLEET_URL.replace(/\/agents\/?$/, '/preview-done');
  const PREVIEW_CLAIM_URL = FLEET_URL.replace(/\/agents\/?$/, '/preview-claim');

  // ── SESSION PREVIEWS ──────────────────────────────────────────────────────
  //
  // Share the dev server the DRIVER is already running in their tab, behind a
  // generated password, on a quick tunnel. This daemon never starts an app: the
  // deleted live-preview feature ran a repo-declared command through a shell,
  // and that is the reason it is deleted. Here the human runs their own server,
  // `listenersIn` notices it, and this only ever wraps a port that measurement
  // already named for that session.
  //
  // CLAIM BEFORE ACTING. Two daemons legitimately share one fleet credential —
  // the case `machineDaemonsDisagree` exists because it happens, and the 0.51.2
  // instance lock is blind to an OLDER peer — so both are handed the same job
  // array. Both opening a tunnel leaves a public hostname alive that nobody
  // owns and nobody can tear down, because only the lease holder can settle the
  // row. `processDiffJobs` gets away without this because running `git show`
  // twice costs nothing.
  const livePreviews = new Map(); // sessionId -> { port, shareId, url, stop }
  const previewClaiming = new Set(); // sessionIds mid-claim on this tick

  // Returns the parsed JSON (or null on any failure) rather than discarding
  // it — an OPEN settle's caller needs to see `data.settled === false`, the
  // sharper share-id check on the server's side of a re-share racing the
  // open's own round trip (see the openTunnel call site below).
  const postPreview = async (body) => {
    try {
      const res = await fetch(PREVIEW_DONE_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${FLEET_TOKEN}`,
          'User-Agent': USER_AGENT,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(30_000),
        body: JSON.stringify({ ...body, instance: DAEMON_INSTANCE }),
      });
      return await res.json().catch(() => null);
    } catch {
      /* the row stops being confirmed and reads as ended — which is true */
      return null;
    }
  };

  // `shareId` is the share the daemon was OFFERED, echoed off the job. A
  // re-share inside the claim's round trip rotates the id server-side, so a
  // claim naming the old one matches nothing and this daemon opens no tunnel
  // for a request that no longer exists. Absent-safe: an older server that
  // does not read the field just claims on the place alone, the old rule.
  const claimPreview = async (sessionId, shareId) => {
    try {
      const res = await fetch(PREVIEW_CLAIM_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${FLEET_TOKEN}`,
          'User-Agent': USER_AGENT,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(15_000),
        body: JSON.stringify({ sessionId, instance: DAEMON_INSTANCE, ...(shareId ? { shareId } : {}) }),
      });
      const j = await res.json().catch(() => null);
      return j?.data?.claimed === true;
    } catch {
      return false; // could not claim → do nothing at all. The other daemon may have.
    }
  };

  /** Tear one down here, and say so. `reason` is why, stored server-side rather
   *  than inferred: "the origin stopped listening" and "the owner pressed Stop"
   *  are different sentences to a teammate holding a phone. */
  const stopPreview = async (sessionId, reason) => {
    const live = livePreviews.get(sessionId);
    livePreviews.delete(sessionId);
    if (live) {
      try {
        live.stop();
      } catch {
        /* best-effort */
      }
    }
    // Confirm only a teardown we actually PERFORMED. The stop job is a
    // broadcast — every daemon on the credential gets it — and the one holding
    // nothing used to answer instantly, flipping the row to 'ended' so the
    // real holder was never told to stop and its tunnel outlived every
    // surface. (The server drops mismatched confirms too; this is the copy on
    // the component that can be published ahead of a deploy.) A stop for a
    // tunnel whose daemon crashed resolves server-side: an unanswered 'ending'
    // row reads as over once it goes stale.
    if (live) await postPreview({ sessionId, ended: true, endedReason: reason });
  };

  const processPreviewJobs = (jobs) => {
    if (!Array.isArray(jobs) || jobs.length === 0) return;
    for (const job of jobs.slice(0, 5)) {
      const sessionId = String(job?.sessionId || '');
      const port = Number(job?.port);
      if (!isSafePathSegment(sessionId)) continue;

      if (job?.action === 'stop') {
        if (previewClaiming.has(sessionId)) continue;
        previewClaiming.add(sessionId);
        void stopPreview(sessionId, 'stopped').finally(() => previewClaiming.delete(sessionId));
        continue;
      }

      if (!Number.isInteger(port) || port <= 0 || port > 65535) continue;

      // VALIDATE THE MEMBERS-GATE TRIPLE AT THE BOUNDARY, the way sessionId and
      // port already are — one place doing the check is one deploy away from
      // being zero places. A malformed value is DROPPED rather than errored and
      // the share opens password-only: a gate is never degraded to open, but it
      // is also never left un-opened over a field we could not read.
      const secret = /^[A-Za-z0-9_-]{32,128}$/.test(String(job?.secret ?? ''))
        ? String(job.secret)
        : null;
      const shareId = isSafePathSegment(String(job?.shareId ?? '')) ? String(job.shareId) : null;
      let authorizeUrl = null;
      try {
        const u = new URL(String(job?.authorizeUrl ?? ''));
        if (u.protocol === 'https:') authorizeUrl = u.toString();
      } catch {
        /* not a URL — password-only, which is honest */
      }
      // All three or none: two of the three is a gate that cannot bounce.
      const gateOk = Boolean(secret && shareId && authorizeUrl);

      // Already serving exactly this. Re-opening would replace a working URL
      // somebody may be looking at right now.
      //
      // NOTE this key is (session, port) and NOT the secret. Rotating a secret
      // under a LIVE share is deliberately unsupported: `requestPreview`
      // early-returns on a live row of the same port, so a new secret only ever
      // arrives with a genuinely new row, by which time this map has been
      // cleared. Anyone adding rotation must widen the key first.
      //
      // WIDENED for shareId: a live entry that has no shareId of its own (an
      // older server, or one opened before shareId rode the wire) or this
      // job's own shareId that is blank still matches on port alone, the old
      // rule — but a live entry whose shareId is SET and DIFFERS from this
      // job's is a re-share of the same port under a NEW request, and must
      // not be skipped as "already serving exactly this".
      const curLive = livePreviews.get(sessionId);
      if (curLive?.port === port && (!shareId || !curLive.shareId || curLive.shareId === shareId))
        continue;
      if (previewClaiming.has(sessionId)) continue;
      previewClaiming.add(sessionId);

      void (async () => {
        try {
          if (!(await claimPreview(sessionId, shareId))) return; // somebody else has it
          const wt = placeDir(sessionId);
          // RE-VALIDATE the attribution here, not just the liveness. The server
          // checked this port against a report up to a minute old; more
          // importantly, checking `originFor` again is what keeps the answer
          // to "whose port is this" on the machine that can actually see it —
          // the same rule the gate itself dials by (below).
          const measured = !originFor(wt, port).error;
          if (!measured) {
            await postPreview({
              sessionId,
              error: `nothing is listening on port ${port} in this worktree.`,
              ...(shareId ? { shareId } : {}),
            });
            return;
          }
          // Replace anything this session already had — one tab, one door.
          const prev = livePreviews.get(sessionId);
          if (prev) {
            try {
              prev.stop();
            } catch {
              /* best-effort */
            }
            livePreviews.delete(sessionId);
          }
          const t = await openTunnel({
            port,
            log: (m) => note(`preview ${sessionId.slice(0, 8)}: ${m}`),
            // The worktree the port was attributed to — the gate then dials
            // the address the ATTRIBUTED socket holds (`originFor`, ::1 for a
            // v6-loopback dev server) and refuses when an outside process
            // holds the same address, rather than assuming 127.0.0.1.
            worktree: wt,
            // The origin died under a live tunnel. cloudflared happily outlives
            // a dead dev server and the gate answers a dead origin with 502, so
            // without this the app would print "live" over a 502.
            onDead: () => {
              livePreviews.delete(sessionId);
              void postPreview({
                sessionId,
                ended: true,
                endedReason: 'origin_gone',
                ...(shareId ? { shareId } : {}),
              });
            },
            // ATTRIBUTION rides the probe, not just the open: a freed default
            // port (5173…) rebound by any other process on the box would keep
            // a bare TCP probe green, and the share's URL+password would serve
            // a worktree nobody consented to publish.
            stillServing: async () => !originFor(wt, port).error,
            ...(gateOk ? { grantSecret: secret, shareId, authorizeUrl } : {}),
            // The gate closed itself after repeated failed passwords. Stored,
            // so the incident is visible — and the entry is dropped so the
            // owner can re-share the port without restarting the daemon.
            onAbuse: () => {
              livePreviews.delete(sessionId);
              void postPreview({
                sessionId,
                ended: true,
                endedReason: 'abuse',
                ...(shareId ? { shareId } : {}),
              });
            },
            // cloudflared died AFTER publishing (quick tunnels get dropped).
            // Without this the daemon kept heartbeating a hostname that 530s.
            onTunnelGone: () => {
              livePreviews.delete(sessionId);
              void postPreview({
                sessionId,
                error: 'the tunnel dropped — share it again to reopen.',
                ...(shareId ? { shareId } : {}),
              });
            },
          });
          if (t.error) {
            await postPreview({ sessionId, error: t.error, ...(shareId ? { shareId } : {}) });
            return;
          }
          livePreviews.set(sessionId, { port, shareId, url: t.url, stop: t.stop });
          // The gate we ACTUALLY installed, so the app never asserts a door
          // nobody observed. An older server ignores the field.
          const settled = await postPreview({
            sessionId,
            url: t.url,
            user: t.user,
            password: t.password,
            gate: t.gateMode,
            ...(shareId ? { shareId } : {}),
          });
          // A re-share (or a Stop) can land inside this open's own round
          // trip and rotate the share id server-side — the settle is then
          // refused for naming a request that no longer exists, and nobody
          // holds a live row for the tunnel we just opened. Tear it down
          // rather than leave a public hostname serving with no door back to
          // it, and only if this call is still the entry's own (a newer open
          // for the same session must not be undone by a late-arriving
          // settle for an older one).
          if (settled?.data?.settled === false) {
            if (livePreviews.get(sessionId)?.stop === t.stop) livePreviews.delete(sessionId);
            try {
              t.stop();
            } catch {
              /* best-effort */
            }
          }
        } finally {
          previewClaiming.delete(sessionId);
        }
      })();
    }
  };

  /** The sessionIds this machine is still serving — sent on the poll so the
   *  server can tell a live share from one whose machine went away. Silence
   *  must never read as "live". */
  /**
   * The daemon's own shape check on an argv the server parsed.
   *
   * Deliberately a SHAPE check and not a re-parse: the server owns the policy
   * (which argv[0] are allowed, the install refusal, the length caps) and the
   * machine owns the refusal to EXECUTE something malformed. It is duplicated
   * rather than imported because this package ships standalone and cannot
   * depend on the monorepo — the mirror is small, and `devCommand.ts` is where
   * the real rules live.
   */
  const isPlausibleDevArgv = (argv) =>
    Array.isArray(argv) &&
    argv.length > 0 &&
    argv.length <= 8 &&
    argv.every((a) => typeof a === 'string' && a.length > 0 && a.length <= 200) &&
    !argv.some((a) => /[&|;<>`$(){}*?~\\]/.test(a));

  // ── DEV RUNS ARE DELETED (2026-08-26) ─────────────────────────────────
  //
  // The machine no longer starts application processes. It never learned to
  // decide what "run dev" means for a stack nobody enumerated — `rojo serve`
  // and `rbxtsc -w` are both correct for one Roblox repo and neither could
  // clear the server's argv0 allowlist, and widening that list is a code change
  // per ecosystem forever.
  //
  // Nothing downstream is lost, because SHARING NEVER DEPENDED ON US STARTING
  // IT. `listenersIn` attributes a listening socket to a place by the cwd of
  // the process holding it, so a server the driver's own agent started in the
  // tab is measured exactly like one this file used to spawn. The web renders
  // that measured list and a person picks which port to share.
  //
  // Gone with it: `devServer.mjs`, `devResolve.mjs`, the four `/fleet/dev-run-*`
  // endpoints, the claim lease, the orphan registry at ~/.flowviant/devruns.json
  // and its adopt-across-re-exec dance. If supervision is ever wanted back it
  // returns as "supervise this process", never as "run dev".

  const livePreviewIds = () => [...livePreviews.keys()];

  /**
   * The tab closed (or the server stopped listing it). Ordered BEFORE
   * `retireWorkSessions`, and that ordering is load-bearing: `git worktree
   * remove` under a running dev server reintroduces the stale-server bug — on
   * Linux the process keeps serving bytes from open file handles in a directory
   * that no longer exists, which shows a human the wrong thing without erroring
   * anywhere.
   */
  const retirePreviews = (activeIds) => {
    // Same guard `retireWorkSessions` keeps: a roster response missing the
    // field is an older server, not a close, and must not tear down every live
    // share at once.
    if (!Array.isArray(activeIds)) return;
    const live = new Set(activeIds);
    for (const sessionId of [...livePreviews.keys()]) {
      if (live.has(sessionId)) continue;
      if (previewClaiming.has(sessionId)) continue;
      previewClaiming.add(sessionId);
      void stopPreview(sessionId, 'tab_closed').finally(() => previewClaiming.delete(sessionId));
    }
  };

  /** Daemon shutdown. Detached tunnels survive our exit by design, so leaving
   *  them would strand a public hostname until the box rebooted — the exact
   *  case `reapOrphanPreviews` exists to clean up after an UNgraceful death. */
  const shutdownPreviews = () => {
    for (const [, live] of livePreviews) {
      try {
        live.stop();
      } catch {
        /* best-effort */
      }
    }
    livePreviews.clear();
  };

  return { processPreviewJobs, livePreviewIds, retirePreviews, shutdownPreviews };
}
