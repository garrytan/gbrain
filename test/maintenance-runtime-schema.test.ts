import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';

setDefaultTimeout(20_000);

describe('maintenance runtime schema', () => {
  const tempPaths: string[] = [];

  afterEach(async () => {
    while (tempPaths.length > 0) {
      rmSync(tempPaths.pop()!, { recursive: true, force: true });
    }
  });

  test('sqlite initSchema creates durable maintenance runtime tables', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mbrain-maintenance-runtime-sqlite-'));
    tempPaths.push(dir);

    const engine = new SQLiteEngine();
    await engine.connect({ engine: 'sqlite', database_path: join(dir, 'brain.db') });
    await engine.initSchema();

    const db = (engine as any).database;
    const tables = db.query(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table'
        AND name IN (
          'memory_jobs',
          'memory_job_events',
          'memory_job_logs',
          'memory_job_artifacts',
          'memory_cycle_locks',
          'memory_worker_heartbeats'
        )
      ORDER BY name
    `).all() as Array<{ name: string }>;

    expect(tables.map((row) => row.name)).toEqual([
      'memory_cycle_locks',
      'memory_job_artifacts',
      'memory_job_events',
      'memory_job_logs',
      'memory_jobs',
      'memory_worker_heartbeats',
    ]);

    const jobColumns = db.query(`PRAGMA table_info(memory_jobs)`).all() as Array<{ name: string }>;
    expect(jobColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
      'id',
      'name',
      'queue',
      'status',
      'lock_token',
      'idempotency_key',
      'failure_class',
      'next_run_at',
    ]));

    db.run(`INSERT INTO memory_jobs (id, name, status) VALUES ('job:audit', 'audit', 'waiting')`);
    db.run(`INSERT INTO memory_job_events (id, job_id, event_type) VALUES ('event:audit', 'job:audit', 'job_enqueued')`);
    db.run(`INSERT INTO memory_job_logs (id, job_id, level, message) VALUES ('log:audit', 'job:audit', 'info', 'hello')`);
    db.run(`INSERT INTO memory_job_artifacts (id, job_id, artifact_kind, artifact_ref) VALUES ('artifact:audit', 'job:audit', 'snapshot', 'ref')`);
    expect(() => db.run(`UPDATE memory_job_events SET event_type = 'mutated' WHERE id = 'event:audit'`)).toThrow(/append-only/);
    expect(() => db.run(`DELETE FROM memory_job_logs WHERE id = 'log:audit'`)).toThrow(/append-only/);
    expect(() => db.run(`DELETE FROM memory_job_artifacts WHERE id = 'artifact:audit'`)).toThrow(/append-only/);
    expect(() => db.run(`DELETE FROM memory_jobs WHERE id = 'job:audit'`)).toThrow(/append-only/);

    await engine.disconnect();
  });

  test('pglite initSchema creates durable maintenance runtime tables and indexes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mbrain-maintenance-runtime-pglite-'));
    tempPaths.push(dir);

    const engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite', database_path: dir });
    await engine.initSchema();

    const tables = await (engine as any).db.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN (
          'memory_jobs',
          'memory_job_events',
          'memory_job_logs',
          'memory_job_artifacts',
          'memory_cycle_locks',
          'memory_worker_heartbeats'
        )
      ORDER BY table_name
    `);
    expect(tables.rows.map((row: { table_name: string }) => row.table_name)).toEqual([
      'memory_cycle_locks',
      'memory_job_artifacts',
      'memory_job_events',
      'memory_job_logs',
      'memory_jobs',
      'memory_worker_heartbeats',
    ]);

    const indexes = await (engine as any).db.query(`
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname IN ('idx_memory_jobs_active_idempotency', 'idx_memory_jobs_claimable')
      ORDER BY indexname
    `);
    expect(indexes.rows.map((row: { indexname: string }) => row.indexname)).toEqual([
      'idx_memory_jobs_active_idempotency',
      'idx_memory_jobs_claimable',
    ]);

    await (engine as any).db.query(`INSERT INTO memory_jobs (id, name, status) VALUES ('job:audit', 'audit', 'waiting')`);
    await (engine as any).db.query(`INSERT INTO memory_job_events (id, job_id, event_type) VALUES ('event:audit', 'job:audit', 'job_enqueued')`);
    await (engine as any).db.query(`INSERT INTO memory_job_logs (id, job_id, level, message) VALUES ('log:audit', 'job:audit', 'info', 'hello')`);
    await (engine as any).db.query(`INSERT INTO memory_job_artifacts (id, job_id, artifact_kind, artifact_ref) VALUES ('artifact:audit', 'job:audit', 'snapshot', 'ref')`);
    await expect((engine as any).db.query(`UPDATE memory_job_events SET event_type = 'mutated' WHERE id = 'event:audit'`)).rejects.toThrow(/append-only/);
    await expect((engine as any).db.query(`DELETE FROM memory_job_logs WHERE id = 'log:audit'`)).rejects.toThrow(/append-only/);
    await expect((engine as any).db.query(`DELETE FROM memory_job_artifacts WHERE id = 'artifact:audit'`)).rejects.toThrow(/append-only/);
    await expect((engine as any).db.query(`DELETE FROM memory_jobs WHERE id = 'job:audit'`)).rejects.toThrow(/append-only/);

    await engine.disconnect();
  });
});
