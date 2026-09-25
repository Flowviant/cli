import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildUninstallPlan, runUninstall } from './uninstall.mjs';

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'flowviant-uninstall-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const put = (path, value = '') => { fs.mkdirSync(join(home, path, '..'), { recursive: true }); fs.writeFileSync(join(home, path), value); return join(home, path); };
  const binary = put('.flowviant/bin/flowviant', 'binary');
  const npmRoot = join(home, 'npm-global', 'node_modules');
  const npmPackage = put('npm-global/node_modules/flowviant/package.json', '{"name":"flowviant","version":"1.2.3"}');
  const npx = put('.npm/_npx/solo/node_modules/flowviant/package.json', '{"name":"flowviant","version":"1.1.0"}');
  put('.npm/_npx/solo/package.json', '{"dependencies":{"flowviant":"1.1.0"}}');
  const mixed = put('.npm/_npx/mixed/node_modules/flowviant/package.json', '{"name":"flowviant"}');
  put('.npm/_npx/mixed/package.json', '{"dependencies":{"flowviant":"1.1.0","other":"1"}}');
  const rc = put('.zshrc', `before\n# flowviant\nexport PATH="${join(home, '.flowviant', 'bin')}:$PATH"\nafter\n`);
  const calls = [];
  const options = {
    home, fs, path: join(home, '.flowviant', 'bin'), compiled: true, execPath: binary,
    execFile: async (file, args) => {
      calls.push([file, ...args]);
      if (args[0] === 'root') return { stdout: `${npmRoot}\n` };
      if (file === 'npm') fs.rmSync(join(npmRoot, 'flowviant'), { recursive: true });
      return { stdout: '' };
    },
    procAvailable: true, pidLive: () => false, procReader: () => '',
    tty: false, yes: true, log: () => {}, stdout: () => {},
    stopAllDaemons: () => ({ failed: 0 }),
  };
  return { home, binary, npmRoot, npmPackage, npx, mixed, rc, calls, options, put };
}

test('plan finds installed copies and exact PATH block, and marks a mixed npx cache', async (t) => {
  const f = fixture(t);
  const plan = await buildUninstallPlan(f.options);
  assert.deepEqual(plan.copies.map((c) => c.kind).sort(), ['binary', 'npm-global', 'npx-cache', 'npx-cache', 'path-line'].sort());
  assert.equal(plan.copies.find((c) => c.path === join(f.npx, '..')).version, '1.1.0');
  assert.match(plan.copies.find((c) => c.path === join(f.mixed, '..')).skipReason, /other packages/);
  assert.equal(plan.copies.find((c) => c.path === f.binary).current, true);
});

test('a PATH symlink into another npm prefix is attributed to its package', async (t) => {
  const f = fixture(t);
  const cli = f.put('other/lib/node_modules/flowviant/bin/cli.mjs', 'cli');
  fs.chmodSync(cli, 0o755);
  f.put('other/lib/node_modules/flowviant/package.json', '{"version":"2.0.0"}');
  const link = join(f.home, 'other', 'bin', 'flowviant');
  fs.mkdirSync(join(f.home, 'other', 'bin'), { recursive: true });
  fs.symlinkSync(cli, link);
  const plan = await buildUninstallPlan({ ...f.options, path: join(f.home, 'other', 'bin') });
  const copy = plan.copies.find((c) => c.path === join(f.home, 'other', 'lib', 'node_modules', 'flowviant'));
  assert.equal(copy.kind, 'npm-global');
  assert.equal(copy.version, '2.0.0');
  assert.equal(copy.npmPrefix, join(f.home, 'other'));
  assert.equal(plan.copies.some((c) => c.kind === 'binary' && c.path === cli), false);
});

test('PATH probing ignores a regular file without execute permission', async (t) => {
  const f = fixture(t);
  const nonExecutable = f.put('extra/flowviant', 'data');
  const plan = await buildUninstallPlan({ ...f.options, path: join(f.home, 'extra') });
  assert.equal(plan.copies.some((copy) => copy.path === nonExecutable), false);
});

test('full uninstall stops first, removes copies, and keeps login data', async (t) => {
  const f = fixture(t);
  f.put('.flowviant/credentials.json', 'saved');
  f.options.stopAllDaemons = () => {
    assert.equal(fs.existsSync(f.binary), true);
    assert.equal(fs.existsSync(f.npx), true);
    return { failed: 0 };
  };
  const result = await runUninstall(f.options);
  assert.equal(result.ok, true);
  assert.equal(fs.existsSync(f.binary), false);
  assert.equal(fs.existsSync(join(f.home, '.npm', '_npx', 'solo')), false);
  assert.equal(fs.existsSync(join(f.home, '.npm', '_npx', 'mixed')), true);
  assert.equal(fs.readFileSync(join(f.home, '.flowviant', 'credentials.json'), 'utf8'), 'saved');
  assert.equal(fs.readFileSync(f.rc, 'utf8'), 'beforeafter\n');
});

test('--others keeps the launched binary and PATH line, skips a live daemon copy, and stops nothing', async (t) => {
  const f = fixture(t);
  const lock = f.put('.flowviant/daemon-123456789abc.lock', '{"pid":42}');
  f.options.pidLive = (pid) => pid === 42;
  f.options.procReader = (_, file) => file === 'exe' ? '/usr/bin/node' : Buffer.from(`/usr/bin/node\0${join(f.npx, '..', 'bin', 'cli.mjs')}\0`);
  f.options.stopAllDaemons = () => { throw new Error('must not stop'); };
  const result = await runUninstall({ ...f.options, others: true });
  assert.equal(result.ok, true);
  assert.equal(fs.existsSync(f.binary), true);
  assert.equal(fs.existsSync(lock), true);
  assert.equal(fs.existsSync(join(f.home, '.npm', '_npx', 'solo')), true);
  assert.equal(fs.readFileSync(f.rc, 'utf8').includes('# flowviant'), true);
  assert.match(result.skipped.find((c) => c.path === join(f.npx, '..')).reason, /pid 42/);
});

test('--purge disconnects each stored project and deletes locally after a server failure', async (t) => {
  const f = fixture(t);
  f.put('.flowviant/credentials.json', 'saved');
  const seen = [];
  const result = await runUninstall({ ...f.options, purge: true,
    projects: () => [{ projectId: 'one' }, { projectId: 'two' }],
    disconnect: async (entry) => { seen.push(entry.projectId); if (entry.projectId === 'one') throw new Error('server down'); return { ok: true }; },
  });
  assert.deepEqual(seen, ['one', 'two']);
  assert.equal(result.ok, false);
  assert.match(result.errors[0], /server down/);
  assert.equal(fs.existsSync(join(f.home, '.flowviant')), false);
});

test('PATH removal is byte exact, preserves near misses and mode', async (t) => {
  const f = fixture(t);
  fs.chmodSync(f.rc, 0o640);
  const near = f.put('.bashrc', `before\n# flowviant\nexport PATH='${join(f.home, '.flowviant', 'bin')}:$PATH'\nafter\n`);
  const beforeNear = fs.readFileSync(near);
  await runUninstall(f.options);
  assert.deepEqual(fs.readFileSync(near), beforeNear);
  assert.equal(fs.statSync(f.rc).mode & 0o777, 0o640);
  assert.equal(fs.readFileSync(f.rc, 'utf8'), 'beforeafter\n');
});

test('a custom install directory is found from the fish installer block', async (t) => {
  const f = fixture(t);
  const custom = f.put('custom/bin/flowviant', 'binary');
  const fish = f.put('.config/fish/conf.d/flowviant.fish', `set -gx EDITOR vim\n# flowviant\nfish_add_path "${join(f.home, 'custom', 'bin')}"\n`);
  const plan = await buildUninstallPlan({ ...f.options, path: '' });
  assert.ok(plan.copies.some((copy) => copy.path === custom && copy.kind === 'binary'));
  assert.ok(plan.copies.some((copy) => copy.path === fish && copy.kind === 'path-line'));
  await runUninstall({ ...f.options, path: '' });
  assert.equal(fs.existsSync(custom), false);
  assert.equal(fs.readFileSync(fish, 'utf8'), 'set -gx EDITOR vim');
});

test('without proc, --others treats every live daemon as possibly using each copy', async (t) => {
  const f = fixture(t);
  f.put('.flowviant/daemon-123456789abc.lock', '{"pid":42}');
  const result = await runUninstall({ ...f.options, others: true, procAvailable: false, pidLive: () => true });
  assert.equal(result.ok, true);
  assert.equal(fs.existsSync(f.binary), true);
  assert.equal(fs.existsSync(join(f.npmRoot, 'flowviant')), true);
  assert.equal(fs.existsSync(join(f.home, '.npm', '_npx', 'solo')), true);
  assert.equal(fs.readFileSync(f.rc, 'utf8').includes('# flowviant'), true);
});

test('headless without --yes removes nothing', async (t) => {
  const f = fixture(t);
  const lines = [];
  const result = await runUninstall({ ...f.options, yes: false, log: (line) => lines.push(line) });
  assert.equal(result.ok, false);
  assert.match(result.errors[0], /re-run with --yes/);
  assert.ok(lines.some((line) => line.includes(f.binary)));
  assert.equal(fs.existsSync(f.binary), true);
});

test('an empty plan exits successfully without confirmation', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'flowviant-uninstall-empty-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const lines = [];
  const result = await runUninstall({ home, fs, path: '', compiled: false, argvPath: join(home, 'missing'),
    execFile: async () => { throw new Error('npm unavailable'); },
    stopAllDaemons: () => ({ failed: 0 }), tty: false, yes: false,
    log: (line) => lines.push(line), stdout: () => {},
  });
  assert.equal(result.ok, true);
  assert.ok(lines.includes('no flowviant copies found on this machine.'));
});

test('TTY confirmation can decline without removal', async (t) => {
  const f = fixture(t);
  const questions = [];
  const result = await runUninstall({ ...f.options, yes: false, tty: true,
    prompt: async (question) => { questions.push(question); return 'n'; },
  });
  assert.deepEqual(questions, ['Remove these? [y/N] ']);
  assert.equal(result.ok, false);
  assert.equal(fs.existsSync(f.binary), true);
});

test('--json writes exactly one stdout line', async (t) => {
  const f = fixture(t);
  const stdout = [];
  const result = await runUninstall({ ...f.options, json: true, stdout: (line) => stdout.push(line) });
  assert.equal(stdout.length, 1);
  assert.deepEqual(JSON.parse(stdout[0]), result);
});

test('npm uninstall failure is reported while other copies are removed', async (t) => {
  const f = fixture(t);
  f.options.execFile = async (_, args) => {
    if (args[0] === 'root') return { stdout: `${f.npmRoot}\n` };
    throw Object.assign(new Error('permission denied'), { stderr: 'read-only prefix' });
  };
  const result = await runUninstall(f.options);
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /read-only prefix/);
  assert.equal(fs.existsSync(f.binary), false);
  assert.equal(fs.existsSync(join(f.npmRoot, 'flowviant')), true);
});

test('a wrapper script named flowviant elsewhere on PATH is not ours and is never planned', async (t) => {
  const f = fixture(t);
  const script = f.put('mybin/flowviant', '#!/bin/sh\nexec npx flowviant "$@"\n');
  fs.chmodSync(script, 0o755);
  const plan = await buildUninstallPlan({ ...f.options, path: join(f.home, 'mybin'),
    execFile: async (file, args) => (args[0] === 'root' ? { stdout: `${f.npmRoot}\n` } : { stdout: '0.100.0\n' }) });
  assert.equal(plan.copies.some((c) => c.path === script), false);
});

test('a compiled binary elsewhere on PATH counts only when it answers --version', async (t) => {
  const f = fixture(t);
  const elf = f.put('opt/flowviant', '\x7fELF-not-really');
  fs.chmodSync(elf, 0o755);
  const answering = await buildUninstallPlan({ ...f.options, path: join(f.home, 'opt'),
    execFile: async (file, args) => (args[0] === 'root' ? { stdout: `${f.npmRoot}\n` } : { stdout: '0.99.0\n' }) });
  assert.equal(answering.copies.find((c) => c.path === elf)?.version, '0.99.0');
  const silent = await buildUninstallPlan({ ...f.options, path: join(f.home, 'opt'),
    execFile: async (file, args) => { if (args[0] === 'root') return { stdout: `${f.npmRoot}\n` }; throw new Error('not flowviant'); } });
  assert.equal(silent.copies.some((c) => c.path === elf), false);
});
