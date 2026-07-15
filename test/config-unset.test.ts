/**
 * Pins the v0.32.3 `gbrain config unset` + `listConfigKeys` engine surface.
 * Required by `gbrain search modes --reset` [CDX-8].
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await engine.executeRaw(`DELETE FROM config WHERE key LIKE 'test.%' OR key LIKE 'search.%'`);
});

describe('engine.unsetConfig', () => {
  test('removes an existing key, returns 1', async () => {
    await engine.setConfig('test.k1', 'v1');
    const n = await engine.unsetConfig('test.k1');
    expect(n).toBe(1);
    const after = await engine.getConfig('test.k1');
    expect(after).toBeNull();
  });

  test('returns 0 for a missing key (no error)', async () => {
    const n = await engine.unsetConfig('test.never-existed');
    expect(n).toBe(0);
  });

  test('does not affect other keys', async () => {
    await engine.setConfig('test.keep', 'keep');
    await engine.setConfig('test.remove', 'gone');
    await engine.unsetConfig('test.remove');
    expect(await engine.getConfig('test.keep')).toBe('keep');
    expect(await engine.getConfig('test.remove')).toBeNull();
  });
});

describe('engine.listConfigKeys prefix-matcher', () => {
  test('empty when no key matches', async () => {
    expect(await engine.listConfigKeys('test.')).toEqual([]);
  });

  test('returns matching keys sorted ascending', async () => {
    await engine.setConfig('test.b', '2');
    await engine.setConfig('test.a', '1');
    await engine.setConfig('test.c', '3');
    await engine.setConfig('other', 'no');
    const keys = await engine.listConfigKeys('test.');
    expect(keys).toEqual(['test.a', 'test.b', 'test.c']);
  });

  test('prefix is an EXACT literal match — no glob wildcards', async () => {
    await engine.setConfig('test.matchme', 'yes');
    // % in user input is escaped — does NOT act as wildcard.
    expect(await engine.listConfigKeys('test%')).toEqual([]);
    expect(await engine.listConfigKeys('test.match')).toEqual(['test.matchme']);
  });

  test('underscore in prefix is escaped (literal _)', async () => {
    await engine.setConfig('test_underscore', 'val');
    await engine.setConfig('testXunderscore', 'no');
    const keys = await engine.listConfigKeys('test_');
    // test_underscore matches because we asked for prefix "test_"; the
    // testXunderscore does NOT because the _ is escaped to literal.
    expect(keys).toEqual(['test_underscore']);
  });

  test('search.* prefix sweep returns every search-mode override key set', async () => {
    await engine.setConfig('search.cache.enabled', 'true');
    await engine.setConfig('search.cache.ttl_seconds', '7200');
    await engine.setConfig('search.tokenBudget', '8000');
    await engine.setConfig('search.mode', 'tokenmax'); // mode key itself
    const keys = await engine.listConfigKeys('search.');
    expect(keys.length).toBe(4);
    expect(keys).toContain('search.cache.enabled');
    expect(keys).toContain('search.cache.ttl_seconds');
    expect(keys).toContain('search.tokenBudget');
    expect(keys).toContain('search.mode');
  });
});

describe('round-trip: set → unset → get', () => {
  test('setting and unsetting in a tight loop is idempotent', async () => {
    for (let i = 0; i < 5; i++) {
      await engine.setConfig('test.loopkey', `iteration-${i}`);
      expect(await engine.getConfig('test.loopkey')).toBe(`iteration-${i}`);
      const n = await engine.unsetConfig('test.loopkey');
      expect(n).toBe(1);
      expect(await engine.getConfig('test.loopkey')).toBeNull();
    }
  });
});
