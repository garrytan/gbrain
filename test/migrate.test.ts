import { afterEach, beforeEach, describe, test, expect } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { LATEST_VERSION } from '../src/core/migrate.ts';

const originalEnv = { ...process.env };
let tempHome = '';

function makeVector(...values: number[]): Float32Array {
  const vector = new Float32Array(768);
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
  test('LATEST_VERSION includes the nomic pgvector migration', () => {
    expect(typeof LATEST_VERSION).toBe('number');
    expect(LATEST_VERSION).toBeGreaterThan(6);
  });

  test('runMigrations is exported and callable', async () => {
    const { runMigrations } = await import('../src/core/migrate.ts');
    expect(typeof runMigrations).toBe('function');
  });

  test('postgres baseline schema uses nomic-friendly dimensions and defaults', () => {
    const schemaSource = readFileSync(
      new URL('../src/schema.sql', import.meta.url),
      'utf-8',
    );

    expect(schemaSource).toContain('vector(768)');
    expect(schemaSource).toContain('page_embedding vector(768)');
    expect(schemaSource).toContain("'nomic-embed-text'");
    expect(schemaSource).toContain("'embedding_dimensions', '768'");
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

    expect(embeddedSource).toContain('page_embedding vector(768)');
    expect(pgliteSchema).toContain('page_embedding vector(768)');
  });

  test('migration source includes the pgvector resize step', async () => {
    const migrateSource = readFileSync(
      new URL('../src/core/migrate.ts', import.meta.url),
      'utf-8',
    );

    expect(migrateSource).toContain('pgvector_768_for_nomic');
    expect(migrateSource).toContain('page_embedding_upgrade');
    expect(migrateSource).toContain('vector(768)');
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
    await source.connect({ engine: 'sqlite', database_path: sourcePath });
    await source.initSchema();
    await source.putPage('systems/compiler.md', {
      type: 'system',
      title: 'Compiler',
      compiled_truth: 'Compiler system overview.',
    });
    await source.updatePageEmbedding('systems/compiler.md', embedding);

    await runMigrateEngine(source, ['--to', 'pglite', '--path', targetPath]);
    await source.disconnect();

    const target = new PGLiteEngine();
    await target.connect({ engine: 'pglite', database_path: targetPath });
    await target.initSchema();

    const embeddings = await target.getPageEmbeddings('system');
    expect(embeddings).toHaveLength(1);
    expect(embeddings[0]?.slug).toBe('systems/compiler.md');
    expect(embeddings[0]?.embedding).not.toBeNull();
    expect(Array.from(embeddings[0]!.embedding!.slice(0, 3))).toEqual([1, 2, 3]);

    await target.disconnect();
  });

  // Integration tests for actual migration execution require DATABASE_URL
  // and are covered in the E2E suite (test/e2e/mechanical.test.ts)
});
