/**
 * `initSchema()` must not revert a non-English brain's search_vector trigger
 * functions to 'english'.
 *
 * Migration v123 (`configurable_fts_language`) stamps
 * `update_page_search_vector` / `update_chunk_search_vector` with
 * `getFtsLanguage()` when it applies. But the schema templates that
 * `initSchema()` replays — `src/schema.sql` and `PGLITE_SCHEMA_SQL_TEMPLATE` —
 * still carried the literal `to_tsvector('english', …)`, and they are applied
 * with `CREATE OR REPLACE FUNCTION`. So the SECOND `initSchema()` clobbers
 * what v123 stamped on the first: v123 is already recorded as applied, so the
 * migration runner skips it and nothing puts the language back.
 *
 * That second call is not hypothetical — it is what `gbrain init
 * --migrate-only` does on every upgrade, and it prints "Schema up to date"
 * while doing it. The write side then tokenizes under a different
 * configuration than `searchKeyword`/`searchTitles`/`searchKeywordChunks`
 * read under, with no warning: rows keep being indexed, just unreachable by
 * the queries meant to find them.
 *
 * The replay test below is the discriminating one — a single `initSchema()`
 * on a fresh brain passes either way, because v123 runs and stamps the
 * correct language. Only the replay separates fixed from broken.
 *
 * `simple` is used as the non-default configuration because it ships with
 * every Postgres build (no extension needed) and is not the default, so a
 * clobber back to 'english' is unambiguous.
 *
 * Serial: mutates process.env (isolation guard R2).
 */

import { describe, test, expect, beforeEach, afterEach, afterAll } from 'bun:test';
import { applyFtsLanguagePolicy, resetFtsLanguageCache } from '../src/core/fts-language.ts';
import { getPostgresSchema } from '../src/core/postgres-engine.ts';
import { getPGLiteSchema } from '../src/core/pglite-schema.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

const ENV_KEY = 'GBRAIN_FTS_LANGUAGE';
const originalLang = process.env[ENV_KEY];

const TSVECTOR_EN = /to_tsvector\('english',/g;
const TSVECTOR_SIMPLE = /to_tsvector\('simple',/g;

function count(haystack: string, re: RegExp): number {
  return (haystack.match(re) ?? []).length;
}

beforeEach(() => {
  delete process.env[ENV_KEY];
  resetFtsLanguageCache();
});

afterEach(() => {
  delete process.env[ENV_KEY];
  resetFtsLanguageCache();
});

afterAll(() => {
  if (originalLang !== undefined) process.env[ENV_KEY] = originalLang;
  resetFtsLanguageCache();
});

describe('applyFtsLanguagePolicy', () => {
  test('is identity for the default configuration (English installs unchanged)', () => {
    const sql = "setweight(to_tsvector('english', COALESCE(NEW.chunk_text, '')), 'B')";
    expect(applyFtsLanguagePolicy(sql)).toBe(sql);
  });

  test('rewrites every to_tsvector call when a configuration is set', () => {
    process.env[ENV_KEY] = 'simple';
    const sql = "to_tsvector('english', a) || to_tsvector('english', b)";
    expect(applyFtsLanguagePolicy(sql)).toBe("to_tsvector('simple', a) || to_tsvector('simple', b)");
  });

  test('leaves an invalid configuration on the default (validation is upstream)', () => {
    process.env[ENV_KEY] = 'Robert; DROP TABLE pages';
    const sql = "to_tsvector('english', a)";
    expect(applyFtsLanguagePolicy(sql)).toBe(sql);
  });
});

describe('schema templates carry the configured FTS language', () => {
  test('postgres: default leaves english in place', () => {
    const sql = getPostgresSchema();
    expect(count(sql, TSVECTOR_EN)).toBeGreaterThan(0);
    expect(count(sql, TSVECTOR_SIMPLE)).toBe(0);
  });

  test('postgres: configured language replaces every english tsvector', () => {
    const before = count(getPostgresSchema(), TSVECTOR_EN);
    resetFtsLanguageCache();
    process.env[ENV_KEY] = 'simple';
    const sql = getPostgresSchema();
    expect(count(sql, TSVECTOR_EN)).toBe(0);
    expect(count(sql, TSVECTOR_SIMPLE)).toBe(before);
  });

  test('pglite: default leaves english in place', () => {
    const sql = getPGLiteSchema();
    expect(count(sql, TSVECTOR_EN)).toBeGreaterThan(0);
    expect(count(sql, TSVECTOR_SIMPLE)).toBe(0);
  });

  test('pglite: configured language replaces every english tsvector', () => {
    const before = count(getPGLiteSchema(), TSVECTOR_EN);
    resetFtsLanguageCache();
    process.env[ENV_KEY] = 'simple';
    const sql = getPGLiteSchema();
    expect(count(sql, TSVECTOR_EN)).toBe(0);
    expect(count(sql, TSVECTOR_SIMPLE)).toBe(before);
  });
});

describe('initSchema replay preserves the configured FTS language (the upgrade path)', () => {
  test('a second initSchema() does not revert the trigger functions to english', async () => {
    process.env[ENV_KEY] = 'simple';
    resetFtsLanguageCache();
    // A loaded snapshot short-circuits initSchema() entirely (`_snapshotLoaded`),
    // which would make the replay vacuous. Force the real path.
    const savedSnapshot = process.env.GBRAIN_PGLITE_SNAPSHOT;
    delete process.env.GBRAIN_PGLITE_SNAPSHOT;

    const engine = new PGLiteEngine();
    try {
      await engine.connect({ database_url: '' });

      // First apply: schema template + migrations. v123 stamps the trigger
      // functions with the configured language.
      await engine.initSchema();

      const afterFirst = await engine.executeRaw<{ prosrc: string }>(
        `SELECT prosrc FROM pg_proc WHERE proname = 'update_page_search_vector'`,
      );
      expect(afterFirst.length).toBe(1);
      expect(afterFirst[0]!.prosrc).toContain("'simple'");

      // Replay — what `gbrain init --migrate-only` does on every upgrade.
      // v123 is already recorded as applied, so nothing re-stamps the
      // functions; only the schema template runs, via CREATE OR REPLACE.
      await engine.initSchema();

      const afterReplay = await engine.executeRaw<{ prosrc: string }>(
        `SELECT prosrc FROM pg_proc WHERE proname = 'update_page_search_vector'`,
      );
      expect(afterReplay.length).toBe(1);
      expect(afterReplay[0]!.prosrc).toContain("'simple'");
      expect(afterReplay[0]!.prosrc).not.toContain("'english'");
    } finally {
      await engine.disconnect();
      if (savedSnapshot !== undefined) process.env.GBRAIN_PGLITE_SNAPSHOT = savedSnapshot;
    }
  });
});
