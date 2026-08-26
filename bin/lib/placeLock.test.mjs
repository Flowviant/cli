import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPlaceLock } from './placeLock.mjs';

/** A promise plus its resolver, so a test can hold work open deliberately. */
const gate = () => {
  let open;
  const p = new Promise((r) => (open = r));
  return { p, open };
};
const tick = () => new Promise((r) => setImmediate(r));

test('two turns in one place run at the SAME time', async () => {
  const { inPlace } = createPlaceLock();
  const a = gate();
  const b = gate();
  let both = 0;
  const t1 = inPlace('p', false, async () => {
    both += 1;
    await a.p;
  });
  const t2 = inPlace('p', false, async () => {
    both += 1;
    await b.p;
  });
  await tick();
  // The whole point of the change: neither waits for the other.
  assert.equal(both, 2, 'both turns should be running');
  a.open();
  b.open();
  await Promise.all([t1, t2]);
});

test('a ship waits for every turn already running in its place', async () => {
  const { inPlace } = createPlaceLock();
  const turn = gate();
  let shipped = false;
  const t = inPlace('p', false, () => turn.p);
  const s = inPlace('p', true, async () => {
    shipped = true;
  });
  await tick();
  assert.equal(shipped, false, 'ship must not run beside a live turn');
  turn.open();
  await t;
  await s;
  assert.equal(shipped, true);
});

test('a turn queued behind a waiting ship does not overtake it — no starvation', async () => {
  const { inPlace } = createPlaceLock();
  const first = gate();
  const order = [];
  const t1 = inPlace('p', false, async () => {
    order.push('turn1');
    await first.p;
  });
  await tick();
  const s = inPlace('p', true, async () => {
    order.push('ship');
  });
  await tick();
  // Arrives AFTER the ship is waiting, so it must land after it.
  const t2 = inPlace('p', false, async () => {
    order.push('turn2');
  });
  first.open();
  await Promise.all([t1, s, t2]);
  assert.deepEqual(order, ['turn1', 'ship', 'turn2']);
});

test('places are independent — a ship in one never blocks a turn in another', async () => {
  const { inPlace } = createPlaceLock();
  const held = gate();
  let ran = false;
  const s = inPlace('a', true, () => held.p);
  const t = inPlace('b', false, async () => {
    ran = true;
  });
  await tick();
  assert.equal(ran, true, 'a different directory is not contended');
  held.open();
  await Promise.all([s, t]);
});

test('a throwing turn releases the lock and still rejects', async () => {
  const { inPlace, placeLocks } = createPlaceLock();
  await assert.rejects(
    inPlace('p', false, async () => {
      throw new Error('boom');
    }),
    /boom/
  );
  // A swallowed throw here would let a turn fail silently; the settle contract
  // in work.mjs is what guarantees an answer, and it needs the rejection.
  let after = false;
  await inPlace('p', true, async () => {
    after = true;
  });
  assert.equal(after, true, 'the place must not be wedged');
  assert.equal(placeLocks.size, 0, 'a quiet place drops out of the map');
});

test('the map does not grow for the process lifetime', async () => {
  const { inPlace, placeLocks } = createPlaceLock();
  for (const id of ['a', 'b', 'c']) {
    await inPlace(id, false, async () => {});
  }
  assert.equal(placeLocks.size, 0);
});
