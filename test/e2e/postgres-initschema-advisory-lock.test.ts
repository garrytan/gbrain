/**
 * E2E regression test for the v0.41.x initSchema advisory-lock leak fix.
 *
 * Pre-fix bug: `PostgresEngine.initSchema()` ran `pool`SELECT
 * pg_advisory_lock(42)`` to acquire the lock and `pool`SELECT
 * pg_advisory_unlock(42)`` in the finally block to release. postgres.js
 * pulls a fresh physical connection from the pool on each tag-template
 * call, so the acquire ran on backend A and the unlock fired on backend B.
 * Postgres returned `false` from the unlock (lock not held by current
 * session) and the lock stayed held on backend A's session indefinitely.
 *
 * Symptom in production: CLI cold-start hangs ~5 min on every subsequent
 * `initSchema()` because `SELECT pg_advisory_lock(42)` blocks until
 * `statement_timeout` fires. Observed against a 440K-page brain where one
 * backend had been holding lock 42 idle for 14h since the autopilot
 * worker's first call.
 *
 * Fix: wrap the lock acquire + release pair in `pool.reserve()` so both
 * queries hit the same physical connection.
 *
 * This test:
 *   1. Connects + runs initSchema (acquires + releases lock 42 on backend A)
 *   2. Asserts lock 42 is NOT held after initSchema returns
 *   3. Connects a second engine + runs initSchema again
 *   4. Asserts the second initSchema completes promptly (no 5-min hang)
 *
 * Pre-fix this test would either hang on step 3 (until statement_timeout)
 * or show lock 42 still held in step 2's assertion. Either way: red.
 *
 * Run: DATABASE_URL=postgresql://... bun run test:e2e \
 *      test/e2e/postgres-initschema-advisory-lock.test.ts
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import postgres from 'postgres';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL;

describe.skipIf(skip)('PostgresEngine.initSchema advisory-lock pair invariant (E2E)', () => {
  let sql: postgres.Sql;

  beforeAll(async () => {
    sql = postgres(DATABASE_URL!, { max: 2 });
  });

  afterAll(async () => {
    await sql.end();
  });

  test('initSchema does not leak advisory lock 42', async () => {
    const engine = new PostgresEngine();
    await engine.connect({ database_url: DATABASE_URL! });
    try {
      await engine.initSchema();

      // Lock 42 MUST be released by the time initSchema returns. Pre-fix
      // this assertion failed because acquire + release fired on different
      // pool connections; the original session retained the lock.
      const held = await sql<{ pid: number }[]>`
        SELECT pid FROM pg_locks
        WHERE locktype = 'advisory'
          AND objid = 42
          AND granted = true
      `;
      expect(held.length).toBe(0);
    } finally {
      await engine.disconnect();
    }
  }, 60_000);

  test('two consecutive initSchema calls do not block each other', async () => {
    // Pre-fix: the FIRST initSchema would leak lock 42 (acquire on conn A,
    // unlock on conn B). The SECOND initSchema would block on `SELECT
    // pg_advisory_lock(42)` until statement_timeout fired (~5 min default).
    // Post-fix: both calls complete in <1s typical, well under our 30s gate.
    const e1 = new PostgresEngine();
    await e1.connect({ database_url: DATABASE_URL! });
    try {
      const t0 = Date.now();
      await e1.initSchema();
      const firstCallMs = Date.now() - t0;

      const e2 = new PostgresEngine();
      await e2.connect({ database_url: DATABASE_URL! });
      try {
        const t1 = Date.now();
        await e2.initSchema();
        const secondCallMs = Date.now() - t1;

        // Generous wall-clock gate: <30s on each call. Pre-fix the second
        // call hung the full statement_timeout window (default 5 min) and
        // failed loud. Post-fix typical wallclock is <1s; we leave headroom
        // for CI machines + cold-cache effects.
        expect(firstCallMs).toBeLessThan(30_000);
        expect(secondCallMs).toBeLessThan(30_000);
      } finally {
        await e2.disconnect();
      }
    } finally {
      await e1.disconnect();
    }
  }, 90_000);
});
