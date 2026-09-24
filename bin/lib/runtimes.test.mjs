/**
 * probeSkillsOnce, against a FAKE `claude` on PATH (the preview.test.mjs
 * shape: no network, the fake prints exactly what the assertions read).
 *
 * The one behaviour under test is the UTF-8 fix (audit 2026-09-24):
 * `child.stdout.on('data', d => buf += d.toString())` decoded each Buffer
 * CHUNK on its own, so a multi-byte character split across two chunks came
 * out as replacement bytes on either side of the split. `setEncoding('utf8')`
 * holds a partial sequence over to the next chunk instead. Run:
 * node --test bin/lib/runtimes.test.mjs
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const bin = mkdtempSync(join(tmpdir(), 'fv-runtimes-bin-'));
const home = mkdtempSync(join(tmpdir(), 'fv-runtimes-home-'));
const realPath = process.env.PATH;
const realHome = process.env.HOME;
process.env.PATH = `${bin}:${realPath}`;
process.env.HOME = home;
after(() => {
  process.env.PATH = realPath;
  process.env.HOME = realHome;
});

const { probeSkillsOnce, knownMcpServers } = await import('./runtimes.mjs');

/**
 * An mcp_servers name carrying a multi-byte UTF-8 character (é, U+00E9 —
 * 0xC3 0xA9), the two bytes written in SEPARATE writes with a pause between
 * them so they arrive as two distinct `data` events rather than one. `\303`
 * and `\251` are POSIX `printf`'s octal-escape spelling of those bytes.
 * `recordMcpServers` has no character allowlist (unlike `recordSkills`,
 * which would drop a non-ASCII name outright and hide the very bug under
 * test), so a mis-decoded name is directly observable.
 */
function fakeClaudeSplitUtf8() {
  const p = join(bin, 'claude');
  writeFileSync(
    p,
    [
      '#!/bin/sh',
      `printf '{"type":"system","subtype":"init","skills":[],"mcp_servers":[{"name":"caf\\303'`,
      'sleep 0.05',
      `printf '\\251","status":"needs-auth"}],"session_id":"probe-1"}\\n'`,
      // No trailing sleep: the script simply exits once printed. (An earlier
      // draft lingered with `sleep 5` after printing, the preview.test.mjs
      // shape — but that command forks as a SEPARATE child of this script's
      // shell, foreground, sharing this process's stdout fd; killing only
      // this pid then leaves the orphaned sleep holding the pipe's write end
      // open for the rest of its sleep, and the test runner's own exit
      // waited on that fd actually closing. Nothing here needs the process
      // to survive past printing.)
    ].join('\n'),
    { mode: 0o755 }
  );
  chmodSync(p, 0o755);
}

test('a multi-byte character split across two stdout chunks decodes whole', async () => {
  fakeClaudeSplitUtf8();
  probeSkillsOnce(process.cwd());
  const deadline = Date.now() + 3000;
  while (knownMcpServers() === null && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
  }
  const servers = knownMcpServers();
  assert.ok(servers, 'the probe recorded something');
  assert.deepEqual(
    servers.map((s) => s.n),
    ['café'],
    'the split byte pair decodes to one correct character, not two mangled halves'
  );
});
