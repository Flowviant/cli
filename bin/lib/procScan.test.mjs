/**
 * THE /proc WALK (SOLID audit 2026-09-26, F007): every pid is looked at, the
 * bound is on the rows collected, a cut is SAID — and the listener scans that
 * used to slice the pid list find a dev server past four thousand other pids,
 * in the inventory and in the dial-address check alike.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';
import { insideDir, procPids, scanProcs, SCAN_MATCH_BOUND } from './procScan.mjs';
import { measureListeners, originFor } from './listeners.mjs';

test('the walk looks at every pid and bounds only the rows it keeps', () => {
  const pids = Array.from({ length: 10 }, (_, i) => String(i + 1));
  const even = (raw) => (Number(raw) % 2 === 0 ? { pid: Number(raw) } : null);
  assert.deepEqual(scanProcs(pids, even), { rows: [2, 4, 6, 8, 10].map((pid) => ({ pid })), complete: true });
  // Cut with pids unread: said.
  assert.deepEqual(scanProcs(pids, even, 2), { rows: [{ pid: 2 }, { pid: 4 }], complete: false });
  // Exactly at the bound with nothing left unread is complete.
  assert.equal(scanProcs(['2', '4'], even, 2).complete, true);
  assert.ok(SCAN_MATCH_BOUND >= 1000, 'a runaway bound, not a capacity statement');
});

test('an unlistable /proc is "cannot look" (null), never an empty box', () => {
  assert.equal(
    procPids(() => {
      throw new Error('EACCES');
    }),
    null
  );
  assert.deepEqual(procPids(() => ['1', 'self', '42', 'net']), ['1', '42']);
});

test('inside a directory is the resolved path or below it, never a sibling prefix', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fv-procscan-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'wt'));
  const inside = insideDir(join(root, 'wt'));
  assert.equal(inside(join(root, 'wt')), true);
  assert.equal(inside(join(root, 'wt', 'src')), true);
  assert.equal(inside(join(root, 'wt-other')), false);
  assert.equal(insideDir(join(root, 'gone')), null);
});

/** A dev server standing in a fresh worktree, on 127.0.0.1:<kernel port>. */
async function devServer(t, wt) {
  const child = spawn(
    process.execPath,
    ['-e', "const s=require('net').createServer().listen(0,'127.0.0.1',()=>console.log(s.address().port))"],
    { cwd: wt, stdio: ['ignore', 'pipe', 'ignore'] }
  );
  t.after(() => child.kill('SIGKILL'));
  const port = await new Promise((r, j) => {
    child.stdout.once('data', (d) => r(Number(String(d).trim())));
    child.once('exit', () => j(new Error('dev server exited')));
  });
  return { child, port };
}

test('a dev server past 4000 other pids is found by the inventory AND the dial check', { skip: platform() !== 'linux' }, async (t) => {
  const wt = mkdtempSync(join(tmpdir(), 'fv-procscan-wt-'));
  t.after(() => rmSync(wt, { recursive: true, force: true }));
  const { child, port } = await devServer(t, wt);
  // Four and a half thousand pids nothing holds, THEN the server — the order a
  // string-sorted readdir gives a high pid on a busy box. The old scans cut
  // the list at 4000 and never reached it.
  const noise = Array.from({ length: 4500 }, (_, i) => String(90_000_000 + i));
  const io = { list: () => [...noise, String(child.pid)] };
  const m = measureListeners(wt, io);
  assert.ok(m.rows.some((r) => r.port === port && r.pid === child.pid), 'the inventory finds it');
  assert.equal(m.incomplete, undefined, 'a walk that read every pid says nothing extra');
  assert.deepEqual(originFor(wt, port, io), { host: '127.0.0.1' });
});

test('a walk cut by its bound says so, and the dial check refuses in words rather than "nothing is listening"', { skip: platform() !== 'linux' }, async (t) => {
  const wt = mkdtempSync(join(tmpdir(), 'fv-procscan-cut-'));
  t.after(() => rmSync(wt, { recursive: true, force: true }));
  const { child, port } = await devServer(t, wt);
  // Another process standing in the worktree fills the bound of one first.
  const other = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e6)'], { cwd: wt, stdio: 'ignore' });
  t.after(() => other.kill('SIGKILL'));
  await new Promise((r) => setTimeout(r, 150));
  const io = { list: () => [String(other.pid), String(child.pid)], bound: 1 };
  const m = measureListeners(wt, io);
  assert.equal(m.incomplete, true);
  assert.equal(m.rows.some((r) => r.port === port), false);
  const o = originFor(wt, port, io);
  assert.match(o.error, /could not be told — it was not shared/);
  assert.doesNotMatch(o.error, /nothing is listening/);
});

test('a cut walk never refuses a socket of ours the rule would share', { skip: platform() !== 'linux' }, async (t) => {
  const wt = mkdtempSync(join(tmpdir(), 'fv-procscan-share-'));
  t.after(() => rmSync(wt, { recursive: true, force: true }));
  const { child, port } = await devServer(t, wt);
  // A second process in the worktree, on the SAME port but the other family,
  // which the cut walk never reaches — so its socket reads as foreign. It does
  // not shadow 127.0.0.1, so the rule shares the reached one; the cut alone is
  // no reason to refuse (review 2026-09-26).
  const v6 = spawn(
    process.execPath,
    ['-e', `require('net').createServer().on('error',()=>process.exit(3)).listen(${port},'::1',()=>console.log('up'))`],
    { cwd: wt, stdio: ['ignore', 'pipe', 'ignore'] }
  );
  t.after(() => v6.kill('SIGKILL'));
  try {
    await new Promise((r, j) => {
      v6.stdout.once('data', r);
      v6.once('exit', () => j(new Error('no ::1 here')));
    });
  } catch {
    t.skip('this box has no IPv6 loopback');
    return;
  }
  const io = { list: () => [String(child.pid), String(v6.pid)], bound: 1 };
  assert.equal(measureListeners(wt, io).incomplete, true, 'the walk WAS cut');
  assert.deepEqual(originFor(wt, port, io), { host: '127.0.0.1' });
});

/** CODE ONLY — headers quote the shapes they replaced. */
const code = (f) =>
  readFileSync(new URL(`./${f}`, import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l))
    .join('\n');

test('the /proc walk has one home: no scan lists /proc or cuts a pid list itself', () => {
  const files = readdirSync(new URL('./', import.meta.url)).filter((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs'));
  assert.ok(files.includes('procScan.mjs') && files.includes('listeners.mjs'), 'the walk found the tree (canary)');
  const listing = files.filter((f) => code(f).includes("readdirSync('/proc')"));
  assert.deepEqual(listing, ['procScan.mjs']);
  for (const f of ['listeners.mjs', 'processes.mjs']) {
    const src = code(f);
    assert.ok(src.includes("from './procScan.mjs'"), `${f} walks through procScan`);
    assert.ok(!/MAX_PIDS/.test(src), `${f}: no bound of its own`);
    assert.ok(!/pids\.slice\(0,/.test(src), `${f}: never cuts the pid list`);
  }
});
