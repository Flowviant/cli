import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adoptLoginPath, loginShellPath, mergePath, userBinDirs } from './loginPath.mjs';

test('the login shell PATH is read past anything a startup file prints', () => {
  const exec = (shell, args, opts) => {
    assert.deepEqual(args.slice(0, 1), ['-ilc']);
    assert.equal(opts.stdio[0], 'ignore');
    return 'Welcome to Ubuntu\n\n__FLOWVIANT_PATH__=/home/w/.local/bin:/usr/bin\n';
  };
  assert.equal(loginShellPath({ env: { SHELL: '/bin/zsh' }, exec }), '/home/w/.local/bin:/usr/bin');
  assert.equal(loginShellPath({ env: {}, exec: () => { throw new Error('timed out'); } }), null);
  assert.equal(loginShellPath({ env: {}, exec: () => 'no marker' }), null);
});

test('the current PATH keeps its order; additions come after it, once', () => {
  assert.equal(mergePath('/usr/bin:/bin', '/home/w/.local/bin:/usr/bin', ['/home/w/.bun/bin']), '/usr/bin:/bin:/home/w/.local/bin:/home/w/.bun/bin');
  assert.equal(mergePath('', null, []), '');
});

test('per-user bin dirs are the ones that exist, with the newest nvm node', () => {
  const have = new Set(['/h/.local/bin', '/h/.nvm/versions/node/v22.3.0/bin']);
  const dirs = userBinDirs({ home: '/h', exists: (d) => have.has(d), list: () => ['v18.20.1', 'v22.3.0', 'v20.11.0', 'system'] });
  assert.deepEqual(dirs, ['/h/.local/bin', '/h/.nvm/versions/node/v22.3.0/bin']);
});

test('a tray-started daemon gains the terminal PATH; a terminal start is unchanged in order', () => {
  const env = { PATH: '/usr/local/bin:/usr/bin', SHELL: '/bin/bash' };
  adoptLoginPath({ env, exec: () => '__FLOWVIANT_PATH__=/home/w/.nvm/versions/node/v22.3.0/bin:/usr/bin\n', home: '/nowhere' });
  assert.equal(env.PATH, '/usr/local/bin:/usr/bin:/home/w/.nvm/versions/node/v22.3.0/bin');
  const kept = { PATH: '/a', FLOWVIANT_KEEP_PATH: '1' };
  adoptLoginPath({ env: kept, exec: () => '__FLOWVIANT_PATH__=/b\n' });
  assert.equal(kept.PATH, '/a');
});
