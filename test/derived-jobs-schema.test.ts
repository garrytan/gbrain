import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';

describe('derived job schema', () => {
  const tempPaths: string[] = [];

  afterEach(async () => {
    while (tempPaths.length > 0) {
      rmSync(tempPaths.pop()!, { recursive: true, force: true });
    }
  });

  test('sqlite initSchema creates durable derived job tables', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mbrain-derived-jobs-sqlite-'));
    tempPaths.push(dir);

    const engine = new SQLiteEngine();
    await engine.connect({ engine: 'sqlite', database_path: join(dir, 'brain.db') });
    await engine.initSchema();

    const db = (engine as any).database;
    const tables = db.query(
      `SELECT name
       FROM sqlite_master
       WHERE type = 'table'
         AND name IN ('derived_jobs', 'derived_index_state')
       ORDER BY name`,
    ).all() as Array<{ name: string }>;
    expect(tables.map((row) => row.name)).toEqual([
      'derived_index_state',
      'derived_jobs',
    ]);

    const jobColumns = db.query(`PRAGMA table_info(derived_jobs)`).all() as Array<{ name: string }>;
    expect(jobColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
      'scope_id',
      'slug',
      'artifact_kind',
      'target_content_hash',
      'manifest_path',
      'derived_parameters',
      'status',
      'attempts',
      'lease_owner',
      'lease_expires_at',
    ]));

    const stateColumns = db.query(`PRAGMA table_info(derived_index_state)`).all() as Array<{ name: string }>;
    expect(stateColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
      'scope_id',
      'slug',
      'artifact_kind',
      'target_content_hash',
      'indexed_content_hash',
      'status',
      'extractor_version',
      'derived_schema_version',
    ]));

    await engine.disconnect();
  });

  test('pglite initSchema creates durable derived job tables', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mbrain-derived-jobs-pglite-'));
    tempPaths.push(dir);

    const engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite', database_path: dir });
    await engine.initSchema();

    const tables = await (engine as any).db.query(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name IN ('derived_jobs', 'derived_index_state')
       ORDER BY table_name`,
    );
    expect(tables.rows.map((row: { table_name: string }) => row.table_name)).toEqual([
      'derived_index_state',
      'derived_jobs',
    ]);

    const indexes = await (engine as any).db.query(
      `SELECT indexname
       FROM pg_indexes
       WHERE schemaname = 'public'
         AND indexname IN ('idx_derived_jobs_pending', 'idx_derived_jobs_active_slug_artifact')
       ORDER BY indexname`,
    );
    expect(indexes.rows.map((row: { indexname: string }) => row.indexname)).toEqual([
      'idx_derived_jobs_active_slug_artifact',
      'idx_derived_jobs_pending',
    ]);

    await engine.disconnect();
  });
});
