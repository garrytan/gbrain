/**
 * E2E for #1745 (v0.42.20.0): module-mode reconnect() must NOT tear down the
 * shared module singleton.
 *
 * The bug: a transient blip triggers withRetry's reconnect callback →
 * PostgresEngine.reconnect() → this.disconnect() → (module mode) db.disconnect()
 * → `sql.end(); sql = null`. Concurrent ops (other dream-cycle phases, the
 * minion-queue promoteDelayed loop) read db.getConnection() during that null
 * window and throw "No database connection: connect() has not been called".
 *
 * The fix: module-mode reconnect() never calls db.disconnect(); it idempotently
 * re-establishes via db.connect() (a no-op when the singleton is alive, which is
 * the common case) and refreshes the ConnectionManager read pool. postgres.js
 * auto-heals dead sockets, so a transient blip recovers without a teardown.
 *
 * Instance-pool engines (worker / `jobs work`) keep the teardown+recreate path.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import * as db from '../../src/core/db.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL;

if (skip) {
  // eslint-disable-next-line no-console
  console.log('Skipping postgres-reconnect-singleton E2E (DATABASE_URL not set)');
}

describe.skipIf(skip)('#1745 — module-mode reconnect preserves the shared singleton', () => {
  beforeAll(async () => {
    await db.disconnect();
    await db.connect({ database_url: DATABASE_URL! });
  }, 30_000);

  afterAll(async () => {
    await db.disconnect();
  });

  test('module reconnect() keeps db.getConnection() live (no null window)', async () => {
    const engine = new PostgresEngine();
    await engine.connect({ database_url: DATABASE_URL! }); // module singleton (no poolSize)

    // Capture the singleton reference BEFORE reconnect — pre-fix, reconnect's
    // disconnect would sql.end() + null this out.
    const sqlBefore = db.getConnection();

    await engine.reconnect();

    // Post-fix: the singleton is untouched (db.connect() is a no-op when alive),
    // so getConnection() still returns a usable client and queries still work.
    const sqlAfter = db.getConnection();
    const rows = await sqlAfter.unsafe('SELECT 1 as ok');
    expect((rows[0] as unknown as { ok: number }).ok).toBe(1);
    // Same live pool object (no teardown/recreate in module mode).
    expect(sqlAfter).toBe(sqlBefore);
  }, 30_000);

  test('concurrent reader during reconnect never sees "connect() has not been called"', async () => {
    const engine = new PostgresEngine();
    await engine.connect({ database_url: DATABASE_URL! });

    // Fire a burst of reads through the module singleton WHILE reconnecting.
    // Pre-fix, the disconnect→connect window nulled the singleton and the
    // concurrent readers threw. Post-fix there is no null window.
    const readers = Array.from({ length: 20 }, async () => {
      const r = await db.getConnection().unsafe('SELECT 1 as ok');
      return (r[0] as unknown as { ok: number }).ok;
    });
    const [reconnectErr, ...results] = await Promise.all([
      engine.reconnect().then(() => null).catch((e) => e),
      ...readers,
    ]);
    expect(reconnectErr).toBeNull();
    for (const ok of results) expect(ok).toBe(1);
  }, 30_000);

  test('instance-pool reconnect() still teardown+recreates its own pool', async () => {
    const engine = new PostgresEngine();
    await engine.connect({ database_url: DATABASE_URL!, poolSize: 2 });

    // Works before.
    const before = await engine.executeRaw<{ ok: number }>('SELECT 1 as ok');
    expect(before[0].ok).toBe(1);

    await engine.reconnect(); // instance path: tears down + rebuilds _sql

    // Works after (fresh pool).
    const after = await engine.executeRaw<{ ok: number }>('SELECT 1 as ok');
    expect(after[0].ok).toBe(1);

    await engine.disconnect();

    // Module singleton untouched by the instance engine's reconnect/disconnect.
    const mod = await db.getConnection().unsafe('SELECT 1 as ok');
    expect((mod[0] as unknown as { ok: number }).ok).toBe(1);
  }, 30_000);
});
