/**
 * v0.32.7 CJK wave — migration v54 (cjk_wave_pages_chunker_version_and_source_path).
 *
 * Asserts the two new columns + partial indexes on `pages` exist after schema
 * initialization on PGLite. Postgres parity is covered by test/e2e/schema-drift.test.ts.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

describe('migration v54: cjk_wave_pages_chunker_version_and_source_path', () => {
  test('pages.chunker_version exists with default 1', async () => {
    const rows = await engine.executeRaw<{ column_name: string; data_type: string; column_default: string | null; is_nullable: string }>(
      `SELECT column_name, data_type, column_default, is_nullable
         FROM information_schema.columns
        WHERE table_name = 'pages' AND column_name = 'chunker_version'`,
    );
    expect(rows.length).toBe(1);
    expect(rows[0].is_nullable).toBe('NO');
    expect(rows[0].column_default).toContain('1');
  });

  test('pages.source_path exists, nullable', async () => {
    const rows = await engine.executeRaw<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable
         FROM information_schema.columns
        WHERE table_name = 'pages' AND column_name = 'source_path'`,
    );
    expect(rows.length).toBe(1);
    expect(rows[0].is_nullable).toBe('YES');
  });

  test('partial index pages_chunker_version_idx exists', async () => {
    const rows = await engine.executeRaw<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE indexname = 'pages_chunker_version_idx'`,
    );
    expect(rows.length).toBe(1);
  });

  test('partial index pages_source_path_idx exists', async () => {
    const rows = await engine.executeRaw<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE indexname = 'pages_source_path_idx'`,
    );
    expect(rows.length).toBe(1);
  });

  test('default-inherited rows show chunker_version=1', async () => {
    // Insert a page WITHOUT specifying chunker_version; verify default fires.
    await engine.executeRaw(
      `INSERT INTO pages (slug, type, title, source_path)
         VALUES ('test/cjk-migration', 'note', 'Test', 'test/cjk-migration.md')
         ON CONFLICT DO NOTHING`,
    );
    const rows = await engine.executeRaw<{ chunker_version: number; source_path: string | null }>(
      `SELECT chunker_version, source_path FROM pages WHERE slug = 'test/cjk-migration'`,
    );
    expect(rows.length).toBe(1);
    expect(Number(rows[0].chunker_version)).toBe(1);
    expect(rows[0].source_path).toBe('test/cjk-migration.md');
  });
});
