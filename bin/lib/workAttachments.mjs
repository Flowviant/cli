/**
 * FILES THE HUMAN ATTACHED, downloaded into the place a turn runs in.
 *
 * Split out of work.mjs (2026-09-26, SOLID F037). One trust boundary — a
 * server-sent name becoming a path on somebody's machine — with its caps, its
 * collision rule and its git exclude, reached from the session lane
 * (`fetchAttachments`) and, since 0.112.0, the agent lane (`fetchAgentFiles`:
 * the files on an answer, a send-back or the card's notes). ONE download loop
 * serves both, so the two lanes cannot disagree about what a safe name is.
 * The name rule itself is safeFileName.mjs's.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FLEET_URL, FLEET_TOKEN, USER_AGENT } from './config.mjs';
import { excludeInWorktree } from './git.mjs';
import { FLOWVIANT_OWN_PATHS } from './knowledgeLibrary.mjs';
import { safeFileName } from './safeFileName.mjs';
import { fleetEndpoint } from './fleetWire.mjs';
import { readAgentFiles } from './agentFiles.mjs';

/**
 * ONE FILE'S CEILING, for both lanes (0.113.0, the owner 2026-09-29: "20 MB
 * for every file"). The server's `ATTACHMENT_MAX_BYTES` (the app's
 * fieldCaps.ts), held equal by the release gate (`scripts/check-app-parity.mjs`,
 * rule 11): a tighter copy here skips a file the person watched go out — which
 * is what 0.112.0's 10 MB did to anything bigger, and why the server floors a
 * file over 10 MB at this release (`DAEMON_LARGE_FILES_MIN`).
 */
export const ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;

export function createWorkAttachments() {
  /**
   * WHERE THE BYTES COME FROM, by lane: the Terminal's `/fleet/attachment/:id`
   * (a session's uploads) and the agent lane's `/fleet/agent-file/:id` (a
   * card conversation's, 0.112.0). Same shape — the machine credential, the
   * bytes streamed, 404/410 when gone — and a different store behind each.
   */
  const FILE_URL = {
    attachment: fleetEndpoint('attachment', FLEET_URL),
    'agent-file': fleetEndpoint('agent-file', FLEET_URL),
  };
  /**
   * FILES THE HUMAN ATTACHED, brought to where a CLI can read them.
   *
   * A screenshot in a chat bubble is useless to an agent; a path is not. So the
   * turn's attachments are downloaded into `.flowviant/uploads/` inside the
   * session's own worktree and the prompt is handed the relative paths.
   *
   * `.flowviant/` rather than the repo proper, and gitignored-or-not it is
   * never committed by us: these are the human's inputs to a conversation, not
   * project files. The name is re-sanitized HERE even though the server already
   * did it — this string becomes a path on someone's machine, and one place
   * doing that check is one deploy away from being zero places.
   */
  const UPLOAD_DIR = '.flowviant/uploads';
  // `safeFileName` (bin/lib/safeFileName.mjs — the server's rule, one daemon
  // home): THE EXTENSION SURVIVES A CUT, and it is idempotent over its own
  // output, so re-applying it to what the server already sanitized is a no-op
  // and the two sides never disagree about the cut. An empty name is
  // `attachment`, the server's own fallback.
  const safeUploadName = (raw) => safeFileName(raw, 'attachment');
  /** The file at `path` holds exactly `buf` — read only when the sizes agree. */
  const holds = (path, buf) => {
    try {
      return statSync(path).size === buf.byteLength && readFileSync(path).equals(buf);
    } catch {
      return false;
    }
  };
  /**
   * THE ONE DOWNLOAD LOOP. Each entry's relative path, or null where it did
   * not land — aligned with `list`, so a caller can say which file is missing.
   * `endpoint` names the route (`FILE_URL`). `sameBytesKept` is the agent
   * lane's: a turn about a card is handed the card's files EVERY turn, into
   * one long-lived worktree, and without it the second turn's copy of
   * `mock.png` collided with the first's and was renamed `mock-<id6>.png` — one
   * file under two names, the prompt naming a different one each turn. A name
   * already holding these exact bytes IS this file. The Terminal's loop never
   * asks it: a tab's message carries its files once, and its answer stays
   * what it was.
   */
  const landFiles = async (wt, list, endpoint, sameBytesKept) => {
    const dir = join(wt, UPLOAD_DIR);
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      return list.map(() => null);
    }
    // "Never committed by us" has to be true for GIT, not just for this code:
    // an untracked `.flowviant/` makes the whole worktree dirty, which refuses
    // every ship, exempts the tree from closed-tab retirement forever, and
    // shows the human's own uploads in the rail as session changes. Same
    // mechanism the materialized env files used until the vault was deleted —
    // the exclude file git actually reads (git.mjs, where the helper moved when
    // env.mjs shrank), which already skips lines it has written before, so
    // calling it per fetch is idempotent. NARROWED 2026-09-23 to the paths
    // this daemon writes (`FLOWVIANT_OWN_PATHS`, knowledgeLibrary.mjs says why): the
    // whole-directory line also hid a repo's own new `.flowviant/check.json`
    // from its agent's `git add -A`.
    excludeInWorktree(wt, FLOWVIANT_OWN_PATHS);
    const landed = [];
    for (const a of list) {
      landed.push(null);
      if (!a?.id || typeof a.id !== 'string' || !/^[0-9a-f-]{8,64}$/i.test(a.id)) continue;
      if (Number(a.size) > ATTACHMENT_MAX_BYTES) continue;
      try {
        const res = await fetch(`${FILE_URL[endpoint]}/${a.id}`, {
          headers: { Authorization: `Bearer ${FLEET_TOKEN}`, 'User-Agent': USER_AGENT },
          signal: AbortSignal.timeout(60_000),
        });
        if (!res.ok) continue;
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.byteLength === 0 || buf.byteLength > ATTACHMENT_MAX_BYTES) continue;
        // Collisions are real (two screenshots both named Screenshot.png), and
        // silently overwriting one with the other loses a file the human sent.
        let name = safeUploadName(a.name);
        let already = sameBytesKept && holds(join(dir, name), buf);
        if (!already && existsSync(join(dir, name))) {
          const dot = name.lastIndexOf('.');
          const stem = dot > 0 ? name.slice(0, dot) : name;
          const ext = dot > 0 ? name.slice(dot) : '';
          name = `${stem}-${String(a.id).slice(0, 6)}${ext}`;
          already = sameBytesKept && holds(join(dir, name), buf);
        }
        if (!already) writeFileSync(join(dir, name), buf);
        landed[landed.length - 1] = `${UPLOAD_DIR}/${name}`;
      } catch {
        /* one file failing must not fail the turn — the prompt lists what
           actually arrived, so the agent never chases a path that isn't there */
      }
    }
    return landed;
  };

  /** @returns relative paths written, in the order the human attached them. */
  const fetchAttachments = async (wt, attachments) => {
    if (!Array.isArray(attachments) || attachments.length === 0) return [];
    return (await landFiles(wt, attachments.slice(0, 8), 'attachment', false)).filter(Boolean);
  };

  /**
   * AN AGENT TURN'S FILES (0.112.0), read off the wire (agentFiles.mjs: each
   * origin at the server's cap, message files first) and fetched from
   * `/fleet/agent-file/:id` into the agent's own worktree.
   *
   * Split by where the prompt prints them, and each entry says whether it
   * LANDED: `{ path }` for a file on disk, `{ missed: name }` for one that did
   * not arrive. Unlike the Terminal, which lists only what arrived, a miss is
   * NAMED: a tab's person is watching the reply and re-attaches; a person who
   * answered a parked agent "like this" with a screenshot is not, and an agent
   * told nothing reads "like this" with no referent and guesses. Told the file
   * could not be fetched, it can say so in its answer. Never a path for a
   * miss, so it still never chases one.
   *
   * @returns {Promise<{ message: Array<{path: string}|{missed: string}>, card: Array<{path: string}|{missed: string}> }>}
   */
  const fetchAgentFiles = async (wt, attachments) => {
    const out = { message: [], card: [] };
    const list = readAgentFiles(attachments);
    if (list.length === 0) return out;
    const landed = await landFiles(wt, list, 'agent-file', true);
    list.forEach((a, i) => out[a.from].push(landed[i] ? { path: landed[i] } : { missed: safeUploadName(a.name) }));
    return out;
  };

  return { fetchAttachments, fetchAgentFiles };
}
