import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nearestCommand, renderCommandHelp, renderHelp, unknownCommandMessage } from './help.mjs';
import { BUILTIN_COMMANDS, COMMANDS, commandUsesCheckout, findCommand } from './commandSpecs.mjs';

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

/** The keys of cli.mjs's HANDLERS map, comments stripped, both anchors asserted. */
function handlerKeys() {
  const source = readFileSync(cli, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  const open = source.indexOf('const HANDLERS = {');
  assert.ok(open >= 0, 'anchor: cli.mjs declares its HANDLERS map');
  const close = source.indexOf('};', open);
  assert.ok(close > open, 'anchor: the HANDLERS map closes');
  const body = source.slice(open + 'const HANDLERS = {'.length, close);
  return body.split(',').map((row) => row.trim()).filter(Boolean).map((row) => row.split(':')[0].trim().replace(/^'|'$/g, ''));
}

test('every command row has exactly one handler, and every handler a row', () => {
  const keys = handlerKeys();
  assert.ok(keys.includes('login') && keys.includes('doctor'), 'the handler scan found the commands');
  assert.equal(new Set(keys).size, keys.length, 'no command is handled twice');
  const handled = COMMANDS.filter((cmd) => !BUILTIN_COMMANDS.includes(cmd.name)).map((cmd) => cmd.name).sort();
  assert.deepEqual([...keys].sort(), handled);
  for (const name of BUILTIN_COMMANDS) assert.ok(findCommand(name), `builtin \`${name}\` is a row of the table`);
});

test('cli.mjs keeps no command inventory of its own', () => {
  const source = readFileSync(cli, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  assert.ok(source.includes('commandUsesCheckout(process.argv[2])'), 'anchor: the --dir policy asks the table');
  assert.ok(!source.includes('noCheckoutCommand'), 'the checkout policy is the table’s, not a second set');
  // Only the start splice and two flag policies may name a word; no dispatch.
  const dispatches = [...source.matchAll(/if \(process\.argv\[2\] === '([a-z-]+)'\) \{/g)].map((m) => m[1]);
  assert.deepEqual(dispatches, [], 'dispatch goes through HANDLERS, never a conditional');
});

test('checkout policy and help come from the same row', () => {
  for (const cmd of COMMANDS) {
    assert.equal(typeof cmd.usesCheckout, 'boolean', `${cmd.name} states its checkout policy`);
    assert.equal(commandUsesCheckout(cmd.name), cmd.usesCheckout, cmd.name);
    assert.equal(renderCommandHelp(findCommand(cmd.name)).startsWith(cmd.usage), true, cmd.name);
  }
  // Aliases follow their row; flags and no word at all are the start path.
  assert.equal(commandUsesCheckout('--version'), false);
  assert.equal(commandUsesCheckout('-h'), false);
  assert.equal(commandUsesCheckout('--project'), true);
  assert.equal(commandUsesCheckout(undefined), true);
  assert.deepEqual(COMMANDS.filter((cmd) => cmd.usesCheckout).map((cmd) => cmd.name), ['start', 'login', 'logs', 'open', 'doctor']);
});

test('--dir moves into the checkout only for a command that works on one', async () => {
  const missing = join(tmpdir(), 'fv-no-such-dir-for-help-test');
  const projects = await run(['projects', '--dir', missing]);
  assert.equal(projects.code, 0, projects.stderr);
  assert.doesNotMatch(projects.stderr, /cannot use directory/);
  const logs = await run(['logs', '--dir', missing]);
  assert.equal(logs.code, 1);
  assert.match(logs.stderr, /cannot use directory/);
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
