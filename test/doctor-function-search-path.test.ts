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
        'ALTER FUNCTION public.gbrain_fts_input(t text) SET search_path = pg_catalog, pg_temp;',
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

  test('a gbrain function re-created without any search_path is named, with a fix that pins one (#7688)', async () => {
    await engine.runMigration(0, `ALTER FUNCTION gbrain_try_jsonb(text) RESET search_path`);
    expect(await functionSearchPathProblems(engine)).toEqual({
      functions: ['gbrain_try_jsonb(text)'],
      fix: ['ALTER FUNCTION public.gbrain_try_jsonb(input text) SET search_path = pg_catalog, public, pg_temp;'],
    });
    await engine.runMigration(0, (await functionSearchPathProblems(engine)).fix.join('\n'));
    expect(await functionSearchPathProblems(engine)).toEqual({ functions: [], fix: [] });
  }, 120_000);

  test('at or past v277 the check fails with the ALTER as a host-admin psql fix and the SQL in details (#7688)', async () => {
    await engine.runMigration(0, `ALTER FUNCTION gbrain_refuse_purged_take() SET search_path = pg_catalog, public`);
    const [check] = await run(engine);
    expect(check).toMatchObject({
      name: 'function_search_path', status: 'fail',
      fix: { argv: ['psql', '-c', 'ALTER FUNCTION public.gbrain_refuse_purged_take() SET search_path = pg_catalog, public, pg_temp;'], actor: 'host_admin', consent: [],
        verify: { argv: ['gbrain', 'doctor', '--only', 'function_search_path', '--json'] }, docs: 'docs/guides/troubleshooting.md#function-search-path' },
      details: { functions: ['gbrain_refuse_purged_take()'], sql: ['ALTER FUNCTION public.gbrain_refuse_purged_take() SET search_path = pg_catalog, public, pg_temp;'] },
    });
    expect(check!.message).toContain('as the role that owns each function');
    await engine.runMigration(0, `ALTER FUNCTION gbrain_refuse_purged_take() SET search_path = pg_catalog, public, pg_temp`);
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
