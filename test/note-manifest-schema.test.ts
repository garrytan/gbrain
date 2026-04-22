import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';

describe('note-manifest schema', () => {
  const tempPaths: string[] = [];

  afterEach(async () => {
    while (tempPaths.length > 0) {
      rmSync(tempPaths.pop()!, { recursive: true, force: true });
    }
  });

  test('sqlite initSchema creates note_manifest_entries', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mbrain-note-manifest-sqlite-'));
    const databasePath = join(dir, 'brain.db');
    tempPaths.push(dir);

    const engine = new SQLiteEngine();
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();

    const db = (engine as any).database;
    const rows = db
      .query(
        `SELECT name
         FROM sqlite_master
         WHERE type = 'table'
           AND name = 'note_manifest_entries'`,
      )
      .all() as Array<{ name: string }>;

    expect(rows.map((row) => row.name)).toEqual(['note_manifest_entries']);

    await engine.disconnect();
  });

  test('pglite initSchema creates note_manifest_entries', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mbrain-note-manifest-pglite-'));
    tempPaths.push(dir);

    const engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite', database_path: dir });
    await engine.initSchema();

    const result = await (engine as any).db.query(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = 'note_manifest_entries'`,
    );

    expect(result.rows.map((row: { table_name: string }) => row.table_name)).toEqual([
      'note_manifest_entries',
    ]);

    await engine.disconnect();
  });
});
