import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { MIGRATIONS, LATEST_VERSION } from '../src/core/migrate.ts';
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

describe('v33 configurable_fts_language migration', () => {
  test('migration is registered at version 33', () => {
    const v33 = MIGRATIONS.find(m => m.version === 33);
    expect(v33).toBeDefined();
    expect(v33?.name).toBe('configurable_fts_language');
  });

  test('v33 is the latest migration', () => {
    expect(LATEST_VERSION).toBe(33);
  });

  test('v33 uses handler (not static SQL) because language interpolation is dynamic', () => {
    const v33 = MIGRATIONS.find(m => m.version === 33);
    expect(v33?.sql).toBe('');
    expect(v33?.handler).toBeTypeOf('function');
  });

  test('v33 handler is async', () => {
    const v33 = MIGRATIONS.find(m => m.version === 33);
    // Async function check: the constructor name is 'AsyncFunction'
    expect(v33?.handler?.constructor.name).toBe('AsyncFunction');
  });

  test('migration handler issues recreate-function calls (smoke check via mock engine)', async () => {
    const v33 = MIGRATIONS.find(m => m.version === 33);
    const calls: string[] = [];

    const mockEngine = {
      executeRaw: async (sql: string) => {
        calls.push(sql);
        return [];
      },
    } as unknown as BrainEngine;

    process.env[ENV_KEY] = 'english';
    resetFtsLanguageCache();

    await v33?.handler?.(mockEngine);

    // Default 'english' \u2014 no backfill, only 2 CREATE OR REPLACE calls.
    expect(calls.length).toBe(2);
    expect(calls[0]).toContain('CREATE OR REPLACE FUNCTION update_page_search_vector');
    expect(calls[0]).toContain("to_tsvector('english'");
    expect(calls[1]).toContain('CREATE OR REPLACE FUNCTION update_chunk_search_vector');
    expect(calls[1]).toContain("to_tsvector('english'");
  });

  test('non-english language triggers backfill', async () => {
    const v33 = MIGRATIONS.find(m => m.version === 33);
    const calls: string[] = [];

    const mockEngine = {
      executeRaw: async (sql: string) => {
        calls.push(sql);
        return [];
      },
    } as unknown as BrainEngine;

    process.env[ENV_KEY] = 'pt_br';
    resetFtsLanguageCache();

    await v33?.handler?.(mockEngine);

    // pt_br \u2014 2 CREATE + 2 backfill UPDATEs = 4 calls
    expect(calls.length).toBe(4);
    expect(calls[0]).toContain("to_tsvector('pt_br'");
    expect(calls[1]).toContain("to_tsvector('pt_br'");
    expect(calls[2]).toMatch(/UPDATE pages/);
    expect(calls[3]).toContain("to_tsvector('pt_br'");
    expect(calls[3]).toMatch(/UPDATE content_chunks/);
  });

  test('invalid language falls back to english (no SQL injection)', async () => {
    const v33 = MIGRATIONS.find(m => m.version === 33);
    const calls: string[] = [];

    const mockEngine = {
      executeRaw: async (sql: string) => {
        calls.push(sql);
        return [];
      },
    } as unknown as BrainEngine;

    process.env[ENV_KEY] = "english'; DROP TABLE pages; --";
    resetFtsLanguageCache();

    await v33?.handler?.(mockEngine);

    // Falls back to english: 2 CREATE OR REPLACE only, no DROP TABLE in any SQL.
    expect(calls.length).toBe(2);
    for (const sql of calls) {
      expect(sql).not.toContain('DROP TABLE');
      expect(sql).toContain("to_tsvector('english'");
    }
  });
});
