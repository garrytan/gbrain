/**
 * #7632: every migration run ends by putting pg_temp back on gbrain functions' search_path. That step is best-effort:
 * when it fails after the migrations committed (a lock it cannot take, a dropped connection), the run (and so
 * initSchema, apply-migrations and the upgrade preflight) still finishes, names the failure on stderr, and doctor's
 * function_search_path check names what it left. runMigrations directly: initSchema returns early on a PGLite snapshot.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';

const HARDENING = '../src/core/function-search-path.ts';
const actual = await import(HARDENING);
const harden = actual.hardenFunctionSearchPaths;
const state: { calls: number; failFrom: number; error: () => Error } = { calls: 0, failFrom: Infinity, error: () => new Error('canceling statement due to lock timeout') };
mock.module(HARDENING, () => ({ ...actual, hardenFunctionSearchPaths: async (engine: unknown) => {
  state.calls++;
  if (state.calls < state.failFrom) return harden(engine as never);
  throw state.error();
} }));
const { v277 } = await import('../src/core/schema-migrations/v277-function-search-path-pg-temp.ts');
const { PGLiteEngine } = await import('../src/core/pglite-engine.ts');
const { LATEST_VERSION, runMigrations } = await import('../src/core/migrate.ts');

async function captureStderr<T>(run: () => Promise<T>): Promise<{ result: T | Error; stderr: string }> {
  const write = process.stderr.write.bind(process.stderr);
  let stderr = '';
  process.stderr.write = ((chunk: string | Uint8Array) => { stderr += String(chunk); return true; }) as typeof process.stderr.write;
  try {
    return { result: await run().catch((e: Error) => e), stderr };
  } finally {
    process.stderr.write = write;
  }
}

describe('the search_path step after a migration run is best-effort (#7632)', () => {
  let engine: InstanceType<typeof PGLiteEngine>;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  }, 120_000);
  afterAll(async () => { await engine?.disconnect(); });
  const searchPath = async (name: string) => (await engine.executeRaw<{ setting: string }>(
    `SELECT s.setting FROM pg_proc p CROSS JOIN LATERAL unnest(p.proconfig) AS s(setting) WHERE p.proname = '${name}' AND s.setting LIKE 'search_path=%'`))[0]?.setting;

  test('the migration run finishes the upgrade and names the failed step when it throws', async () => {
    await engine.executeRaw(`ALTER FUNCTION gbrain_try_jsonb(text) SET search_path = pg_catalog, public`);
    await engine.executeRaw(`UPDATE config SET value = '${v277.version - 1}' WHERE key = 'version'`);
    Object.assign(state, { calls: 0, failFrom: 2 });
    const { result, stderr } = await captureStderr(() => runMigrations(engine));
    expect(result).toEqual({ applied: LATEST_VERSION - v277.version + 1, current: LATEST_VERSION });
    expect(await engine.getConfig('version')).toBe(String(LATEST_VERSION));
    expect(stderr).toContain('search_path: pg_temp not restored on gbrain functions (canceling statement due to lock timeout)');
    expect(await searchPath('gbrain_try_jsonb')).toBe('search_path=pg_catalog, public, pg_temp');
  }, 120_000);

  test('at the latest version (nothing pending) a failing search_path step still lets the run finish and names it (#7688)', async () => {
    await engine.executeRaw(`ALTER FUNCTION gbrain_try_jsonb(text) SET search_path = pg_catalog, public`);
    Object.assign(state, { calls: 0, failFrom: 1 });
    const { result, stderr } = await captureStderr(() => runMigrations(engine));
    expect(result).toEqual({ applied: 0, current: LATEST_VERSION });
    expect(state.calls).toBe(1);
    expect(stderr).toContain('search_path: pg_temp not restored on gbrain functions (canceling statement due to lock timeout)');
    Object.assign(state, { calls: 0, failFrom: Infinity });
    expect(await captureStderr(() => runMigrations(engine))).toEqual({ result: { applied: 0, current: LATEST_VERSION }, stderr: '' });
    expect(await searchPath('gbrain_try_jsonb')).toBe('search_path=pg_catalog, public, pg_temp');
  }, 120_000);

  test('a run a migration stopped on a lock it could not take skips the search_path step instead of waiting a second lock_timeout (#7688)', async () => {
    await engine.executeRaw(`UPDATE config SET value = '${v277.version - 1}' WHERE key = 'version'`);
    const lockError = () => Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' });
    Object.assign(state, { calls: 0, failFrom: 1, error: lockError });
    const { result, stderr } = await captureStderr(() => runMigrations(engine));
    expect(result).toBeInstanceOf(Error);
    expect(state.calls).toBe(1);
    expect(stderr).toContain('search_path: not put back on gbrain functions after the lock refusal');
    expect(stderr).not.toContain('pg_temp not restored');
    expect(await engine.getConfig('version')).toBe(String(v277.version - 1));
    Object.assign(state, { calls: 0, failFrom: Infinity });
    expect((await captureStderr(() => runMigrations(engine))).result).toEqual({ applied: LATEST_VERSION - v277.version + 1, current: LATEST_VERSION });
  }, 120_000);
});
