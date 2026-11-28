/**
 * #6587: the embedding migration's long transactions (the retained-vector
 * census, ~88 s on a large remote brain) held the lease rows FOR SHARE from
 * the start, so the 15 s heartbeat's refresh UPDATE blocked, was cancelled at
 * its timeout and the migration aborted as lease-lost. Real Postgres: the row
 * lock semantics are the bug. Timings are scaled (census = pg_sleep(4),
 * refresh timeout 1.5 s instead of 30 s).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { hasDatabase, setupDB, teardownDB, getEngine } from './helpers.ts';
import { tryAcquireDbLock, type DbLockHandle } from '../../src/core/db-lock.ts';
import { assertMigrationLeases, withMigrationLeaseTransaction, type MigrationLeaseAssert } from '../../src/core/embedding-migration-budget.ts';
import { applyEmbeddingMigration, planEmbeddingMigration, readMigrationState, runSchemaTransition, MIGRATION_STATE_KEY } from '../../src/core/embedding-migration.ts';
import { DEFAULT_EMBEDDING_MODEL } from '../../src/core/ai/defaults.ts';
import type { BrainEngine } from '../../src/core/engine.ts';

const skip = !hasDatabase();
beforeAll(async () => { if (!skip) await setupDB(); }, 120_000);
afterAll(async () => { if (!skip) await teardownDB(); });

const owned = (lock: DbLockHandle): MigrationLeaseAssert => async (tx, lease) => {
  if (tx) await assertMigrationLeases(tx, [lock], lease);
};
async function refreshDuring(census: Promise<unknown>, lock: DbLockHandle): Promise<unknown> {
  await new Promise(r => setTimeout(r, 300));
  let refreshed: unknown;
  try { refreshed = await lock.refresh({ signal: AbortSignal.timeout(1500) }); } catch (e) { refreshed = `threw: ${(e as Error).message}`; }
  await census.catch(() => {});
  return refreshed;
}

const CENSUS_START = 'LOCK TABLE sources, pages, content_chunks';
/** The engine the migration runs on: every retained-vector census, once it holds its table locks, waits for `onCensus`. */
function onEveryCensus(engine: BrainEngine, onCensus: () => Promise<void>, stopBefore?: string): BrainEngine {
  const spy = (e: BrainEngine): BrainEngine => Object.assign(Object.create(e), {
    transaction: (fn: (tx: BrainEngine) => Promise<unknown>, opts?: unknown) => e.transaction(tx => fn(spy(tx)), opts as never),
    executeRaw: async (sql: string, params?: unknown[]) => {
      if (stopBefore && sql.includes(stopBefore)) throw new Error('stopped before the DDL');
      const rows = await e.executeRaw(sql, params);
      if (sql.startsWith(CENSUS_START)) await onCensus();
      return rows;
    },
  });
  return spy(engine);
}
const tryRefresh = async (lock: DbLockHandle): Promise<unknown> => {
  try { return await lock.refresh({ signal: AbortSignal.timeout(1500) }); } catch (e) { return `threw: ${(e as Error).message}`; }
};
const recording = (lock: DbLockHandle, checks: string[]): MigrationLeaseAssert => async (tx, lease) => {
  if (!tx) return;
  checks.push(lease?.rowLock === false ? 'check' : 'lock');
  await assertMigrationLeases(tx, [lock], lease);
};

describe.skipIf(skip)('migration lease transactions (#6587)', () => {
  test('the heartbeat refreshes the lease while a long census transaction runs', async () => {
    const engine = getEngine();
    const lock = (await tryAcquireDbLock(engine, 'w17-6587-census', 60))!;
    try {
      const census = withMigrationLeaseTransaction(engine, owned(lock), tx => tx.executeRaw('SELECT pg_sleep(4)'));
      expect(await refreshDuring(census, lock)).toBe(true);
      await census;
    } finally { await lock.release(); }
  }, 30_000);

  test('forced probe: holding the lease rows FOR SHARE across the census (the old shape) blocks the heartbeat', async () => {
    const engine = getEngine();
    const lock = (await tryAcquireDbLock(engine, 'w17-6587-old-shape', 60))!;
    try {
      const census = engine.transaction(async tx => {
        await assertMigrationLeases(tx, [lock]);
        await tx.executeRaw('SELECT pg_sleep(4)');
      });
      expect(String(await refreshDuring(census, lock))).toContain('threw');
    } finally { await lock.release(); }
  }, 30_000);

  test('a lease stolen during the work rolls the transaction back', async () => {
    const engine = getEngine();
    const lock = (await tryAcquireDbLock(engine, 'w17-6587-stolen', 60))!;
    try {
      await expect(withMigrationLeaseTransaction(engine, owned(lock), async tx => {
        await tx.executeRaw(`INSERT INTO config(key,value) VALUES('w17.6587.marker','written') ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`);
        await engine.executeRaw(`UPDATE gbrain_cycle_locks SET acquisition_token=gen_random_uuid() WHERE id=$1`, [lock.id]);
      })).rejects.toThrow('Migration lease lost');
      expect(await engine.executeRaw(`SELECT value FROM config WHERE key=$1`, ['w17.6587.marker'])).toEqual([]);
    } finally {
      await engine.executeRaw(`DELETE FROM gbrain_cycle_locks WHERE id=$1`, [lock.id]);
    }
  }, 30_000);

  test('#9864: runSchemaTransition leaves the lease refreshable during its census and locks it before the DDL', async () => {
    const engine = getEngine();
    const lock = (await tryAcquireDbLock(engine, 'w17-9864-schema', 60))!;
    try {
      const refreshes: unknown[] = [];
      const checks: string[] = [];
      const [{ dims }] = await engine.executeRaw<{ dims: number }>(`SELECT atttypmod AS dims FROM pg_attribute
        WHERE attrelid='content_chunks'::regclass AND attname='embedding' AND NOT attisdropped`);
      const spied = onEveryCensus(engine, async () => { refreshes.push(await tryRefresh(lock)); }, 'FROM pg_depend');
      await expect(runSchemaTransition(spied, dims, recording(lock, checks))).rejects.toThrow('stopped before the DDL');
      expect(refreshes).toEqual([true]);
      expect(checks).toEqual(['check', 'lock']);
    } finally { await lock.release(); }
  }, 30_000);

  describe('#9864: the config-file step of applyEmbeddingMigration', () => {
    async function sameTargetPlan(engine: BrainEngine) {
      const config = await engine.executeRaw<{ key: string; value: string }>(`SELECT key,value FROM config WHERE key IN ('embedding_model','embedding_dimensions')`);
      const [{ dims }] = await engine.executeRaw<{ dims: number }>(`SELECT atttypmod AS dims FROM pg_attribute
        WHERE attrelid='content_chunks'::regclass AND attname='embedding' AND NOT attisdropped`);
      const model = config.find(r => r.key === 'embedding_model')?.value ?? DEFAULT_EMBEDDING_MODEL;
      const plan = await planEmbeddingMigration(engine, { to: model, dim: dims, fromModel: model, fromDims: dims });
      const restore = async () => {
        await engine.executeRaw(`DELETE FROM config WHERE key = ANY($1::text[])`, [[MIGRATION_STATE_KEY, 'embedding_model', 'embedding_dimensions']]);
        for (const row of config) await engine.executeRaw('INSERT INTO config (key, value) VALUES ($1, $2)', [row.key, row.value]);
      };
      return { plan, model, dims, restore };
    }

    test('the heartbeat refreshes during its census, and the lease is locked before the config write', async () => {
      const engine = getEngine();
      const { plan, model, dims, restore } = await sameTargetPlan(engine);
      const lock = (await tryAcquireDbLock(engine, 'w17-9864-config', 60))!;
      try {
        const refreshes: unknown[] = [];
        const checks: string[] = [];
        const persisted: Array<[string, number, string | undefined]> = [];
        const result = await applyEmbeddingMigration(onEveryCensus(engine, async () => { refreshes.push(await tryRefresh(lock)); }), plan, {
          ignoreEnvOverride: true,
          assertOwned: recording(lock, checks),
          persistConfig: (m, d) => { persisted.push([m, d, checks.at(-1)]); },
        });
        expect(refreshes.filter(r => r !== true)).toEqual([]);
        expect(result.status).toBe('applied');
        expect(persisted).toEqual([[model, dims, 'lock']]);
      } finally { await lock.release(); await restore(); }
    }, 60_000);

    test('a lease stolen during its census never reaches the config write', async () => {
      const engine = getEngine();
      const { plan, restore } = await sameTargetPlan(engine);
      const lock = (await tryAcquireDbLock(engine, 'w17-9864-config-stolen', 60))!;
      try {
        let stolen = false;
        const persisted: number[] = [];
        const steal = async () => {
          if (stolen || !(await readMigrationState(engine)).state?.companion_vectors_invalidated) return;
          await engine.transaction(async t => {
            await t.executeRaw("SET LOCAL lock_timeout = '1500ms'");
            await t.executeRaw(`UPDATE gbrain_cycle_locks SET acquisition_token=gen_random_uuid() WHERE id=$1`, [lock.id]);
          });
          stolen = true;
        };
        const result = await applyEmbeddingMigration(onEveryCensus(engine, steal), plan, {
          ignoreEnvOverride: true,
          assertOwned: recording(lock, []),
          persistConfig: (_m, d) => { persisted.push(d); },
        });
        expect(stolen).toBe(true);
        expect(result).toEqual({ status: 'failed', reason: expect.stringContaining('Migration lease lost') });
        expect(persisted).toEqual([]);
      } finally {
        await engine.executeRaw(`DELETE FROM gbrain_cycle_locks WHERE id=$1`, [lock.id]);
        await restore();
      }
    }, 60_000);
  });

  test('a deadlock victim reruns side-effect-free work; mutating work is not retried', async () => {
    const engine = getEngine();
    const lock = (await tryAcquireDbLock(engine, 'w17-6587-deadlock', 60))!;
    try {
      const deadlock = () => Object.assign(new Error('deadlock detected'), { code: '40P01' });
      let attempts = 0;
      const result = await withMigrationLeaseTransaction(engine, owned(lock), async () => {
        if (++attempts === 1) throw deadlock();
        return 'census-ok';
      }, { deadlockRetries: 3 });
      expect({ result, attempts }).toEqual({ result: 'census-ok', attempts: 2 });
      let mutating = 0;
      await expect(withMigrationLeaseTransaction(engine, owned(lock), async () => { mutating++; throw deadlock(); })).rejects.toThrow('deadlock detected');
      expect(mutating).toBe(1);
    } finally { await lock.release(); }
  }, 30_000);
});
