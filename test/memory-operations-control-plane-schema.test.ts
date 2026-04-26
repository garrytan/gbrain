import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { LATEST_VERSION } from '../src/core/migrate.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';

const MUTATION_EVENT_COLUMNS = [
  'id',
  'session_id',
  'realm_id',
  'actor',
  'operation',
  'target_kind',
  'target_id',
  'scope_id',
  'source_refs',
  'expected_target_snapshot_hash',
  'current_target_snapshot_hash',
  'result',
  'conflict_info',
  'dry_run',
  'metadata',
  'redaction_visibility',
  'created_at',
  'decided_at',
  'applied_at',
];

const MUTATION_EVENT_INDEXES = [
  'idx_memory_mutation_events_session_created',
  'idx_memory_mutation_events_realm_created',
  'idx_memory_mutation_events_actor_created',
  'idx_memory_mutation_events_operation_created',
  'idx_memory_mutation_events_target',
  'idx_memory_mutation_events_result_created',
  'idx_memory_mutation_events_scope_created',
];

const MEMORY_SESSION_COLUMNS = [
  'id',
  'task_id',
  'status',
  'actor_ref',
  'created_at',
  'closed_at',
  'expires_at',
];

const REDACTION_PLAN_COLUMNS = [
  'id',
  'scope_id',
  'query',
  'replacement_text',
  'status',
  'requested_by',
  'review_reason',
  'created_at',
  'reviewed_at',
  'applied_at',
];

const REDACTION_PLAN_ITEM_COLUMNS = [
  'id',
  'plan_id',
  'target_object_type',
  'target_object_id',
  'field_path',
  'before_hash',
  'after_hash',
  'status',
  'preview_text',
  'created_at',
  'updated_at',
];

function validInsertSql(id: string): string {
  return `
    INSERT INTO memory_mutation_events (
      id,
      session_id,
      realm_id,
      actor,
      operation,
      target_kind,
      target_id,
      scope_id,
      source_refs,
      result,
      dry_run,
      redaction_visibility
    ) VALUES (
      '${id}',
      'session-1',
      'work',
      'agent:test',
      'put_page',
      'page',
      'concepts/phase-9.md',
      'workspace:default',
      '["Source: schema contract test"]'::jsonb,
      'applied',
      false,
      'visible'
    )
  `;
}

function realmUpsertInsertSql(id: string): string {
  return validInsertSql(id)
    .replace("'put_page'", "'upsert_memory_realm'")
    .replace("'page'", "'memory_realm'")
    .replace("'concepts/phase-9.md'", "'realm:work'")
    .replace("'workspace:default'", "'work'");
}

function sqliteSql(sql: string): string {
  return sql.replaceAll('::jsonb', '').replaceAll('false', '0').replaceAll('true', '1');
}

function invalidInsertSql(column: string, value: string): string {
  return `
    INSERT INTO memory_mutation_events (
      id,
      session_id,
      realm_id,
      actor,
      operation,
      target_kind,
      target_id,
      source_refs,
      result,
      dry_run,
      redaction_visibility
    ) VALUES (
      '${column}-${value}',
      'session-1',
      'work',
      'agent:test',
      ${column === 'operation' ? `'${value}'` : "'put_page'"},
      ${column === 'target_kind' ? `'${value}'` : "'page'"},
      'concepts/phase-9.md',
      '["Source: invalid schema contract test"]'::jsonb,
      ${column === 'result' ? `'${value}'` : "'applied'"},
      ${column === 'dry_run' ? value : 'false'},
      ${column === 'redaction_visibility' ? `'${value}'` : "'visible'"}
    )
  `;
}

function missingSourceRefsSql(id: string): string {
  return validInsertSql(id).replace(
    `
      source_refs,
`,
    '',
  ).replace(
    `
      '["Source: schema contract test"]'::jsonb,
`,
    '',
  );
}

function emptySourceRefsSql(id: string): string {
  return validInsertSql(id).replace("'[\"Source: schema contract test\"]'::jsonb", "'[]'::jsonb");
}

function invalidSourceRefsSql(id: string, sourceRefsJson: string): string {
  return validInsertSql(id).replace("'[\"Source: schema contract test\"]'::jsonb", `'${sourceRefsJson}'::jsonb`);
}

function emptyTargetIdSql(id: string): string {
  return validInsertSql(id).replace("'concepts/phase-9.md'", "''");
}

function targetIdSql(id: string, targetIdExpression: string): string {
  return validInsertSql(id).replace("'concepts/phase-9.md'", targetIdExpression);
}

function dryRunMismatchSql(id: string, result: 'dry_run' | 'applied', dryRun: 'true' | 'false'): string {
  return validInsertSql(id)
    .replace("'applied'", `'${result}'`)
    .replace('false', dryRun);
}

function expectSqliteMutationEventRequiredContract(db: any): void {
  expect(() => db.query(sqliteSql(missingSourceRefsSql('sqlite-missing-source-refs'))).run()).toThrow();
  expect(() => db.query(sqliteSql(emptySourceRefsSql('sqlite-empty-source-refs'))).run()).toThrow();
  expect(() => db.query(sqliteSql(invalidSourceRefsSql('sqlite-blank-source-ref', '["   "]'))).run()).toThrow();
  expect(() => db.query(sqliteSql(invalidSourceRefsSql('sqlite-null-source-ref', '[null]'))).run()).toThrow();
  expect(() => db.query(sqliteSql(invalidSourceRefsSql('sqlite-number-source-ref', '[123]'))).run()).toThrow();
  expect(() => db.query(sqliteSql(invalidSourceRefsSql('sqlite-object-source-ref', '[{}]'))).run()).toThrow();
  expect(() => db.query(sqliteSql(invalidSourceRefsSql('sqlite-tab-source-ref', '["\\t"]'))).run()).toThrow();
  expect(() => db.query(sqliteSql(invalidSourceRefsSql('sqlite-newline-source-ref', '["\\n"]'))).run()).toThrow();
  expect(() => db.query(sqliteSql(invalidSourceRefsSql('sqlite-nbsp-source-ref', '["\\u00A0"]'))).run()).toThrow();
  expect(() => db.query(sqliteSql(emptyTargetIdSql('sqlite-empty-target-id'))).run()).toThrow();
  expect(() => db.query(sqliteSql(targetIdSql('sqlite-tab-target-id', 'char(9)'))).run()).toThrow();
  expect(() => db.query(sqliteSql(targetIdSql('sqlite-newline-target-id', 'char(10)'))).run()).toThrow();
  expect(() => db.query(sqliteSql(targetIdSql('sqlite-nbsp-target-id', 'char(160)'))).run()).toThrow();
  expect(() => db.query(sqliteSql(dryRunMismatchSql('sqlite-dry-mismatch-a', 'dry_run', 'false'))).run()).toThrow();
  expect(() => db.query(sqliteSql(dryRunMismatchSql('sqlite-dry-mismatch-b', 'applied', 'true'))).run()).toThrow();
}

async function expectPgMutationEventRequiredContract(db: { query: (sql: string) => Promise<unknown> }): Promise<void> {
  await expect(db.query(missingSourceRefsSql('pg-missing-source-refs'))).rejects.toThrow();
  await expect(db.query(emptySourceRefsSql('pg-empty-source-refs'))).rejects.toThrow();
  await expect(db.query(invalidSourceRefsSql('pg-blank-source-ref', '["   "]'))).rejects.toThrow();
  await expect(db.query(invalidSourceRefsSql('pg-null-source-ref', '[null]'))).rejects.toThrow();
  await expect(db.query(invalidSourceRefsSql('pg-number-source-ref', '[123]'))).rejects.toThrow();
  await expect(db.query(invalidSourceRefsSql('pg-object-source-ref', '[{}]'))).rejects.toThrow();
  await expect(db.query(invalidSourceRefsSql('pg-tab-source-ref', '["\\t"]'))).rejects.toThrow();
  await expect(db.query(invalidSourceRefsSql('pg-newline-source-ref', '["\\n"]'))).rejects.toThrow();
  await expect(db.query(invalidSourceRefsSql('pg-nbsp-source-ref', '["\\u00A0"]'))).rejects.toThrow();
  await expect(db.query(emptyTargetIdSql('pg-empty-target-id'))).rejects.toThrow();
  await expect(db.query(targetIdSql('pg-tab-target-id', 'chr(9)'))).rejects.toThrow();
  await expect(db.query(targetIdSql('pg-newline-target-id', 'chr(10)'))).rejects.toThrow();
  await expect(db.query(targetIdSql('pg-nbsp-target-id', 'chr(160)'))).rejects.toThrow();
  await expect(db.query(dryRunMismatchSql('pg-dry-mismatch-a', 'dry_run', 'false'))).rejects.toThrow();
  await expect(db.query(dryRunMismatchSql('pg-dry-mismatch-b', 'applied', 'true'))).rejects.toThrow();
}

const OLD_V26_POSTGRES_MUTATION_EVENT_SQL = `
  CREATE TABLE memory_mutation_events (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    realm_id TEXT NOT NULL,
    actor TEXT NOT NULL,
    operation TEXT NOT NULL,
    target_kind TEXT NOT NULL CHECK (
      target_kind IN (
        'page',
        'source_record',
        'task_thread',
        'working_set',
        'task_event',
        'task_episode',
        'attempt',
        'decision',
        'procedure',
        'memory_candidate',
        'memory_patch_candidate',
        'profile_memory',
        'personal_episode',
        'context_map',
        'context_atlas',
        'file_artifact',
        'export_artifact',
        'ledger_event'
      )
    ),
    target_id TEXT,
    scope_id TEXT,
    source_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
    expected_target_snapshot_hash TEXT,
    current_target_snapshot_hash TEXT,
    result TEXT NOT NULL CHECK (
      result IN (
        'dry_run',
        'staged_for_review',
        'applied',
        'conflict',
        'denied',
        'failed',
        'redacted'
      )
    ),
    conflict_info JSONB,
    dry_run BOOLEAN NOT NULL DEFAULT false,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    redaction_visibility TEXT NOT NULL DEFAULT 'visible' CHECK (
      redaction_visibility IN ('visible', 'partially_redacted', 'tombstoned')
    ),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    decided_at TIMESTAMPTZ,
    applied_at TIMESTAMPTZ
  );
  CREATE INDEX idx_memory_mutation_events_session_created
    ON memory_mutation_events(session_id, created_at DESC, id DESC);
  CREATE INDEX idx_memory_mutation_events_realm_created
    ON memory_mutation_events(realm_id, created_at DESC, id DESC);
  CREATE INDEX idx_memory_mutation_events_actor_created
    ON memory_mutation_events(actor, created_at DESC, id DESC);
  CREATE INDEX idx_memory_mutation_events_operation_created
    ON memory_mutation_events(operation, created_at DESC, id DESC);
  CREATE INDEX idx_memory_mutation_events_target
    ON memory_mutation_events(target_kind, target_id);
  CREATE INDEX idx_memory_mutation_events_result_created
    ON memory_mutation_events(result, created_at DESC, id DESC);
  CREATE INDEX idx_memory_mutation_events_scope_created
    ON memory_mutation_events(scope_id, created_at DESC, id DESC);
  INSERT INTO memory_mutation_events (
    id, session_id, realm_id, actor, operation, target_kind, target_id, scope_id, source_refs, result
  ) VALUES (
    'old-v26-valid', 'session-1', 'work', 'agent:test', 'put_page', 'page', '  concepts/phase-9.md  ', 'workspace:default', '["Source: old v26 contract test"]', 'applied'
  );
`;

const OLD_V26_SQLITE_MUTATION_EVENT_SQL = OLD_V26_POSTGRES_MUTATION_EVENT_SQL
  .replaceAll('JSONB', 'TEXT')
  .replaceAll(" DEFAULT '[]'::jsonb", " DEFAULT '[]'")
  .replaceAll(" DEFAULT '{}'::jsonb", " DEFAULT '{}'")
  .replaceAll('BOOLEAN NOT NULL DEFAULT false', 'INTEGER NOT NULL DEFAULT 0 CHECK (dry_run IN (0, 1))')
  .replaceAll('TIMESTAMPTZ NOT NULL DEFAULT now()', "TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))")
  .replaceAll('TIMESTAMPTZ', 'TEXT');

const OLD_V31_POSTGRES_MEMORY_SESSION_SQL = `
  CREATE TABLE memory_sessions (
    id TEXT PRIMARY KEY,
    task_id TEXT,
    status TEXT NOT NULL CHECK (status IN ('active', 'closed')),
    actor_ref TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    closed_at TIMESTAMPTZ
  );
  INSERT INTO memory_sessions (id, task_id, status, actor_ref)
  VALUES ('old-v31-session', 'task-v31', 'active', 'agent:v31');
`;

const OLD_V31_SQLITE_MEMORY_SESSION_SQL = OLD_V31_POSTGRES_MEMORY_SESSION_SQL
  .replaceAll('TIMESTAMPTZ NOT NULL DEFAULT now()', "TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))")
  .replaceAll('TIMESTAMPTZ', 'TEXT');

describe('memory operations control-plane schema', () => {
  const tempPaths: string[] = [];

  afterEach(async () => {
    while (tempPaths.length > 0) {
      rmSync(tempPaths.pop()!, { recursive: true, force: true });
    }
  });

  test('sqlite initSchema creates memory session expiry contract', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mbrain-memory-session-sqlite-'));
    tempPaths.push(dir);

    const engine = new SQLiteEngine();
    await engine.connect({ engine: 'sqlite', database_path: join(dir, 'brain.db') });
    await engine.initSchema();

    const db = (engine as any).database;
    const table = db
      .query(
        `SELECT name, sql
         FROM sqlite_master
         WHERE type = 'table'
           AND name = 'memory_sessions'`,
      )
      .get() as { name: string; sql: string } | null;

    expect(table?.name).toBe('memory_sessions');
    expect(table?.sql).toContain("status TEXT NOT NULL CHECK (status IN ('active', 'expired', 'closed'))");
    expect(table?.sql).toContain('expires_at TEXT');

    const columns = db.query(`PRAGMA table_info(memory_sessions)`).all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual(MEMORY_SESSION_COLUMNS);

    expect(() => db.query(`
      INSERT INTO memory_sessions (id, status, expires_at)
      VALUES ('sqlite-expired-valid', 'expired', '2000-01-01T00:00:00.000Z')
    `).run()).not.toThrow();
    expect(() => db.query(`
      INSERT INTO memory_sessions (id, status)
      VALUES ('sqlite-revoked-invalid', 'revoked')
    `).run()).toThrow();

    await engine.disconnect();
  });

  test('pglite initSchema creates memory session expiry contract', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mbrain-memory-session-pglite-'));
    tempPaths.push(dir);

    const engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite', database_path: dir });
    await engine.initSchema();

    const db = (engine as any).db;
    const columns = await db.query(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'memory_sessions'
       ORDER BY ordinal_position`,
    );
    expect(columns.rows.map((row: { column_name: string }) => row.column_name)).toEqual(MEMORY_SESSION_COLUMNS);

    const constraints = await db.query(
      `SELECT pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
       WHERE conrelid = 'memory_sessions'::regclass
         AND contype = 'c'`,
    );
    expect(String(constraints.rows.map((row: { definition: string }) => row.definition).join('\n'))).toContain('expired');
    await expect(db.query(`
      INSERT INTO memory_sessions (id, status, expires_at)
      VALUES ('pglite-expired-valid', 'expired', '2000-01-01T00:00:00.000Z')
    `)).resolves.toBeDefined();
    await expect(db.query(`
      INSERT INTO memory_sessions (id, status)
      VALUES ('pglite-revoked-invalid', 'revoked')
    `)).rejects.toThrow();

    await engine.disconnect();
  }, 10_000);

  test('sqlite initSchema creates redaction plan tables', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mbrain-redaction-plan-sqlite-'));
    tempPaths.push(dir);

    const engine = new SQLiteEngine();
    await engine.connect({ engine: 'sqlite', database_path: join(dir, 'brain.db') });
    await engine.initSchema();

    const db = (engine as any).database;
    const planTable = db
      .query(
        `SELECT name, sql
         FROM sqlite_master
         WHERE type = 'table'
           AND name = 'memory_redaction_plans'`,
      )
      .get() as { name: string; sql: string } | null;
    const itemTable = db
      .query(
        `SELECT name, sql
         FROM sqlite_master
         WHERE type = 'table'
           AND name = 'memory_redaction_plan_items'`,
      )
      .get() as { name: string; sql: string } | null;

    expect(planTable?.name).toBe('memory_redaction_plans');
    expect(planTable?.sql).toContain("status TEXT NOT NULL CHECK (status IN ('draft', 'approved', 'applied', 'rejected'))");
    expect(itemTable?.name).toBe('memory_redaction_plan_items');
    expect(itemTable?.sql).toContain("status TEXT NOT NULL CHECK (status IN ('planned', 'applied', 'unsupported'))");

    const planColumns = db.query(`PRAGMA table_info(memory_redaction_plans)`).all() as Array<{ name: string }>;
    const itemColumns = db.query(`PRAGMA table_info(memory_redaction_plan_items)`).all() as Array<{ name: string }>;
    expect(planColumns.map((column) => column.name)).toEqual(REDACTION_PLAN_COLUMNS);
    expect(itemColumns.map((column) => column.name)).toEqual(REDACTION_PLAN_ITEM_COLUMNS);

    expect(() => db.query(`
      INSERT INTO memory_redaction_plans (id, scope_id, query, status)
      VALUES ('sqlite-redaction-valid', 'workspace:default', 'secret', 'draft')
    `).run()).not.toThrow();
    expect(() => db.query(`
      INSERT INTO memory_redaction_plans (id, scope_id, query, status)
      VALUES ('sqlite-redaction-invalid', 'workspace:default', 'secret', 'queued')
    `).run()).toThrow();

    await engine.disconnect();
  });

  test('pglite initSchema creates redaction plan tables', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mbrain-redaction-plan-pglite-'));
    tempPaths.push(dir);

    const engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite', database_path: dir });
    await engine.initSchema();

    const db = (engine as any).db;
    const columns = await db.query(
      `SELECT table_name, column_name
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name IN ('memory_redaction_plans', 'memory_redaction_plan_items')
       ORDER BY table_name, ordinal_position`,
    );
    const planColumns = columns.rows
      .filter((row: { table_name: string }) => row.table_name === 'memory_redaction_plans')
      .map((row: { column_name: string }) => row.column_name);
    const itemColumns = columns.rows
      .filter((row: { table_name: string }) => row.table_name === 'memory_redaction_plan_items')
      .map((row: { column_name: string }) => row.column_name);
    expect(planColumns).toEqual(REDACTION_PLAN_COLUMNS);
    expect(itemColumns).toEqual(REDACTION_PLAN_ITEM_COLUMNS);

    const indexes = await db.query(
      `SELECT indexname
       FROM pg_indexes
       WHERE schemaname = 'public'
         AND tablename IN ('memory_redaction_plans', 'memory_redaction_plan_items')`,
    );
    expect(indexes.rows.map((row: { indexname: string }) => row.indexname)).toContain(
      'idx_memory_redaction_plans_scope_status',
    );
    expect(indexes.rows.map((row: { indexname: string }) => row.indexname)).toContain(
      'idx_memory_redaction_items_plan',
    );
    expect(indexes.rows.map((row: { indexname: string }) => row.indexname)).toContain(
      'idx_memory_redaction_items_target',
    );

    await expect(db.query(`
      INSERT INTO memory_redaction_plans (id, scope_id, query, status)
      VALUES ('pglite-redaction-valid', 'workspace:default', 'secret', 'draft')
    `)).resolves.toBeDefined();
    await expect(db.query(`
      INSERT INTO memory_redaction_plans (id, scope_id, query, status)
      VALUES ('pglite-redaction-invalid', 'workspace:default', 'secret', 'queued')
    `)).rejects.toThrow();

    await engine.disconnect();
  }, 10_000);

  test('sqlite upgrades version 33 databases to redaction plan tables', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mbrain-redaction-plan-sqlite-v33-'));
    tempPaths.push(dir);

    const engine = new SQLiteEngine();
    await engine.connect({ engine: 'sqlite', database_path: join(dir, 'brain.db') });
    const db = (engine as any).database;
    db.exec(`
      CREATE TABLE config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      INSERT INTO config (key, value) VALUES ('version', '33');
    `);

    await engine.initSchema();

    const version = db.query(`SELECT value FROM config WHERE key = 'version'`).get() as { value: string };
    const planTable = db.query(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table'
        AND name = 'memory_redaction_plans'
    `).get() as { name: string } | null;
    const itemTable = db.query(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table'
        AND name = 'memory_redaction_plan_items'
    `).get() as { name: string } | null;
    expect(Number(version.value)).toBeGreaterThan(33);
    expect(version.value).toBe(String(LATEST_VERSION));
    expect(planTable?.name).toBe('memory_redaction_plans');
    expect(itemTable?.name).toBe('memory_redaction_plan_items');

    await engine.disconnect();
  });

  test('pglite upgrades version 33 databases to redaction plan tables', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mbrain-redaction-plan-pglite-v33-'));
    tempPaths.push(dir);

    const engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite', database_path: dir });
    const db = (engine as any).db;
    await db.exec(`
      CREATE TABLE config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      INSERT INTO config (key, value) VALUES ('version', '33');
    `);

    await engine.initSchema();

    const version = await db.query(`SELECT value FROM config WHERE key = 'version'`);
    const tables = await db.query(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name IN ('memory_redaction_plans', 'memory_redaction_plan_items')
       ORDER BY table_name`,
    );
    expect(Number((version.rows[0] as { value: string }).value)).toBeGreaterThan(33);
    expect(version.rows).toEqual([{ value: String(LATEST_VERSION) }]);
    expect(tables.rows.map((row: { table_name: string }) => row.table_name)).toEqual([
      'memory_redaction_plan_items',
      'memory_redaction_plans',
    ]);

    await engine.disconnect();
  }, 10_000);

  test('sqlite initSchema creates memory mutation ledger contract', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mbrain-mutation-ledger-sqlite-'));
    tempPaths.push(dir);

    const engine = new SQLiteEngine();
    await engine.connect({ engine: 'sqlite', database_path: join(dir, 'brain.db') });
    await engine.initSchema();

    const db = (engine as any).database;
    const table = db
      .query(
        `SELECT name, sql
         FROM sqlite_master
         WHERE type = 'table'
           AND name = 'memory_mutation_events'`,
      )
      .get() as { name: string; sql: string } | null;

    expect(table?.name).toBe('memory_mutation_events');
    expect(table?.sql).toContain("operation TEXT NOT NULL CHECK");
    expect(table?.sql).toContain("target_kind TEXT NOT NULL CHECK");
    expect(table?.sql).toContain("result TEXT NOT NULL CHECK");
    expect(table?.sql).toContain("dry_run INTEGER NOT NULL DEFAULT 0 CHECK");
    expect(table?.sql).toContain("result = 'dry_run' AND dry_run = 1");
    expect(table?.sql).toContain("redaction_visibility TEXT NOT NULL DEFAULT 'visible' CHECK");

    const columns = db.query(`PRAGMA table_info(memory_mutation_events)`).all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual(MUTATION_EVENT_COLUMNS);

    const indexes = db
      .query(
        `SELECT name, sql
         FROM sqlite_master
         WHERE type = 'index'
           AND tbl_name = 'memory_mutation_events'`,
      )
      .all() as Array<{ name: string; sql: string }>;
    const indexNames = indexes.map((row) => row.name);
    for (const indexName of MUTATION_EVENT_INDEXES) {
      expect(indexNames).toContain(indexName);
    }
    const scopeIndex = indexes.find((row) => row.name === 'idx_memory_mutation_events_scope_created');
    expect(scopeIndex?.sql).toContain('WHERE scope_id IS NOT NULL');

    expect(() => db.query(sqliteSql(validInsertSql('sqlite-valid'))).run()).not.toThrow();
    expect(() => db.query(sqliteSql(realmUpsertInsertSql('sqlite-realm-upsert-valid'))).run()).not.toThrow();
    expect(() => db.query(sqliteSql(invalidInsertSql('operation', 'invented_operation'))).run()).toThrow();
    expect(() => db.query(sqliteSql(invalidInsertSql('result', 'approved'))).run()).toThrow();
    expect(() => db.query(sqliteSql(invalidInsertSql('target_kind', 'note'))).run()).toThrow();
    expect(() => db.query(sqliteSql(invalidInsertSql('redaction_visibility', 'hidden'))).run()).toThrow();
    expect(() => db.query(sqliteSql(invalidInsertSql('dry_run', '2'))).run()).toThrow();
    expectSqliteMutationEventRequiredContract(db);

    await engine.disconnect();
  });

  test('pglite initSchema creates memory mutation ledger contract', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mbrain-mutation-ledger-pglite-'));
    tempPaths.push(dir);

    const engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite', database_path: dir });
    await engine.initSchema();

    const db = (engine as any).db;
    const tables = await db.query(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = 'memory_mutation_events'`,
    );
    expect(tables.rows.map((row: { table_name: string }) => row.table_name)).toEqual([
      'memory_mutation_events',
    ]);

    const columns = await db.query(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'memory_mutation_events'
       ORDER BY ordinal_position`,
    );
    expect(columns.rows.map((row: { column_name: string }) => row.column_name)).toEqual(MUTATION_EVENT_COLUMNS);

    const indexes = await db.query(
      `SELECT indexname
       FROM pg_indexes
       WHERE schemaname = 'public'
         AND tablename = 'memory_mutation_events'`,
    );
    const indexNames = indexes.rows.map((row: { indexname: string }) => row.indexname);
    for (const indexName of MUTATION_EVENT_INDEXES) {
      expect(indexNames).toContain(indexName);
    }

    const operationConstraints = await db.query(
      `SELECT conname
       FROM pg_constraint
       WHERE conrelid = 'memory_mutation_events'::regclass
         AND contype = 'c'
         AND pg_get_constraintdef(oid) LIKE '%operation%'
       ORDER BY conname`,
    );
    expect(operationConstraints.rows.map((row: { conname: string }) => row.conname)).toEqual([
      'chk_memory_mutation_events_operation',
    ]);

    await expect(db.query(validInsertSql('pglite-valid'))).resolves.toBeDefined();
    await expect(db.query(realmUpsertInsertSql('pglite-realm-upsert-valid'))).resolves.toBeDefined();
    await expect(db.query(invalidInsertSql('operation', 'invented_operation'))).rejects.toThrow();
    await expect(db.query(invalidInsertSql('result', 'approved'))).rejects.toThrow();
    await expect(db.query(invalidInsertSql('target_kind', 'note'))).rejects.toThrow();
    await expect(db.query(invalidInsertSql('redaction_visibility', 'hidden'))).rejects.toThrow();
    await expect(db.query(invalidInsertSql('dry_run', '2'))).rejects.toThrow();
    await expectPgMutationEventRequiredContract(db);

    await engine.disconnect();
  }, 10_000);

  test('sqlite upgrades version 31 memory sessions to expiry contract', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mbrain-memory-session-sqlite-v31-expiry-'));
    tempPaths.push(dir);

    const engine = new SQLiteEngine();
    await engine.connect({ engine: 'sqlite', database_path: join(dir, 'brain.db') });
    const db = (engine as any).database;
    db.exec(`
      CREATE TABLE config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      INSERT INTO config (key, value) VALUES ('version', '31');
      ${OLD_V31_SQLITE_MEMORY_SESSION_SQL}
    `);

    await engine.initSchema();

    const version = db.query(`SELECT value FROM config WHERE key = 'version'`).get() as { value: string };
    const columns = db.query(`PRAGMA table_info(memory_sessions)`).all() as Array<{ name: string }>;
    const existing = db
      .query(`SELECT id, task_id, status, actor_ref, expires_at FROM memory_sessions WHERE id = 'old-v31-session'`)
      .get() as Record<string, unknown> | null;

    expect(version.value).toBe(String(LATEST_VERSION));
    expect(columns.map((column) => column.name)).toEqual(MEMORY_SESSION_COLUMNS);
    expect(existing).toEqual({
      id: 'old-v31-session',
      task_id: 'task-v31',
      status: 'active',
      actor_ref: 'agent:v31',
      expires_at: null,
    });
    expect(() => db.query(`UPDATE memory_sessions SET status = 'expired' WHERE id = 'old-v31-session'`).run()).not.toThrow();
    expect(() => db.query(`UPDATE memory_sessions SET status = 'revoked' WHERE id = 'old-v31-session'`).run()).toThrow();

    await engine.disconnect();
  });

  test('pglite upgrades version 31 memory sessions to expiry contract', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mbrain-memory-session-pglite-v31-expiry-'));
    tempPaths.push(dir);

    const engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite', database_path: dir });
    const db = (engine as any).db;
    await db.exec(`
      CREATE TABLE config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      INSERT INTO config (key, value) VALUES ('version', '31');
      ${OLD_V31_POSTGRES_MEMORY_SESSION_SQL}
    `);

    await engine.initSchema();

    const version = await db.query(`SELECT value FROM config WHERE key = 'version'`);
    const columns = await db.query(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'memory_sessions'
       ORDER BY ordinal_position`,
    );
    const existing = await db.query(
      `SELECT id, task_id, status, actor_ref, expires_at
       FROM memory_sessions
       WHERE id = 'old-v31-session'`,
    );

    expect(version.rows).toEqual([{ value: String(LATEST_VERSION) }]);
    expect(columns.rows.map((row: { column_name: string }) => row.column_name)).toEqual(MEMORY_SESSION_COLUMNS);
    expect(existing.rows).toEqual([{
      id: 'old-v31-session',
      task_id: 'task-v31',
      status: 'active',
      actor_ref: 'agent:v31',
      expires_at: null,
    }]);
    await expect(db.query(`UPDATE memory_sessions SET status = 'expired' WHERE id = 'old-v31-session'`)).resolves.toBeDefined();
    await expect(db.query(`UPDATE memory_sessions SET status = 'revoked' WHERE id = 'old-v31-session'`)).rejects.toThrow();

    await engine.disconnect();
  }, 10_000);

  test('sqlite upgrades version 29 databases to accept memory realm upsert ledger events', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mbrain-mutation-ledger-sqlite-v29-realm-upsert-'));
    tempPaths.push(dir);

    const engine = new SQLiteEngine();
    await engine.connect({ engine: 'sqlite', database_path: join(dir, 'brain.db') });
    const db = (engine as any).database;
    db.exec(`
      CREATE TABLE config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      INSERT INTO config (key, value) VALUES ('version', '29');
      ${OLD_V26_SQLITE_MUTATION_EVENT_SQL}
    `);

    await engine.initSchema();

    const version = db.query(`SELECT value FROM config WHERE key = 'version'`).get() as { value: string };
    expect(version.value).toBe(String(LATEST_VERSION));
    expect(() => db.query(sqliteSql(realmUpsertInsertSql('sqlite-v29-realm-upsert-valid'))).run()).not.toThrow();
    expect(() => db.query(sqliteSql(invalidInsertSql('operation', 'invented_operation'))).run()).toThrow();
    expect(() => db.query(sqliteSql(invalidInsertSql('target_kind', 'note'))).run()).toThrow();

    await engine.disconnect();
  });

  test('pglite upgrades version 29 databases to accept memory realm upsert ledger events', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mbrain-mutation-ledger-pglite-v29-realm-upsert-'));
    tempPaths.push(dir);

    const engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite', database_path: dir });
    const db = (engine as any).db;
    await db.exec(`
      CREATE TABLE config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      INSERT INTO config (key, value) VALUES ('version', '29');
      ${OLD_V26_POSTGRES_MUTATION_EVENT_SQL}
    `);

    await engine.initSchema();

    const version = await db.query(`SELECT value FROM config WHERE key = 'version'`);
    expect(version.rows).toEqual([{ value: String(LATEST_VERSION) }]);
    await expect(db.query(realmUpsertInsertSql('pglite-v29-realm-upsert-valid'))).resolves.toBeDefined();
    await expect(db.query(invalidInsertSql('operation', 'invented_operation'))).rejects.toThrow();
    await expect(db.query(invalidInsertSql('target_kind', 'note'))).rejects.toThrow();

    await engine.disconnect();
  }, 10_000);

  test('sqlite upgrades version 25 databases to memory mutation ledger contract', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mbrain-mutation-ledger-sqlite-upgrade-'));
    tempPaths.push(dir);

    const engine = new SQLiteEngine();
    await engine.connect({ engine: 'sqlite', database_path: join(dir, 'brain.db') });
    const db = (engine as any).database;
    db.exec(`
      CREATE TABLE config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      INSERT INTO config (key, value) VALUES ('version', '25');
    `);

    await engine.initSchema();

    const table = db
      .query(
        `SELECT name
         FROM sqlite_master
         WHERE type = 'table'
           AND name = 'memory_mutation_events'`,
      )
      .get() as { name: string } | null;
    const version = db.query(`SELECT value FROM config WHERE key = 'version'`).get() as { value: string };

    expect(table?.name).toBe('memory_mutation_events');
    expect(version.value).toBe(String(LATEST_VERSION));

    await engine.disconnect();
  });

  test('pglite upgrades version 25 databases to memory mutation ledger contract', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mbrain-mutation-ledger-pglite-upgrade-'));
    tempPaths.push(dir);

    const engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite', database_path: dir });
    const db = (engine as any).db;
    await db.exec(`
      CREATE TABLE config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      INSERT INTO config (key, value) VALUES ('version', '25');
    `);

    await engine.initSchema();

    const tables = await db.query(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = 'memory_mutation_events'`,
    );
    const version = await db.query(`SELECT value FROM config WHERE key = 'version'`);

    expect(tables.rows.map((row: { table_name: string }) => row.table_name)).toEqual([
      'memory_mutation_events',
    ]);
    expect(version.rows).toEqual([{ value: String(LATEST_VERSION) }]);

    await engine.disconnect();
  }, 10_000);

  test('sqlite repairs old version 26 memory mutation ledger operation contract', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mbrain-mutation-ledger-sqlite-v26-repair-'));
    tempPaths.push(dir);

    const engine = new SQLiteEngine();
    await engine.connect({ engine: 'sqlite', database_path: join(dir, 'brain.db') });
    const db = (engine as any).database;
    db.exec(`
      CREATE TABLE config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      INSERT INTO config (key, value) VALUES ('version', '26');
      ${OLD_V26_SQLITE_MUTATION_EVENT_SQL}
    `);

    await engine.initSchema();

    const version = db.query(`SELECT value FROM config WHERE key = 'version'`).get() as { value: string };
    const existing = db
      .query(`SELECT id, operation, target_id FROM memory_mutation_events WHERE id = 'old-v26-valid'`)
      .get() as { id: string; operation: string; target_id: string } | null;
    const scopeIndex = db
      .query(
        `SELECT sql
         FROM sqlite_master
         WHERE type = 'index'
           AND tbl_name = 'memory_mutation_events'
           AND name = 'idx_memory_mutation_events_scope_created'`,
      )
      .get() as { sql: string } | null;

    expect(version.value).toBe(String(LATEST_VERSION));
    expect(existing).toEqual({ id: 'old-v26-valid', operation: 'put_page', target_id: 'concepts/phase-9.md' });
    expect(scopeIndex?.sql).toContain('WHERE scope_id IS NOT NULL');
    expect(() => db.query(sqliteSql(invalidInsertSql('operation', 'invented_operation'))).run()).toThrow();
    expectSqliteMutationEventRequiredContract(db);

    await engine.disconnect();
  });

  test('pglite repairs old version 26 memory mutation ledger operation contract', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mbrain-mutation-ledger-pglite-v26-repair-'));
    tempPaths.push(dir);

    const engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite', database_path: dir });
    const db = (engine as any).db;
    await db.exec(`
      CREATE TABLE config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      INSERT INTO config (key, value) VALUES ('version', '26');
      ${OLD_V26_POSTGRES_MUTATION_EVENT_SQL}
    `);

    await engine.initSchema();

    const version = await db.query(`SELECT value FROM config WHERE key = 'version'`);
    const existing = await db.query(
      `SELECT id, operation, target_id
       FROM memory_mutation_events
       WHERE id = 'old-v26-valid'`,
    );
    const indexDefinitions = await db.query(
      `SELECT indexdef
       FROM pg_indexes
       WHERE schemaname = 'public'
         AND tablename = 'memory_mutation_events'
         AND indexname = 'idx_memory_mutation_events_scope_created'`,
    );

    expect(version.rows).toEqual([{ value: String(LATEST_VERSION) }]);
    expect(existing.rows).toEqual([{ id: 'old-v26-valid', operation: 'put_page', target_id: 'concepts/phase-9.md' }]);
    expect(String(indexDefinitions.rows[0]?.indexdef)).toContain('WHERE (scope_id IS NOT NULL)');
    await expect(db.query(invalidInsertSql('operation', 'invented_operation'))).rejects.toThrow();
    await expectPgMutationEventRequiredContract(db);

    await engine.disconnect();
  }, 10_000);

  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl) {
    test('postgres initSchema creates memory session expiry contract', async () => {
      const engine = new PostgresEngine();
      const schemaName = `memory_session_${crypto.randomUUID().replace(/-/g, '_')}`;

      await engine.connect({ engine: 'postgres', database_url: databaseUrl, poolSize: 1 });
      await engine.sql.unsafe(`CREATE SCHEMA "${schemaName}"`);
      await engine.sql.unsafe(`SET search_path TO "${schemaName}", public`);

      try {
        await engine.initSchema();

        const columns = await engine.sql`
          SELECT column_name
          FROM information_schema.columns
          WHERE table_schema = ${schemaName}
            AND table_name = 'memory_sessions'
          ORDER BY ordinal_position
        `;
        expect(columns.map((row) => row.column_name)).toEqual(MEMORY_SESSION_COLUMNS);

        const constraints = await engine.sql.unsafe(`
          SELECT pg_get_constraintdef(oid) AS definition
          FROM pg_constraint
          WHERE conrelid = '"${schemaName}"."memory_sessions"'::regclass
            AND contype = 'c'
        `);
        expect(String(constraints.map((row) => row.definition).join('\n'))).toContain('expired');
        await expect(engine.sql.unsafe(`
          INSERT INTO memory_sessions (id, status, expires_at)
          VALUES ('postgres-expired-valid', 'expired', '2000-01-01T00:00:00.000Z')
        `)).resolves.toBeDefined();
        await expect(engine.sql.unsafe(`
          INSERT INTO memory_sessions (id, status)
          VALUES ('postgres-revoked-invalid', 'revoked')
        `)).rejects.toThrow();
      } finally {
        await engine.sql.unsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
        await engine.disconnect();
      }
    }, 20_000);

    test('postgres initSchema creates memory mutation ledger contract', async () => {
      const engine = new PostgresEngine();
      const schemaName = `mutation_ledger_${crypto.randomUUID().replace(/-/g, '_')}`;

      await engine.connect({ engine: 'postgres', database_url: databaseUrl, poolSize: 1 });
      await engine.sql.unsafe(`CREATE SCHEMA "${schemaName}"`);
      await engine.sql.unsafe(`SET search_path TO "${schemaName}", public`);

      try {
        await engine.initSchema();

        const tables = await engine.sql`
          SELECT table_name
          FROM information_schema.tables
          WHERE table_schema = ${schemaName}
            AND table_name = 'memory_mutation_events'
        `;
        expect(tables.map((row) => row.table_name)).toEqual(['memory_mutation_events']);

        const columns = await engine.sql`
          SELECT column_name
          FROM information_schema.columns
          WHERE table_schema = ${schemaName}
            AND table_name = 'memory_mutation_events'
          ORDER BY ordinal_position
        `;
        expect(columns.map((row) => row.column_name)).toEqual(MUTATION_EVENT_COLUMNS);

        const indexes = await engine.sql`
          SELECT indexname
          FROM pg_indexes
          WHERE schemaname = ${schemaName}
            AND tablename = 'memory_mutation_events'
        `;
        const indexNames = indexes.map((row) => row.indexname);
        for (const indexName of MUTATION_EVENT_INDEXES) {
          expect(indexNames).toContain(indexName);
        }

        await expect(engine.sql.unsafe(validInsertSql('postgres-valid'))).resolves.toBeDefined();
        await expect(engine.sql.unsafe(realmUpsertInsertSql('postgres-realm-upsert-valid'))).resolves.toBeDefined();
        await expect(engine.sql.unsafe(invalidInsertSql('operation', 'invented_operation'))).rejects.toThrow();
        await expect(engine.sql.unsafe(invalidInsertSql('result', 'approved'))).rejects.toThrow();
        await expect(engine.sql.unsafe(invalidInsertSql('target_kind', 'note'))).rejects.toThrow();
        await expect(engine.sql.unsafe(invalidInsertSql('redaction_visibility', 'hidden'))).rejects.toThrow();
        await expect(engine.sql.unsafe(invalidInsertSql('dry_run', '2'))).rejects.toThrow();
        await expectPgMutationEventRequiredContract({ query: (sql) => engine.sql.unsafe(sql) });
      } finally {
        await engine.sql.unsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
        await engine.disconnect();
      }
    }, 20_000);
  } else {
    test.skip('postgres memory session expiry schema skipped: DATABASE_URL is not configured', () => {});
    test.skip('postgres memory mutation ledger schema skipped: DATABASE_URL is not configured', () => {});
  }
});
