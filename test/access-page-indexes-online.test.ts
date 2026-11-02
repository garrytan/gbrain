/**
 * GBRA-218: the member and folder access GIN indexes on pages are built online.
 *
 * 1. Protects: v282 and v283 add page_readers and folder_rule_ids to pages
 *    inside their migration transactions, which hold ACCESS EXCLUSIVE on pages
 *    until commit. A plain CREATE INDEX there scans every row of pages under that
 *    lock (a partial predicate on a new, all-NULL column still reads the heap),
 *    so every read and write of an upgrading Postgres brain waited on two full
 *    scans. v284 builds both indexes with buildIndexOnline (CONCURRENTLY on
 *    Postgres) in a migration of its own, as v270 does.
 * 2. Fails when: v282 or v283 creates an index on pages, v284 runs in a
 *    transaction, or an upgrade from v283 leaves either index missing or
 *    INVALID.
 * 3. Real seams: the migration registry and runMigrations on PGLite, and on
 *    Postgres when DATABASE_URL is set (testBackends).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MIGRATIONS, runMigrations } from '../src/core/migrate.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

const INDEXES = ['pages_page_readers_gin', 'pages_folder_rule_ids_gin'];
const backends = testBackends();
const engines: Array<{ backend: string; engine: BrainEngine }> = [];
let closePostgres: (() => Promise<void>) | undefined;

beforeAll(async () => {
  if (backends.includes('pglite')) {
    const engine = new PGLiteEngine();
    await engine.connect({}); await engine.initSchema();
    engines.push({ backend: 'pglite', engine });
  }
  if (backends.includes('postgres')) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    engines.push({ backend: 'postgres', engine: pg.engine }); closePostgres = pg.close;
  }
}, 120_000);

afterAll(async () => {
  for (const { engine } of engines) await engine.disconnect();
  await closePostgres?.();
});

describe('GBRA-218 access indexes on pages', () => {
  test('v282 and v283 create no index on pages; the access indexes come from one online migration', () => {
    for (const name of ['member_read_access', 'folder_access_rules']) {
      const m = MIGRATIONS.find(x => x.name === name)!;
      expect({ name, pageIndex: /CREATE\s+INDEX[^;]*\bON\s+pages\b/i.test(m.sql ?? '') }).toEqual({ name, pageIndex: false });
    }
    const online = MIGRATIONS.find(x => x.name === 'access_page_indexes');
    expect({ found: !!online, transaction: online?.transaction, handler: typeof online?.handler }).toEqual({ found: true, transaction: false, handler: 'function' });
    expect(online!.version).toBeGreaterThan(MIGRATIONS.find(x => x.name === 'folder_access_rules')!.version);
  });

  for (const backend of backends) {
    const engineFor = () => engines.find(e => e.backend === backend)!.engine;
    const valid = async () => Object.fromEntries(await Promise.all(INDEXES.map(async name => {
      const [row] = await engineFor().executeRaw<{ valid: boolean }>('SELECT indisvalid AS valid FROM pg_index WHERE indexrelid = to_regclass($1)', [name]);
      return [name, row?.valid ?? null] as const;
    })));

    test(`[${backend}] initSchema leaves both access indexes valid`, async () => {
      expect(await valid()).toEqual(Object.fromEntries(INDEXES.map(n => [n, true])));
    });

    test(`[${backend}] upgrading a brain at v283 builds both indexes online`, async () => {
      const engine = engineFor();
      const latest = await engine.getConfig('version');
      for (const name of INDEXES) await engine.executeRaw(`DROP INDEX ${name}`);
      await engine.setConfig('version', String(MIGRATIONS.find(x => x.name === 'folder_access_rules')!.version));
      await runMigrations(engine);
      expect(await valid()).toEqual(Object.fromEntries(INDEXES.map(n => [n, true])));
      expect(await engine.getConfig('version')).toBe(latest);
    });
  }
});
