/**
 * function_search_path doctor check (#7632): names every gbrain function whose pinned search_path lacks a trailing
 * pg_temp, with the ALTER FUNCTION that fixes it; the fix changes no owner, so the next boot still succeeds. The Postgres
 * non-owner path is in test/e2e/function-search-path-postgres.test.ts (case 5).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { functionSearchPathProblems } from '../src/commands/doctor/checks/function-search-path.ts';

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
  });

  test('each function without pg_temp is named, running the printed fix clears it, and a boot after the fix still succeeds', async () => {
    await engine.runMigration(0, `ALTER FUNCTION gbrain_refuse_purged_page() SET search_path = pg_catalog, public;
      ALTER FUNCTION gbrain_fts_input(text) SET search_path = pg_catalog;`);
    const { functions, fix } = await functionSearchPathProblems(engine);
    expect({ functions, fix }).toEqual({
      functions: ['gbrain_fts_input(text)', 'gbrain_refuse_purged_page()'],
      fix: [
        'ALTER FUNCTION gbrain_fts_input(text) SET search_path = pg_catalog, pg_temp;',
        'ALTER FUNCTION gbrain_refuse_purged_page() SET search_path = pg_catalog, public, pg_temp;',
      ],
    });
    await engine.runMigration(0, fix.join('\n'));
    expect(await functionSearchPathProblems(engine)).toEqual({ functions: [], fix: [] });
    await engine.initSchema();
    expect(await functionSearchPathProblems(engine)).toEqual({ functions: [], fix: [] });
  }, 120_000);
});
