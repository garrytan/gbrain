import { setDefaultTimeout, afterEach, beforeEach, describe, test, expect } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { LATEST_VERSION } from '../src/core/migrate.ts';

setDefaultTimeout(Number(process.env.TEST_TIMEOUT_MS ?? 20_000));

const originalEnv = { ...process.env };
const PGLITE_MIGRATION_TEST_TIMEOUT_MS = 45_000;
let tempHome = '';

function makeVector(...values: number[]): Float32Array {
  const vector = new Float32Array(1024);
  values.forEach((value, index) => {
    vector[index] = value;
  });
  return vector;
}

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'mbrain-migrate-test-'));
  process.env.HOME = tempHome;
  delete process.env.DATABASE_URL;
  delete process.env.MBRAIN_DATABASE_URL;
});

afterEach(() => {
  process.env = { ...originalEnv };
  rmSync(tempHome, { recursive: true, force: true });
});

describe('migrate', () => {
  test('LATEST_VERSION includes the qwen3 pgvector migration', () => {
    expect(typeof LATEST_VERSION).toBe('number');
    expect(LATEST_VERSION).toBeGreaterThan(6);
  });

  test('SQLite migration switch covers every Postgres migration version', () => {
    const migrateSource = readFileSync(
      new URL('../src/core/migrate.ts', import.meta.url),
      'utf-8',
    );
    const sqliteSource = readFileSync(
      new URL('../src/core/sqlite-engine.ts', import.meta.url),
      'utf-8',
    );
    const pgVersions = [...migrateSource.matchAll(/version:\s*(\d+)/g)]
      .map(match => Number(match[1]));
    const sqliteMigrationBody = sqliteSource.slice(sqliteSource.indexOf('private async runSqliteMigrations'));
    const sqliteCases = new Set([...sqliteMigrationBody.matchAll(/case\s+(\d+)\s*:/g)]
      .map(match => Number(match[1])));
    const missing = pgVersions.filter(version => version > 1 && !sqliteCases.has(version));

    expect(pgVersions.at(-1)).toBe(LATEST_VERSION);
    expect(missing).toEqual([]);
    expect(sqliteMigrationBody).toContain('SQLite migration ${version} is not implemented');
  });

  // Tables that legitimately exist on BOTH engines but whose column NAMES are allowed to
  // differ (engine-specific shape). Keep this list short and documented — every entry is a
  // deliberate divergence, not a parity bug. An empty list means every shared table must
  // expose identical column names on SQLite and PGLite.
  const PARITY_COLUMN_ALLOWLIST = new Set<string>([
    // Postgres/PGLite store a tsvector `search_vector` column on `pages` for full-text
    // search; SQLite uses a separate FTS5 virtual table (`pages_fts`) instead, so the
    // `pages` column sets legitimately differ by one column.
    'pages',
  ]);

  test('fresh SQLite and PGLite schemas expose matching columns for every shared table', async () => {
    const { SQLiteEngine } = await import('../src/core/sqlite-engine.ts');
    const { PGLiteEngine } = await import('../src/core/pglite-engine.ts');
    const sqlite = new SQLiteEngine();
    const pglite = new PGLiteEngine();
    const sqlitePath = join(tempHome, 'schema-parity.sqlite');
    const pglitePath = join(tempHome, 'schema-parity.pglite');
    try {
      await sqlite.connect({ engine: 'sqlite', database_path: sqlitePath });
      await sqlite.initSchema();
      await pglite.connect({ engine: 'pglite', database_path: pglitePath });
      await pglite.initSchema();
      const db = (sqlite as any).database;

      // Programmatic intersection of the two live schemas, so a column added to a SQLite
      // ensure-helper without the matching PGLite migration (or vice versa) fails parity for
      // ANY shared table — not just a hardcoded subset.
      const sqliteTables = (db.query(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
      ).all() as Array<{ name: string }>).map(row => row.name);
      const pgTables = (await (pglite as any).db.query(`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
        ORDER BY table_name
      `)).rows.map((row: { table_name: string }) => row.table_name);

      const pgTableSet = new Set<string>(pgTables);
      const sharedTables = sqliteTables
        .filter(name => pgTableSet.has(name))
        .filter(name => !PARITY_COLUMN_ALLOWLIST.has(name));

      // Guard against the intersection silently collapsing to nothing (e.g. an introspection
      // change), which would make the parity assertion vacuous.
      expect(sharedTables.length).toBeGreaterThanOrEqual(9);

      for (const table of sharedTables) {
        const sqliteColumns = (db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
          .map(column => column.name).sort();
        const pgColumns = ((await (pglite as any).db.query(`
          SELECT column_name
          FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1
        `, [table])).rows.map((row: { column_name: string }) => row.column_name) as string[]).sort();

        expect(pgColumns, `${table} should exist in PGLite`).not.toHaveLength(0);
        expect(sqliteColumns, `${table} columns diverge between SQLite and PGLite`).toEqual(pgColumns);
      }
    } finally {
      await sqlite.disconnect().catch(() => undefined);
      await pglite.disconnect().catch(() => undefined);
    }
  }, PGLITE_MIGRATION_TEST_TIMEOUT_MS);

  test('runMigrations is exported and callable', async () => {
    const { runMigrations } = await import('../src/core/migrate.ts');
    expect(typeof runMigrations).toBe('function');
  });

  test('runMigrations batches consecutive SQL-only migrations', async () => {
    const { runMigrations } = await import('../src/core/migrate.ts');
    const calls: string[] = [];
    const engine = {
      getConfig: async () => '25',
      transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
        calls.push('transaction');
        return fn(engine);
      },
      runMigration: async (version: number) => {
        calls.push(`migration:${version}`);
      },
      setConfig: async (_key: string, value: string) => {
        calls.push(`version:${value}`);
      },
    };

    const result = await runMigrations(engine as any);

    expect(result.current).toBe(LATEST_VERSION);
    expect(calls.filter(call => call === 'transaction')).toHaveLength(1);
    expect(calls).toContain('migration:26');
    expect(calls).toContain(`migration:${LATEST_VERSION}`);
    expect(calls).toContain(`version:${LATEST_VERSION}`);
  });

  test('freshSchemaMigrationSql can start after an embedded baseline version', async () => {
    const { freshSchemaMigrationSql } = await import('../src/core/migrate.ts');

    const sql = freshSchemaMigrationSql(25);

    expect(sql).toContain('CREATE TABLE IF NOT EXISTS memory_mutation_events');
    expect(sql).not.toContain('CREATE TABLE IF NOT EXISTS access_tokens');
  });

  test('postgres baseline schema uses qwen3-friendly dimensions and defaults', () => {
    const schemaSource = readFileSync(
      new URL('../src/schema.sql', import.meta.url),
      'utf-8',
    );

    expect(schemaSource).toContain('vector(1024)');
    expect(schemaSource).toContain('page_embedding vector(1024)');
    expect(schemaSource).toContain("'qwen3-embedding:0.6b'");
    expect(schemaSource).toContain("'embedding_dimensions', '1024'");
    expect(schemaSource).toContain("'chunk_size_tokens', '768'");
    expect(schemaSource).toContain("'chunk_overlap_tokens', '128'");
    expect(schemaSource).toContain("'chunk_strategy', 'qwen3_token_recursive'");
  });

  test('postgres HTTP surface prep matches v56 access token scope default repair', () => {
    const postgresEngineSource = readFileSync(
      new URL('../src/core/postgres-engine.ts', import.meta.url),
      'utf-8',
    );
    const prepBody = postgresEngineSource.slice(postgresEngineSource.indexOf('async prepareMcpHttpSurfaceSchema'));

    expect(prepBody).toContain('ADD COLUMN IF NOT EXISTS scopes TEXT[] DEFAULT ARRAY[\'mcp\']::TEXT[]');
    expect(prepBody).toContain('ALTER COLUMN scopes SET DEFAULT ARRAY[\'mcp\']::TEXT[]');
    expect(prepBody).toContain('UPDATE access_tokens SET scopes = ARRAY[\'mcp\']::TEXT[] WHERE scopes IS NULL');
  });

  test('v51 assertion scope indexes are applied by migration after adding scope columns', async () => {
    const schemaSource = readFileSync(
      new URL('../src/schema.sql', import.meta.url),
      'utf-8',
    );
    const embeddedSource = readFileSync(
      new URL('../src/core/schema-embedded.ts', import.meta.url),
      'utf-8',
    );
    const pgliteSchema = readFileSync(
      new URL('../src/core/pglite-schema.ts', import.meta.url),
      'utf-8',
    );
    const { freshSchemaMigrationSql } = await import('../src/core/migrate.ts');
    const v51Sql = freshSchemaMigrationSql(50);
    const v51IndexNames = [
      'idx_assertions_scope_target_property',
      'idx_assertion_evidence_scope_assertion',
      'idx_assertion_links_scope_from',
    ];

    for (const indexName of v51IndexNames) {
      expect(schemaSource).not.toContain(indexName);
      expect(embeddedSource).not.toContain(indexName);
      expect(pgliteSchema).not.toContain(indexName);
      expect(v51Sql).toContain(indexName);
    }

    expect(v51Sql).toContain('ADD COLUMN IF NOT EXISTS scope_id');
  });

  test('initSchema upgrades existing v50 assertion tables before creating v51 scope indexes', async () => {
    const { PGLiteEngine } = await import('../src/core/pglite-engine.ts');
    const engine = new PGLiteEngine();
    const targetPath = join(tempHome, 'v50-assertion-upgrade.pglite');
    let connected = false;

    try {
      await engine.connect({ engine: 'pglite', database_path: targetPath });
      connected = true;
      await engine.db.exec(`
        CREATE TABLE IF NOT EXISTS config (
          key   TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        INSERT INTO config (key, value) VALUES ('version', '50')
        ON CONFLICT (key) DO UPDATE SET value = excluded.value;

        CREATE TABLE IF NOT EXISTS assertions (
          id                         TEXT PRIMARY KEY,
          claim_type                 TEXT NOT NULL,
          target_type                TEXT NOT NULL,
          target_id                  TEXT NOT NULL,
          target_slug                TEXT,
          property                   TEXT NOT NULL,
          value_json                 JSONB NOT NULL,
          normalized_claim           TEXT NOT NULL,
          authority_summary          JSONB NOT NULL DEFAULT '{}',
          confidence                 REAL NOT NULL DEFAULT 0,
          evidence_count             INTEGER NOT NULL DEFAULT 0,
          authority_state            TEXT NOT NULL CHECK (authority_state IN ('unresolved', 'candidate', 'canonical', 'conflicted', 'rejected')),
          lifecycle_state            TEXT NOT NULL CHECK (lifecycle_state IN ('active', 'stale', 'expired', 'archived', 'purged')),
          valid_from                 TIMESTAMPTZ,
          valid_until                TIMESTAMPTZ,
          supersedes_assertion_id    TEXT,
          superseded_by_assertion_id TEXT,
          conflict_set_id            TEXT,
          created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now()
        );

        CREATE TABLE IF NOT EXISTS assertion_evidence (
          id                  TEXT PRIMARY KEY,
          assertion_id         TEXT NOT NULL REFERENCES assertions(id) ON DELETE CASCADE,
          extracted_claim_id   TEXT NOT NULL,
          source_id            TEXT NOT NULL,
          source_item_id       TEXT NOT NULL,
          source_chunk_id      TEXT NOT NULL,
          session_id           TEXT,
          task_event_id        TEXT,
          contribution_type    TEXT NOT NULL CHECK (contribution_type IN ('supports', 'contradicts', 'supersedes', 'superseded_by', 'context', 'audit_only')),
          evidence_authority   TEXT NOT NULL,
          evidence_confidence  REAL NOT NULL,
          valid_from           TIMESTAMPTZ,
          valid_until          TIMESTAMPTZ,
          revocation_state     TEXT NOT NULL DEFAULT 'active',
          forgetting_state     TEXT NOT NULL DEFAULT 'retained',
          created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
        );

        CREATE TABLE IF NOT EXISTS assertion_links (
          id                 TEXT PRIMARY KEY,
          from_assertion_id  TEXT NOT NULL REFERENCES assertions(id) ON DELETE CASCADE,
          to_assertion_id    TEXT NOT NULL REFERENCES assertions(id) ON DELETE CASCADE,
          link_type          TEXT NOT NULL,
          created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE(from_assertion_id, to_assertion_id, link_type)
        );
      `);

      await engine.initSchema();

      expect(await engine.getConfig('version')).toBe(String(LATEST_VERSION));
      const assertionColumns = await engine.db.query<{ column_name: string }>(`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_name = 'assertions'
      `);
      expect(assertionColumns.rows.map(row => row.column_name)).toContain('scope_id');

      const indexes = await engine.db.query<{ indexname: string }>(`
        SELECT indexname
        FROM pg_indexes
        WHERE tablename IN ('assertions', 'assertion_evidence', 'assertion_links')
      `);
      expect(indexes.rows.map(row => row.indexname)).toEqual(expect.arrayContaining([
        'idx_assertions_scope_target_property',
        'idx_assertion_evidence_scope_assertion',
        'idx_assertion_links_scope_from',
      ]));
    } finally {
      if (connected) {
        await engine.disconnect();
      }
    }
  }, PGLITE_MIGRATION_TEST_TIMEOUT_MS);

  test('generated schemas stay aligned on page_embedding', () => {
    const embeddedSource = readFileSync(
      new URL('../src/core/schema-embedded.ts', import.meta.url),
      'utf-8',
    );
    const pgliteSchema = readFileSync(
      new URL('../src/core/pglite-schema.ts', import.meta.url),
      'utf-8',
    );

    expect(embeddedSource).toContain('page_embedding vector(1024)');
    expect(pgliteSchema).toContain('page_embedding vector(1024)');
  });

  test('migration source includes the pgvector resize step', async () => {
    const migrateSource = readFileSync(
      new URL('../src/core/migrate.ts', import.meta.url),
      'utf-8',
    );

    expect(migrateSource).toContain('pgvector_768_for_nomic');
    expect(migrateSource).toContain('pgvector_1024_for_qwen3');
    expect(migrateSource).toContain('qwen3_token_chunk_defaults');
    expect(migrateSource).toContain('page_embedding_upgrade');
    expect(migrateSource).toContain('vector(1024)');
    expect(migrateSource).toContain("'chunk_size_tokens', '768'");
    expect(migrateSource).toContain("'chunk_overlap_tokens', '128'");
  });

  test('runMigrateEngine preserves page embeddings when migrating sqlite to pglite', async () => {
    const { saveConfig } = await import('../src/core/config.ts');
    const { runMigrateEngine } = await import('../src/commands/migrate-engine.ts');
    const { SQLiteEngine } = await import('../src/core/sqlite-engine.ts');
    const { PGLiteEngine } = await import('../src/core/pglite-engine.ts');

    process.env.MBRAIN_CONFIG_DIR = join(tempHome, 'custom-config');
    const sourcePath = join(tempHome, '.mbrain', 'source.db');
    const targetPath = join(tempHome, '.mbrain', 'target.pglite');
    const embedding = makeVector(1, 2, 3);

    saveConfig({
      engine: 'sqlite',
      database_path: sourcePath,
      offline: true,
      embedding_provider: 'local',
      query_rewrite_provider: 'heuristic',
    });

    const source = new SQLiteEngine();
    const target = new PGLiteEngine();
    let sourceConnected = false;
    let targetConnected = false;

    try {
      await source.connect({ engine: 'sqlite', database_path: sourcePath });
      sourceConnected = true;
      await source.initSchema();
      await source.putPage('systems/compiler.md', {
        type: 'system',
        title: 'Compiler',
        compiled_truth: 'Compiler system overview.',
      });
      await source.updatePageEmbedding('systems/compiler.md', embedding);

      await runMigrateEngine(source, ['--to', 'pglite', '--path', targetPath]);
      await source.disconnect();
      sourceConnected = false;

      await target.connect({ engine: 'pglite', database_path: targetPath });
      targetConnected = true;
      await target.initSchema();

      const embeddings = await target.getPageEmbeddings('system');
      expect(embeddings).toHaveLength(1);
      expect(embeddings[0]?.slug).toBe('systems/compiler.md');
      expect(embeddings[0]?.embedding).not.toBeNull();
      expect(Array.from(embeddings[0]!.embedding!.slice(0, 3))).toEqual([1, 2, 3]);
    } finally {
      await Promise.all([
        targetConnected ? target.disconnect() : Promise.resolve(),
        sourceConnected ? source.disconnect() : Promise.resolve(),
      ]);
    }
  }, PGLITE_MIGRATION_TEST_TIMEOUT_MS);

  // Integration tests for actual migration execution require DATABASE_URL
  // and are covered in the E2E suite (test/e2e/mechanical.test.ts)
});
