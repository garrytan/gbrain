/**
 * function_search_path doctor check (#7632, #7688): names every gbrain function whose search_path does not end in
 * pg_temp, with a schema-qualified ALTER FUNCTION that fixes it; the fix changes no owner, so the next boot still
 * succeeds. Below migration v277 it points at the migration instead. The Postgres non-owner path is in
 * test/e2e/function-search-path-postgres.test.ts (case 5).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { functionSearchPathEntry, functionSearchPathProblems } from '../src/commands/doctor/checks/function-search-path.ts';
import type { Check } from '../src/commands/doctor.ts';
import type { BrainEngine } from '../src/core/engine.ts';

const progress = { heartbeat: () => {} };
const run = async (engine: BrainEngine) => (await functionSearchPathEntry.run({ engine, progress } as never) as Check[]);

describe('function_search_path doctor check (#7632)', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  }, 120_000);
  afterAll(async () => { await engine?.disconnect(); });

  test('a fresh install has no problem', async () => {
    expect(await functionSearchPathProblems(engine)).toEqual({ functions: [], fix: [] });
    expect(await run(engine)).toEqual([{ name: 'function_search_path', status: 'ok', message: 'Every gbrain function that pins a search_path ends it with pg_temp' }]);
  });

  test('each function without pg_temp is named, running the printed fix clears it, and a boot after the fix still succeeds', async () => {
    await engine.runMigration(0, `ALTER FUNCTION gbrain_refuse_purged_page() SET search_path = pg_catalog, public;
      ALTER FUNCTION gbrain_fts_input(text) SET search_path = pg_catalog;`);
    const { functions, fix } = await functionSearchPathProblems(engine);
    expect({ functions, fix }).toEqual({
      functions: ['gbrain_fts_input(text)', 'gbrain_refuse_purged_page()'],
      fix: [
        'ALTER FUNCTION public.gbrain_fts_input(text) SET search_path = pg_catalog, pg_temp;',
        'ALTER FUNCTION public.gbrain_refuse_purged_page() SET search_path = pg_catalog, public, pg_temp;',
      ],
    });
    await engine.runMigration(0, fix.join('\n'));
    expect(await functionSearchPathProblems(engine)).toEqual({ functions: [], fix: [] });
    await engine.initSchema();
    expect(await functionSearchPathProblems(engine)).toEqual({ functions: [], fix: [] });
  }, 120_000);

  test('the printed fix is schema-qualified, so it runs from a session whose search_path does not name public (#7688)', async () => {
    await engine.runMigration(0, `ALTER FUNCTION gbrain_try_jsonb(text) SET search_path = pg_catalog, public`);
    const { fix } = await functionSearchPathProblems(engine);
    await engine.transaction(async tx => {
      await tx.executeRaw(`SET LOCAL search_path = pg_catalog`);
      await tx.executeRaw(fix.join('\n'));
    });
    expect(await functionSearchPathProblems(engine)).toEqual({ functions: [], fix: [] });
  }, 120_000);

  test('at or past v277 the check fails with the ALTER in its message and details, and no runnable fix (#7688)', async () => {
    await engine.runMigration(0, `ALTER FUNCTION gbrain_refuse_purged_take() SET search_path = pg_catalog, public`);
    const sql = 'ALTER FUNCTION public.gbrain_refuse_purged_take() SET search_path = pg_catalog, public, pg_temp;';
    const [check] = await run(engine);
    expect(check).toMatchObject({
      name: 'function_search_path', status: 'fail', fix_unavailable_reason: 'no_safe_automatic_fix',
      details: { functions: ['gbrain_refuse_purged_take()'], sql: [sql], docs: 'docs/guides/troubleshooting.md#function-search-path' },
    });
    expect(check!.fix).toBeUndefined();
    expect(check!.message).toContain(`as the role that owns each function (migration v277 and every migration run already did the ones the migrating role owns): ${sql}`);
    await engine.runMigration(0, `ALTER FUNCTION gbrain_refuse_purged_take() SET search_path = pg_catalog, public, pg_temp`);
  }, 120_000);

  test('the printed ALTER names argument types only, never a caller-chosen argument name (#7688)', async () => {
    await engine.runMigration(0, `CREATE FUNCTION public.gbrain_try_jsonb("$(touch x)" int) RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, public AS $f$ BEGIN RETURN NULL; END $f$`);
    try {
      const { fix } = await functionSearchPathProblems(engine);
      expect(fix).toEqual(['ALTER FUNCTION public.gbrain_try_jsonb(integer) SET search_path = pg_catalog, public, pg_temp;']);
    } finally {
      await engine.runMigration(0, 'DROP FUNCTION public.gbrain_try_jsonb(int)');
    }
  }, 120_000);

  test('below v277 the check points at gbrain apply-migrations --yes instead of hand-written ALTERs (#7688)', async () => {
    await engine.runMigration(0, `ALTER FUNCTION gbrain_refuse_purged_take() SET search_path = pg_catalog, public`);
    const latest = await engine.getConfig('version');
    await engine.setConfig('version', '276');
    try {
      const [check] = await run(engine);
      expect(check).toMatchObject({
        name: 'function_search_path', status: 'fail',
        fix: { argv: ['gbrain', 'apply-migrations', '--yes', '--no-autopilot-install'], actor: 'agent', requires_exclusive: true },
        details: { functions: ['gbrain_refuse_purged_take()'], schema_version: 276 },
      });
      expect(check!.message).toContain('below migration v277');
      expect(check!.message).not.toContain('ALTER FUNCTION');
    } finally {
      await engine.setConfig('version', latest!);
      await engine.runMigration(0, `ALTER FUNCTION gbrain_refuse_purged_take() SET search_path = pg_catalog, public, pg_temp`);
    }
  }, 120_000);

  test('a failing probe is reported as a check error, not a pass', async () => {
    const broken = { executeRaw: async () => { throw new Error('connection reset'); } } as unknown as BrainEngine;
    const [check] = await run(broken);
    expect(check).toMatchObject({ name: 'function_search_path', fix_unavailable_reason: 'check_errored' });
    expect(check!.status).not.toBe('ok');
    expect(check!.message).toContain('connection reset');
  });
});
