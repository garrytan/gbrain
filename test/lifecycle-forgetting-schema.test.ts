import { setDefaultTimeout, afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { LATEST_VERSION } from '../src/core/migrate.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';

setDefaultTimeout(20_000);

const tempPaths: string[] = [];

afterEach(() => {
  while (tempPaths.length > 0) {
    const path = tempPaths.pop();
    if (path) rmSync(path, { recursive: true, force: true });
  }
});

const LIFECYCLE_TABLES = [
  'forgetting_policies',
  'memory_lifecycle_states',
  'forgetting_events',
  'purge_plans',
  'purge_plan_items',
  'restore_events',
  'memory_tombstones',
] as const;

describe('lifecycle forgetting schema', () => {
  test('sqlite initSchema exposes Phase 08 lifecycle forgetting tables in the local runtime', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mbrain-lifecycle-forgetting-sqlite-'));
    tempPaths.push(dir);

    const engine = new SQLiteEngine();
    await engine.connect({ engine: 'sqlite', database_path: join(dir, 'brain.db') });
    await engine.initSchema();

    const db = (engine as any).database;
    const tables = db.query(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table'
        AND name IN (${LIFECYCLE_TABLES.map(() => '?').join(', ')})
      ORDER BY name
    `).all(...LIFECYCLE_TABLES) as Array<{ name: string }>;
    expect(tables.map((row) => row.name)).toEqual([...LIFECYCLE_TABLES].sort());

    await engine.disconnect();
  });

  test('pglite initSchema exposes Phase 08 lifecycle forgetting tables in the local runtime', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mbrain-lifecycle-forgetting-pglite-'));
    tempPaths.push(dir);

    const engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite', database_path: dir });
    await engine.initSchema();

    const db = (engine as any).db;
    const tables = await db.query(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = ANY($1)
      ORDER BY table_name`,
      [LIFECYCLE_TABLES],
    );
    expect(tables.rows.map((row: any) => row.table_name)).toEqual([...LIFECYCLE_TABLES].sort());

    await engine.disconnect();
  }, 10_000);

  test('sqlite upgrades version 38 databases and installs lifecycle forgetting tables', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mbrain-lifecycle-forgetting-sqlite-v38-'));
    tempPaths.push(dir);

    const engine = new SQLiteEngine();
    await engine.connect({ engine: 'sqlite', database_path: join(dir, 'brain.db') });
    const db = (engine as any).database;
    db.exec(`
      CREATE TABLE config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      INSERT INTO config (key, value) VALUES ('version', '38');
    `);

    await engine.initSchema();

    const version = db.query(`SELECT value FROM config WHERE key = 'version'`).get() as { value: string };
    const table = db.query(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table'
        AND name = 'memory_lifecycle_states'
    `).get() as { name: string } | null;
    expect(version.value).toBe(String(LATEST_VERSION));
    expect(table).toEqual({ name: 'memory_lifecycle_states' });

    await engine.disconnect();
  });

  test('pglite upgrades version 38 databases and installs lifecycle forgetting tables', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mbrain-lifecycle-forgetting-pglite-v38-'));
    tempPaths.push(dir);

    const engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite', database_path: dir });
    const db = (engine as any).db;
    await db.exec(`
      CREATE TABLE config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      INSERT INTO config (key, value) VALUES ('version', '38');
    `);

    await engine.initSchema();

    const version = await db.query(`SELECT value FROM config WHERE key = 'version'`);
    const table = await db.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = 'memory_lifecycle_states'
    `);
    expect(version.rows).toEqual([{ value: String(LATEST_VERSION) }]);
    expect(table.rows).toEqual([{ table_name: 'memory_lifecycle_states' }]);

    await engine.disconnect();
  }, 10_000);
});
