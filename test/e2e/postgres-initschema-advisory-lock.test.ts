/**
 * E2E: initSchema must release advisory lock 42 on the backend that took it.
 *
 * pg_advisory_lock is session-scoped, but ConnectionManager.ddl() returns a
 * POOL on plain Postgres (dual-pool routing inactive). Under concurrent pool
 * traffic the acquire and the `pg_advisory_unlock(42)` land on different
 * backends: the unlock returns false and the holder goes back to the pool
 * still holding key 42, stalling every later initSchema until the deadlined
 * acquire gives up. Idle-pool runs reuse one connection and hide the bug, so
 * this test keeps the pool busy while initSchema runs.
 *
 * Run: DATABASE_URL=postgresql://.../gbrain_test bun run test:e2e \
 *      test/e2e/postgres-initschema-advisory-lock.test.ts
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import postgres from '#postgres';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';

const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)('PostgresEngine.initSchema advisory lock 42 (E2E)', () => {
  let observer: postgres.Sql;
  let engine: PostgresEngine;

  beforeAll(async () => {
    observer = postgres(DATABASE_URL!, { max: 1 });
    engine = new PostgresEngine();
    await engine.connect({ database_url: DATABASE_URL! });
    await engine.initSchema();
  });

  afterAll(async () => {
    await engine.disconnect();
    await observer.end();
  });

  test('lock 42 is not left held after initSchema under concurrent pool load', async () => {
    let stop = false;
    const noise = (async () => {
      while (!stop) {
        await Promise.all(Array.from({ length: 8 }, () => engine.executeRaw('SELECT pg_sleep(0.005)')));
      }
    })();
    let leaked = 0;
    try {
      for (let i = 0; i < 5; i++) {
        await engine.initSchema();
        const [row] = await observer<{ n: number }[]>`
          SELECT count(*)::int AS n FROM pg_locks
           WHERE locktype = 'advisory' AND objid = 42 AND granted`;
        if (row.n > 0) leaked++;
      }
    } finally {
      stop = true;
      await noise;
    }
    expect(leaked).toBe(0);
  }, 120_000);
});
