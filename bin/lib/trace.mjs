/**
 * THE WHOLE TURN, RELAYED — "watch it work".
 *
 * An agent turn already streams everything it does: the CLI prints its
 * thinking, its narration and every tool call, `runTurn` parses all of it, and
 * the agent lane read exactly ONE line out of that stream every two seconds,
 * overwrote the previous one, and threw the rest away. So the board could say
 * an agent was reading a file and never what it had read before that — which is
 * the difference between a spinner with a caption and watching Claude Code.
 *
 * This is the second, DURABLE channel for the same stream. The one-line pulse
 * (`/fleet/agent-activity`) is untouched and still sent: it carries staleness —
 * "the machine last spoke 40 seconds ago" — which an append-only list of steps
 * cannot, because a list that stopped growing and a list that is complete look
 * identical.
 *
 * ── FOUR RULES, AND EACH ONE IS LOAD-BEARING ──
 *
 * ORDER IS THE CONTRACT. Batches are serialized through an await chain, never
 * fired in parallel: the server appends what arrives, so two POSTs in flight at
 * once would interleave a turn's steps into a sequence that never happened.
 *
 * SEQ IS ABSOLUTE, AND DROPS ADVANCE IT. Every entry accepted here gets an
 * index in this turn's whole stream, whether it is sent or shed from a full
 * buffer. That makes a retry idempotent — the server trims what it already has
 * against its high-water mark rather than appending it twice — and it makes a
 * GAP visible: the server's "N earlier steps aren't shown" is computed from the
 * distance between the high-water mark and what it kept, so a daemon-side drop
 * and a server-side prune are reported as the same honest sentence instead of
 * one of them being silent.
 *
 * …AND IT IS ABSOLUTE WITHIN ONE RUN, WHICH IS WHY EVERY BATCH NAMES ITS RUN.
 * The counter lives in this closure, and this closure is built fresh inside
 * `runAgentTurn`; the server's high-water mark lives on the TURN ROW and
 * outlives any number of attempts at it. A turn is re-run whenever the daemon
 * restarts mid-turn, is taken over, or throws after the CLI ran but before the
 * settle — the server hands the identical turn back on the next poll — and the
 * second attempt then opened at `seq: 0` against a mark of three hundred, so
 * every batch it sent was trimmed to nothing and the surface showed the
 * ABANDONED attempt's steps with the new one's tail welded on, no seam, no
 * `dropped` to say so. `run` is a nonce per relay: the server rebases an
 * unfamiliar one onto its current mark, so a second attempt appends AFTER the
 * first instead of being deleted by it, and a retry inside one run still trims
 * exactly as before.
 *
 * SCRUB EVERY STRING. This is the CLI's own stdout — a command echoing an env
 * var, a read of a config file — riding the same uplink the answer does. Prose
 * is scrubbed here; a tool event arrives already scrubbed by `toolEventOf`,
 * which does it over a bounded window BEFORE its own caps for reasons its
 * header states.
 *
 * IT IS A READOUT AND MUST NEVER FAIL A TURN. Every failure is swallowed, the
 * timer is unref'd, and the final flush is bounded — a wedged uplink costs the
 * tail of a trace, never the settle behind it.
 */

import { THINK_MARKER } from './runtimes.mjs';

/** One batch every two seconds — the discipline the tab's narrator keeps, for
 *  the same reason: a turn emits hundreds of entries and nobody is reading them
 *  faster than that. */
export const TRACE_FLUSH_MS = 2_000;
/** Entries per POST. Matches the server's own per-batch cap. */
export const TRACE_BATCH = 40;
/** Entries held while the uplink is down. Past this the OLDEST go: a trace is
 *  scrollback, and the newest steps are the ones somebody watching wants. The
 *  drop is not silent — see the seq rule above. */
export const TRACE_BUFFER = 120;
/**
 * Longest prose entry. The server clamps to the same number
 * (`agentTrace.ts.TRACE_PROSE_CAP`); doing it here too means a pathological line
 * never becomes the POST. The two must move together — daemon at or below the
 * server's, or the server silently does the cutting and this file's caps stop
 * describing what ships.
 *
 * 300 UNTIL 2026-09-16, when it was the thing clipping sentences. A trace entry
 * used to be the humanized 160-char label the console prints, so a 300 cap could
 * not bite; it now carries the FULL text of what the CLI said or thought, and at
 * 300 a paragraph of narration was cut mid-sentence. The real bound is the
 * TURN's (400 entries / 96KB server-side, oldest shed with the count said out
 * loud) — a long thought spends budget older steps would have held, and an
 * admitted shed beats a silent clip.
 */
export const TRACE_PROSE_CAP = 4_000;

/**
 * ONE ATTEMPT AT ONE TURN, named.
 *
 * Short on purpose — it is an equality check and nothing else, never an id
 * anybody resolves — and random rather than a counter, because the thing it has
 * to be distinct from is the PREVIOUS PROCESS's attempt at the same turn, which
 * a counter restarting at zero would collide with every time.
 */
function newRunId() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

/**
 * `post(body)` delivers one batch and resolves truthy when the entries may be
 * forgotten — which deliberately includes a permanent refusal (an older server
 * with no such route, a body the server will never accept). Resolving falsy
 * keeps them queued for the next flush.
 */
export function makeTraceRelay({ agentId, turnId, post, scrub = (s) => s, run = newRunId() }) {
  /** Entries not yet delivered. `base` is the ABSOLUTE index of queue[0] in
   *  THIS RUN's stream, so `base + queue.length` is everything this relay has
   *  ever accepted — sent, queued or shed. Absolute for the TURN is the
   *  server's business: it rebases each run onto its own high-water mark. */
  const queue = [];
  let base = 0;
  /** The last entry this relay ACCEPTED, kept across flushes and across a shed
   *  buffer — `queue[queue.length - 1]` is not the same thing, because a flush
   *  empties the queue and a batch boundary is not a change in the stream. Read
   *  by the bare-marker collapse in `prose()` and nothing else. */
  let lastEntry = null;
  let dirty = false;
  let timer = null;
  let stopped = false;
  /** The await chain. Every flush appends to it, so batches leave in order
   *  however many callers ask at once. */
  let chain = Promise.resolve();

  const schedule = () => {
    if (timer || stopped || !dirty) return;
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, TRACE_FLUSH_MS);
    timer.unref?.(); // never hold the process open for a readout
  };

  const push = (entry) => {
    if (stopped || !entry) return;
    lastEntry = entry;
    queue.push(entry);
    while (queue.length > TRACE_BUFFER) {
      queue.shift();
      base += 1; // the shed entry keeps its index — the gap is the record
    }
    dirty = true;
    schedule();
  };

  const drain = async (deadlineMs) => {
    const until = deadlineMs > 0 ? Date.now() + deadlineMs : 0;
    while (queue.length) {
      if (until && Date.now() > until) {
        dirty = true;
        return;
      }
      const entries = queue.slice(0, TRACE_BATCH);
      const seq = base;
      dirty = false;
      let ok = false;
      try {
        ok = (await post({ agentId, turnId, run, seq, entries })) !== false;
      } catch {
        ok = false;
      }
      if (!ok) {
        // Held, at the SAME seq: a retry the server has already seen is
        // trimmed against its high-water mark rather than doubled.
        dirty = true;
        return;
      }
      queue.splice(0, entries.length);
      base += entries.length;
    }
  };

  const flush = (deadlineMs = 0) => {
    chain = chain.then(() => drain(deadlineMs)).catch(() => {});
    const done = chain;
    void done.then(() => {
      if (dirty) schedule();
    });
    return done;
  };

  return {
    /**
     * A prose line from the stream. `kind` is the daemon's activity vocabulary
     * (runtimes.mjs); anything that is not thinking or the model speaking is a
     * `note` — the honest bucket for a codex error line or an agy tool name,
     * rather than a wire value invented per runtime.
     *
     * THE NEWLINES SURVIVE (2026-09-16). This used to be `\s+ → ' '`, which was
     * right while an entry WAS a one-line label and wrong the moment the caller
     * started handing over the whole of what the CLI said: a model writes in
     * paragraphs and lists, and flattening them here is the relay deciding how
     * the agent's own words should be shaped. So only HORIZONTAL runs collapse,
     * and a wall of blank lines becomes one — that second rule is not cosmetic,
     * it stops padding eating the cap that the real sentences need.
     *
     * The scrub still runs over the WHOLE text, before the cap: this is the
     * CLI's own stdout, and a secret in a thought must not ride further than it
     * did when a thought was 300 characters.
     */
    prose(kind, text) {
      const t = scrub(String(text ?? ''))
        // One line ending, whatever the CLI printed.
        .replace(/\r\n?/g, '\n')
        // Spaces and tabs collapse; `\n` is deliberately excluded from the class.
        .replace(/[^\S\n]+/g, ' ')
        // Three or more breaks in a row — two or more blank lines — become one.
        .replace(/\n{3,}/g, '\n\n')
        .trim()
        .slice(0, TRACE_PROSE_CAP);
      if (!t) return;
      const k = kind === 'think' ? 'think' : kind === 'say' ? 'say' : 'note';
      /**
       * A RUN OF BARE "thinking…" IS ONE STEP, not forty.
       *
       * Claude emits a thinking block per burst and (measured 2026-09-16, three
       * real transcripts: 93 blocks, all of them empty) carries no text in any
       * of them — so the trace filled with the identical marker repeated, which
       * is noise standing exactly where the thought would have been. The wiki
       * feed collapses the same run for the same reason (fleet.mjs: "Collapse
       * runs of bare 'thinking…' so the feed doesn't fill with it").
       *
       * ONLY THE BARE MARKER, and that is the whole safety of it: a think WITH
       * text is never equal to it, so no real thought is ever eaten — the day
       * the CLI starts emitting thinking text, every one of those blocks lands
       * whole beside the others.
       *
       * A collapsed marker is NOT a drop: it never becomes an entry, so it
       * never takes a seq, exactly like the empty line above it. The "N earlier
       * steps are not shown" count stays a count of steps that existed.
       */
      if (k === 'think' && t === THINK_MARKER && lastEntry?.k === 'think' && lastEntry.t === t) {
        return;
      }
      push({ k, t });
    },
    /** One structured tool event, exactly as `toolEventOf` built it. A tool this
     *  builder does not know returns null there and nothing is pushed here — a
     *  card is never invented. */
    tool(e) {
      if (e && typeof e === 'object') push({ k: 'tool', e });
    },
    flush,
    /** No more entries, no more timers. The queue survives so a final flush can
     *  still deliver it. */
    stop() {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
    /** For tests and nothing else: what has been accepted, where the next batch
     *  would start, and which attempt this relay is. */
    stats() {
      return { run, seq: base, queued: queue.length, emitted: base + queue.length };
    },
  };
}
