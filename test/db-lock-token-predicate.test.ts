/**
 * #6028 (wave 14 P4.8): the lease identity is (id, holder_pid,
 * acquisition_token). Every acquisition mints a fresh UUID (v152 made the
 * column NOT NULL DEFAULT gen_random_uuid()), so the token alone tells this
 * handle's row from a successor's. The epoch text of `acquired_at` used to
 * be a fourth predicate term; its text form is session-fragile (numeric
 * scale, DateStyle, a maintenance rewrite of the row) and made a runner
 * refuse its OWN lease as `migrations_running` naming its own pid.
 *
 * Runs on PGLite here and on Postgres through
 * test/e2e/db-lock-token-predicate-postgres.test.ts.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { tryAcquireDbLock } from '../src/core/db-lock.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const engines: Array<{ engine: BrainEngine; close: () => Promise<void> }> = [];

beforeAll(async () => {
  for (const backend of testBackends()) {
    if (backend === 'pglite') {
      const engine = new PGLiteEngine();
      await engine.connect({ database_url: '' });
      await engine.initSchema();
      engines.push({ engine, close: () => engine.disconnect() });
    } else {
      engines.push(await isolatedPersistencePostgres(process.env.DATABASE_URL!));
    }
  }
}, 120_000);

afterAll(async () => {
  for (const e of engines) await e.close();
});

beforeEach(async () => {
  for (const { engine } of engines) await engine.executeRaw(`DELETE FROM gbrain_cycle_locks WHERE id LIKE 'test-token-%'`);
});

async function row(engine: BrainEngine, id: string) {
  const rows = await engine.executeRaw<{ acquisition_token: string; ttl_expires_at: Date | string }>(
    `SELECT acquisition_token::text AS acquisition_token, ttl_expires_at FROM gbrain_cycle_locks WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

describe('#6028 token-bearing lease predicate', () => {
  test('a rewritten acquired_at while holding keeps refresh() and release() valid', async () => {
    for (const { engine } of engines) {
      const handle = await tryAcquireDbLock(engine, 'test-token-rewrite', 5);
      expect(handle).not.toBeNull();
      await engine.executeRaw(
        `UPDATE gbrain_cycle_locks SET acquired_at = acquired_at + INTERVAL '1 millisecond' WHERE id = $1`, ['test-token-rewrite']);
      expect(await handle!.refresh()).toBe(true);
      expect((await row(engine, 'test-token-rewrite'))?.acquisition_token).toBe(handle!.acquisitionToken);
      await handle!.release();
      expect(await row(engine, 'test-token-rewrite')).toBeNull();
    }
  });

  test('a successor acquisition (new token) fences the old handle out of refresh, release and cleanup', async () => {
    for (const { engine } of engines) {
      const old = await tryAcquireDbLock(engine, 'test-token-successor', 5);
      expect(old).not.toBeNull();
      // Expire the row the way a stalled holder does, then let a successor take it over.
      await engine.executeRaw(
        `UPDATE gbrain_cycle_locks SET ttl_expires_at = NOW() - INTERVAL '1 minute', last_refreshed_at = NOW() - INTERVAL '1 day' WHERE id = $1`,
        ['test-token-successor']);
      const successor = await tryAcquireDbLock(engine, 'test-token-successor', 5);
      expect(successor).not.toBeNull();
      expect(successor!.acquisitionToken).not.toBe(old!.acquisitionToken);

      expect(await old!.refresh()).toBe(false);
      await old!.release();
      const after = await row(engine, 'test-token-successor');
      expect(after?.acquisition_token).toBe(successor!.acquisitionToken);
      expect(await successor!.refresh()).toBe(true);
      await successor!.release();
      expect(await row(engine, 'test-token-successor')).toBeNull();
    }
  });

  test('a tokenless schema (pre-v152 table) is unchanged: the acquire reports the missing column', async () => {
    for (const { engine } of engines) {
      await engine.executeRaw(`ALTER TABLE gbrain_cycle_locks DROP COLUMN acquisition_token`);
      try {
        let caught: unknown = null;
        await tryAcquireDbLock(engine, 'test-token-less', 5).catch((err: unknown) => { caught = err; });
        const e = caught as { code?: string; message?: string } | null;
        expect(e).not.toBeNull();
        expect(e?.code === '42703' || /acquisition_token.*does not exist/i.test(e?.message ?? '')).toBe(true);
      } finally {
        await engine.executeRaw(`ALTER TABLE gbrain_cycle_locks ADD COLUMN IF NOT EXISTS acquisition_token UUID NOT NULL DEFAULT gen_random_uuid()`);
      }
    }
  });
});
