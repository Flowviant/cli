// THE CURL BINARY NEVER READS THE PROJECT'S .env OR bunfig.toml (0.109.0).
//
// A Bun executable autoloads `.env` (and `.env.local`, `.env.<NODE_ENV>`) and
// `bunfig.toml` from its working directory unless built not to. The daemon
// starts in the project's repo, so the app's own `.env` — an ANTHROPIC_API_KEY
// the app bills against — became the daemon's environment and rode every
// Claude turn, putting the machine's turns on the app's API key instead of its
// Max login (measured in production, 2026-09-28). Both flags, on every target.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const script = readFileSync(join(here, '..', '..', 'scripts', 'build-binaries.sh'), 'utf8')
  .split('\n')
  .filter((line) => !line.trim().startsWith('#'))
  .join('\n');

test('every compile turns off .env and bunfig.toml autoloading', () => {
  const compiles = script.split('\n').filter((line) => /\bbun build\b/.test(line) && /--compile\b/.test(line));
  assert.ok(compiles.length >= 1, 'a bun build --compile line exists');
  for (const line of compiles) {
    assert.match(line, /--no-compile-autoload-dotenv\b/);
    assert.match(line, /--no-compile-autoload-bunfig\b/);
  }
});
