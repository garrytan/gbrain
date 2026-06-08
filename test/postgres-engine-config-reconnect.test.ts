/**
 * PR #1593 follow-up — non-batch config reads must self-heal the same way the
 * batch path does.
 *
 * `getConfig` (and the sibling config accessors) touch `this.sql` directly.
 * When an instance pool is torn down mid-cycle the getter throws a RETRYABLE
 * "No database connection" (issue #1678) by design, so a withRetry+reconnect
 * caller can rebuild the pool and recover. Pre-fix these accessors had NO such
 * wrapper, so the first hard DB call after a mid-cycle disconnect (loadCfg's
 * `getConfig`) threw unhandled and crashed the worker into a respawn loop
 * (the autopilot crash @rayers reported on #1593). This pins that the config
 * accessors now reconnect + retry, and that non-retryable errors are NOT
 * masked by a reconnect.
 *
 * Pure: pokes private fields and stubs `reconnect` to simulate the pool
 * rebuild; no real DB.
 */

import { describe, it, expect } from 'bun:test';
import { PostgresEngine } from '../src/core/postgres-engine.ts';

// A tagged-template-callable fake `sql` that resolves to the given rows.
function fakeSql(rows: unknown[]) {
  return (..._args: unknown[]) => Promise.resolve(rows);
}

// Near-instant retry delays so the inter-attempt sleep does not slow the test.
// Shape matches `typeof BULK_RETRY_OPTS` (the getBulkRetryOpts cache type).
const FAST_RETRY = { maxRetries: 3, delayMs: 1, delayMaxMs: 1, jitter: 'none' as const };

describe('PostgresEngine non-batch config reads self-heal (PR #1593 follow-up)', () => {
  it('getConfig reconnects + retries a null instance pool, then returns the value', async () => {
    const e = new PostgresEngine();
    (e as unknown as { _connectionStyle: string })._connectionStyle = 'instance';
    (e as unknown as { _sql: unknown })._sql = null; // instance pool torn down → getter throws retryable
    (e as unknown as { _bulkRetryOptsCache: unknown })._bulkRetryOptsCache = FAST_RETRY;

    let reconnectCalls = 0;
    (e as unknown as { reconnect: () => Promise<void> }).reconnect = async () => {
      reconnectCalls++;
      // Simulate reconnect installing a live pool — the next attempt sees it.
      (e as unknown as { _sql: unknown })._sql = fakeSql([{ value: 'live-value' }]);
    };

    const got = await e.getConfig('some.key');
    expect(got).toBe('live-value');
    expect(reconnectCalls).toBe(1); // exactly one reconnect closed the gap
  });

  it('getConfig surfaces a non-retryable error without reconnecting (no masking)', async () => {
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
    expect(reconnectCalls).toBe(0); // non-retryable → no reconnect, error not masked
  });

  it('listConfigKeys reconnects + retries a null instance pool, then returns keys', async () => {
    const e = new PostgresEngine();
    (e as unknown as { _connectionStyle: string })._connectionStyle = 'instance';
    (e as unknown as { _sql: unknown })._sql = null;
    (e as unknown as { _bulkRetryOptsCache: unknown })._bulkRetryOptsCache = FAST_RETRY;

    let reconnectCalls = 0;
    (e as unknown as { reconnect: () => Promise<void> }).reconnect = async () => {
      reconnectCalls++;
      (e as unknown as { _sql: unknown })._sql = fakeSql([{ key: 'a.one' }, { key: 'a.two' }]);
    };

    const keys = await e.listConfigKeys('a.');
    expect(keys).toEqual(['a.one', 'a.two']);
    expect(reconnectCalls).toBe(1);
  });
});
