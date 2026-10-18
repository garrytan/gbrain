/**
 * #6911: the recreate steps behind `gbrain repair missing-tables` rebuild each rebuildable cache in exactly the shape
 * a fully migrated brain has (columns, types, defaults and indexes), and the expected-table check scopes itself to the
 * brain's schema version. A later migration that changes one of these tables without a matching recreate line fails
 * here. Real PGLite, plus Postgres when DATABASE_URL is set.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { LATEST_VERSION } from '../src/core/migrate.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { GRADUATION_INVENTORY } from '../src/core/persistence/graduation-inventory.ts';
import { readMissingTables, RECREATABLE_TABLES, recreateStep } from '../src/core/schema-missing-tables.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withColdPglite } from './helpers/with-snapshot.ts';

const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;

async function shape(engine: BrainEngine, table: string) {
  const columns = await engine.executeRaw<Record<string, unknown>>(`SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS not_null,
      pg_get_expr(d.adbin, d.adrelid) AS default_expr
    FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE a.attrelid=to_regclass($1) AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attname`, [table]);
  const indexes = await engine.executeRaw<{ indexdef: string }>('SELECT indexdef FROM pg_indexes WHERE schemaname=current_schema() AND tablename=$1 ORDER BY indexname', [table]);
  return { columns, indexes: indexes.map(i => i.indexdef) };
}
async function setVersion(engine: BrainEngine, version: number) { await engine.setConfig('version', String(version)); }

beforeAll(async () => {
  engines.push(await withColdPglite(async () => { const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); return lite; }));
  if (process.env.DATABASE_URL) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL);
    engines.push(pg.engine); closePostgres = pg.close;
  }
}, 180_000);
afterAll(async () => { await engines[0]?.disconnect(); await closePostgres?.(); }, 60_000);

describe('#6911 recreatable caches', () => {
  test('every inventory rebuild table is recreatable here or comes back from the base-schema replay, and nothing else resolves to a step', async () => {
    const rebuild = GRADUATION_INVENTORY.entries.filter(e => e.class === 'rebuild' && e.kind === 'table').map(e => e.relation);
    for (const table of RECREATABLE_TABLES) expect(rebuild).toContain(table);
    const engine = engines[0]!;
    for (const table of rebuild.filter(t => !RECREATABLE_TABLES.includes(t))) {
      await engine.executeRaw(`DROP TABLE ${table}`);
      await engine.initSchema();
      expect({ table, missing: (await readMissingTables(engine) as { missing: Array<{ table: string }> }).missing.map(m => m.table) }).toEqual({ table, missing: [] });
    }
    for (const name of ['facts', 'core_edit_notices', 'constructor', 'toString', '__proto__', 'hasOwnProperty']) expect(recreateStep(name)).toBeUndefined();
  });

  test('each recreated table has the columns, types, defaults and indexes of the migrated brain', async () => {
    for (const engine of engines) {
      for (const table of RECREATABLE_TABLES) {
        const expected = await shape(engine, table);
        expect(expected.columns.length).toBeGreaterThan(0);
        await engine.executeRaw(`DROP TABLE ${table}`);
        await engine.transaction(tx => recreateStep(table)!(tx));
        expect({ engine: engine.kind, table, ...await shape(engine, table) }).toEqual({ engine: engine.kind, table, ...expected });
      }
    }
  }, 120_000);

  test('below head only caches whose creating migration ran are expected; a newer brain is skipped', async () => {
    for (const engine of engines) {
      await engine.executeRaw('DROP TABLE query_cache');
      try {
        await setVersion(engine, 100);
        expect(await readMissingTables(engine)).toMatchObject({ status: 'checked', scope: 'rebuildable_caches', checked: 2,
          missing: [{ table: 'query_cache', recreatable: true }] });
        await setVersion(engine, 57);
        expect(await readMissingTables(engine)).toMatchObject({ status: 'checked', scope: 'rebuildable_caches', checked: 1, missing: [{ table: 'query_cache' }] });
        await setVersion(engine, 54);
        expect(await readMissingTables(engine)).toEqual({ status: 'checked', scope: 'rebuildable_caches', checked: 0, missing: [] });
        await setVersion(engine, LATEST_VERSION + 1);
        expect(await readMissingTables(engine)).toEqual({ status: 'skipped', reason: 'client_behind', version: LATEST_VERSION + 1, latest: LATEST_VERSION });
      } finally {
        await setVersion(engine, LATEST_VERSION);
        await engine.transaction(tx => recreateStep('query_cache')!(tx));
      }
      expect(await readMissingTables(engine)).toMatchObject({ status: 'checked', scope: 'all_tables', missing: [] });
    }
  }, 120_000);
});
