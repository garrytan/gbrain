import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';

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

  test('sqlite upgrades pre-trace-fidelity traces and backfills structured gate fields', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mbrain-task-memory-sqlite-legacy-trace-'));
    const databasePath = join(dir, 'brain.db');
    tempPaths.push(dir);

    const engine = new SQLiteEngine();
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    const db = (engine as any).database;
    db.exec(`
      CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO config (key, value) VALUES ('version', '22');
      CREATE TABLE task_threads (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        title TEXT NOT NULL,
        goal TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL,
        repo_path TEXT,
        branch_name TEXT,
        current_summary TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
      CREATE TABLE retrieval_traces (
        id TEXT PRIMARY KEY,
        task_id TEXT REFERENCES task_threads(id) ON DELETE SET NULL,
        scope TEXT NOT NULL,
        route TEXT NOT NULL DEFAULT '[]',
        source_refs TEXT NOT NULL DEFAULT '[]',
        verification TEXT NOT NULL DEFAULT '[]',
        outcome TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
      INSERT INTO task_threads (id, scope, title, status)
      VALUES ('legacy-task', 'work', 'Legacy trace', 'active');
      INSERT INTO retrieval_traces (id, task_id, scope, route, source_refs, verification, outcome)
      VALUES (
        'legacy-trace',
        'legacy-task',
        'personal',
        '[]',
        '[]',
        '["intent:precision_lookup","scope_gate:deny","scope_gate_reason:unsupported_scope_intent"]',
        'precision_lookup route unavailable'
      );
    `);

    await engine.initSchema();

    const trace = (await engine.listRetrievalTraces('legacy-task', { limit: 1 }))[0]!;
    expect(trace.selected_intent).toBe('precision_lookup');
    expect(trace.scope_gate_policy).toBe('deny');
    expect(trace.scope_gate_reason).toBe('unsupported_scope_intent');
    expect(trace.derived_consulted).toEqual([]);
    expect(trace.write_outcome).toBe('no_durable_write');

    await engine.disconnect();
  });

  test('pglite upgrades pre-trace-fidelity traces and backfills structured gate fields', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mbrain-task-memory-pglite-legacy-trace-'));
    tempPaths.push(dir);

    const engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite', database_path: dir });
    await (engine as any).db.exec(`
      CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO config (key, value) VALUES ('version', '22');
      CREATE TABLE task_threads (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        title TEXT NOT NULL,
        goal TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL,
        repo_path TEXT,
        branch_name TEXT,
        current_summary TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE retrieval_traces (
        id TEXT PRIMARY KEY,
        task_id TEXT REFERENCES task_threads(id) ON DELETE SET NULL,
        scope TEXT NOT NULL,
        route JSONB NOT NULL DEFAULT '[]',
        source_refs JSONB NOT NULL DEFAULT '[]',
        verification JSONB NOT NULL DEFAULT '[]',
        outcome TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      INSERT INTO task_threads (id, scope, title, status)
      VALUES ('legacy-task', 'work', 'Legacy trace', 'active');
      INSERT INTO retrieval_traces (id, task_id, scope, route, source_refs, verification, outcome)
      VALUES (
        'legacy-trace',
        'legacy-task',
        'personal',
        '[]'::jsonb,
        '[]'::jsonb,
        '["intent:precision_lookup","scope_gate:deny","scope_gate_reason:unsupported_scope_intent"]'::jsonb,
        'precision_lookup route unavailable'
      );
    `);

    await engine.initSchema();

    const trace = (await engine.listRetrievalTraces('legacy-task', { limit: 1 }))[0]!;
    expect(trace.selected_intent).toBe('precision_lookup');
    expect(trace.scope_gate_policy).toBe('deny');
    expect(trace.scope_gate_reason).toBe('unsupported_scope_intent');
    expect(trace.derived_consulted).toEqual([]);
    expect(trace.write_outcome).toBe('no_durable_write');

    await engine.disconnect();
  });

  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl) {
    test('postgres upgrades pre-trace-fidelity traces and backfills structured gate fields', async () => {
      const engine = new PostgresEngine();
      const schemaName = `trace_fidelity_${crypto.randomUUID().replace(/-/g, '_')}`;

      await engine.connect({ engine: 'postgres', database_url: databaseUrl, poolSize: 1 });
      await engine.sql.unsafe(`CREATE SCHEMA "${schemaName}"`);
      await engine.sql.unsafe(`SET search_path TO "${schemaName}", public`);

      try {
        await engine.sql.unsafe(`
          CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
          INSERT INTO config (key, value) VALUES ('version', '22');
          CREATE TABLE task_threads (
            id TEXT PRIMARY KEY,
            scope TEXT NOT NULL,
            title TEXT NOT NULL,
            goal TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL,
            repo_path TEXT,
            branch_name TEXT,
            current_summary TEXT NOT NULL DEFAULT '',
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
          );
          CREATE TABLE retrieval_traces (
            id TEXT PRIMARY KEY,
            task_id TEXT REFERENCES task_threads(id) ON DELETE SET NULL,
            scope TEXT NOT NULL,
            route JSONB NOT NULL DEFAULT '[]',
            source_refs JSONB NOT NULL DEFAULT '[]',
            verification JSONB NOT NULL DEFAULT '[]',
            outcome TEXT NOT NULL DEFAULT '',
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
          );
          INSERT INTO task_threads (id, scope, title, status)
          VALUES ('legacy-task', 'work', 'Legacy trace', 'active');
          INSERT INTO retrieval_traces (id, task_id, scope, route, source_refs, verification, outcome)
          VALUES (
            'legacy-trace',
            'legacy-task',
            'personal',
            '[]'::jsonb,
            '[]'::jsonb,
            '["intent:precision_lookup","scope_gate:deny","scope_gate_reason:unsupported_scope_intent"]'::jsonb,
            'precision_lookup route unavailable'
          );
        `);

        await engine.initSchema();

        const trace = (await engine.listRetrievalTraces('legacy-task', { limit: 1 }))[0]!;
        expect(trace.selected_intent).toBe('precision_lookup');
        expect(trace.scope_gate_policy).toBe('deny');
        expect(trace.scope_gate_reason).toBe('unsupported_scope_intent');
        expect(trace.derived_consulted).toEqual([]);
        expect(trace.write_outcome).toBe('no_durable_write');
      } finally {
        await engine.sql.unsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
        await engine.disconnect();
      }
    });
  } else {
    test.skip('postgres trace-fidelity migration coverage skipped: DATABASE_URL is not configured', () => {});
  }
});
