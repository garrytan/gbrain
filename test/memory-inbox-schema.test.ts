import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';

describe('memory-inbox schema', () => {
  const tempPaths: string[] = [];

  afterEach(async () => {
    while (tempPaths.length > 0) {
      rmSync(tempPaths.pop()!, { recursive: true, force: true });
    }
  });

  test('sqlite initSchema creates memory_candidate_entries', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mbrain-memory-inbox-sqlite-'));
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
           AND name = 'memory_candidate_entries'`,
      )
      .all() as Array<{ name: string }>;

    expect(rows.map((row) => row.name)).toEqual(['memory_candidate_entries']);

    const schema = db
      .query(
        `SELECT sql
         FROM sqlite_master
         WHERE type = 'table'
           AND name = 'memory_candidate_entries'`,
      )
      .get() as { sql: string };

    expect(schema.sql).toContain("candidate_type TEXT NOT NULL CHECK");
    expect(schema.sql).toContain("generated_by TEXT NOT NULL CHECK");
    expect(schema.sql).toContain("extraction_kind TEXT NOT NULL CHECK");
    expect(schema.sql).toContain("sensitivity TEXT NOT NULL CHECK");
    expect(schema.sql).toContain("status TEXT NOT NULL CHECK");
    expect(schema.sql).toContain("target_object_type TEXT CHECK");

    expect(() => {
      db.query(`
        INSERT INTO memory_candidate_entries (
          id,
          scope_id,
          candidate_type,
          proposed_content,
          source_refs,
          generated_by,
          extraction_kind,
          confidence_score,
          importance_score,
          recurrence_score,
          sensitivity,
          status
        ) VALUES (
          'bad-status',
          'workspace:default',
          'fact',
          'Invalid status should fail at the DB layer.',
          '[]',
          'manual',
          'manual',
          0.5,
          0.5,
          0,
          'work',
          'promoted'
        )
      `).run();
    }).toThrow();

    await engine.disconnect();
  });

  test('pglite initSchema creates memory_candidate_entries', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mbrain-memory-inbox-pglite-'));
    tempPaths.push(dir);

    const engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite', database_path: dir });
    await engine.initSchema();

    const result = await (engine as any).db.query(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = 'memory_candidate_entries'`,
    );

    expect(result.rows.map((row: { table_name: string }) => row.table_name)).toEqual([
      'memory_candidate_entries',
    ]);

    await expect((engine as any).db.query(`
      INSERT INTO memory_candidate_entries (
        id,
        scope_id,
        candidate_type,
        proposed_content,
        source_refs,
        generated_by,
        extraction_kind,
        confidence_score,
        importance_score,
        recurrence_score,
        sensitivity,
        status
      ) VALUES (
        'bad-status',
        'workspace:default',
        'fact',
        'Invalid status should fail at the DB layer.',
        '[]',
        'manual',
        'manual',
        0.5,
        0.5,
        0,
        'work',
        'promoted'
      )
    `)).rejects.toThrow();

    await engine.disconnect();
  });
});
