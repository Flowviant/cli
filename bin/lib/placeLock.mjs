/**
 * THE PLACE LOCK — several turns may run in one directory; Flowviant's own git
 * may not run beside any of them.
 *
 * Its own module because it is the only concurrency PRIMITIVE in the daemon and
 * the only one whose failure mode is invisible: a lock that grants too much
 * shows up as corrupted work weeks later, and one that grants too little shows
 * up as "ship did nothing". Inside `createWorkManager` it could not be tested
 * at all.
 */
export function createPlaceLock() {
/**
 * THE PLACE LOCK — turns run CONCURRENTLY; Flowviant's own git does not.
 *
 * This was `chainFor`, a strict serial queue per place: every turn waited for
 * the one before it, so two tabs in one directory took turns and — because
 * every tab's place defaulted to the checkout — no two tabs in the product
 * ever ran at the same time. The driver's instruction ended it: "i feel like
 * we shouldnt need to manage parallelism on flowviant, the ai clis should
 * intrinsictly factor that in."
 *
 * It is a READERS-WRITER lock now, and the split is exactly where the
 * argument lands. A TURN is a READER: several may run in one place at once,
 * because coordinating two agents editing a tree is their job and they are
 * better at it than a queue is — measured, three agents on disjoint files
 * lost nothing across 120 concurrent writes. A SHIP is a WRITER: it folds and
 * merges with git, in that same directory, and the CLIs cannot coordinate
 * with it because they do not know it exists. That is the one piece of
 * concurrency Flowviant still owns, so it is the one piece it still manages.
 *
 * WRITER PREFERENCE, deliberately: once a ship is waiting, later turns queue
 * behind it. Without that a busy place could starve a ship indefinitely, and
 * "ship it" would appear to do nothing for as long as anybody kept typing.
 *
 * THE SHIP SIDE ALSO FIXES A LATENT BUG. Ship used to take `chainFor` on the
 * SESSION id while turns took it on the PLACE, under a comment claiming a
 * ship "must not run git in this worktree while a turn's CLI is live in it".
 * Those are different keys the moment a place is set — which was every tab —
 * so the two never shared a chain and the guarantee was not held. Both sides
 * key on the place now.
 *
 * The cross-process pid lock (`flowviant-turn.lock`) is UNCHANGED and stays
 * per-place: it is a crash backstop for an orphaned CLI a dead daemon left
 * behind, not the parallelism policy. It is more conservative than this lock
 * — two sessions sharing one place still serialize across processes — which
 * costs nothing in practice, since a place holds one session unless somebody
 * deliberately points a second one at it.
 */
const placeLocks = new Map(); // placeId -> { readers, writing, waiters: [] }

const pumpPlace = (id) => {
  const st = placeLocks.get(id);
  if (!st) return;
  while (st.waiters.length) {
    const next = st.waiters[0];
    if (next.write) {
      // A writer runs only in a quiet place, and blocks everything behind it.
      if (st.readers === 0 && !st.writing) {
        st.waiters.shift();
        st.writing = true;
        next.go();
      }
      break;
    }
    if (st.writing) break;
    st.waiters.shift();
    st.readers += 1;
    next.go();
  }
  // Drop the entry when the place goes quiet, so the map cannot grow for the
  // process lifetime.
  if (!st.writing && st.readers === 0 && st.waiters.length === 0) placeLocks.delete(id);
};

/**
 * Run `fn` holding the place's lock. `write: true` is exclusive.
 *
 * `.finally` rather than a try/catch that swallows: one rejected turn must
 * release the lock but must NOT be turned into a success — the settle
 * contract above is what guarantees a turn is answered, and hiding a throw
 * here would let a turn fail silently while holding nothing.
 */
const inPlace = async (placeId, write, fn) => {
  let st = placeLocks.get(placeId);
  if (!st) {
    st = { readers: 0, writing: false, waiters: [] };
    placeLocks.set(placeId, st);
  }
  await new Promise((go) => {
    st.waiters.push({ write, go });
    pumpPlace(placeId);
  });
  try {
    return await fn();
  } finally {
    const cur = placeLocks.get(placeId);
    if (cur) {
      if (write) cur.writing = false;
      else cur.readers = Math.max(0, cur.readers - 1);
      pumpPlace(placeId);
    }
  }
};

  return { placeLocks, inPlace };
}
