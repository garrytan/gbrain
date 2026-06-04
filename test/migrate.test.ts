import { setDefaultTimeout, afterEach, beforeEach, describe, test, expect } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { LATEST_VERSION } from '../src/core/migrate.ts';

setDefaultTimeout(20_000);

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
