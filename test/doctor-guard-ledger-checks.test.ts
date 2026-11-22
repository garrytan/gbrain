/**
 * guard_ledger_checks doctor check (GST-2885, #7632/#7659): names every purge or withdrawal guard whose body lacks its
 * row_security_active('<ledger>') check, with the role that owns it and the fix for that role. A guard the doctor's role
 * may re-create gets the runnable migration fix; one another role owns gets the SQL to run as that role. PGLite has no
 * row-level security, so there the check reports not applicable.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { Check } from '../src/commands/doctor.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

const backends = testBackends();
const progress = { heartbeat: () => {} };
const run = async (engine: BrainEngine): Promise<Check[]> => {
  const { guardLedgerChecksEntry } = await import('../src/commands/doctor/checks/guard-ledger-checks.ts');
  return await guardLedgerChecksEntry.run({ engine, progress } as never) as Check[];
};
const ROLLBACK = 'guard-ledger-doctor-rollback';
const STALE = `CREATE OR REPLACE FUNCTION gbrain_refuse_purged_fact() RETURNS trigger LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp AS $fn$ BEGIN RETURN NEW; END $fn$`;
const OK: Check = { name: 'guard_ledger_checks', status: 'ok', message: 'Every purge and withdrawal guard refuses a write role that row-level security keeps from its ledger' };

describe.if(backends.includes('pglite'))('guard_ledger_checks on PGLite', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
  afterAll(async () => { await engine?.disconnect(); });

  test('reports not applicable, even with a guard left without its ledger check', async () => {
    const skipped: Check[] = [{ name: 'guard_ledger_checks', status: 'ok', message: 'Skipped (PGLite has no row-level security, so every guard reads its ledgers in full)' }];
    expect(await run(engine)).toEqual(skipped);
    await engine.executeRaw(STALE);
    expect(await run(engine)).toEqual(skipped);
  }, 120_000);
});

describe.if(backends.includes('postgres'))('guard_ledger_checks on Postgres', () => {
  let engine: BrainEngine;
  let close: () => Promise<void>;
  let me = '';
  const other = `gbrain_guard_doctor_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  beforeAll(async () => {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    engine = pg.engine; close = pg.close;
    me = (await engine.executeRaw<{ me: string }>('SELECT current_user::text AS me'))[0]!.me;
    await engine.executeRaw(`CREATE ROLE ${other} NOLOGIN`);
  }, 180_000);
  afterAll(async () => {
    await engine?.executeRaw(`DROP ROLE IF EXISTS ${other}`);
    await close?.();
  });

  const rolledBack = async (fn: (tx: BrainEngine) => Promise<void>) => {
    try {
      await engine.transaction(async tx => { await fn(tx); throw new Error(ROLLBACK); });
    } catch (error) {
      if ((error as Error).message !== ROLLBACK) throw error;
    }
  };

  test('a fresh install is clean', async () => {
    expect(await run(engine)).toEqual([OK]);
  });

  test('a guard the role may re-create is named with the migration run that re-creates it', async () => {
    await rolledBack(async tx => {
      await tx.executeRaw(STALE);
      const [check] = await run(tx);
      expect(check).toMatchObject({
        name: 'guard_ledger_checks', status: 'fail',
        fix: { argv: ['gbrain', 'apply-migrations', '--yes', '--no-autopilot-install'], actor: 'agent' },
        details: { functions: ['gbrain_refuse_purged_fact()'], owners: [me] },
      });
      expect(check!.message).toContain('gbrain_refuse_purged_fact() (owner ' + me + ')');
    });
    expect(await run(engine)).toEqual([OK]);
  }, 120_000);

  test('a guard another role owns is named with its owner and the SQL that role runs, and no runnable fix', async () => {
    await rolledBack(async tx => {
      await tx.executeRaw(STALE);
      await tx.executeRaw(`SET LOCAL ROLE ${other}`);
      const [check] = await run(tx);
      const sql = `ALTER FUNCTION public.gbrain_refuse_purged_fact() OWNER TO ${other};`;
      expect(check).toMatchObject({
        name: 'guard_ledger_checks', status: 'fail', fix_unavailable_reason: 'no_safe_automatic_fix',
        details: { functions: ['gbrain_refuse_purged_fact()'], owners: [me], sql: [sql], docs: 'docs/ENGINES.md#purge-and-withdrawal-guards' },
      });
      expect(check!.fix).toBeUndefined();
      expect(check!.message).toContain(`connected as ${me}`);
      expect(check!.message).toContain(sql);
    });
  }, 120_000);
});
