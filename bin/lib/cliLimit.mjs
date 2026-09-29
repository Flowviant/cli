/**
 * The CLI-limit trigger — whether a CLI's output says the account hit a
 * usage limit, relayed in the CLI's own words. Split out of
 * workAgentReview.mjs (SOLID F039) because two lanes read it (the agent turn,
 * which parks on it, and the pre-review, which only skips) and neither owns
 * it: it is a fact about what the CLIs print.
 */
import { scrub as envScrub } from './uplinkScrub.mjs';

/**
 * DID THE ACCOUNT HIT A LIMIT?
 *
 * Deliberately a LITERAL MATCH on the few sentences the CLIs actually print,
 * and the matched line is relayed VERBATIM. It is a trigger, not a
 * classifier: nothing here decides what an error "means" or writes a sentence
 * of its own, because the product's own rule is that it relays and never
 * infers. The honest limit is that a phrasing nobody listed reads as an
 * ordinary failed turn — which lands the agent in Stuck with the CLI's words
 * attached, and is a perfectly survivable second-best.
 */
const LIMIT_PHRASES = [
  /usage limit reached/i,
  /rate limit/i,
  /you've reached your .* limit/i,
  /quota exceeded/i,
  /insufficient_quota/i,
];
export const limitLine = (text) => {
  for (const line of String(text ?? '').split('\n')) {
    const t = line.trim();
    if (t && LIMIT_PHRASES.some((re) => re.test(t))) return envScrub(t).slice(0, 300);
  }
  return null;
};
