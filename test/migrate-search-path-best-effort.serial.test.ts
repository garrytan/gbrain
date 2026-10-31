/**
 * #7632: every migration run ends by putting pg_temp back on gbrain functions' search_path. That step is best-effort:
 * when it fails after the migrations committed (a lock it cannot take, a dropped connection), the run (and so
 * initSchema, apply-migrations and the upgrade preflight) still finishes, names the failure on stderr, and doctor's
 * function_search_path check names what it left. runMigrations directly: initSchema returns early on a PGLite snapshot.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';

const V277 = '../src/core/schema-migrations/v277-function-search-path-pg-temp.ts';
const actual = await import(V277);
const harden = actual.hardenFunctionSearchPaths;
mock.module(V277, () => ({ ...actual, hardenFunctionSearchPaths: async (engine: unknown, label: string) => {
  if (label === 'v277') return harden(engine as never, label);
  throw new Error('canceling statement due to lock timeout');
} }));
const { PGLiteEngine } = await import('../src/core/pglite-engine.ts');
const { LATEST_VERSION, runMigrations } = await import('../src/core/migrate.ts');

describe('the search_path step after a migration run is best-effort (#7632)', () => {
  let engine: InstanceType<typeof PGLiteEngine>;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  }, 120_000);
  afterAll(async () => { await engine?.disconnect(); });

  test('the migration run finishes the upgrade and names the failed step when it throws', async () => {
    await engine.executeRaw(`ALTER FUNCTION gbrain_try_jsonb(text) SET search_path = pg_catalog, public`);
    await engine.executeRaw(`UPDATE config SET value = '${actual.v277.version - 1}' WHERE key = 'version'`);
    const write = process.stderr.write.bind(process.stderr);
    let stderr = '';
    process.stderr.write = ((chunk: string | Uint8Array) => { stderr += String(chunk); return true; }) as typeof process.stderr.write;
    try {
      expect((await runMigrations(engine)).applied).toBe(LATEST_VERSION - actual.v277.version + 1);
    } finally {
      process.stderr.write = write;
    }
    expect(await engine.getConfig('version')).toBe(String(LATEST_VERSION));
    expect(stderr).toContain('search_path: pg_temp not restored on gbrain functions (canceling statement due to lock timeout)');
    const [row] = await engine.executeRaw<{ setting: string }>(
      `SELECT s.setting FROM pg_proc p CROSS JOIN LATERAL unnest(p.proconfig) AS s(setting) WHERE p.proname = 'gbrain_try_jsonb' AND s.setting LIKE 'search_path=%'`);
    expect(row!.setting).toBe('search_path=pg_catalog, public, pg_temp');
  }, 120_000);
});
