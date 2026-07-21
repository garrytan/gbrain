/**
 * Process-lifetime config cache (#1694 takeover, by @Omerbahari).
 *
 * A single search fires ~85 getConfig() reads; on a remote pooler each is a
 * round-trip. The first read now batch-loads the whole `config` table into a
 * Map; setConfig/unsetConfig write through; TTL bounds multi-writer
 * staleness; GBRAIN_CONFIG_CACHE_TTL_MS=0 restores per-key reads.
 *
 * Pure: stubs `_sql` with a call-counting fake; no real DB.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { PostgresEngine } from '../src/core/postgres-engine.ts';

const FAST_RETRY = { maxRetries: 3, delayMs: 1, delayMaxMs: 1, jitter: 'none' as const };

/** Engine whose `sql` records every query's template strings and returns `rows`. */
function makeEngine(rows: unknown[]) {
  const e = new PostgresEngine();
  const calls: string[] = [];
  (e as unknown as { _connectionStyle: string })._connectionStyle = 'instance';
  (e as unknown as { _bulkRetryOptsCache: unknown })._bulkRetryOptsCache = FAST_RETRY;
  (e as unknown as { _sql: unknown })._sql = (strings: TemplateStringsArray) => {
    calls.push(strings.join('?'));
    return Promise.resolve(rows);
  };
  return { engine: e, calls };
}

const savedTtl = process.env.GBRAIN_CONFIG_CACHE_TTL_MS;

beforeEach(() => {
  delete process.env.GBRAIN_CONFIG_CACHE_TTL_MS;
});

afterEach(() => {
  if (savedTtl === undefined) delete process.env.GBRAIN_CONFIG_CACHE_TTL_MS;
  else process.env.GBRAIN_CONFIG_CACHE_TTL_MS = savedTtl;
});

describe('PostgresEngine config cache (#1694)', () => {
  it('batch-loads once and serves repeat reads from the cache', async () => {
    const { engine, calls } = makeEngine([
      { key: 'search.mode', value: 'balanced' },
      { key: 'embedding_multimodal', value: 'true' },
    ]);
    expect(await engine.getConfig('search.mode')).toBe('balanced');
    expect(await engine.getConfig('embedding_multimodal')).toBe('true');
    expect(await engine.getConfig('search.mode')).toBe('balanced');
    // One SELECT total — this is the whole point of the fix.
    expect(calls.length).toBe(1);
    expect(calls[0]).toContain('SELECT key, value FROM config');
  });

  it('returns null for a known-absent key without an extra round-trip', async () => {
    const { engine, calls } = makeEngine([{ key: 'a', value: '1' }]);
    expect(await engine.getConfig('missing.key')).toBeNull();
    expect(await engine.getConfig('missing.key')).toBeNull();
    expect(calls.length).toBe(1);
  });

  it('setConfig writes through so subsequent reads see the new value', async () => {
    const { engine, calls } = makeEngine([{ key: 'k', value: 'old' }]);
    expect(await engine.getConfig('k')).toBe('old');
    await engine.setConfig('k', 'new');
    expect(await engine.getConfig('k')).toBe('new');
    expect(calls.length).toBe(2); // batch load + upsert; no re-read
  });

  it('unsetConfig writes through so subsequent reads see absence', async () => {
    const { engine } = makeEngine([{ key: 'k', value: 'v' }]);
    expect(await engine.getConfig('k')).toBe('v');
    await engine.unsetConfig('k');
    expect(await engine.getConfig('k')).toBeNull();
  });

  it('concurrent cold reads share a single batch load (single-flight)', async () => {
    const { engine, calls } = makeEngine([{ key: 'k', value: 'v' }]);
    const [a, b, c] = await Promise.all([
      engine.getConfig('k'),
      engine.getConfig('k'),
      engine.getConfig('other'),
    ]);
    expect([a, b, c]).toEqual(['v', 'v', null]);
    expect(calls.length).toBe(1);
  });

  it('GBRAIN_CONFIG_CACHE_TTL_MS=0 disables the cache (per-key reads)', async () => {
    process.env.GBRAIN_CONFIG_CACHE_TTL_MS = '0';
    const { engine, calls } = makeEngine([{ value: 'v' }]);
    expect(await engine.getConfig('k')).toBe('v');
    expect(await engine.getConfig('k')).toBe('v');
    expect(calls.length).toBe(2);
    expect(calls[0]).toContain('SELECT value FROM config WHERE key =');
  });

  it('an expired TTL reloads from the database', async () => {
    process.env.GBRAIN_CONFIG_CACHE_TTL_MS = '1';
    const { engine, calls } = makeEngine([{ key: 'k', value: 'v' }]);
    expect(await engine.getConfig('k')).toBe('v');
    await new Promise((r) => setTimeout(r, 5));
    expect(await engine.getConfig('k')).toBe('v');
    expect(calls.length).toBe(2); // two batch loads
  });

  it('the batch load keeps the connRetry reconnect posture (#1603/#1891)', async () => {
    const e = new PostgresEngine();
    (e as unknown as { _connectionStyle: string })._connectionStyle = 'instance';
    (e as unknown as { _sql: unknown })._sql = null; // torn-down pool → retryable
    (e as unknown as { _bulkRetryOptsCache: unknown })._bulkRetryOptsCache = FAST_RETRY;
    let reconnects = 0;
    (e as unknown as { reconnect: () => Promise<void> }).reconnect = async () => {
      reconnects++;
      (e as unknown as { _sql: unknown })._sql = () =>
        Promise.resolve([{ key: 'k', value: 'v' }]);
    };
    expect(await e.getConfig('k')).toBe('v');
    expect(reconnects).toBe(1);
  });
});
