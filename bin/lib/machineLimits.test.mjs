/**
 * WHAT THIS MACHINE CAN BE GIVEN — the cgroup-before-host rule, driven with
 * supplied measurements (SOLID F059). Before the split the rule ran at
 * config.mjs import against whatever cgroup the suite sat in; every case here
 * names its own.
 *
 * Run: node --test bin/lib/machineLimits.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveMachineLimits, measureMachineLimits } from './machineLimits.mjs';

const GiB = 1024 ** 3;
const host = { hostMemBytes: 256 * GiB, hostCores: 64 };

test('a memory quota under the host total binds', () => {
  assert.equal(deriveMachineLimits({ ...host, memMax: String(4 * GiB) }).memBytes, 4 * GiB);
});

test('"max" and a quota above the host leave the host total', () => {
  assert.equal(deriveMachineLimits({ ...host, memMax: 'max' }).memBytes, 256 * GiB);
  assert.equal(deriveMachineLimits({ ...host, memMax: String(512 * GiB) }).memBytes, 256 * GiB);
});

test('a CPU quota floors to whole cores, never below one', () => {
  assert.equal(deriveMachineLimits({ ...host, cpuMax: '400000 100000' }).cores, 4);
  assert.equal(deriveMachineLimits({ ...host, cpuMax: '250000 100000' }).cores, 2);
  assert.equal(deriveMachineLimits({ ...host, cpuMax: '50000 100000' }).cores, 1);
  // A quota above the host's cores does not invent cores.
  assert.equal(deriveMachineLimits({ ...host, cpuMax: '12800000 100000' }).cores, 64);
  assert.equal(deriveMachineLimits({ ...host, cpuMax: 'max 100000' }).cores, 64);
});

test('unparseable cgroup contents are ignored, the host figure stands', () => {
  const d = deriveMachineLimits({ ...host, memMax: 'garbage', cpuMax: 'x y' });
  assert.deepEqual(d, { memBytes: 256 * GiB, cores: 64 });
  assert.equal(deriveMachineLimits({ ...host, memMax: '0' }).memBytes, 256 * GiB);
  assert.equal(deriveMachineLimits({ ...host, cpuMax: '400000 0' }).cores, 64);
});

test('no cgroup files: the host, with two cores when the host reports none', () => {
  assert.deepEqual(deriveMachineLimits({ ...host }), { memBytes: 256 * GiB, cores: 64 });
  assert.equal(deriveMachineLimits({ hostMemBytes: GiB, hostCores: 0 }).cores, 2);
});

test('measureMachineLimits hands the rule the files its reader returns', () => {
  const asked = [];
  const d = measureMachineLimits((f) => {
    asked.push(f);
    return { 'memory.max': String(GiB), 'cpu.max': '100000 100000' }[f] ?? null;
  });
  assert.deepEqual(asked.sort(), ['cpu.max', 'memory.max']);
  assert.equal(d.cores, 1);
  assert.ok(d.memBytes <= GiB);
});

test('the rule has one home: config.mjs reads no cgroup file and no host total', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, 'config.mjs'), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  assert.ok(src.includes('measureMachineLimits()'), 'anchor: config.mjs takes MACHINE from machineLimits.mjs');
  for (const banned of ['/sys/fs/cgroup', 'totalmem(', 'cpus(']) {
    assert.ok(!src.includes(banned), `config.mjs must not measure the machine itself (${banned})`);
  }
});
