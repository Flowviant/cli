/**
 * THE PREVIEW TUNNEL REGISTRY as a policy over procRegistry's primitives
 * (SOLID audit 2026-09-26, F006), against a scratch HOME and real processes:
 * no count ever drops a live tunnel's row, a dead tunnel's row does not
 * accumulate, an owner from another boot (or a recycled pid) is an orphan's
 * owner, a row an older daemon wrote is still believed, a row this daemon
 * writes is still believed by an older one, and two writers at once lose
 * nothing.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'fv-preview-reg-'));
const realHome = process.env.HOME;
process.env.HOME = home;
after(() => {
  process.env.HOME = realHome;
  rmSync(home, { recursive: true, force: true });
});
mkdirSync(join(home, '.flowviant'), { recursive: true });
const reg = join(home, '.flowviant', 'previews.json');

const { recordPreviewPid, forgetPreviewPid, reapOrphanPreviews, sameOwnerStart, legacyOwnerStart } = await import(
  './previewRegistry.mjs'
);
const { processStartTime } = await import('./procRegistry.mjs');

const linux = process.platform === 'linux';
const sleeper = (args = []) =>
  spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e6)', '--', ...args], { detached: true, stdio: 'ignore' });
const settle = () => new Promise((r) => setTimeout(r, 150));
const read = () => JSON.parse(readFileSync(reg, 'utf8'));
/** A pid nothing holds: well past any default pid_max. */
const DEAD = 99_999_990;

test('more live tunnels than the generic cap all keep their rows; dead rows are pruned', async (t) => {
  const tunnels = Array.from({ length: 34 }, () => sleeper());
  t.after(() => tunnels.forEach((p) => p.kill('SIGKILL')));
  await settle();
  const live = tunnels.map((p) => ({ pid: p.pid, sig: `sig-${p.pid}`, owner: process.pid }));
  const dead = Array.from({ length: 50 }, (_, i) => ({ pid: DEAD - i, sig: 'gone', owner: process.pid }));
  writeFileSync(reg, JSON.stringify([...live, ...dead]));
  const mine = sleeper();
  t.after(() => mine.kill('SIGKILL'));
  await settle();
  recordPreviewPid(mine.pid, 'sig-mine');
  const rows = read();
  assert.equal(rows.length, 35, 'every live tunnel, uncapped, plus the new one');
  assert.deepEqual(new Set(rows.map((r) => r.pid)), new Set([...tunnels.map((p) => p.pid), mine.pid]));
  // The new row pins its owner with the ONE identity reader.
  const added = rows.find((r) => r.pid === mine.pid);
  assert.equal(added.owner, process.pid);
  if (linux) {
    const reading = processStartTime(process.pid);
    assert.equal(added.ownerMark, reading);
    // `ownerStart` keeps the spelling published daemons compare exactly.
    assert.equal(added.ownerStart, `l:${reading.slice(reading.lastIndexOf(':') + 1)}`);
  }
  forgetPreviewPid(mine.pid);
  assert.equal(read().some((r) => r.pid === mine.pid), false);
  writeFileSync(reg, '[]');
});

test('an owner recorded in another boot is not a live peer: its tunnel is reaped', { skip: !linux }, async (t) => {
  const sig = `--url http://localhost:${41000 + Math.floor(Math.random() * 999)}`;
  const orphan = sleeper(sig.split(' '));
  const peer = sleeper();
  t.after(() => {
    orphan.kill('SIGKILL');
    peer.kill('SIGKILL');
  });
  await settle();
  const now = processStartTime(peer.pid);
  const ticks = now.slice(now.lastIndexOf(':') + 1);
  // Same pid, same ticks — but written in a boot that is not this one. The
  // legacy field alone would match; the boot-marked one is what this code reads.
  writeFileSync(
    reg,
    JSON.stringify([{ pid: orphan.pid, sig, owner: peer.pid, ownerStart: `l:${ticks}`, ownerMark: `another-boot:${ticks}` }])
  );
  reapOrphanPreviews();
  await settle();
  assert.equal(orphan.signalCode, 'SIGKILL');
  assert.deepEqual(read(), []);
});

test("a peer's row written by an older daemon (legacy start mark) is still believed", { skip: !linux }, async (t) => {
  const sig = `--url http://localhost:${42000 + Math.floor(Math.random() * 999)}`;
  const tunnel = sleeper(sig.split(' '));
  const peer = sleeper();
  t.after(() => {
    tunnel.kill('SIGKILL');
    peer.kill('SIGKILL');
  });
  await settle();
  const now = processStartTime(peer.pid);
  const entry = { pid: tunnel.pid, sig, owner: peer.pid, ownerStart: `l:${now.slice(now.lastIndexOf(':') + 1)}` };
  writeFileSync(reg, JSON.stringify([entry]));
  reapOrphanPreviews();
  await settle();
  assert.equal(tunnel.exitCode, null);
  assert.equal(tunnel.signalCode, null);
  assert.deepEqual(read(), [entry]);
  writeFileSync(reg, '[]');
});

/**
 * THE PUBLISHED READER, verbatim from 0.103.0's preview.mjs (`processStartOf`
 * on Linux + `ownerStillRunning`): it compares `ownerStart` EXACTLY against
 * `l:<ticks>` and SIGKILLs the tunnel on a mismatch. Any daemon on the box may
 * be that old; a row this version writes must still read as a live owner's.
 */
function publishedOwnerStillRunning(owner, ownerStart) {
  try {
    process.kill(owner, 0);
  } catch (e) {
    if (e.code !== 'EPERM') return false;
  }
  if (typeof ownerStart !== 'string') return true;
  let now = null;
  try {
    const stat = readFileSync(`/proc/${owner}/stat`, 'utf8');
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    now = rest[19] ? `l:${rest[19]}` : null;
  } catch {
    now = null;
  }
  return now == null ? true : now === ownerStart;
}

test("an older daemon on the box believes a live peer's freshly recorded row", { skip: !linux }, async (t) => {
  writeFileSync(reg, '[]');
  const sig = `--url http://localhost:${43000 + Math.floor(Math.random() * 999)}`;
  const tunnel = sleeper(sig.split(' '));
  // The PEER is a live daemon of this version: it records the tunnel as its
  // own and stays up.
  const peer = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `const { recordPreviewPid } = await import(${JSON.stringify(new URL('./previewRegistry.mjs', import.meta.url).href)});
       recordPreviewPid(${tunnel.pid}, ${JSON.stringify(sig)});
       process.stdout.write('recorded');
       setInterval(() => {}, 1e6);`,
    ],
    { env: { ...process.env, HOME: home }, stdio: ['ignore', 'pipe', 'inherit'] }
  );
  t.after(() => {
    tunnel.kill('SIGKILL');
    peer.kill('SIGKILL');
  });
  await new Promise((resolve, reject) => {
    peer.stdout.once('data', resolve);
    peer.once('exit', (code) => reject(new Error(`the peer exited (${code}) before recording`)));
  });
  const [row] = read();
  assert.equal(row.owner, peer.pid);
  assert.equal(publishedOwnerStillRunning(row.owner, row.ownerStart), true, 'a 0.103.0 reap would kill this live tunnel');
  // Canary: the published rule does refuse a boot-marked `ownerStart` — the
  // spelling the first cut of this move wrote there.
  assert.equal(publishedOwnerStillRunning(row.owner, row.ownerMark), false);
  // And this version's reap leaves it too.
  reapOrphanPreviews();
  await settle();
  assert.equal(tunnel.signalCode, null);
  assert.deepEqual(read(), [row]);
  writeFileSync(reg, '[]');
});

test('the legacy spelling of a reading', () => {
  assert.equal(legacyOwnerStart('0f3c-boot:1424620', 'linux'), 'l:1424620');
  assert.equal(legacyOwnerStart('bt:1790000000:77', 'linux'), 'l:77');
  assert.equal(legacyOwnerStart('Mon Sep  1 00:00:00 2026', 'darwin'), 'd:Mon Sep  1 00:00:00 2026');
  assert.equal(legacyOwnerStart('anything', 'win32'), null);
  assert.equal(legacyOwnerStart(null, 'linux'), null);
});

test('the start-mark comparison: current, legacy Linux, legacy macOS, unreadable', { skip: !linux }, () => {
  const now = processStartTime(process.pid);
  const ticks = now.slice(now.lastIndexOf(':') + 1);
  assert.equal(sameOwnerStart(now, process.pid), true);
  assert.equal(sameOwnerStart(`l:${ticks}`, process.pid), true);
  assert.equal(sameOwnerStart(`l:${Number(ticks) + 1}`, process.pid), false);
  assert.equal(sameOwnerStart('d:Mon Sep 1 00:00:00 2026', process.pid), false);
  assert.equal(sameOwnerStart(`x${now}`, process.pid), false);
  // A pid nothing holds cannot be read: "cannot tell", never a mismatch.
  assert.equal(sameOwnerStart(now, DEAD), null);
});

test('two daemons recording at once lose nothing', async () => {
  writeFileSync(reg, '[]');
  const N = 15;
  const script = `
    const { recordPreviewPid } = await import(${JSON.stringify(new URL('./previewRegistry.mjs', import.meta.url).href)});
    for (let i = 0; i < ${N}; i++) recordPreviewPid(${process.pid}, 'w' + process.argv[1] + '-' + i);
  `;
  const run = (tag) =>
    new Promise((resolve, reject) =>
      execFile(process.execPath, ['--input-type=module', '-e', script, tag], { env: { ...process.env, HOME: home } }, (e) =>
        e ? reject(e) : resolve()
      )
    );
  await Promise.all([run('a'), run('b')]);
  const sigs = read().map((r) => r.sig).sort();
  assert.equal(sigs.length, 2 * N);
  assert.ok(sigs.includes('wa-0') && sigs.includes(`wb-${N - 1}`));
  assert.deepEqual(readdirSync(join(home, '.flowviant')).filter((f) => f.endsWith('.lock') || f.endsWith('.tmp')), []);
  writeFileSync(reg, '[]');
});

/** CODE ONLY — the headers quote the shapes they replaced. */
const code = (f) =>
  readFileSync(new URL(`./${f}`, import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l))
    .join('\n');

test('preview keeps no second registry: the lock, the write and the start time are procRegistry’s', () => {
  const policy = code('previewRegistry.mjs');
  assert.match(policy, /from '\.\/procRegistry\.mjs'/, 'reading the real policy module');
  assert.match(policy, /mutateRegistry\(FLOWVIANT_DIR, PREVIEW_REGISTRY, REGISTRY_LOCK, fn, \{ prune: keepLiveTunnels \}\)/);
  for (const f of ['preview.mjs', 'previewRegistry.mjs']) {
    const src = code(f);
    assert.ok(src.length > 1000, `${f} was read`);
    assert.ok(!src.includes("'wx'"), `${f}: no lock of its own`);
    assert.ok(!src.includes('renameSync(tmp'), `${f}: no atomic write of its own`);
    assert.ok(!/\/proc\/\$\{pid\}\/stat`/.test(src), `${f}: no start-time reader of its own`);
  }
});
