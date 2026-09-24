/**
 * THE TUNNEL, against a FAKE cloudflared on PATH and a scratch HOME
 * (audit 2026-09-24). No network: the fake prints what the real binary prints
 * and the assertions read what `openTunnel` made of it.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'fv-preview-home-'));
const bin = mkdtempSync(join(tmpdir(), 'fv-preview-bin-'));
const realHome = process.env.HOME;
const realPath = process.env.PATH;
process.env.HOME = home;
process.env.PATH = `${bin}:${realPath}`;
after(() => {
  process.env.HOME = realHome;
  process.env.PATH = realPath;
});

const { openTunnel, reapOrphanPreviews, processStartOf, TUNNEL_RE } = await import('./preview.mjs');

/** A cloudflared that answers `--version` and otherwise runs `script`. */
function fakeCloudflared(script) {
  const p = join(bin, 'cloudflared');
  writeFileSync(
    p,
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "cloudflared version 2026.8.2"; exit 0; fi\n${script}\n`
  );
  chmodSync(p, 0o755);
}

test('the failure line naming api.trycloudflare.com is NOT a published URL', async () => {
  fakeCloudflared(
    `echo 'ERR failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": dial tcp: lookup api.trycloudflare.com: Temporary failure in name resolution' >&2\nexit 1`
  );
  const r = await openTunnel({ port: 1, stillServing: async () => true });
  assert.equal(r.url, undefined, `must not report ${r.url} live`);
  assert.match(r.error, /exited before publishing a URL/);
  // cloudflared's own sentence is what reaches the person.
  assert.match(r.error, /Temporary failure in name resolution/);
});

test('the assigned hostname is published, even split across two reads', async () => {
  fakeCloudflared(
    `printf '| Your quick Tunnel has been created! Visit it at |\\n|  https://brave-otter-'\nsleep 0.2\nprintf 'lamp.trycloudflare.com  |\\n'\nsleep 30`
  );
  const r = await openTunnel({ port: 1, stillServing: async () => true });
  try {
    assert.equal(r.url, 'https://brave-otter-lamp.trycloudflare.com');
    assert.ok(r.password);
  } finally {
    r.stop?.();
  }
});

test('the hostname pattern refuses the API host and a longer name', () => {
  assert.equal(TUNNEL_RE.exec('https://api.trycloudflare.com/tunnel'), null);
  assert.equal(TUNNEL_RE.exec('https://x.trycloudflare.com.evil.test'), null);
  assert.equal(TUNNEL_RE.exec('see https://a-b-c.trycloudflare.com |')[0], 'https://a-b-c.trycloudflare.com');
});

test('an orphaned tunnel is reaped even when its dead owner\'s pid now belongs to somebody else', async () => {
  const sig = `--url http://localhost:${40000 + Math.floor(Math.random() * 9999)}`;
  const orphan = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e6)', '--', ...sig.split(' ')], {
    detached: true,
    stdio: 'ignore',
  });
  const recycled = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e6)'], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 150));
  const reg = join(home, '.flowviant', 'previews.json');
  mkdirSync(join(home, '.flowviant'), { recursive: true });
  try {
    // A LIVE owner whose recorded start time is not this process's: the pid
    // was recycled after the daemon that spawned the tunnel died.
    writeFileSync(reg, JSON.stringify([{ pid: orphan.pid, sig, owner: recycled.pid, ownerStart: 'l:1' }]));
    reapOrphanPreviews();
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(orphan.exitCode ?? orphan.signalCode, 'SIGKILL');
    assert.deepEqual(JSON.parse(readFileSync(reg, 'utf8')), []);
  } finally {
    try {
      orphan.kill('SIGKILL');
    } catch {}
    recycled.kill('SIGKILL');
  }
});

test("a live peer's tunnel — owner pid AND start time match — is left alone", async () => {
  const sig = `--url http://localhost:${50000 + Math.floor(Math.random() * 9999)}`;
  const tunnel = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e6)', '--', ...sig.split(' ')], {
    detached: true,
    stdio: 'ignore',
  });
  const peer = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e6)'], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 150));
  const reg = join(home, '.flowviant', 'previews.json');
  try {
    const entry = { pid: tunnel.pid, sig, owner: peer.pid, ownerStart: processStartOf(peer.pid) };
    writeFileSync(reg, JSON.stringify([entry]));
    reapOrphanPreviews();
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(tunnel.exitCode, null);
    assert.equal(tunnel.signalCode, null);
    assert.deepEqual(JSON.parse(readFileSync(reg, 'utf8')), [entry]);
  } finally {
    tunnel.kill('SIGKILL');
    peer.kill('SIGKILL');
  }
});
