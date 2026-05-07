/**
 * E2E test pinning the PostgresEngine.disconnect() idempotency invariant.
 *
 * Background: when commit 671ef099 added engine.disconnect() to
 * MinionWorker.start()'s finally block, every test that calls worker.start()
 * AND then engine.disconnect() in its own finally was double-disconnecting
 * the same engine instance. Pre-fix, the second disconnect found _sql=null
 * and fell through to the `else` branch which calls db.disconnect() — but
 * db.disconnect() clears the GLOBAL module-level connection, breaking
 * unrelated downstream tests (their getConn() throws "no database
 * connection" on the next beforeEach).
 *
 * The fix: PostgresEngine tracks `_connectionStyle` ('instance' | 'module')
 * and only calls db.disconnect() when it actually owns the module-level
 * connection. Second disconnect on an instance-pool engine is a no-op.
 *
 * This test pins the contract so future refactors of disconnect() can't
 * silently regress (it's exactly the bug class that took an hour of E2E
 * debugging to find). Two cases:
 *   1. instance-pool engine: connect → disconnect → disconnect must NOT
 *      affect the module-level connection.
 *   2. module-singleton engine: connect → disconnect → disconnect is safe
 *      (second call no-ops).
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import * as db from '../../src/core/db.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL;

if (skip) {
  // eslint-disable-next-line no-console
  console.log('Skipping postgres-engine-disconnect-idempotency E2E (DATABASE_URL not set)');
}

describe.skipIf(skip)('PostgresEngine.disconnect idempotency', () => {
  beforeAll(async () => {
    // Establish the module-level connection so we can verify it survives
    // the instance-pool engine's double-disconnect.
    await db.disconnect();
    await db.connect({ database_url: DATABASE_URL! });
  });

  afterAll(async () => {
    await db.disconnect();
  });

  test('instance-pool engine: second disconnect() does NOT clobber module singleton', async () => {
    const engine = new PostgresEngine();
    await engine.connect({ database_url: DATABASE_URL!, poolSize: 2 });

    // First disconnect — closes the engine's own pool.
    await engine.disconnect();

    // Sanity: module-level connection still alive (this is what
    // helpers.ts's getConn() returns).
    const before = await db.getConnection().unsafe('SELECT 1 as ok');
    expect((before[0] as unknown as { ok: number }).ok).toBe(1);

    // Second disconnect — pre-fix, this fell through to db.disconnect()
    // and cleared the module-level singleton. Post-fix, it's a no-op.
    await engine.disconnect();

    // Module-level connection MUST still be alive.
    const after = await db.getConnection().unsafe('SELECT 1 as ok');
    expect((after[0] as unknown as { ok: number }).ok).toBe(1);
  });

  test('module-singleton engine: second disconnect() is a no-op', async () => {
    // Re-establish module-level connection (idempotent; no-op if still
    // connected from beforeAll).
    await db.connect({ database_url: DATABASE_URL! });

    const engine = new PostgresEngine();
    // No poolSize → uses the module-level singleton.
    await engine.connect({ database_url: DATABASE_URL! });

    // First disconnect closes module-level singleton (this engine owned it).
    await engine.disconnect();

    // Second disconnect must NOT throw — should be a no-op since
    // _connectionStyle was reset to null.
    await expect(engine.disconnect()).resolves.toBeUndefined();
  });
});
