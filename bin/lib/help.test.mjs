import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { COMMANDS, findCommand, nearestCommand, renderHelp, unknownCommandMessage } from './help.mjs';

const cli = new URL('../cli.mjs', import.meta.url);

function run(args) {
  const home = mkdtempSync(join(tmpdir(), 'fv-help-'));
  return new Promise((resolve) => {
    execFile(process.execPath, [cli.pathname, ...args], { env: { ...process.env, HOME: home, NO_COLOR: '1', FLOWVIANT_NO_UPDATE: '1' }, timeout: 20_000 }, (error, stdout, stderr) => {
      rmSync(home, { recursive: true, force: true });
      resolve({ code: error ? error.code : 0, stdout, stderr });
    });
  });
}

test('the help table lists exactly the commands cli.mjs dispatches', () => {
  const source = readFileSync(cli, 'utf8');
  const dispatched = new Set([...source.matchAll(/process\.argv\[2\] === '([a-z-]+)'/g)].map((m) => m[1]));
  assert.ok(dispatched.has('login') && dispatched.has('doctor'), 'the dispatch scan found the commands');
  const listed = new Set(COMMANDS.map((cmd) => cmd.name));
  for (const name of dispatched) assert.ok(findCommand(name), `\`${name}\` is dispatched but missing from help`);
  for (const name of listed) {
    if (['start', 'help'].includes(name)) continue; // start is the bare command; help is handled by flag
    assert.ok(dispatched.has(name) || [...dispatched].some((d) => findCommand(d)?.name === name), `\`${name}\` is in help but nothing dispatches it`);
  }
});

test('the main screen shows every visible command and hides the rest', () => {
  const screen = renderHelp('1.2.3');
  for (const cmd of COMMANDS) assert.equal(screen.includes(`  ${cmd.name} `), !cmd.hidden, cmd.name);
});

test('a slip suggests the command it was meant to be, and nonsense suggests nothing', () => {
  assert.equal(nearestCommand('hlep'), 'help');
  assert.equal(nearestCommand('stauts'), 'status');
  assert.equal(nearestCommand('uninstal'), 'uninstall');
  assert.equal(nearestCommand('mach'), 'machines');
  assert.equal(nearestCommand('zzzzzz'), null);
  assert.match(unknownCommandMessage('zzzzzz'), /not a command\.\nRun `flowviant help`/);
  assert.equal(findCommand('--version').name, 'version');
});

test('--help, help and <command> --help print and never start anything', async () => {
  const main = await run(['--help']);
  assert.equal(main.code, 0);
  assert.match(main.stdout, /Usage: flowviant \[command\]/);
  assert.equal((await run(['help'])).stdout, main.stdout);
  const logs = await run(['logs', '--help']);
  assert.equal(logs.code, 0);
  assert.match(logs.stdout, /^flowviant logs \[-f\]/);
  assert.match((await run(['help', 'login'])).stdout, /--no-start/);
  assert.match((await run(['start', '-h'])).stdout, /^flowviant \[start\]/);
});

test('an unknown word is refused with exit 1 instead of starting the daemon', async () => {
  const res = await run(['hlep']);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /'hlep' is not a command\. Did you mean `flowviant help`\?/);
  assert.doesNotMatch(res.stdout + res.stderr, /credential|approve|serving/i);
});
