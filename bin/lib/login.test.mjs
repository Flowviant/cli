/**
 * A DIRECTORY SERVES ONE PROJECT (0.96.0; 0.95.0 had asked a three-way
 * question here, and the owner ended it the same day: "a directory cannot
 * have more than one project on flowviant. if one already exists, it would
 * warn the user and ask them to delete the project on flowviant first.
 * because 2 projects shouldnt be able to edit a directory at the same time.")
 *
 * Pinned here: the refusal's words, that login consults the store BEFORE the
 * save and saves nothing on a clash, that the daemon's start refuses the same
 * directory the same way, and that no picker or "keep both" is left anywhere.
 *
 * Run: node --test bin/lib/login.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const code = (url) =>
  readFileSync(url, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l))
    .join('\n');
const between = (src, from, to, what) => {
  const a = src.indexOf(from);
  assert.ok(a >= 0, `${what}: anchor not found — ${from}`);
  const b = src.indexOf(to, a + 1);
  assert.ok(b > a, `${what}: closing anchor not found after it — ${to}`);
  return src.slice(a, b);
};

test('the refusal names every project on the directory, the rule, and the remedy in the owner’s order', async () => {
  const { directoryTakenRefusal } = await import('./credentials.mjs');
  const bound = [{ projectId: 'fd716bf3-aaaa', name: 'BRIF AI', savedAt: '2026-08-01T12:00:00Z' }];
  const incoming = { projectId: 'fdcec6a0-bbbb', name: 'BRIF AI', savedAt: '2026-09-16T12:00:00Z' };
  const text = directoryTakenRefusal(bound, '/home/whuang/brif-ai', { incoming });
  // Same-named, so the colliding rows carry the id and date — a refusal naming
  // "BRIF AI" twice would be the puzzle it exists to end.
  assert.match(text, /\/home\/whuang\/brif-ai is already connected to BRIF AI \(id fd716bf3…, connected Aug 1\), so BRIF AI \(id fdcec6a0…, connected Sep 16\) was not connected here\./);
  assert.match(text, /A directory serves one project — two projects must not edit it at the same time\./);
  assert.match(text, /Delete the project you do not mean in Flowviant first \(project settings → General → Delete project\),\nor disconnect this box from it with `flowviant machines`, then run this again\./);
  // The daemon's own start prints the same sentence with no incoming project.
  const start = directoryTakenRefusal([...bound, incoming], '/home/whuang/brif-ai');
  assert.match(start, /^\/home\/whuang\/brif-ai is connected to BRIF AI \(id fd716bf3…, connected Aug 1\) and BRIF AI \(id fdcec6a0…, connected Sep 16\)\./);
  // Differently-named projects need no suffix.
  assert.match(directoryTakenRefusal([{ projectId: 'f5f7db90-1', name: 'Merriam One' }], '/r'), /^\/r is connected to Merriam One\./);
});

test('login refuses a second project on a directory, saves nothing, and the command exits 1', () => {
  const login = code(new URL('./login.mjs', import.meta.url));
  const approved = between(login, "if (poll.status === 'approved') {", 'saveLogin(entry);', 'the approved branch');
  assert.ok(approved.includes('boundElsewhere(listStoredProjects(), repoRoot, entry.projectId)'), 'asked of the store, for this repo, excluding the approved project');
  assert.ok(approved.includes('warn(directoryTakenRefusal(clash, repoRoot, { incoming: entry }));'), 'the shared refusal');
  assert.ok(approved.includes('return { saved: false };'), '…and nothing is saved');
  // NO "keep both", NO "replace": a directory serves one project, so there is
  // no menu to offer. Pinned as absences, because an absence passes every
  // render test ever written against it.
  assert.ok(!login.includes('keep both'), 'no keep-both');
  assert.ok(!login.includes('selectMenu'), 'no menu in login at all');
  assert.ok(!login.includes('secondProjectOptions'), 'the three-answer helper is gone');

  const cli = code(new URL('../cli.mjs', import.meta.url));
  assert.ok(cli.includes('if (!login?.saved) process.exit(1);'), 'the login command exits 1 on the refusal');
  // …and the daemon's start refuses the same directory the same way, before
  // any picker, on a TTY and headless alike.
  const start = between(cli, "if (!FLEET_TOKEN) {", "if (CREDENTIAL.choices?.length && interactive) {", 'the start gate');
  assert.ok(start.includes("if (CREDENTIAL.reason === 'multiple-bound') {"), 'multiple-bound is a refusal');
  assert.ok(start.includes('directoryTakenRefusal(CREDENTIAL.choices, CREDENTIAL.repoRoot)'));
  assert.equal(cli.split("'multiple-bound'").length - 1, 1, 'and nothing else in cli.mjs branches on it — no picker path is left');
});
