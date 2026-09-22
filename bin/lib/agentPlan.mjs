/**
 * READING A MODEL'S ANSWER, in the agent lane's three shapes: a planner's
 * PROPOSAL, an agent's own TURN RESULT, and (2026-09-16) the AI pre-review's
 * TRIAGE.
 *
 * The scratch agent behind a Deploy press is asked for one JSON object and
 * nothing else. This is what turns its final message into a proposal, and it is
 * its own module because it is the one piece of that turn that can quietly LIE:
 * everything else either works or throws, while a half-parsed proposal renders
 * as a plausible-looking board somebody accepts.
 *
 * LENIENT ON PACKAGING, STRICT ON SHAPE.
 *
 * A model asked for one object will sometimes fence it and sometimes not, and
 * sometimes say "Here you go:" first. Refusing the whole plan over that spends
 * the operator's own model quota to produce nothing, so the packaging is
 * forgiven. What is NOT forgiven is the shape: an agent holding no cards, a
 * `taskIds` that is not an array of strings, or no agents at all is a proposal
 * nobody can accept, and `null` — which the caller reports in the machine's own
 * words — beats rendering an empty board with an Accept button on it.
 *
 * Every string is CAPPED here rather than downstream. This text is model
 * output about untrusted card content, and it becomes a row.
 *
 * Run: node --test bin/lib/agentPlan.test.mjs
 */

/** The biggest a single proposal may be. Bounds on a machine, not a policy:
 *  the server caps these again at its own boundary. */
const MAX_AGENTS = 20;
const MAX_TASKS_PER_AGENT = 60;
const MAX_NAME = 80;
const MAX_NOTE = 1000;

/**
 * Find the objects.
 *
 * A fenced block first, because that is what was asked for. Otherwise every `{`
 * in the text is tried as a start, and its BALANCED end is found by counting
 * braces while skipping string literals — each caller then takes the first
 * candidate whose SHAPE is the one it asked for.
 *
 * The obvious cheap version — first `{` to last `}` — is wrong in a way a test
 * caught: a planner that writes "I looked at {the auth module} first" before its
 * JSON produces a span starting at the wrong brace, and the whole plan is lost
 * to a sentence. Scanning candidates costs nothing at this size and cannot be
 * defeated by prose.
 *
 * ONE SCANNER FOR ALL THREE READERS in this file (2026-09-16). It was written
 * twice — once here and once inline in `parseTurnResult` — and a third copy was
 * about to be written for the precheck. A brace scanner that skips string
 * literals is exactly the kind of thing where two copies quietly stop agreeing
 * about escapes and nobody notices, because the disagreement only shows up on a
 * card title with a quote in it.
 */
function candidateObjects(raw) {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const bodies = [];
  if (fenced) bodies.push(fenced[1]);
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== '{') continue;
    const end = balanced(raw, i);
    if (end > i) bodies.push(raw.slice(i, end + 1));
  }
  const out = [];
  for (const body of bodies) {
    if (!body.trim()) continue;
    try {
      const v = JSON.parse(body);
      if (v && typeof v === 'object') out.push(v);
    } catch {
      /* the next candidate may be the object */
    }
  }
  return out;
}

function extract(raw) {
  return candidateObjects(raw).find((v) => Array.isArray(v.agents)) ?? null;
}

/** The index of the `}` that closes the `{` at `from`, or -1. Skips string
 *  literals so a brace inside a card title cannot end the object early. */
function balanced(s, from) {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = from; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return i;
  }
  return -1;
}

export function parseProposal(text) {
  const raw = String(text ?? '');
  const parsed = extract(raw);
  if (!parsed) return null;

  const agents = [];
  for (const [i, g] of parsed.agents.slice(0, MAX_AGENTS).entries()) {
    if (!g || typeof g !== 'object') continue;
    const taskIds = Array.isArray(g.taskIds)
      ? g.taskIds.filter((t) => typeof t === 'string' && t.trim()).slice(0, MAX_TASKS_PER_AGENT)
      : [];
    // AN AGENT WITH NO CARDS IS NOT AN AGENT. Dropping it is right rather than
    // merely tidy: accepting one would create a worktree and a branch for
    // nothing, and it would sit in Working forever with an empty queue.
    if (taskIds.length === 0) continue;
    agents.push({
      tempId: String(g.tempId || `a${i + 1}`).slice(0, 64),
      name: String(g.name ?? '').slice(0, MAX_NAME),
      taskIds,
      ...(Number.isFinite(g.pointsBudget) && g.pointsBudget > 0
        ? { pointsBudget: Math.min(Math.round(g.pointsBudget), 100_000) }
        : {}),
      // NO `waitsOn`, AND ITS ABSENCE IS THE FEATURE (2026-09-16).
      //
      // The planner's schema used to carry it — tempIds of agents that had to
      // MERGE first — and the owner deleted the idea: "whats the point of
      // dividing up the agents if one of the agents rely on waiting for one to
      // finish? if thats the case have it be in the same agent." An agent
      // already works its cards in order, so a chain split across two agents
      // buys a second worktree, a second branch and a second review and then
      // idles one of them; the only thing a split buys is SIMULTANEOUS work.
      // SYSTEM_PLAN no longer mentions the key at all.
      //
      // So a model that emits it anyway is answering a schema it was not given
      // — an older prompt cached in a resumed conversation, or invention — and
      // reading it would create a silently-waiting agent through the exact door
      // the prompt just closed. DROPPED, not REFUSED: this file's own law is
      // lenient packaging, strict shape, and a stray key is packaging. The
      // proposal is otherwise good work the operator already paid for.
      //
      // The SERVER still accepts and honours `waitsOn` on the wire — 0.86.0
      // daemons are still proposing it and existing agents still carry it. This
      // is the end of PROPOSING one, not the end of reading one.
      ...(typeof g.intoAgentId === 'string' && g.intoAgentId
        ? { intoAgentId: g.intoAgentId.slice(0, 64) }
        : {}),
    });
  }
  if (agents.length === 0) return null;
  return {
    agents,
    ...(typeof parsed.note === 'string' && parsed.note.trim()
      ? { note: parsed.note.slice(0, MAX_NOTE) }
      : {}),
  };
}

/**
 * The running account, off whichever shape the turn ended with — `{ progress }`
 * or nothing at all.
 *
 * A SPREAD RATHER THAN A FIELD, so an absent account produces no key on the
 * result and therefore no key on the settle body. That is the whole contract
 * with the server: absence means KEEP the last account, and an empty string
 * sent instead would be indistinguishable from an agent saying the branch now
 * amounts to nothing.
 *
 * AN ABSURDITY BOUND HERE, NOT THE DISPLAY CAP (corrected 2026-09-22, in
 * review). This sliced to the wire's own 1000 first, which quietly INVERTED the
 * order the caller's own comment claims to keep: `envScrub` replaces EXACT
 * values, so handing it a paragraph already cut at 1000 hands it a credential
 * cut in half — it matches nothing and the surviving prefix ships. The scrub is
 * the only thing standing between a model that pasted a secret into its own
 * summary and the wire, and a cap must never run ahead of it. So this is the
 * same absurdity bound `summary` takes one line up (8000): enough that nothing
 * a model writes reaches the caller unbounded, far enough above the 1000 the
 * wire cuts to that the scrub always sees whole values. `work.mjs` scrubs and
 * THEN cuts to 1000, and the server clamps again because the wire never trusts
 * a machine to have clamped.
 */
const MAX_PROGRESS = 8000;
const progressOf = (v) => {
  const t = typeof v.progress === 'string' ? v.progress.trim() : '';
  return t ? { progress: t.slice(0, MAX_PROGRESS) } : {};
};

/**
 * READING AN AGENT'S ANSWER at the end of a turn.
 *
 * Same lenient-packaging / strict-shape rule as `parseProposal`, and the same
 * reason: the turn already ran and the operator already paid for it, so
 * refusing the whole thing over a stray "Here you go:" throws away real work.
 *
 * NULL IS A REAL ANSWER AND THE MOST IMPORTANT ONE. It means the turn declared
 * NEITHER delivered nor blocked — a signed-out CLI, a crash, an exhausted
 * quota, or a model that simply stopped — and the caller reports it as
 * `nothing`, which sends the agent to Stuck. Optimistic status from a machine
 * that quit is the one lie this board cannot afford, so anything ambiguous ends
 * up here rather than being read as success.
 *
 * ── AND IT CARRIES THE AGENT'S RUNNING ACCOUNT OF ITSELF (2026-09-22) ─────
 *
 * The owner: "we should add a brief summary of what the agent has done overall
 * at the top that updates." `progress` is one more key on the SAME object —
 * two or three cumulative sentences about the whole branch, rewritten fresh
 * every turn — and it is read here because this is where everything the agent
 * SAYS is already read. Nothing derives it: this file parses, it does not
 * summarise, and a daemon that read the turn log and wrote its own paragraph
 * would be the second brain the product forbids.
 *
 * ON BOTH SHAPES, because a turn that stopped to ask has still done work — an
 * agent that built three quarters of a feature and then needed a decision is
 * exactly the run whose account a person wants. It is NOT read off an
 * unparseable turn, and that is not an omission: there is no object to read it
 * from, and a `nothing` outcome means the CLI never got as far as saying
 * anything about itself.
 *
 * MISSING IS MISSING. An older prompt, a resumed conversation that never saw
 * the key, a model that dropped it — all of them leave it absent, and the
 * caller omits the field rather than sending an empty string, so the server
 * keeps the last account that was true instead of blanking the head.
 */
export function parseTurnResult(text) {
  for (const v of candidateObjects(String(text ?? ''))) {
    if (v.status === 'blocked') {
      const question = typeof v.question === 'string' ? v.question.trim() : '';
      // A "blocked" with no question is not an answer anybody can act on — it
      // parks an agent with nothing to reply to. Treated as `nothing`, which
      // at least says truthfully that the machine went quiet.
      if (!question) continue;
      return { outcome: 'question', answer: question.slice(0, 8000), ...progressOf(v) };
    }
    if (v.status === 'delivered') {
      return {
        outcome: 'delivered',
        answer: (typeof v.summary === 'string' ? v.summary : '').slice(0, 8000),
        ...progressOf(v),
        raised: Array.isArray(v.raised)
          ? v.raised
              .filter((r) => r && typeof r.title === 'string' && r.title.trim())
              .slice(0, 10)
              .map((r) => ({
                title: r.title.trim().slice(0, 300),
                ...(typeof r.brief === 'string' && r.brief.trim()
                  ? { brief: r.brief.trim().slice(0, 2000) }
                  : {}),
              }))
          : [],
      };
    }
  }
  return null;
}

/** The precheck's own bounds — mirrored at the server boundary, which caps
 *  again. A note is one sentence of triage and `overall` is one paragraph; the
 *  numbers are the ones SYSTEM_PRECHECK asks for, stated here so a model that
 *  ignores them cannot make the row bigger than the surface can render. */
const MAX_PRECHECK_CARDS = 60;
const MAX_PRECHECK_NOTE = 400;
const MAX_PRECHECK_OVERALL = 1200;

/**
 * READING THE AI PRE-REVIEW's ANSWER (2026-09-16).
 *
 * Same law as its two neighbours — LENIENT ON PACKAGING, STRICT ON SHAPE — and
 * here the strict half has a sharper consequence than usual: this text is about
 * to be rendered on the surface where somebody decides whether a branch reaches
 * main. A half-read answer is a plausible-looking triage nobody wrote.
 *
 * NULL IS THE SAFE ANSWER AND THE COMMON ONE. A precheck that came back
 * unparseable posts NOTHING, and the absence renders nothing: the human's review
 * is exactly what it was before this feature existed. That is the whole reason
 * this may be strict where `parseProposal` cannot be — a lost proposal wastes a
 * press somebody made, a lost precheck costs a label nobody was promised.
 *
 * ONE ENTRY PER CARD, and the FIRST one wins: a model that judges a card twice
 * has contradicted itself, and rendering two notes on one card face would ask
 * the reviewer to arbitrate between them. An unknown verdict word is dropped
 * rather than coerced — `ok` is a claim ("I looked and found nothing"), and
 * guessing it from a word nobody listed would be the parser making that claim.
 *
 * `scrub` RIDES IN, AND IT RUNS BEFORE EVERY CUT (review, 2026-09-17).
 *
 * The caller used to scrub afterwards — `envScrub(cd.note).slice(0, 400)` over
 * a note this function had ALREADY cut to 400. `scrub` replaces EXACT full
 * values, so a credential straddling the cut arrived here pre-severed, matched
 * nothing, and its surviving prefix was stored and rendered to every member of
 * the project. That is byte-for-byte the bug `runCheck`'s output lane records
 * learning the expensive way, and the reviewer this parses reads a worktree
 * holding the project's materialized dev secrets — a note quoting a `.env`
 * line is the ordinary way to reach it. The fix is `toolEventOf`'s: the scrub
 * rides INTO the builder and runs over the whole field, before the cap.
 *
 * DEFAULTED TO IDENTITY so the parser stays testable on its own, and so a
 * caller that forgets loses redaction rather than the whole reading — but the
 * ONE production caller passes `envScrub`, and `work.test.mjs` pins the order.
 */
export function parsePrecheck(text, scrub = (s) => s) {
  const parsed = candidateObjects(String(text ?? '')).find((v) => Array.isArray(v.cards));
  if (!parsed) return null;

  const cards = [];
  const seen = new Set();
  for (const c of parsed.cards.slice(0, MAX_PRECHECK_CARDS)) {
    if (!c || typeof c !== 'object') continue;
    const taskId = typeof c.taskId === 'string' ? c.taskId.trim().slice(0, 64) : '';
    if (!taskId || seen.has(taskId)) continue;
    if (c.verdict !== 'ok' && c.verdict !== 'concerns') continue;
    seen.add(taskId);
    // SCRUB, THEN CUT — see the docblock. The whole field is in hand here, so an
    // exact-value match still finds a secret that spans the cap.
    const note =
      typeof c.note === 'string' ? scrub(c.note.trim()).slice(0, MAX_PRECHECK_NOTE) : '';
    cards.push({ taskId, verdict: c.verdict, ...(note ? { note } : {}) });
  }
  const overall =
    typeof parsed.overall === 'string'
      ? scrub(parsed.overall.trim()).slice(0, MAX_PRECHECK_OVERALL)
      : '';
  /**
   * AN ANSWER THAT SAYS NOTHING IS NOT AN ANSWER. No readable card verdict and
   * no overall means the model produced the right punctuation and no content —
   * posting that would put an empty "Claude's pre-review" heading on the deck,
   * which reads as a feature that ran and found the branch unremarkable. It did
   * not run.
   */
  if (cards.length === 0 && !overall) return null;
  return { cards, ...(overall ? { overall } : {}) };
}
