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

test('--purge disconnects each stored project and KEEPS local state after a server failure, so it can retry', async (t) => {
  const f = fixture(t);
  f.put('.flowviant/credentials.json', 'saved');
  const seen = [];
  const result = await runUninstall({ ...f.options, purge: true,
    projects: () => [{ projectId: 'one' }, { projectId: 'two' }],
    disconnect: async (entry) => { seen.push(entry.projectId); if (entry.projectId === 'one') throw new Error('server down'); return { ok: true }; },
  });
  assert.deepEqual(seen, ['one', 'two']);
  assert.equal(result.ok, false);
  assert.match(result.errors[0], /registry removal for one: server down/);
  // The copies still go — the person asked to uninstall — but the credential
  // store that could still tell the app stays.
  assert.equal(fs.existsSync(f.binary), false);
  assert.equal(fs.readFileSync(join(f.home, '.flowviant', 'credentials.json'), 'utf8'), 'saved');
  assert.ok(result.kept.includes(join(f.home, '.flowviant')));
});

test('a leave the app answers with HTTP 500 is reported from the outcome, and the credential stays to retry', async (t) => {
  const f = fixture(t);
  f.put('.flowviant/credentials.json', 'saved');
  const { disconnectHere } = await import('./machineDisconnect.mjs');
  const lines = [];
  const forgotten = [];
  const result = await runUninstall({ ...f.options, purge: true,
    // The wording is irrelevant now: a log that says nothing recognisable must
    // not change the decision.
    log: (m) => lines.push(m),
    projects: () => [{ projectId: 'p1', fleetToken: 'fva_1', name: 'Alpha' }],
    disconnect: (entry, log) => disconnectHere(entry, {
      stopDaemon: () => ({ stopped: 0, unconfirmed: 0, failed: 0, running: 0 }),
      leave: async () => ({ error: 'HTTP 500' }),
      forget: (id) => { forgotten.push(id); return {}; },
    }, { log: () => log('…'), forgetAfterFailedLeave: false }),
  });
  assert.equal(result.ok, false);
  assert.match(result.errors[0], /^registry removal for p1: could not tell the app this box has left \(HTTP 500\)$/);
  assert.deepEqual(forgotten, [], 'the credential is kept, not forgotten, after a failed leave');
  assert.equal(fs.existsSync(join(f.home, '.flowviant', 'credentials.json')), true);
  assert.ok(lines.some((l) => /Kept ~\/\.flowviant: the purge did not finish for every project \(see the errors below\)\. .*remove this box on the project's Machines page\./.test(l)));
});

test('a daemon finishing a deploy holds the purge: nothing left or forgotten, ~/.flowviant kept to finish later', async (t) => {
  const f = fixture(t);
  f.put('.flowviant/credentials.json', 'saved');
  const { disconnectHere } = await import('./machineDisconnect.mjs');
  const acts = [];
  const result = await runUninstall({ ...f.options, purge: true,
    projects: () => [{ projectId: 'p1', fleetToken: 'fva_1', name: 'Alpha' }],
    disconnect: (entry, log) => disconnectHere(entry, {
      stopDaemon: () => ({ stopped: 1, unconfirmed: 0, failed: 0, running: 1, draining: 1 }),
      leave: async () => { acts.push('leave'); return { removed: true }; },
      forget: () => { acts.push('forget'); return {}; },
    }, { log, forgetAfterFailedLeave: false }),
  });
  assert.deepEqual(acts, [], 'the credential the deploy report needs, and the app row, are both left alone');
  assert.equal(result.ok, false);
  assert.match(result.errors[0], /^registry removal for p1: a daemon for it is finishing a deploy here; wait for it to finish$/);
  assert.equal(fs.readFileSync(join(f.home, '.flowviant', 'credentials.json'), 'utf8'), 'saved');
});

test('a clean purge deletes local state; an older server with no leave route is said but does not hold it', async (t) => {
  for (const outcome of [
    { ok: true, stop: 'none', leave: 'left', forget: 'forgotten' },
    { ok: true, stop: 'stopped', leave: 'unsupported', forget: 'forgotten' },
  ]) {
    const f = fixture(t);
    f.put('.flowviant/credentials.json', 'saved');
    const result = await runUninstall({ ...f.options, purge: true,
      projects: () => [{ projectId: 'p1' }],
      disconnect: async () => outcome,
    });
    assert.equal(fs.existsSync(join(f.home, '.flowviant')), false, JSON.stringify(outcome));
    assert.equal(result.ok, outcome.leave === 'left', JSON.stringify(outcome));
    if (outcome.leave === 'unsupported') assert.match(result.errors[0], /older server/);
  }
});

test('uninstall decides on the outcome, never on the disconnect\'s sentences', () => {
  const src = fs.readFileSync(new URL('./uninstall.mjs', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
  assert.ok(src.includes('disconnectShortfall(await disconnect(entry, line))'));
  assert.ok(!/could not tell the app\|/.test(src), 'no phrase regex over log lines');
  assert.ok(!src.includes('messages.find('), 'no reading of collected messages');
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

test('human lines say a PATH line left the rc file, and a fresh install stays quiet about its own copy', async (t) => {
  const f = fixture(t);
  const lines = [];
  await runUninstall({ ...f.options, others: true, log: (m) => lines.push(m) });
  assert.equal(lines.some((m) => /running copy/.test(m)), false);
  const all = [];
  await runUninstall({ ...f.options, log: (m) => all.push(m) });
  assert.ok(all.includes(`removed the flowviant PATH line from ${f.rc}`));
  assert.equal(all.includes(`removed ${f.rc}`), false);
});

test('every discoverable kind has a strategy for protection and removal', async (t) => {
  const { COPY_KINDS, copyKind } = await import('./uninstallCopies.mjs');
  const f = fixture(t);
  const plan = await buildUninstallPlan(f.options);
  const kinds = new Set(plan.copies.map((c) => c.kind));
  assert.deepEqual([...kinds].sort(), ['binary', 'npm-global', 'npx-cache', 'path-line']);
  for (const kind of Object.keys(COPY_KINDS)) {
    const k = copyKind(kind);
    assert.equal(typeof k.label, 'string', kind);
    assert.equal(typeof k.current, 'function', kind);
    assert.equal(typeof k.othersSkip, 'function', kind);
    assert.equal(typeof k.remove, 'function', kind);
    assert.equal(typeof k.removedLine, 'function', kind);
    assert.equal(typeof k.removeHint, 'string', kind);
    assert.ok(k.runsFrom === null || typeof k.runsFrom === 'function', kind);
  }
  assert.throws(() => copyKind('snap'), /unknown installed-copy kind 'snap'/);
  assert.throws(() => copyKind('toString'), /unknown installed-copy kind/);
  // Running-copy protection, per kind that a daemon can run from.
  const table = [
    ['binary', '/opt/flowviant', '/opt/flowviant', true],
    ['binary', '/opt/flowviant', '/opt/flowviant-old', false],
    ['npm-global', '/g/node_modules/flowviant/bin/cli.mjs', '/g/node_modules/flowviant', true],
    ['npx-cache', '/h/.npm/_npx/a/node_modules/flowviant/bin/cli.mjs', '/h/.npm/_npx/a', true],
    ['npx-cache', '/h/.npm/_npx/b/cli.mjs', '/h/.npm/_npx/a', false],
  ];
  for (const [kind, daemonPath, source, runs] of table) assert.equal(copyKind(kind).runsFrom(daemonPath, source), runs, `${kind} ${daemonPath}`);
  assert.equal(copyKind('path-line').runsFrom, null, 'no daemon runs from an rc file line');
});

test('doctor and removal read a copy kind from the table, never by its name', () => {
  const code = (file) => fs.readFileSync(new URL(`./${file}`, import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
  const views = code('views.mjs');
  assert.ok(views.includes('kind.removeHint'), 'doctor reads the removal hint from the table');
  assert.equal(/kind\s*[!=]==\s*'(binary|npm-global|npx-cache|path-line)'/.test(views), false, 'views.mjs branches on a copy kind name');
  assert.equal(views.includes('sudo npm uninstall'), false, 'the npm hint has one home (uninstallCopies.mjs)');
});

test('a live daemon running from each kind of copy protects it under --others', async (t) => {
  // One run per kind a daemon can run from. The binary case needs a second,
  // non-current binary (the fixture's own binary is skipped as the running
  // copy whatever a daemon does), so it adds a proven one on PATH.
  const cases = [
    { kind: 'binary', setup: (f) => {
      const elf = f.put('opt/flowviant', '\x7fELF-not-really');
      fs.chmodSync(elf, 0o755);
      return { path: elf, exe: elf, script: elf, extra: { path: `${f.options.path}:${join(f.home, 'opt')}`,
        execFile: async (file, args) => (args[0] === 'root' ? { stdout: `${f.npmRoot}\n` } : file === 'npm' ? f.options.execFile(file, args) : { stdout: '0.99.0\n' }) } };
    } },
    { kind: 'npm-global', setup: (f) => {
      const pkg = join(f.npmRoot, 'flowviant');
      return { path: pkg, exe: '/usr/bin/node', script: join(pkg, 'bin', 'cli.mjs') };
    } },
    { kind: 'npx-cache', setup: (f) => {
      const pkg = join(f.npx, '..');
      return { path: pkg, exe: '/usr/bin/node', script: join(pkg, 'bin', 'cli.mjs') };
    } },
  ];
  for (const { kind, setup } of cases) {
    const f = fixture(t);
    f.put('.flowviant/daemon-123456789abc.lock', '{"pid":77}');
    const running = setup(f);
    f.options.pidLive = (pid) => pid === 77;
    f.options.procReader = (_, file) => (file === 'exe' ? running.exe : Buffer.from(`${running.exe}\0${running.script}\0`));
    const result = await runUninstall({ ...f.options, ...running.extra, others: true });
    const skip = result.skipped.find((c) => c.kind === kind && c.path === running.path);
    assert.ok(skip, `${kind}: the copy the daemon runs from is skipped`);
    assert.match(skip.reason, /pid 77/, kind);
    assert.equal(fs.existsSync(running.path), true, `${kind}: still on disk`);
    assert.equal(result.removed.some((c) => c.path === running.path), false, kind);
    // Every other copy of a kind a daemon can run from, not current, goes.
    assert.ok(result.removed.length > 0, `${kind}: idle copies are still removed`);
  }
});
