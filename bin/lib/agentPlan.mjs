/**
 * READING A PLANNER'S ANSWER.
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
 * Find the object.
 *
 * A fenced block first, because that is what was asked for. Otherwise every `{`
 * in the text is tried as a start, and its BALANCED end is found by counting
 * braces while skipping string literals — the first candidate that parses into
 * something with an `agents` array wins.
 *
 * The obvious cheap version — first `{` to last `}` — is wrong in a way a test
 * caught: a planner that writes "I looked at {the auth module} first" before its
 * JSON produces a span starting at the wrong brace, and the whole plan is lost
 * to a sentence. Scanning candidates costs nothing at this size and cannot be
 * defeated by prose.
 */
function extract(raw) {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [];
  if (fenced) candidates.push(fenced[1]);
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== '{') continue;
    const end = balanced(raw, i);
    if (end > i) candidates.push(raw.slice(i, end + 1));
  }
  for (const body of candidates) {
    if (!body.trim()) continue;
    try {
      const v = JSON.parse(body);
      if (v && typeof v === 'object' && Array.isArray(v.agents)) return v;
    } catch {
      /* the next candidate may be the object */
    }
  }
  return null;
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
      ...(Array.isArray(g.waitsOn)
        ? { waitsOn: g.waitsOn.filter((w) => typeof w === 'string' && w).slice(0, 20) }
        : {}),
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
 */
export function parseTurnResult(text) {
  const parsedRaw = String(text ?? '');
  const fenced = parsedRaw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [];
  if (fenced) candidates.push(fenced[1]);
  for (let i = 0; i < parsedRaw.length; i++) {
    if (parsedRaw[i] !== '{') continue;
    const end = balanced(parsedRaw, i);
    if (end > i) candidates.push(parsedRaw.slice(i, end + 1));
  }
  for (const body of candidates) {
    let v;
    try {
      v = JSON.parse(body);
    } catch {
      continue;
    }
    if (!v || typeof v !== 'object') continue;
    if (v.status === 'blocked') {
      const question = typeof v.question === 'string' ? v.question.trim() : '';
      // A "blocked" with no question is not an answer anybody can act on — it
      // parks an agent with nothing to reply to. Treated as `nothing`, which
      // at least says truthfully that the machine went quiet.
      if (!question) continue;
      return { outcome: 'question', answer: question.slice(0, 8000) };
    }
    if (v.status === 'delivered') {
      return {
        outcome: 'delivered',
        answer: (typeof v.summary === 'string' ? v.summary : '').slice(0, 8000),
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
