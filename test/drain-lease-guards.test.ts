/**
 * The lock-row guards the drain lease's model (spec/tla/drain-lease) depends on, on both engines: a live holder's
 * unexpired row is never taken over, and a former holder's refresh and release never touch its successor's row. Each is
 * a guard mutant in spec/tla/drain-lease/mutants.json: removing it from src/core/db-lock.ts must fail its test here.
 *
 * Runs on PGLite here and on Postgres through test/e2e/drain-lease-guards-postgres.test.ts.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { tryAcquireDbLock } from '../src/core/db-lock.ts';
import { DRAIN_LEASE_TTL_MINUTES } from '../src/core/persistence/sync-lease.ts';
import { testBackends, type TestBackend } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const engines: Array<{ backend: TestBackend; engine: BrainEngine; close: () => Promise<void> }> = [];

beforeAll(async () => {
  for (const backend of testBackends()) {
    if (backend === 'pglite') {
      const engine = new PGLiteEngine();
      await engine.connect({ database_url: '' });
      await engine.initSchema();
      engines.push({ backend, engine, close: () => engine.disconnect() });
    } else {
      engines.push({ backend, ...await isolatedPersistencePostgres(process.env.DATABASE_URL!) });
    }
  }
}, 120_000);

afterAll(async () => {
  for (const e of engines) await e.close();
});

beforeEach(async () => {
  for (const { engine } of engines) await engine.executeRaw(`DELETE FROM gbrain_cycle_locks WHERE id LIKE 'test-guard-%'`);
});

async function row(engine: BrainEngine, id: string) {
  const rows = await engine.executeRaw<{ token: string; expires: string }>(
    `SELECT acquisition_token::text AS token, ttl_expires_at::text AS expires FROM gbrain_cycle_locks WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

/** A successor took the row over: same pid (this process), a new token, as tryAcquireDbLock's takeover writes it. */
async function succeed(engine: BrainEngine, id: string) {
  await engine.executeRaw(`UPDATE gbrain_cycle_locks SET acquisition_token = gen_random_uuid(), acquired_at = now(),
    ttl_expires_at = now() + interval '2 minutes', last_refreshed_at = now() WHERE id = $1`, [id]);
  return row(engine, id);
}

// One describe per engine, and no custom expect() messages: the mutant runner counts a failure as a caught guard only
// when Bun reports it as an AssertionError, and a custom message turns it into a plain Error.
for (const backend of testBackends()) {
  const engineFor = () => engines.find(e => e.backend === backend)!.engine;

  describe(`drain lease lock-row guards (${backend})`, () => {
    test('a live holder whose row has not expired is never taken over (takeover-ignores-ttl)', async () => {
      const engine = engineFor();
      const holder = await tryAcquireDbLock(engine, 'test-guard-live', DRAIN_LEASE_TTL_MINUTES);
      expect(holder).not.toBeNull();
      const before = await row(engine, 'test-guard-live');
      expect(await tryAcquireDbLock(engine, 'test-guard-live', DRAIN_LEASE_TTL_MINUTES)).toBeNull();
      expect(await row(engine, 'test-guard-live')).toEqual(before);
      await holder!.release();
    });

    test("a former holder's refresh leaves its successor's row as it was (renewal-ignores-token)", async () => {
      const engine = engineFor();
      const former = await tryAcquireDbLock(engine, 'test-guard-refresh', DRAIN_LEASE_TTL_MINUTES);
      expect(former).not.toBeNull();
      const successor = await succeed(engine, 'test-guard-refresh');
      expect(await former!.refresh()).toBe(false);
      expect(await row(engine, 'test-guard-refresh')).toEqual(successor);
    });

    test("a former holder's release leaves its successor's row in place (release-ignores-token)", async () => {
      const engine = engineFor();
      const former = await tryAcquireDbLock(engine, 'test-guard-release', DRAIN_LEASE_TTL_MINUTES);
      expect(former).not.toBeNull();
      const successor = await succeed(engine, 'test-guard-release');
      await former!.release();
      expect(await row(engine, 'test-guard-release')).toEqual(successor);
    });
  });
}
