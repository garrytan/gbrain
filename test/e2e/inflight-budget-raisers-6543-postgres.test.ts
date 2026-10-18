/**
 * #6543 (A4): the real gbrain paths that lift or raise a statement timeout keep
 * running past the pool's in-flight budget on the ordinary pool, because the
 * driver budgets each statement from the timeout its operation declared:
 * the deferred ANN build (`SET statement_timeout = 0` on a reserved connection
 * for CREATE INDEX CONCURRENTLY) and both migration paths (SET LOCAL in a
 * transaction; a session SET on a reserved connection for transaction:false).
 * The pool budget here is 1 s (statement_timeout 500 ms + grace 500 ms).
 * Regression that fails it on master: each statement is retired with
 * CONNECTION_STUCK after 1 s of silence.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { buildDeferredAnnIndexes } from '../../src/core/embedding-ann-build.ts';
import { runMigrationSQL, type Migration } from '../../src/core/migrate.ts';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';

const url = process.env.DATABASE_URL;
let engine: PostgresEngine;
let warn: { mock: { calls: unknown[][] }; mockRestore: () => void };
const previous = { grace: process.env.GBRAIN_PG_STUCK_GRACE_MS, timeout: process.env.GBRAIN_STATEMENT_TIMEOUT };
const stuckLines = () => warn.mock.calls.map(c => String(c[0])).filter(l => l.includes('pg_connection_stuck'));

describe.skipIf(!url)('#6543 A4: timeout raisers on the ordinary pool', () => {
  beforeAll(async () => {
    assertSafeE2eDatabaseUrl(url!);
    process.env.GBRAIN_STATEMENT_TIMEOUT = '500ms';
    process.env.GBRAIN_PG_STUCK_GRACE_MS = '500';
    warn = spyOn(console, 'warn').mockImplementation(() => {});
    engine = new PostgresEngine();
    await engine.connect({ engine: 'postgres', database_url: url!, poolSize: 3 });
    await engine.executeRaw('DROP TABLE IF EXISTS inflight_6543_t');
    await engine.executeRaw('CREATE TABLE inflight_6543_t (x int)');
    await engine.executeRaw('INSERT INTO inflight_6543_t SELECT g FROM generate_series(1, 8) g');
    await engine.executeRaw(`CREATE OR REPLACE FUNCTION slow_6543(int) RETURNS int LANGUAGE plpgsql IMMUTABLE AS $$ BEGIN PERFORM pg_sleep(0.3); RETURN $1; END $$`);
  }, 30_000);

  afterAll(async () => {
    try {
      await engine?.executeRaw('DROP TABLE IF EXISTS inflight_6543_t').catch(() => {});
      await engine?.executeRaw('DROP FUNCTION IF EXISTS slow_6543(int)').catch(() => {});
      await engine?.disconnect();
    } finally {
      warn?.mockRestore();
      if (previous.grace === undefined) delete process.env.GBRAIN_PG_STUCK_GRACE_MS; else process.env.GBRAIN_PG_STUCK_GRACE_MS = previous.grace;
      if (previous.timeout === undefined) delete process.env.GBRAIN_STATEMENT_TIMEOUT; else process.env.GBRAIN_STATEMENT_TIMEOUT = previous.timeout;
    }
  });

  test('the deferred ANN build (CREATE INDEX CONCURRENTLY after SET statement_timeout = 0) runs past the budget unretired', async () => {
    let pending = [{ name: 'idx_inflight_6543', def: 'CREATE INDEX idx_inflight_6543 ON inflight_6543_t (slow_6543(x))' }];
    const started = Date.now();
    const result = await buildDeferredAnnIndexes(engine, { targetDims: 768, readPending: async () => pending, writePending: async next => { pending = next; }, log: () => {}, monitorIntervalMs: 200 });
    expect(Date.now() - started).toBeGreaterThan(1500);
    expect(result.built).toEqual(['idx_inflight_6543']);
    expect(pending).toEqual([]);
    expect(engine.getPoolDiagnostics()?.stuckDiscards).toBe(0);
    expect(stuckLines()).toEqual([]);
  }, 30_000);

  test('a migration in a transaction (SET LOCAL statement_timeout) runs past the budget unretired', async () => {
    const m = { version: 996543, name: 'inflight_6543_tx', sql: '' } as unknown as Migration;
    await runMigrationSQL(engine, m, 'SELECT pg_sleep(1.6)');
    expect(engine.getPoolDiagnostics()?.stuckDiscards).toBe(0);
    expect(stuckLines()).toEqual([]);
  }, 30_000);

  test('a transaction:false migration (session SET on a reserved connection) runs past the budget unretired', async () => {
    const m = { version: 996544, name: 'inflight_6543_notx', sql: '', transaction: false } as unknown as Migration;
    await runMigrationSQL(engine, m, 'SELECT pg_sleep(1.6)');
    expect(engine.getPoolDiagnostics()?.stuckDiscards).toBe(0);
    expect(stuckLines()).toEqual([]);
    expect(await engine.executeRaw<{ x: number }>('SELECT 1 AS x')).toEqual([{ x: 1 }]);
  }, 30_000);
});
