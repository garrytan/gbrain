/**
 * Engine-sql prepared-statement and protocol parity (refactor wave 1, EO6 / T-G4).
 *
 * Runs on every backend in scripts/e2e-backend-matrix.txt:
 *   - direct Postgres: a converted engine-sql statement becomes a named
 *     prepared statement on its backend (like the tagged template it
 *     replaces), while master's `executeRaw` path stays unprepared;
 *   - PgBouncer (connection `prepare: false`): nothing is prepared;
 *   - every backend, PGLite included: a zero-parameter multi-statement
 *     string is rejected, because converted statements never use the simple
 *     protocol.
 * `pg_prepared_statements` is per session, so each check runs inside one
 * `engine.transaction()` to stay on one backend connection.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { SqlExecutor } from '../../src/core/engine-sql/executor.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { hasDatabase, setupDB, teardownDB } from './helpers.ts';

const backend = process.env.GBRAIN_TEST_BACKEND ?? 'postgres-direct';
const describeDb = hasDatabase() ? describe : describe.skip;
const engineSql = (engine: BrainEngine) => (engine as unknown as { engineSql: SqlExecutor }).engineSql;

async function preparedMatching(exec: SqlExecutor, marker: string): Promise<number> {
  const res = await exec.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM pg_prepared_statements WHERE statement LIKE $1',
    [`%${marker}%`],
  );
  return res.rows[0].n;
}

describeDb(`engine-sql prepare parity on ${backend}`, () => {
  let engine: PostgresEngine;

  beforeAll(async () => {
    engine = await setupDB();
  }, 120_000);

  afterAll(async () => {
    await teardownDB();
  });

  test('converted statements are prepared on direct Postgres and never through PgBouncer', async () => {
    const marker = `engine_sql_prepare_${Date.now()}`;
    const count = await engine.transaction(async (tx) => {
      const exec = engineSql(tx);
      for (let i = 0; i < 2; i++) await exec.query(`SELECT $1::int AS v /* ${marker} */`, [i]);
      return preparedMatching(exec, marker);
    });
    if (backend === 'pgbouncer') expect(count).toBe(0);
    else expect(count).toBe(1);
  });

  test("master's executeRaw path keeps its unprepared behavior", async () => {
    const marker = `engine_sql_raw_${Date.now()}`;
    const count = await engine.transaction(async (tx) => {
      for (let i = 0; i < 2; i++) await tx.executeRaw(`SELECT $1::int AS v /* ${marker} */`, [i]);
      return preparedMatching(engineSql(tx), marker);
    });
    expect(count).toBe(0);
  });

  test('a zero-parameter multi-statement string is rejected (extended protocol)', async () => {
    const err = await engineSql(engine).query('SELECT 1; SELECT 2').then(() => null, (e: unknown) => e);
    expect((err as { code?: string } | null)?.code).toBe('42601');
  });
});

describe('engine-sql protocol parity on PGLite', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  }, 60_000);

  afterAll(async () => {
    await engine.disconnect();
  });

  test('a zero-parameter multi-statement string is rejected', async () => {
    const err = await engineSql(engine).query('SELECT 1; SELECT 2').then(() => null, (e: unknown) => e);
    expect((err as { code?: string } | null)?.code).toBe('42601');
  });
});
