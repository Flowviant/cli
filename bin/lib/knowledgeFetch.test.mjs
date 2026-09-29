/**
 * THE KNOWLEDGE DOWNLOAD (2026-09-26, split out with knowledgeFetch.mjs —
 * SOLID F049): which door each fetch asks, what a refused size returns, and
 * that no other daemon module spells either door.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { knowledgeFetcher } from './knowledgeFetch.mjs';

const id = (n) => `0000000${n}-aaaa-bbbb-cccc-dddddddddddd`;

test('the fetcher asks the library door for a library item and the knowledge door otherwise', async () => {
  const seen = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    return new Response('ok', { status: 200, headers: { 'content-length': '2' } });
  };
  try {
    const f = knowledgeFetcher({ fleetUrl: 'https://api.test/api/fleet/agents', token: 't', userAgent: 'ua' });
    await f(id(1));
    await f(id(2), { library: true });
  } finally {
    globalThis.fetch = real;
  }
  assert.deepEqual(seen, [
    `https://api.test/api/fleet/knowledge/${id(1)}`,
    `https://api.test/api/fleet/library/${id(2)}`,
  ]);
});

test('a bundle file, a preview and a size over the cap each take their own shape', async () => {
  const seen = [];
  const real = globalThis.fetch;
  let length = '2';
  globalThis.fetch = async (url, init) => {
    seen.push([String(url), init.headers.Authorization, init.headers['User-Agent']]);
    return new Response('ok', { status: 200, headers: { 'content-length': length } });
  };
  try {
    const f = knowledgeFetcher({ fleetUrl: 'https://api.test/api/fleet/agents', token: 't', userAgent: 'ua', maxBytes: 5 });
    await f(id(1), { library: true, fileIndex: 3 });
    await f(id(1), { library: true, preview: true });
    length = '9';
    const over = await f(id(2));
    // Over the cap is a REFUSAL the verify loop reads as one, never a throw.
    assert.equal(over.length, 6);
  } finally {
    globalThis.fetch = real;
  }
  assert.deepEqual(seen, [
    [`https://api.test/api/fleet/library/${id(1)}/file/3`, 'Bearer t', 'ua'],
    [`https://api.test/api/fleet/library/${id(1)}/preview`, 'Bearer t', 'ua'],
    [`https://api.test/api/fleet/knowledge/${id(2)}`, 'Bearer t', 'ua'],
  ]);
});

test('a failed response throws, so the sync retries it', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async () => new Response('no', { status: 500 });
  try {
    const f = knowledgeFetcher({ fleetUrl: 'https://api.test/api/fleet/agents', token: 't', userAgent: 'ua' });
    await assert.rejects(() => f(id(1)), /HTTP 500/);
  } finally {
    globalThis.fetch = real;
  }
});

test('the knowledge and library doors are spelled only in knowledgeFetch.mjs', () => {
  const dir = new URL('./', import.meta.url);
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const door = /fleetEndpoint\(\s*'(knowledge|library)'/g;
  const found = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.mjs') || f.endsWith('.test.mjs')) continue;
    const src = strip(readFileSync(new URL(f, dir), 'utf8'));
    for (const m of src.matchAll(door)) found.push(`${f}:${m[1]}`);
  }
  assert.deepEqual(found.sort(), ['knowledgeFetch.mjs:knowledge', 'knowledgeFetch.mjs:library']);
});
