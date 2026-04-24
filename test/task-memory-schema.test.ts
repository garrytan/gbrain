import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

const RETRIEVAL_TRACE_FIDELITY_COLUMNS = [
  'derived_consulted',
  'write_outcome',
  'selected_intent',
  'scope_gate_policy',
  'scope_gate_reason',
];

describe('task-memory schema', () => {
  const tempPaths: string[] = [];

  afterEach(async () => {
    while (tempPaths.length > 0) {
      rmSync(tempPaths.pop()!, { recursive: true, force: true });
    }
  });

  test('sqlite initSchema creates task-memory tables', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mbrain-task-memory-sqlite-'));
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
           AND (name LIKE 'task_%' OR name = 'retrieval_traces')
         ORDER BY name`,
      )
      .all() as Array<{ name: string }>;

    expect(rows.map((row) => row.name)).toEqual([
      'retrieval_traces',
      'task_attempts',
      'task_decisions',
      'task_threads',
      'task_working_sets',
    ]);

    const columns = db
      .query(`PRAGMA table_info(retrieval_traces)`)
      .all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining(RETRIEVAL_TRACE_FIDELITY_COLUMNS));

    await engine.disconnect();
  });

  test('pglite initSchema creates task-memory tables', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mbrain-task-memory-pglite-'));
    tempPaths.push(dir);

    const engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite', database_path: dir });
    await engine.initSchema();

    const result = await (engine as any).db.query(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND (table_name LIKE 'task_%' OR table_name = 'retrieval_traces')
       ORDER BY table_name`,
    );

    expect(result.rows.map((row: { table_name: string }) => row.table_name)).toEqual([
      'retrieval_traces',
      'task_attempts',
      'task_decisions',
      'task_threads',
      'task_working_sets',
    ]);

    const columns = await (engine as any).db.query(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'retrieval_traces'`,
    );
    expect(columns.rows.map((row: { column_name: string }) => row.column_name)).toEqual(
      expect.arrayContaining(RETRIEVAL_TRACE_FIDELITY_COLUMNS),
    );

    await engine.disconnect();
  });
});
