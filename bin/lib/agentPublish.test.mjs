import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PUBLISH_REF_RE,
  isPublishRef,
  isSha,
  agentBranchRef,
  publishPushArgs,
  publishFetchArgs,
  publishDeleteArgs,
  publishErrorText,
} from './agentPublish.mjs';

/**
 * THE ARGV BUILDERS, tested for what they REFUSE first.
 *
 * Every function here composes a refspec out of a value the SERVER named, and
 * one of them composes a DELETE. A bug in the shape check is not a feature
 * failing to work — it is `git push origin :refs/heads/main` on somebody's base
 * branch. So the refusals are the first block, and each flag character below is
 * one git would accept in a ref name if the whitelist ever became a blacklist.
 */

test('a ref outside the prefix never reaches argv, in any of the three calls', () => {
  const hostile = [
    'main',
    'refs/heads/main',
    '../main',
    'flowviant',
    'flowviant/',
    'notflowviant/x',
    'Flowviant/x', // the prefix is a literal, not a case-insensitive idea
    ' flowviant/x',
    'flowviant/x y',
    'flowviant/x:y',
    'flowviant/x\nmain',
    '-flowviant/x',
    `flowviant/${'x'.repeat(81)}`,
    '',
    null,
    undefined,
    42,
  ];
  for (const ref of hostile) {
    assert.equal(isPublishRef(ref), false, `${String(ref)} must not pass the shape check`);
    assert.equal(publishPushArgs('a-1', ref), null, `push argv built for ${String(ref)}`);
    assert.equal(publishFetchArgs(ref, 'a-1'), null, `fetch argv built for ${String(ref)}`);
    assert.equal(publishDeleteArgs(ref), null, `DELETE argv built for ${String(ref)}`);
  }
  // …and the one shape the server can actually compose passes all three.
  assert.equal(isPublishRef('flowviant/auth-split-3f9a21'), true);
  assert.ok(PUBLISH_REF_RE.test('flowviant/agent-3f9a21'));
});

test('a place that is not a safe path segment builds nothing either', () => {
  // The local side of every refspec is `session/<place>`, so an unchecked place
  // is a second road to naming a branch nobody meant. `agentBranchRef` is the
  // one definition, and a push, a fetch and the begun-guard all read it.
  for (const place of ['../..', 'a/1', '', null, 'a 1']) {
    assert.equal(agentBranchRef(place), null);
    assert.equal(publishPushArgs(place, 'flowviant/x-3f9a21'), null);
    assert.equal(publishFetchArgs('flowviant/x-3f9a21', place), null);
  }
  assert.equal(agentBranchRef('a-3f9a21'), 'refs/heads/session/a-3f9a21');
});

test('the push leases against what THIS process saw, and says so explicitly', () => {
  const sha = 'c16e888f3b2a1d4e5f60718293a4b5c6d7e8f901';
  const args = publishPushArgs('a-3f9a21', 'flowviant/auth-3f9a21', sha);
  assert.deepEqual(args, [
    'push',
    `--force-with-lease=refs/heads/flowviant/auth-3f9a21:${sha}`,
    'origin',
    'refs/heads/session/a-3f9a21:refs/heads/flowviant/auth-3f9a21',
  ]);
  /**
   * THE BARE FORM IS THE BUG, AND IT IS OUR OWN DOING. `--force-with-lease`
   * with no value expects the REMOTE-TRACKING ref — and the worktree sweep runs
   * `git fetch origin --quiet` on its own beat, which refreshes exactly that
   * ref. So the expectation is refreshed to whatever a rival box just pushed,
   * the lease passes, and the push overwrites the rival's commits in silence:
   * measured against real repos as `! [rejected] (stale info)` before that
   * fetch and `(forced update)` after it. BANNED as a string, because the
   * failure is invisible — the argv still reads as protected.
   */
  assert.ok(
    !args.includes('--force-with-lease'),
    'the bare lease is laundered by this daemon’s own fetch'
  );
  assert.ok(!args.includes('--force'));
});

test('no observation means no force flag at all — never a --force wearing a safer name', () => {
  const plain = ['push', 'origin', 'refs/heads/session/a-3f9a21:refs/heads/flowviant/auth-3f9a21'];
  // Everything that is not a sha this machine measured: a fresh process has
  // seen nothing, and the values below are the shapes a bug could hand it.
  for (const seen of [null, undefined, '', 'HEAD', 'main', 'not-a-sha', 'abc', 'g'.repeat(40), 'a'.repeat(41), 42]) {
    assert.equal(isSha(seen), false, `${String(seen)} must not read as a sha`);
    assert.deepEqual(
      publishPushArgs('a-3f9a21', 'flowviant/auth-3f9a21', seen),
      plain,
      `a force flag was built from ${String(seen)}`
    );
  }
  // Unforced, git creates the ref or fast-forwards it — every ordinary case,
  // including the stale-merge fold, which MERGES base in and so leaves a
  // descendant — and refuses a genuine divergence, which is the failure the
  // caller reports rather than work it silently discards.
  assert.equal(isSha('c16e888'), true, 'a short sha is still a measurement');
  assert.equal(isSha('c16e888f3b2a1d4e5f60718293a4b5c6d7e8f901'), true);
});

test('the fetch is NOT forced — it may create a branch and may never clobber one', () => {
  const args = publishFetchArgs('flowviant/auth-3f9a21', 'a-3f9a21');
  assert.deepEqual(args, [
    'fetch',
    'origin',
    'refs/heads/flowviant/auth-3f9a21:refs/heads/session/a-3f9a21',
  ]);
  /**
   * THE MISSING `+` IS THE SAFETY. A forced fetch onto the local branch would
   * overwrite commits this box has and the remote does not — the unpushed tail
   * of a turn that died before its publish. Without it git refuses any
   * non-fast-forward update, which is exactly the fallback the caller wants.
   */
  assert.ok(!args[2].startsWith('+'), 'a forced fetch can destroy local commits');
});

test('the delete is a colon refspec and nothing else', () => {
  assert.deepEqual(publishDeleteArgs('flowviant/auth-3f9a21'), [
    'push',
    'origin',
    ':refs/heads/flowviant/auth-3f9a21',
  ]);
});

test('a push failure is relayed as its DIAGNOSIS, with any credential in the URL stripped', () => {
  const stderr = [
    'To https://user:ghp_secrettoken@github.com/acme/app.git',
    ' ! [rejected]        session/a-1 -> flowviant/auth-3f9a21 (stale info)',
    "error: failed to push some refs to 'https://user:ghp_secrettoken@github.com/acme/app.git'",
  ].join('\n');
  const out = publishErrorText(stderr);
  // git puts `To <url>` FIRST, so a first-line reader relays the remote's
  // address and never the failure.
  assert.match(out, /stale info/);
  assert.match(out, /failed to push some refs/);
  assert.ok(!out.includes('To https://'), 'the head line is not the answer');
  // Stored server-side and rendered to the whole project: userinfo cannot ride
  // along. The daemon scrubs its env values before this; neither check knows
  // about the other, which is why both run.
  assert.ok(!out.includes('ghp_secrettoken'));
  assert.ok(!out.includes('user:'));
  assert.ok(out.length <= 300);
  // An error with nothing in it still says something a person can act on.
  assert.equal(publishErrorText(''), 'the push failed');
  assert.equal(publishErrorText(null), 'the push failed');
  assert.ok(publishErrorText('x'.repeat(900)).length === 300);
});

test('git\'s advice is not its reason — the two commonest real failures relay the reason', () => {
  /**
   * Both of these end with the SAME four lines of advice, which is true of
   * every auth failure there has ever been and says nothing about this one. A
   * pure tail reader relays exactly that, for every remote this feature can
   * fail against, forever.
   */
  const advice = '\nPlease make sure you have the correct access rights\nand the repository exists.';
  const noRemote = publishErrorText(
    "fatal: 'origin' does not appear to be a git repository\nfatal: Could not read from remote repository." +
      advice
  );
  assert.match(noRemote, /does not appear to be a git repository/);
  assert.ok(!noRemote.includes('access rights'));

  const noKey = publishErrorText(
    'git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.' +
      advice
  );
  assert.match(noKey, /Permission denied \(publickey\)/);
  assert.ok(!noKey.includes('access rights'));

  // …and output carrying no diagnostic marker at all still says SOMETHING: a
  // relay with nothing to relay must not go quiet.
  assert.equal(publishErrorText('something unfamiliar happened'), 'something unfamiliar happened');
});
