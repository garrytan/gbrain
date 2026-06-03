/**
 * issue #1678 — the `PostgresEngine.sql` getter must not fall through to the
 * never-connected module singleton when an INSTANCE pool's _sql went null
 * (mid-process disconnect, or a reaped pooler socket). Pre-fix it threw the
 * misleading "connect() has not been called"; post-fix it throws a tailored
 * RETRYABLE error so withRetry+reconnect rebuilds the pool and recovers.
 *
 * Pure: pokes the private fields and reads the synchronous getter; no real DB.
 */

import { describe, it, expect } from 'bun:test';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { isRetryableConnError } from '../src/core/retry-matcher.ts';

describe('PostgresEngine.sql getter self-heal (issue #1678)', () => {
  it('instance-pool + null _sql throws a RETRYABLE error naming the reaped pool', () => {
    const e = new PostgresEngine();
    (e as unknown as { _connectionStyle: string })._connectionStyle = 'instance';
    (e as unknown as { _sql: unknown })._sql = null;

    let thrown: unknown;
    try {
      // accessing the getter triggers the throw
      void e.sql;
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeDefined();
    // Must be classified retryable so the lock/batch retry paths reconnect.
    expect(isRetryableConnError(thrown)).toBe(true);
    // Must NOT be the misleading legacy message.
    const msg = (thrown as Error).message;
    expect(msg).toContain('instance connection pool');
    expect(msg).not.toContain('connect() has not been called');
  });

  it('a live instance _sql is returned directly (no throw)', () => {
    const e = new PostgresEngine();
    const fakeSql = { tag: 'live-pool' };
    (e as unknown as { _sql: unknown })._sql = fakeSql;
    expect(e.sql as unknown).toBe(fakeSql);
  });

  // #1471: the getter self-heal is INTENTIONALLY gated to instance style. A
  // module-style engine with a null _sql must fall through to the loud legacy
  // db.getConnection() error, NOT the instance "reaped pool" self-heal. Post
  // ownership-fix, the module singleton never goes null via a borrower
  // disconnect, so a null module singleton signals a genuine bug we want loud
  // (never connected, or a real owner-side teardown) rather than papered over.
  it('module-style + null _sql falls through to the loud legacy error, not the instance self-heal', () => {
    const e = new PostgresEngine();
    (e as unknown as { _connectionStyle: string })._connectionStyle = 'module';
    (e as unknown as { _sql: unknown })._sql = null;

    let thrown: unknown;
    try {
      void e.sql; // delegates to db.getConnection(), which throws (no module connect)
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeDefined();
    const msg = (thrown as Error).message;
    // The intentional asymmetry: module style keeps the legacy loud message.
    expect(msg).toContain('No database connection');
    expect(msg).not.toContain('instance connection pool');
  });
});
