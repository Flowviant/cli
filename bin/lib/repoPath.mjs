/**
 * REPO IDENTITY BY PATH — whether two spellings name the same checkout. One
 * home for the rule the instance lock (neighbour takeover, same-repo
 * replacement) and the credential store (collisions, the login refusal, start
 * resolution) both decide on. Split out (SOLID F057) because the two were
 * hand-copied: a change to symlink or missing-path treatment made in one would
 * let a lock and a credential disagree about which directory a daemon serves.
 *
 * Realpath first (symlinks and trailing slashes both resolve); a path that no
 * longer exists falls back to its own spelling minus trailing slashes, so a
 * deleted checkout still matches the lock or entry that names it.
 */
import { realpathSync } from 'node:fs';

/** Same directory, whatever it is spelled as. A blank side matches nothing. */
export function samePath(a, b) {
  if (!a || !b) return false;
  const norm = (v) => {
    try {
      return realpathSync(v);
    } catch {
      return String(v).replace(/\/+$/, '');
    }
  };
  return norm(a) === norm(b);
}
