/**
 * Non-batch config accessors must self-heal the same way the batch path does
 * (takeover of PR #1891 by @jalagrange; #1593 follow-up).
 *
 * The config accessors touch `this.sql` directly. When an instance pool is
 * torn down mid-cycle the getter throws a RETRYABLE "No database connection"
 * (issue #1678) by design, so a withRetry+reconnect caller can rebuild the
 * pool and recover. `getConfig` got that wrapper in #1603; `setConfig`,
 * `unsetConfig`, and `listConfigKeys` did not — so the first config write or
 * list after a mid-cycle disconnect threw unhandled. This pins that ALL four
 * accessors now reconnect + retry, and that non-retryable errors are NOT
 * masked by a reconnect.
 *
 * Pure: pokes private fields and stubs `reconnect` to simulate the pool
 * rebuild; no real DB.
 */

import { describe, it, expect } from 'bun:test';
import { PostgresEngine } from '../src/core/postgres-engine.ts';

// A tagged-template-callable fake `sql` that resolves to the given value.
function fakeSql(result: unknown) {
  return (..._args: unknown[]) => Promise.resolve(result);
}

// Near-instant retry delays so the inter-attempt sleep does not slow the test.
// Shape matches `resolveBulkRetryOpts()` (the getBulkRetryOpts cache type).
const FAST_RETRY = { maxRetries: 3, delayMs: 1, delayMaxMs: 1, jitter: 'none' as const };

/** Engine with a torn-down instance pool; reconnect installs `poolResult`. */
function makeTornDownEngine(poolResult: unknown): { engine: PostgresEngine; reconnects: () => number } {
  const e = new PostgresEngine();
  (e as unknown as { _connectionStyle: string })._connectionStyle = 'instance';
  (e as unknown as { _sql: unknown })._sql = null; // instance pool torn down → getter throws retryable
  (e as unknown as { _bulkRetryOptsCache: unknown })._bulkRetryOptsCache = FAST_RETRY;
  let reconnectCalls = 0;
  (e as unknown as { reconnect: () => Promise<void> }).reconnect = async () => {
    reconnectCalls++;
    (e as unknown as { _sql: unknown })._sql = fakeSql(poolResult);
  };
  return { engine: e, reconnects: () => reconnectCalls };
}

describe('PostgresEngine non-batch config accessors self-heal (PR #1891 takeover)', () => {
  it('getConfig reconnects + retries a null instance pool, then returns the value', async () => {
    const { engine, reconnects } = makeTornDownEngine([{ value: 'live-value' }]);
    expect(await engine.getConfig('some.key')).toBe('live-value');
    expect(reconnects()).toBe(1); // exactly one reconnect closed the gap
  });

  it('setConfig reconnects + retries a null instance pool (idempotent upsert)', async () => {
    const { engine, reconnects } = makeTornDownEngine([]);
    await engine.setConfig('some.key', 'v');
    expect(reconnects()).toBe(1);
  });

  it('unsetConfig reconnects + retries a null instance pool, then returns the count', async () => {
    const { engine, reconnects } = makeTornDownEngine({ count: 2 });
    expect(await engine.unsetConfig('some.key')).toBe(2);
    expect(reconnects()).toBe(1);
  });

  it('listConfigKeys reconnects + retries a null instance pool, then returns keys', async () => {
    const { engine, reconnects } = makeTornDownEngine([{ key: 'a.one' }, { key: 'a.two' }]);
    expect(await engine.listConfigKeys('a.')).toEqual(['a.one', 'a.two']);
    expect(reconnects()).toBe(1);
  });

  it('surfaces a non-retryable error without reconnecting (no masking)', async () => {
    const e = new PostgresEngine();
    (e as unknown as { _connectionStyle: string })._connectionStyle = 'instance';
    (e as unknown as { _bulkRetryOptsCache: unknown })._bulkRetryOptsCache = FAST_RETRY;
    // A live pool whose query throws a NON-retryable (non-connection) error.
    (e as unknown as { _sql: unknown })._sql = () =>
      Promise.reject(new Error('syntax error at or near "SLECT"'));

    let reconnectCalls = 0;
    (e as unknown as { reconnect: () => Promise<void> }).reconnect = async () => {
      reconnectCalls++;
    };

    await expect(e.getConfig('k')).rejects.toThrow('syntax error');
    await expect(e.setConfig('k', 'v')).rejects.toThrow('syntax error');
    expect(reconnectCalls).toBe(0); // non-retryable → no reconnect, error not masked
  });
});
