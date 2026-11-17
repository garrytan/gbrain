/**
 * hardenFunctionSearchPaths re-creates every purge or withdrawal guard left without its ledger check (GST-2885,
 * #7632/#7659). Only a guard another role owns stays silent (SQLSTATE 42501, the next run of its owner re-creates it,
 * and doctor's guard_ledger_checks names it); any other failure of the re-create propagates to the migration run,
 * which reports it, instead of leaving a guard that lets a purged or withdrawn write through.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import { hardenFunctionSearchPaths } from '../src/core/function-search-path.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

const backends = testBackends();
const ROLLBACK = 'guard-recreate-rollback';

/** The guard listing names one stale guard the role owns; its CREATE OR REPLACE then fails with `failure`. */
function stubEngine(failure: Error & { code?: string }) {
  let call = 0;
  return {
    kind: 'pglite',
    executeRaw: async () => {
      call++;
      if (call === 1) return [{ name: 'gbrain_refuse_purged_fact', sig: 'gbrain_refuse_purged_fact()', owned: true, role: 'writer' }];
      if (call === 2) throw failure;
      return [];
    },
  } as unknown as BrainEngine;
}

describe('the guard re-create in hardenFunctionSearchPaths', () => {
  test('another role owning the guard (42501) stays silent', async () => {
    const owner = Object.assign(new Error('must be owner of function gbrain_refuse_purged_fact'), { code: '42501' });
    expect(await hardenFunctionSearchPaths(stubEngine(owner))).toEqual([]);
  });

  test('any other failure propagates', async () => {
    const broken = Object.assign(new Error('connection terminated'), { code: '08006' });
    await expect(hardenFunctionSearchPaths(stubEngine(broken))).rejects.toBe(broken);
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
      expect(failure).toMatchObject({ code: '42P13' });
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
