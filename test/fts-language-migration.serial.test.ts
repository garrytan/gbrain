import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { MIGRATIONS } from '../src/core/migrate.ts';
import { resetFtsLanguageCache } from '../src/core/fts-language.ts';

const ENV_KEY = 'GBRAIN_FTS_LANGUAGE';
const originalLang = process.env[ENV_KEY];

beforeEach(() => {
  delete process.env[ENV_KEY];
  resetFtsLanguageCache();
});

afterEach(() => {
  delete process.env[ENV_KEY];
  if (originalLang !== undefined) process.env[ENV_KEY] = originalLang;
  resetFtsLanguageCache();
});

describe('configurable_fts_language migration', () => {
  test('migration is registered', () => {
    const ftsMig = MIGRATIONS.find(m => m.name === 'configurable_fts_language');
    expect(ftsMig).toBeDefined();
    expect(ftsMig?.version).toBeGreaterThan(115);
  });

  // #2704 (v124, page_search_vector_drop_compiled_truth) landed after this
  // migration — "is the latest migration" was only ever true at the
  // moment v123 was added and would break on every subsequent migration,
  // so it's removed rather than bumped to a hardcoded v124. The
  // registration + shape assertions below don't depend on migration order.

  test('ftsMig uses handler (not static SQL) because language interpolation is dynamic', () => {
    const ftsMig = MIGRATIONS.find(m => m.name === 'configurable_fts_language');
    expect(ftsMig?.sql).toBe('');
    expect(ftsMig?.handler).toBeTypeOf('function');
  });

  test('ftsMig handler is async', () => {
    const ftsMig = MIGRATIONS.find(m => m.name === 'configurable_fts_language');
    // Async function check: the constructor name is 'AsyncFunction'
    expect(ftsMig?.handler?.constructor.name).toBe('AsyncFunction');
  });

  test('migration handler issues recreate-function calls (smoke check via mock engine)', async () => {
    const ftsMig = MIGRATIONS.find(m => m.name === 'configurable_fts_language');
    const calls: string[] = [];

    const mockEngine = {
      executeRaw: async (sql: string) => {
        calls.push(sql);
        return [];
      },
    } as unknown as BrainEngine;

    process.env[ENV_KEY] = 'english';
    resetFtsLanguageCache();

    await ftsMig?.handler?.(mockEngine);

    // Default 'english' \u2014 no backfill, only 2 CREATE OR REPLACE calls.
    expect(calls.length).toBe(2);
    expect(calls[0]).toContain('CREATE OR REPLACE FUNCTION update_page_search_vector');
    expect(calls[0]).toContain("to_tsvector('english'");
    expect(calls[1]).toContain('CREATE OR REPLACE FUNCTION update_chunk_search_vector');
    expect(calls[1]).toContain("to_tsvector('english'");
    // v120/#1647 hardening must survive the CREATE OR REPLACE (which resets
    // proconfig): both recreated bodies pin search_path.
    expect(calls[0]).toContain('SET search_path = pg_catalog, public');
    expect(calls[1]).toContain('SET search_path = pg_catalog, public');
  });

  test('non-english language triggers backfill', async () => {
    const ftsMig = MIGRATIONS.find(m => m.name === 'configurable_fts_language');
    const calls: string[] = [];

    const mockEngine = {
      executeRaw: async (sql: string) => {
        calls.push(sql);
        return [];
      },
    } as unknown as BrainEngine;

    process.env[ENV_KEY] = 'pt_br';
    resetFtsLanguageCache();

    await ftsMig?.handler?.(mockEngine);

    // pt_br \u2014 2 CREATE + 2 backfill UPDATEs = 4 calls
    expect(calls.length).toBe(4);
    expect(calls[0]).toContain("to_tsvector('pt_br'");
    expect(calls[1]).toContain("to_tsvector('pt_br'");
    expect(calls[2]).toMatch(/UPDATE pages/);
    expect(calls[3]).toContain("to_tsvector('pt_br'");
    expect(calls[3]).toMatch(/UPDATE content_chunks/);
  });

  test('invalid language falls back to english (no SQL injection)', async () => {
    const ftsMig = MIGRATIONS.find(m => m.name === 'configurable_fts_language');
    const calls: string[] = [];

    const mockEngine = {
      executeRaw: async (sql: string) => {
        calls.push(sql);
        return [];
      },
    } as unknown as BrainEngine;

    process.env[ENV_KEY] = "english'; DROP TABLE pages; --";
    resetFtsLanguageCache();

    await ftsMig?.handler?.(mockEngine);

    // Falls back to english: 2 CREATE OR REPLACE only, no DROP TABLE in any SQL.
    expect(calls.length).toBe(2);
    for (const sql of calls) {
      expect(sql).not.toContain('DROP TABLE');
      expect(sql).toContain("to_tsvector('english'");
    }
  });
});
