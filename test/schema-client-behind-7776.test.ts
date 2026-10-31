/** #7776: an older initializer must not overwrite a newer brain's functions or run drift repairs. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { LATEST_VERSION, runMigrations } from '../src/core/migrate.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withColdPglite } from './helpers/with-snapshot.ts';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keylessBrainEnv } from './helpers/provider-env.ts';

const newer = String(LATEST_VERSION + 1);
const marker = `CREATE OR REPLACE FUNCTION gbrain_fts_input(t text) RETURNS text
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE SET search_path = pg_catalog AS $$ SELECT 'newer-schema'::text $$`;

async function definition(engine: BrainEngine) {
  return engine.executeRaw("SELECT pg_get_functiondef('gbrain_fts_input(text)'::regprocedure) AS definition");
}

for (const backend of testBackends()) describe(`#7776 client behind (${backend})`, () => {
  let engine: BrainEngine;
  let databaseUrl: string;
  let close: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    if (backend === 'postgres') {
      const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
      engine = pg.engine; close = pg.close; databaseUrl = pg.databaseUrl;
    } else {
      engine = await withColdPglite(async () => {
        const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); return lite;
      });
    }
  }, 180_000);
  afterAll(async () => { if (close) await close(); else await engine?.disconnect(); }, 60_000);

  test('schema replay refuses a newer ledger without changing its function or version', async () => {
    await engine.setConfig('version', newer);
    await engine.executeRaw(marker);
    const before = await definition(engine);
    try {
      await expect(engine.initSchema()).rejects.toMatchObject({ code: 'client_behind' });
      expect(await definition(engine)).toEqual(before);
      expect(await engine.getConfig('version')).toBe(newer);
      if (backend === 'postgres') {
        expect(await engine.executeRaw(`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory'
          AND objid = 42 AND granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`)).toEqual([{ n: 0 }]);
      }
    } finally { await engine.setConfig('version', String(LATEST_VERSION)); }
  }, 60_000);

  test('direct migration invocation refuses before best-effort drift repairs mutate newer definitions', async () => {
    await engine.setConfig('version', newer);
    await engine.executeRaw(marker);
    const before = await definition(engine);
    try {
      await expect(runMigrations(engine)).rejects.toMatchObject({ code: 'client_behind' });
      expect(await definition(engine)).toEqual(before);
      expect(await engine.getConfig('version')).toBe(newer);
    } finally { await engine.setConfig('version', String(LATEST_VERSION)); }
  }, 60_000);

  test('a current ledger can still replay, restore the embedded function and initialize again', async () => {
    await engine.executeRaw(marker);
    await engine.initSchema();
    expect(await engine.executeRaw("SELECT gbrain_fts_input('normal input') AS value")).toEqual([{ value: 'normal input' }]);
    expect(await engine.getConfig('version')).toBe(String(LATEST_VERSION));
    await engine.initSchema();
  }, 120_000);

  test.skipIf(backend !== 'postgres')('legacy initializer refuses without overwriting the function or leaking lock 42', async () => {
    const home = await mkdtemp(join(tmpdir(), 'gbrain-schema-behind-'));
    await engine.setConfig('version', newer);
    await engine.executeRaw(marker);
    const before = await definition(engine);
    try {
      const child = Bun.spawn([process.execPath, join(import.meta.dir, 'fixtures/schema-client-behind-legacy.ts')], {
        env: keylessBrainEnv(process.env, home, { DATABASE_URL: databaseUrl, GBRAIN_POOL_SIZE: '2' }),
        stdout: 'pipe', stderr: 'pipe',
      });
      const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect({ code, err }).toEqual({ code: 0, err: '' });
      expect(JSON.parse(out)).toEqual({ code: 'client_behind' });
      expect(await definition(engine)).toEqual(before);
      expect(await engine.getConfig('version')).toBe(newer);
      expect(await engine.executeRaw(`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory'
        AND objid = 42 AND granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`)).toEqual([{ n: 0 }]);
    } finally {
      await engine.setConfig('version', String(LATEST_VERSION));
      await rm(home, { recursive: true, force: true });
    }
  }, 60_000);
});
