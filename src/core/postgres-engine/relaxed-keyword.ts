import { buildBestPerPagePoolCte } from '../search/sql-ranking.ts';

// Only the strict-zero OR recall arm uses this approximation. Index-backed
// term coverage keeps multi-term evidence ahead of incidental common words.
// Round-robin chunk positions prevent one long page from filling a tied pool.
// Equal-coverage pools above the bound can omit a higher-frequency or boosted
// match. Strict search remains exhaustive; this bound is only for OR recall.
export const RELAXED_KEYWORD_RANK_LIMIT = 4096;

interface RelaxedKeywordSql {
  ftsLanguage: string;
  pageWhere: string;
  chunkWhere: string;
  sourceFactorCase: string;
  innerLimitParam: string;
  limitParam: string;
  offsetParam: string;
}

/** PostgreSQL-only bounded reranking; fragments come from trusted SQL builders. */
// engine-sql-ok: PostgreSQL GIN/LATERAL access path and materialization barriers; local PGLite keeps its existing keyword path.
export function buildRelaxedKeywordSql(opts: RelaxedKeywordSql): string {
  const { ftsLanguage, pageWhere, chunkWhere, sourceFactorCase,
    innerLimitParam, limitParam, offsetParam } = opts;
  return `
    WITH query_input AS MATERIALIZED (
      SELECT websearch_to_tsquery('${ftsLanguage}', $1) AS fts_query
    ), eligible_pages AS MATERIALIZED (
      SELECT p.id FROM pages p JOIN sources s ON s.id = p.source_id
      WHERE true ${pageWhere}
    ), term_queries AS MATERIALIZED (
      SELECT DISTINCT websearch_to_tsquery('${ftsLanguage}', term) AS term_query
      FROM unnest(string_to_array($1, ' OR ')) tokens(term)
    ), term_matches AS MATERIALIZED (
      SELECT cc.id, cc.page_id, cc.chunk_index, count(*) AS coverage
      FROM term_queries t CROSS JOIN LATERAL (
        SELECT id, page_id, chunk_index FROM content_chunks cc
        WHERE cc.search_vector @@ t.term_query AND cc.modality = 'text'
          ${chunkWhere} OFFSET 0
      ) cc
      GROUP BY cc.id, cc.page_id, cc.chunk_index
    ), eligible_matches AS (
      SELECT cc.*, row_number() OVER (
        PARTITION BY cc.page_id ORDER BY cc.coverage DESC, cc.chunk_index ASC, cc.id ASC
      ) AS page_position
      FROM term_matches cc JOIN eligible_pages p ON p.id = cc.page_id
    ), eligible_candidates AS MATERIALIZED (
      SELECT * FROM eligible_matches
      ORDER BY coverage DESC, page_position ASC, page_id ASC, id ASC
      LIMIT ${RELAXED_KEYWORD_RANK_LIMIT}
    ), ranked_chunks AS (
      SELECT p.slug, p.id AS page_id, p.title, p.type, p.source_id,
        p.effective_date, p.effective_date_source,
        CASE WHEN NULLIF(regexp_replace(p.frontmatter->>'message_id', '^[[:space:]]+|[[:space:]]+$', '', 'g'), '') IS NOT NULL
          THEN p.frontmatter->>'message_id' END AS message_id, p.frontmatter->>'thread_id' AS thread_id,
        CASE WHEN NULLIF(regexp_replace(p.frontmatter->>'message_id', '^[[:space:]]+|[[:space:]]+$', '', 'g'), '') IS NOT NULL
          THEN NULLIF(p.frontmatter->>'subject', '') END AS source_subject,
        cc.id AS chunk_id, cc.chunk_index, cc.chunk_text, cc.chunk_source,
        ts_rank(cc.search_vector, (SELECT fts_query FROM query_input)) * ${sourceFactorCase} AS score
      FROM eligible_candidates e
      JOIN content_chunks cc ON cc.id = e.id JOIN pages p ON p.id = e.page_id
      ORDER BY score DESC, page_id ASC, chunk_id ASC LIMIT ${innerLimitParam}
    ), ${buildBestPerPagePoolCte('ranked_chunks')}
    SELECT slug, page_id, title, type, source_id, effective_date, effective_date_source,
      message_id, thread_id, source_subject, chunk_id, chunk_index, chunk_text, chunk_source,
      score, false AS stale
    FROM best_per_page ORDER BY score DESC, page_id ASC, chunk_id ASC
    LIMIT ${limitParam} OFFSET ${offsetParam}
  `;
}
