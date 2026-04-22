import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

describe('context-atlas schema', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  test('sqlite initSchema creates context_atlas_entries', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mbrain-context-atlas-sqlite-'));
    tempDirs.push(dir);

    const engine = new SQLiteEngine();
    await engine.connect({ engine: 'sqlite', database_path: join(dir, 'brain.db') });
    await engine.initSchema();

    const tables = (engine as any).database
      .query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'context_atlas_entries'`)
      .all();

    expect(tables).toHaveLength(1);
    await engine.disconnect();
  });

  test('pglite initSchema creates context_atlas_entries', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mbrain-context-atlas-pglite-'));
    tempDirs.push(dir);

    const engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite', database_path: dir });
    await engine.initSchema();

    const result = await (engine as any).db.query(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = 'context_atlas_entries'`,
    );

    expect(result.rows).toHaveLength(1);
    await engine.disconnect();
  });
});
