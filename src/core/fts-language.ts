/**
 * Full-text search language configuration.
 *
 * Postgres tsvector/tsquery require a text search configuration name (e.g.
 * 'english', 'portuguese', 'spanish'). Historically GBrain hardcoded
 * 'english' across engines and trigger functions, which broke search
 * quality for non-English brains (no stemming, no stop-word removal).
 *
 * This helper centralizes the choice. Default stays 'english' for backward
 * compatibility — only users who set GBRAIN_FTS_LANGUAGE see different
 * behavior.
 *
 * Custom configs (e.g. accent-insensitive 'pt_br' built with unaccent +
 * portuguese stemmer) are supported as long as the configuration exists
 * in the target Postgres instance. See docs/guides/multi-language-fts.md
 * for setup instructions.
 *
 * Validation: only allow lowercase letters, digits, and underscores. This
 * prevents SQL injection when the value is interpolated into queries
 * (Postgres tsvector functions don't accept parameterized config names —
 * they must be literals or identifiers).
 */

import { CJK_SLUG_CHARS } from './cjk.ts';

const VALID_CONFIG_NAME = /^[a-z][a-z0-9_]*$/;
const DEFAULT_LANGUAGE = 'english';

/**
 * Config-table key `gbrain reindex-search-vector` sets (value = target
 * language) before it flips the trigger functions and clears only after both
 * backfills finish. While present, rows written after the flip and rows not
 * yet backfilled are tokenized under different configurations, so keyword
 * search matches only part of the corpus; doctor's `fts_reindex_incomplete`
 * check fails on it (#4795).
 */
export const FTS_REINDEX_MARKER_KEY = 'fts.reindex_in_progress';

let cachedLanguage: string | null = null;

/**
 * Returns the configured Postgres text search configuration name.
 *
 * Resolution order:
 *   1. process.env.GBRAIN_FTS_LANGUAGE (if set and valid)
 *   2. 'english' (default — preserves existing behavior)
 *
 * The return value is safe to interpolate directly into SQL because it
 * passes the VALID_CONFIG_NAME guard. If validation fails, falls back to
 * the default and emits a one-time warning.
 *
 * Cached on first call; reset with `resetFtsLanguageCache()` (test only).
 */
export function getFtsLanguage(): string {
  if (cachedLanguage !== null) return cachedLanguage;

  const raw = process.env.GBRAIN_FTS_LANGUAGE?.trim();
  if (!raw) {
    cachedLanguage = DEFAULT_LANGUAGE;
    return cachedLanguage;
  }

  if (!VALID_CONFIG_NAME.test(raw)) {
    console.warn(
      `[gbrain] Invalid GBRAIN_FTS_LANGUAGE='${raw}' — must match /^[a-z][a-z0-9_]*$/. ` +
      `Falling back to '${DEFAULT_LANGUAGE}'.`
    );
    cachedLanguage = DEFAULT_LANGUAGE;
    return cachedLanguage;
  }

  cachedLanguage = raw;
  return cachedLanguage;
}

/**
 * Resets the cached language. Tests only — don't use in production code.
 */
export function resetFtsLanguageCache(): void {
  cachedLanguage = null;
}

/**
 * Rewrites a schema template's hardcoded `to_tsvector('english', ...)` calls
 * to the configured text search configuration.
 *
 * Why this exists: migration v123 (`configurable_fts_language`) stamps the
 * two search_vector trigger functions with `getFtsLanguage()` at apply time,
 * but the schema templates that `initSchema()` replays still carry the
 * literal 'english'. Those templates are applied with `CREATE OR REPLACE
 * FUNCTION`, so every `initSchema()` — including the one behind
 * `gbrain init --migrate-only`, which reports "Schema up to date" — silently
 * reverts a non-English brain's trigger functions to english. The write side
 * then tokenizes under a different configuration than the read side, and
 * nothing warns: rows keep being indexed, just unreachable by the queries
 * that were supposed to find them.
 *
 * Mirrors `applyChunkEmbeddingIndexPolicy()`: a runtime-config-driven rewrite
 * of the static schema template, applied at the same seam in both engines.
 *
 * No-op for the default configuration, so English installs get a
 * byte-identical schema string.
 */
export function applyFtsLanguagePolicy(sql: string): string {
  const lang = getFtsLanguage();
  if (lang === DEFAULT_LANGUAGE) return sql;
  // getFtsLanguage() validates against VALID_CONFIG_NAME, so the value is
  // safe to interpolate as a SQL string literal.
  return sql.replaceAll(`to_tsvector('${DEFAULT_LANGUAGE}',`, `to_tsvector('${lang}',`);
}

const CJK_CLASS = `[${CJK_SLUG_CHARS}]`;

/**
 * `gbrain_fts_input(text)`: the text every indexing `to_tsvector` and the
 * title query's `websearch_to_tsquery` read (#6370). Postgres' default parser
 * treats Han, Kana and Hangul as letters, so `升级PostgreSQL17后查询Redis7`
 * is one lexeme and keyword search for `Redis7` misses it. Two passes insert
 * a space at every CJK→ASCII-alnum and ASCII-alnum→CJK boundary (two passes,
 * not lookbehind, so both engines run the same regex). A byte-for-byte no-op
 * on text without CJK, and idempotent. One copy of this DDL: the schema
 * build splices it into src/schema.sql and the fts-cjk-boundary migration
 * applies it.
 */
export const FTS_INPUT_FUNCTION_SQL = `CREATE OR REPLACE FUNCTION gbrain_fts_input(t text) RETURNS text
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE SET search_path = pg_catalog
AS $fn$
  SELECT regexp_replace(regexp_replace(t, '(${CJK_CLASS})([A-Za-z0-9])', '\\1 \\2', 'g'), '([A-Za-z0-9])(${CJK_CLASS})', '\\1 \\2', 'g')
$fn$;`;

/** POSIX regex (SQL `~`) matching text that holds a CJK/ASCII-alnum boundary `gbrain_fts_input` splits. */
export const FTS_CJK_BOUNDARY_REGEX = `${CJK_CLASS}[A-Za-z0-9]|[A-Za-z0-9]${CJK_CLASS}`;

/**
 * The page keyword vector every sealed writer stores: the title (weight A) and
 * the SANITIZED timeline (weight C, bound by the caller; never the raw column,
 * which can hold private or withdrawn fence text). `title` and `timeline` are
 * SQL expressions. Shared by the seal, the import seal,
 * `reindex-search-vector` and the fts-cjk-boundary migration, so they cannot
 * drift.
 */
export function pageSearchVectorSql(title: string, timeline: string, lang: string = getFtsLanguage()): string {
  return `setweight(to_tsvector('${lang}',gbrain_fts_input(COALESCE(${title},''))),'A') || setweight(to_tsvector('${lang}',gbrain_fts_input(${timeline}::text)),'C')`;
}

/** The chunk keyword vector, over a row's own columns (`NEW.` in the trigger, bare in a backfill). */
export function chunkSearchVectorSql(lang: string, row = ''): string {
  return `setweight(to_tsvector('${lang}', gbrain_fts_input(COALESCE(${row}doc_comment, ''))), 'A') ||
    setweight(to_tsvector('${lang}', gbrain_fts_input(COALESCE(${row}symbol_name_qualified, ''))), 'A') ||
    setweight(to_tsvector('${lang}', gbrain_fts_input(COALESCE(${row}chunk_text, ''))), 'B')`;
}

/**
 * The two search_vector trigger functions under `lang`, for every runtime
 * rewrite (`reindex-search-vector`, the fts-cjk-boundary migration). Their
 * bodies are byte-identical to src/schema.sql's for 'english' (pinned by
 * test/fts-cjk-boundary.test.ts), so the blob replay that every boot runs
 * after a migration leaves the catalog unchanged. #2704: compiled_truth is not
 * indexed (it overflows the 1MB tsvector cap). `SET search_path = pg_catalog,
 * public` keeps the v120/#1647 hardening, which CREATE OR REPLACE would
 * otherwise reset.
 */
export function pageSearchVectorTriggerFnSql(lang: string): string {
  return `CREATE OR REPLACE FUNCTION update_page_search_vector() RETURNS trigger SET search_path = pg_catalog, public AS $$
DECLARE
  timeline_text TEXT;
BEGIN
  SELECT coalesce(string_agg(summary || ' ' || detail, ' '), '')
  INTO timeline_text
  FROM timeline_entries
  WHERE page_id = NEW.id;

  NEW.search_vector :=
    setweight(to_tsvector('${lang}', gbrain_fts_input(coalesce(NEW.title, ''))), 'A') ||
    setweight(to_tsvector('${lang}', gbrain_fts_input(coalesce(NEW.timeline, ''))), 'C') ||
    setweight(to_tsvector('${lang}', gbrain_fts_input(coalesce(timeline_text, ''))), 'C');

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;`;
}

export function chunkSearchVectorTriggerFnSql(lang: string): string {
  return `CREATE OR REPLACE FUNCTION update_chunk_search_vector() RETURNS TRIGGER SET search_path = pg_catalog, public AS $fn$
BEGIN
  NEW.search_vector :=
    ${chunkSearchVectorSql(lang, 'NEW.')};
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;`;
}
