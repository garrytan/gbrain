/**
 * The title-arm statement (`BrainEngine.searchTitles`), built once for both
 * engines and the plan-proof E2E (test/e2e/title-arm-postgres.test.ts) so the
 * SQL they run or EXPLAIN can never drift. Execution, the per-engine session
 * settings and the OR fallback live in engine-sql/titles.ts; see its module
 * doc for the exact-title key (#5889) and the weight-A remote predicate.
 */
import type { SearchOpts } from '../types.ts';
import { clampSearchLimit } from '../engine.ts';
import { searchLimitCap } from './eval-pool-depth.ts';
import { getFtsLanguage } from '../fts-language.ts';
import { requiresSafeChunks } from './safe-chunks.ts';
import { normalizeAlias } from './alias-normalize.ts';
import { resolveBoostMap, resolveHardExcludes } from './source-boost.ts';
import {
  boundWebsearchQuery,
  buildHardExcludeClause,
  buildSourceFactorCase,
  buildVisibilityClause,
} from './sql-ranking.ts';

/** Engine behavior the title arm keeps from each engine's original method. */
export interface SearchTitlesDialect {
  /** Per-attempt `statement_timeout` (Postgres: '8s'); unset means none. */
  statementTimeout?: string;
  /** Run the relaxed (OR) local re-run with `enable_seqscan` off (Postgres). */
  relaxedPrefersIndex: boolean;
  /** Project `stale` from timeline_entries (PGLite); otherwise `false`. */
  staleProbe: boolean;
}

export interface SearchTitlesStatement {
  sql: string;
  /** `$1` is the websearch text (rebound by the OR fallback); `$2` the exact-title key. */
  params: unknown[];
  safeChunks: boolean;
}

/**
 * Label every lexeme of a tsquery's text form with weight A
 * (`'acm' & !'secret'` → `'acm':A & !'secret':A`; prefix `'acm':*` →
 * `'acm':*A`). Lexemes are single-quoted with `''` escapes in that form.
 */
const WEIGHT_A_QUERY = (ftsLang: string): string =>
  `regexp_replace(websearch_to_tsquery('${ftsLang}', gbrain_fts_input($1))::text, '(''(?:[^'']|'''')*'')(?::(\\*))?', '\\1:\\2A', 'g')::tsquery`;

export function buildSearchTitlesStatement(query: string, opts: SearchOpts | undefined, dialect: SearchTitlesDialect): SearchTitlesStatement {
  const limit = clampSearchLimit(opts?.limit, 20, searchLimitCap());
  const offset = opts?.offset || 0;
  const detailLow = opts?.detail === 'low';
  const safeChunks = requiresSafeChunks(opts);

  const boostMap = opts?.source_boosts ?? resolveBoostMap();
  const sourceFactorCase = buildSourceFactorCase('p.slug', boostMap, opts?.detail);
  const hardExcludeClause = buildHardExcludeClause('p.slug', resolveHardExcludes(opts?.exclude_slug_prefixes, opts?.include_slug_prefixes));
  const visibilityClause = buildVisibilityClause('p', 's', opts);
  // FTS config name (e.g. 'english', 'pt_br'). Validated by getFtsLanguage()
  // — safe to interpolate into raw SQL.
  const ftsLang = getFtsLanguage();
  const tsq = `websearch_to_tsquery('${ftsLang}', gbrain_fts_input($1))`;
  const matchSql = safeChunks ? `p.search_vector @@ ${WEIGHT_A_QUERY(ftsLang)}` : `p.search_vector @@ ${tsq}`;
  const rankSql = safeChunks ? `ts_rank_cd(ts_filter(p.search_vector, '{a}'), ${tsq})` : `ts_rank_cd(p.search_vector, ${tsq})`;

  const params: unknown[] = [boundWebsearchQuery(query), normalizeAlias(query), limit, offset];
  let filters = '';
  if (opts?.type) {
    params.push(opts.type);
    filters += ` AND p.type = $${params.length}`;
  }
  if (opts?.types && opts.types.length > 0) {
    params.push(opts.types);
    filters += ` AND p.type = ANY($${params.length}::text[])`;
  }
  if (opts?.exclude_slugs?.length) {
    params.push(opts.exclude_slugs);
    filters += ` AND p.slug != ALL($${params.length}::text[])`;
  }
  // Date filters read COALESCE(effective_date, …), the keyword arm's
  // effective-date-first convention.
  if (opts?.afterDate) {
    params.push(opts.afterDate);
    filters += ` AND COALESCE(p.effective_date, p.updated_at, p.created_at) ${opts?.afterDateInclusive ? '>=' : '>'} $${params.length}::text::timestamptz`;
  }
  if (opts?.beforeDate) {
    params.push(opts.beforeDate);
    filters += ` AND COALESCE(p.effective_date, p.updated_at, p.created_at) ${opts?.beforeDateInclusive ? '<=' : '<'} $${params.length}::text::timestamptz`;
  }
  if (opts?.sourceIds && opts.sourceIds.length > 0) {
    params.push(opts.sourceIds);
    filters += ` AND p.source_id = ANY($${params.length}::text[])`;
  } else if (opts?.sourceId) {
    params.push(opts.sourceId);
    filters += ` AND p.source_id = $${params.length}`;
  }

  // Page grain: one row per page, so no best_per_page pool. top_pages ranks
  // and limits first; the representative-chunk LATERAL (compiled_truth first,
  // then lowest chunk_index) and the stale probe run per OUTPUT row. Neither
  // affects order. COALESCEs keep chunkless pages retrievable (chunk_id 0,
  // empty text). Accepted limitations (Reviewer F5/F6): the synthetic
  // chunkless row dedups on empty chunk_text (fusion's compiledTruthBoost
  // skips it since #3695); detail='low' filters only the representative.
  const staleSql = dialect.staleProbe
    ? `CASE WHEN tp.updated_at < (SELECT MAX(te.created_at) FROM timeline_entries te
         WHERE te.page_id = tp.page_id) THEN true ELSE false END`
    : 'false';
  const sql = `
    WITH top_pages AS (
      SELECT p.slug, p.id AS page_id, p.title, p.type, p.source_id,
        p.effective_date, p.effective_date_source, p.updated_at,
        (lower(btrim(p.title, ' "''' || chr(160))) = $2) AS exact_title,
        ${rankSql} * ${sourceFactorCase} AS score
      FROM pages p
      JOIN sources s ON s.id = p.source_id
      WHERE ${matchSql}
        ${filters}
        ${hardExcludeClause}
        ${visibilityClause}
      ORDER BY exact_title DESC, score DESC, p.id ASC
      LIMIT $3 OFFSET $4
    )
    SELECT tp.slug, tp.page_id, tp.title, tp.type, tp.source_id,
      tp.effective_date, tp.effective_date_source,
      COALESCE(rep.id, 0) AS chunk_id,
      COALESCE(rep.chunk_index, 0) AS chunk_index,
      COALESCE(rep.chunk_text, '') AS chunk_text,
      COALESCE(rep.chunk_source, 'compiled_truth') AS chunk_source,
      tp.score,
      ${staleSql} AS stale
    FROM top_pages tp
    LEFT JOIN LATERAL (
      SELECT cc.id, cc.chunk_index, cc.chunk_text, cc.chunk_source
      FROM content_chunks cc
      WHERE cc.page_id = tp.page_id
        AND cc.modality = 'text'
        ${detailLow ? `AND cc.chunk_source = 'compiled_truth'` : ''}
      ORDER BY (cc.chunk_source = 'compiled_truth') DESC, cc.chunk_index ASC
      LIMIT 1
    ) rep ON true
    ORDER BY tp.exact_title DESC, tp.score DESC, tp.page_id ASC
  `;
  return { sql, params, safeChunks };
}

