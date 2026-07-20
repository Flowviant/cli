/**
 * `flowviant env <import|set|show>` — the CLI half of team env sync.
 *
 * import <file> [--file <targetFile>]  seed the synced bundle from an existing
 *                                      env file (KEY=value lines; comments and
 *                                      blank lines skipped). The onboarding
 *                                      moment: one command, whole team synced.
 * set <KEY> [--file <targetFile>]      set/rotate one value (prompted on stdin,
 *                                      never argv — argv leaks into shell
 *                                      history and `ps`).
 * show [KEY]                           decrypt locally and print — only works
 *                                      on an ENROLLED machine (this is the
 *                                      only place values are ever readable).
 *
 * Writes are sealed to the project pubkey on this machine (same write-only
 * crypto as the browser) and pushed via the fleet-token endpoint; every
 * enrolled daemon resyncs within seconds via the push channel.
 */

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { createInterface } from 'node:readline';
import sodium from 'libsodium-wrappers';
import { FLEET_URL, FLEET_TOKEN, USER_AGENT } from './config.mjs';
import { ensureKeypair, myPubB64, fetchBundle } from './env.mjs';

const B64 = () => sodium.base64_variants.ORIGINAL;
const KEYS_URL = FLEET_URL.replace(/\/agents\/?$/, '/env/keys');

const die = (msg) => {
  console.error(`error: ${msg}`);
  process.exit(1);
};

const fingerprint = (value) => (value ? `${value.slice(0, 4)}…(${value.length})` : '');

async function postKey({ name, targetFile, value, keyEpoch, baseVersion, projectPub }) {
  const ciphertext = sodium.to_base64(
    sodium.crypto_box_seal(sodium.from_string(value), sodium.from_base64(projectPub, B64())),
    B64()
  );
  const res = await fetch(KEYS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${FLEET_TOKEN}`,
      'User-Agent': USER_AGENT,
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout(30_000),
    body: JSON.stringify({
      pubkey: myPubB64(),
      name,
      env: 'dev',
      targetFile,
      ciphertext,
      fingerprint: fingerprint(value),
      keyEpoch,
      baseVersion: baseVersion ?? null,
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json?.success === false) {
    throw new Error(`${name}: ${json?.error ?? `HTTP ${res.status}`}`);
  }
}

function parseEnvFile(text) {
  const out = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const name = line.slice(0, eq).trim().replace(/^export\s+/, '');
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
    let value = line.slice(eq + 1).trim();
    // Strip one layer of matching quotes — the convention .env parsers follow.
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (value) out.push({ name, value });
  }
  return out;
}

function argAfter(args, flag) {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : null;
}

async function readSecretFromStdin(promptText) {
  // Muted input — the typed secret must NOT echo to the terminal (a shoulder-
  // surf / screen-share leak). We write the prompt ourselves, then swallow ALL
  // readline output while reading. Keying the mute on "does this write contain
  // the prompt?" is unsafe: readline's line-refresh (backspace, mid-line edit,
  // paste, resize) re-emits `prompt + buffer` as ONE string, which would sail
  // through such a check and echo the secret. So: mute EVERYTHING.
  process.stderr.write(promptText);
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  rl._writeToOutput = () => {}; // swallow every echo/refresh unconditionally
  const value = await new Promise((resolve) => rl.question('', resolve));
  process.stderr.write('\n');
  rl.close();
  return value.trim();
}

export async function runEnvCommand(args) {
  if (!FLEET_TOKEN) die('no fleet credential — run `flowviant login` first.');
  await sodium.ready;
  await ensureKeypair();
  const cmd = args[0];

  if (cmd === 'import') {
    const file = args[1];
    if (!file) die('usage: flowviant env import <path/to/.env> [--file <targetFile>]');
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch (e) {
      die(`could not read ${file}: ${e.message}`);
    }
    const entries = parseEnvFile(text);
    if (!entries.length) die(`no KEY=value lines found in ${file}.`);
    // Default target: the file's repo-relative-looking path as given (minus
    // leading ./) — `flowviant env import apps/api/.dev.vars` targets exactly
    // that file in every worktree.
    const targetFile = argAfter(args, '--file') ?? file.replace(/^\.\//, '');
    const bundle = await fetchBundle();
    if (bundle.status !== 'enrolled') die('this machine is not enrolled — approve it in Settings → Environment first.');
    if (!bundle.projectPub) die('no project env keypair yet — start the daemon once to bootstrap it.');
    const existing = new Map(bundle.keys.map((k) => [k.name, k]));
    let added = 0;
    let updated = 0;
    for (const e of entries) {
      const prior = existing.get(e.name);
      try {
        await postKey({
          name: e.name,
          targetFile,
          value: e.value,
          keyEpoch: bundle.keyEpoch,
          baseVersion: prior?.version ?? null,
          projectPub: bundle.projectPub,
        });
        prior ? updated++ : added++;
      } catch (err) {
        console.error(`  skip ${err.message}`);
      }
    }
    console.log(`imported ${basename(file)} → ${targetFile}: ${added} added, ${updated} updated. Every daemon syncs in seconds.`);
    return;
  }

  if (cmd === 'set') {
    const name = args[1];
    if (!name || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) die('usage: flowviant env set <KEY> [--file <targetFile>]');
    const bundle = await fetchBundle();
    if (bundle.status !== 'enrolled') die('this machine is not enrolled — approve it in Settings → Environment first.');
    if (!bundle.projectPub) die('no project env keypair yet — start the daemon once to bootstrap it.');
    const prior = bundle.keys.find((k) => k.name === name);
    const targetFile = argAfter(args, '--file') ?? prior?.targetFile ?? '.env';
    const value = await readSecretFromStdin(`value for ${name} (hidden): `);
    if (!value) die('empty value — nothing set.');
    await postKey({
      name,
      targetFile,
      value,
      keyEpoch: bundle.keyEpoch,
      baseVersion: prior?.version ?? null,
      projectPub: bundle.projectPub,
    });
    console.log(`${name} ${prior ? `rotated (v${prior.version + 1})` : 'added'} → ${targetFile}. Every daemon syncs in seconds.`);
    return;
  }

  if (cmd === 'show') {
    const bundle = await fetchBundle();
    if (bundle.status !== 'enrolled') die('this machine is not enrolled — approve it in Settings → Environment first.');
    if (!bundle.wrappedPriv) die('no key material for this machine yet.');
    const kp = await ensureKeypair();
    const priv = sodium.crypto_box_seal_open(
      sodium.from_base64(bundle.wrappedPriv, B64()),
      kp.publicKey,
      kp.privateKey
    );
    const pub = sodium.from_base64(bundle.projectPub, B64());
    const filter = args[1];
    let shown = 0;
    for (const k of bundle.keys) {
      if (filter && k.name !== filter) continue;
      try {
        const plain = sodium.to_string(sodium.crypto_box_seal_open(sodium.from_base64(k.ciphertext, B64()), pub, priv));
        console.log(`${k.name}=${plain}`);
        shown++;
      } catch {
        console.error(`# ${k.name}: cannot open (stale epoch — a rotation should heal it)`);
      }
    }
    if (filter && !shown) die(`no key named ${filter}.`);
    return;
  }

  console.log(
    [
      'flowviant env — team-synced, end-to-end-encrypted dev secrets',
      '',
      '  flowviant env import <file> [--file <targetFile>]   seed from an existing env file',
      '  flowviant env set <KEY> [--file <targetFile>]       set/rotate one value (stdin)',
      '  flowviant env show [KEY]                            decrypt locally (enrolled machines only)',
    ].join('\n')
  );
}
