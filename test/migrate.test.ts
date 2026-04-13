import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { LATEST_VERSION } from '../src/core/migrate.ts';

describe('migrate', () => {
  test('LATEST_VERSION includes the nomic pgvector migration', () => {
    expect(typeof LATEST_VERSION).toBe('number');
    expect(LATEST_VERSION).toBeGreaterThan(4);
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
    expect(schemaSource).toContain("'nomic-embed-text'");
    expect(schemaSource).toContain("'embedding_dimensions', '768'");
  });

  test('migration source includes the pgvector resize step', async () => {
    const migrateSource = readFileSync(
      new URL('../src/core/migrate.ts', import.meta.url),
      'utf-8',
    );

    expect(migrateSource).toContain('pgvector_768_for_nomic');
    expect(migrateSource).toContain('vector(768)');
  });

  // Integration tests for actual migration execution require DATABASE_URL
  // and are covered in the E2E suite (test/e2e/mechanical.test.ts)
});
