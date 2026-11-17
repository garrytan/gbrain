/**
 * hardenFunctionSearchPaths re-creates every purge or withdrawal guard left without its ledger check (GST-2885,
 * #7632/#7659). Only a guard another role owns stays silent (SQLSTATE 42501, the next run of its owner re-creates it,
 * and doctor's guard_ledger_checks names it); any other failure of the re-create propagates to the migration run,
 * which reports it (naming guard_ledger_checks), instead of leaving a guard that lets a purged or withdrawn write
 * through. A concurrent pg_proc update is retried, and a failed re-create never skips the pg_temp hardening.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import { LedgerGuardRecreateError, hardenFailureLine, hardenFunctionSearchPaths } from '../src/core/function-search-path.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

const backends = testBackends();
const ROLLBACK = 'guard-recreate-rollback';

const STALE_ROW = [{ name: 'gbrain_refuse_purged_fact', sig: 'gbrain_refuse_purged_fact()', owned: true, role: 'writer' }];

/** Each executeRaw call takes the next step (rows, or an error to throw); later calls read []. Counts the hardening's transactions. */
function stubEngine(steps: Array<unknown[] | Error>, transactionError?: Error) {
  const state = { transactions: 0 };
  const engine = {
    kind: 'pglite',
    executeRaw: async () => {
      const step = steps.shift() ?? [];
      if (step instanceof Error) throw step;
      return step;
    },
    transaction: async (fn: (tx: unknown) => Promise<void>) => {
      state.transactions++;
      if (transactionError) throw transactionError;
      await fn({ executeRaw: async () => [], runMigration: async () => {} });
    },
  } as unknown as BrainEngine;
  return { engine, state };
}

describe('the guard re-create in hardenFunctionSearchPaths', () => {
  test('another role owning the guard (42501) stays silent', async () => {
    const owner = Object.assign(new Error('must be owner of function gbrain_refuse_purged_fact'), { code: '42501' });
    expect(await hardenFunctionSearchPaths(stubEngine([STALE_ROW, owner]).engine)).toEqual([]);
  });

  test('any other failure propagates, naming guard_ledger_checks, after the pg_temp hardening has run', async () => {
    const broken = Object.assign(new Error('connection terminated'), { code: '08006' });
    const { engine, state } = stubEngine([STALE_ROW, broken, [{ sig: 'gbrain_try_jsonb(text)' }]]);
    const failure = await hardenFunctionSearchPaths(engine).then(() => 'resolved', (error: unknown) => error);
    expect(failure).toBeInstanceOf(LedgerGuardRecreateError);
    expect(failure).toMatchObject({ cause: broken });
    expect((failure as { code?: unknown }).code).toBeUndefined();
    expect(hardenFailureLine(failure)).toBe('  guards: purge or withdrawal guards not re-created (connection terminated); gbrain doctor (guard_ledger_checks) names the ones left without their ledger check\n');
    expect(hardenFailureLine(broken)).toContain('pg_temp not restored');
    expect(state.transactions).toBe(1);
  });

  test('a hardening that fails too keeps its own error, a lock refusal included, and carries the re-create failure', async () => {
    const broken = Object.assign(new Error('connection terminated'), { code: '08006' });
    const lock = Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' });
    const { engine } = stubEngine([STALE_ROW, broken, [{ sig: 'gbrain_try_jsonb(text)' }]], lock);
    const failure = await hardenFunctionSearchPaths(engine).then(() => 'resolved', (error: unknown) => error);
    expect(failure).toMatchObject({ code: 'schema_lock_blocked' });
    expect((failure as { guardFailure?: unknown }).guardFailure).toBeInstanceOf(LedgerGuardRecreateError);
    const line = hardenFailureLine(failure);
    expect(line).toContain('  search_path: pg_temp not restored');
    expect(line).toContain('  guards: purge or withdrawal guards not re-created (connection terminated)');
  });

  test('a concurrent pg_proc update during the re-create is retried', async () => {
    const concurrent = new Error('tuple concurrently updated');
    expect(await hardenFunctionSearchPaths(stubEngine([STALE_ROW, concurrent, STALE_ROW, []]).engine)).toEqual([]);
  });
});

for (const backend of backends) {
  describe(`the guard re-create on ${backend}`, () => {
    let engine: BrainEngine;
    let close: (() => Promise<void>) | undefined;
    const other = `gbrain_guard_recreate_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    beforeAll(async () => {
      if (backend === 'pglite') {
        const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engine = lite;
      } else {
        const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
        engine = pg.engine; close = pg.close;
        await engine.executeRaw(`CREATE ROLE ${other} NOLOGIN`);
      }
    }, 180_000);
    afterAll(async () => {
      if (backend === 'postgres') await engine?.executeRaw(`DROP ROLE IF EXISTS ${other}`);
      if (close) await close(); else await engine?.disconnect();
    });

    test('a re-create that fails for a reason other than ownership reaches the caller', async () => {
      let failure: unknown;
      try {
        await engine.transaction(async tx => {
          await tx.executeRaw('DROP FUNCTION public.gbrain_refuse_purged_fact() CASCADE');
          await tx.executeRaw("CREATE FUNCTION public.gbrain_refuse_purged_fact() RETURNS integer LANGUAGE sql AS 'SELECT 1'");
          failure = await hardenFunctionSearchPaths(tx).then(() => 'resolved', (error: unknown) => error);
          throw new Error(ROLLBACK);
        });
      } catch (error) {
        if ((error as Error).message !== ROLLBACK) throw error;
      }
      const guardFailure = failure instanceof LedgerGuardRecreateError ? failure : (failure as { guardFailure?: unknown }).guardFailure;
      expect(guardFailure).toBeInstanceOf(LedgerGuardRecreateError);
      expect((guardFailure as Error).cause).toMatchObject({ code: '42P13' });
      expect((await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM pg_trigger WHERE tgfoid = 'public.gbrain_refuse_purged_fact()'::regprocedure"))[0]!.n).toBeGreaterThan(0);
    }, 120_000);

    test.if(backend === 'postgres')('a guard another role owns is left silently', async () => {
      try {
        await engine.transaction(async tx => {
          await tx.executeRaw(`CREATE OR REPLACE FUNCTION gbrain_refuse_purged_fact() RETURNS trigger LANGUAGE plpgsql
            SET search_path = pg_catalog, public, pg_temp AS $fn$ BEGIN RETURN NEW; END $fn$`);
          await tx.executeRaw(`SET LOCAL ROLE ${other}`);
          expect(await hardenFunctionSearchPaths(tx)).toEqual([]);
          throw new Error(ROLLBACK);
        });
      } catch (error) {
        if ((error as Error).message !== ROLLBACK) throw error;
      }
    }, 120_000);
  });
}
