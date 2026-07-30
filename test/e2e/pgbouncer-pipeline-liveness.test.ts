/**
 * Transaction-pooler mitigation coverage for postgres.js#1033. The reported
 * failure reproduces on Supavisor but not ordinary PgBouncer, so this test does
 * not claim to reproduce it. It verifies that gbrain configures the reduced
 * pipeline depth and remains live under the same static/parameterized traffic
 * shape, plus that a queued health query is actually cancelled on timeout.
 *
 * Run manually:
 *
 *   GBRAIN_PGBOUNCER_URL=postgresql://postgres:postgres@localhost:6543/gbrain_test \
 *   GBRAIN_PGBOUNCER_DIRECT_URL=postgresql://postgres:postgres@localhost:5434/gbrain_test \
 *   bun test test/e2e/pgbouncer-pipeline-liveness.test.ts
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import postgres from 'postgres';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { probeLiveness } from '../../src/commands/serve-http.ts';

const POOLED_URL = process.env.GBRAIN_PGBOUNCER_URL;
const DIRECT_URL = process.env.GBRAIN_PGBOUNCER_DIRECT_URL;
const describePooled = POOLED_URL && DIRECT_URL ? describe : describe.skip;
const TEST_DB = 'gbrain_pgbouncer_pipeline';

function databaseUrl(base: string, database: string): string {
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
}

function pooledTestUrl(): string {
  const url = new URL(databaseUrl(POOLED_URL!, TEST_DB));
  url.searchParams.set('prepare', 'false');
  return url.toString();
}

async function within<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`query pair did not settle within ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

describePooled('PgBouncer transaction-mode pipeline liveness', () => {
  beforeAll(async () => {
    const admin = postgres(DIRECT_URL!, { max: 1 });
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
      await admin.unsafe(`CREATE DATABASE ${TEST_DB}`);
    } finally {
      await admin.end({ timeout: 5 });
    }

    const setup = postgres(databaseUrl(DIRECT_URL!, TEST_DB), { max: 1 });
    try {
      await setup`
        CREATE TABLE pipeline_liveness_probe (
          id integer PRIMARY KEY,
          n bigint NOT NULL DEFAULT 0
        )
      `;
      await setup`INSERT INTO pipeline_liveness_probe (id) VALUES (1)`;
    } finally {
      await setup.end({ timeout: 5 });
    }
  }, 60_000);

  afterAll(async () => {
    const admin = postgres(DIRECT_URL!, { max: 1 });
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    } finally {
      await admin.end({ timeout: 5 });
    }
  }, 60_000);

  test('static health-style traffic remains live with bounded pipelining', async () => {
    const engine = new PostgresEngine();
    await engine.connect({
      engine: 'postgres',
      database_url: pooledTestUrl(),
      poolSize: 1,
    });

    try {
      expect((engine.sql as unknown as { options: { max_pipeline: number } }).options.max_pipeline)
        .toBe(1);
      for (let i = 0; i < 100; i++) {
        const [staticRows, parameterizedRows] = await within(
          Promise.all([
            engine.executeRaw<{ n: bigint }>(
              'UPDATE pipeline_liveness_probe SET n = n + 1 WHERE id = 1 RETURNING n',
            ),
            engine.executeRaw<{ n: bigint }>(
              'UPDATE pipeline_liveness_probe SET n = n + 1 WHERE id = $1 RETURNING n',
              [1],
            ),
          ]),
          2_000,
        );
        expect(staticRows).toHaveLength(1);
        expect(parameterizedRows).toHaveLength(1);
      }
    } finally {
      await engine.disconnect();
    }
  }, 30_000);

  test('a timed-out queued health query is cancelled instead of leaking', async () => {
    const engine = new PostgresEngine();
    await engine.connect({
      engine: 'postgres',
      database_url: pooledTestUrl(),
      poolSize: 1,
    });

    try {
      // max_pipeline=1 permits one statement behind the active statement.
      // Occupy both positions so the health query stays in the global queue,
      // where AbortSignal cancellation must remove and reject it.
      const blockers = [
        engine.executeRaw('SELECT pg_sleep(0.2)'),
        engine.executeRaw('SELECT pg_sleep(0.2)'),
      ];
      await new Promise(resolve => setTimeout(resolve, 25));

      const result = await probeLiveness(engine, 'postgres', 'test', 50);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.body.error_description).toBe(
          'Health check timed out (database pool may be saturated)',
        );
      }

      await Promise.all(blockers);
      const rows = await within(engine.executeRaw<{ one: number }>('SELECT 1 AS one'), 500);
      expect(rows[0]?.one).toBe(1);
    } finally {
      await engine.disconnect();
    }
  }, 10_000);

  test('AbortSignal cancels an active pooled query and releases the slot', async () => {
    const engine = new PostgresEngine();
    await engine.connect({
      engine: 'postgres',
      database_url: pooledTestUrl(),
      poolSize: 1,
    });

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 50);
      const startedAt = Date.now();
      try {
        await expect(
          engine.executeRaw('SELECT pg_sleep(5)', undefined, {
            signal: controller.signal,
          }),
        ).rejects.toThrow();
      } finally {
        clearTimeout(timer);
      }
      expect(Date.now() - startedAt).toBeLessThan(2_000);

      const rows = await within(engine.executeRaw<{ one: number }>('SELECT 1 AS one'), 500);
      expect(rows[0]?.one).toBe(1);
    } finally {
      await engine.disconnect();
    }
  }, 10_000);
});
