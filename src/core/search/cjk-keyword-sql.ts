/**
 * Shared CJK keyword-fallback SQL builder (#3986).
 *
 * `websearch_to_tsquery` with an ASCII-stemming FTS config ('english', …)
 * can't tokenize CJK, so FTS keyword recall is zero for Chinese / Japanese /
 * Korean queries. Both engines fall back to a term-by-term ILIKE match with
 * term-frequency ranking (v0.32.7 on PGLite; ported to Postgres by #3986).
 * The SQL is built ONCE here with $N positional params so the two engines
 * cannot drift; each engine supplies only its own executor.
 *
 * Ranking: term-frequency count per term via
 * (length(chunk) - length(replace(chunk, term, ''))) / length(term),
 * plus a bonus for contiguous raw-query occurrences when multi-term, and a
 * position() tiebreaker so earlier-in-chunk hits outrank later ones.
 *
 * Parameter bindings:
 *   - LIKE parameters are individually escaped with escapeLikePattern and
 *     wrapped with %.
 *   - Raw terms and raw query are bound unescaped for ranking arithmetic.
 *   - Explicit `ESCAPE '\'` on ILIKE clauses.
 *   - Empty-query guard returns null without binding SQL.
 */
import type { SearchOpts } from '../types.ts';
import { buildBestPerPagePoolCte } from './sql-ranking.ts';
import { escapeLikePattern, splitCJKQueryTerms } from '../cjk.ts';

/** Query-shape context shared by both engines' CJK fallback call sites. */
export interface CjkKeywordCtx {
  limit: number;
  offset: number;
  /** Dedup headroom for the inner CTE; unused when dedup=false. */
  innerLimit: number;
  sourceFactorCase: string;
  hardExcludeClause: string;
  visibilityClause: string;
  detailFilter: string;
  opts: SearchOpts | undefined;
  /** true = page-grain (best chunk per page); false = chunk-grain. */
  dedup: boolean;
}

export interface CjkKeywordSql {
  sql: string;
  params: unknown[];
}

export function buildCJKKeywordSql(query: string, ctx: CjkKeywordCtx): CjkKeywordSql | null {
  const { limit, offset, innerLimit, sourceFactorCase, hardExcludeClause, visibilityClause, detailFilter, opts, dedup } = ctx;
  const qRaw = query;
  if (qRaw.length === 0) return null;
  const terms = splitCJKQueryTerms(qRaw);
  if (terms.length === 0) return null;

  const params: unknown[] = [];

  // LIKE parameters: $1 .. $N (each escaped and wrapped with %)
  const likeParamIndices: number[] = [];
  for (const term of terms) {
    params.push(`%${escapeLikePattern(term)}%`);
    likeParamIndices.push(params.length);
  }

  // Raw term parameters for term-frequency scoring: $N+1 .. $2N
  const rawTermIndices: number[] = [];
  for (const term of terms) {
    params.push(term);
    rawTermIndices.push(params.length);
  }

  // Raw full query parameter for contiguous match bonus and tiebreaker: $2N+1
  params.push(qRaw);
  const qRawIndex = params.length;

  // Pagination limits & offset
  let innerLimitIndex = 0;
  let limitIndex = 0;
  let offsetIndex = 0;

  if (dedup) {
    params.push(innerLimit);
    innerLimitIndex = params.length;
    params.push(limit);
    limitIndex = params.length;
    params.push(offset);
    offsetIndex = params.length;
  } else {
    params.push(limit);
    limitIndex = params.length;
    params.push(offset);
    offsetIndex = params.length;
  }

  let extraFilter = '';
  // #4480: the CJK arm must honor the SAME shape filters as the main
  // keyword arm. type/types/exclude_slugs were silently dropped here, so a
  // typed query (`gbrain whoknows` → types:['person','company']) or an
  // exclude-scoped query returned out-of-contract rows for CJK text while
  // ASCII text filtered correctly.
  if (opts?.type) {
    params.push(opts.type);
    extraFilter += ` AND p.type = $${params.length}`;
  }
  if (opts?.types && opts.types.length > 0) {
    params.push(opts.types);
    extraFilter += ` AND p.type = ANY($${params.length}::text[])`;
  }
  if (opts?.exclude_slugs?.length) {
    params.push(opts.exclude_slugs);
    extraFilter += ` AND p.slug != ALL($${params.length}::text[])`;
  }
  if (opts?.language) {
    params.push(opts.language);
    extraFilter += ` AND cc.language = $${params.length}`;
  }
  if (opts?.symbolKind) {
    params.push(opts.symbolKind);
    extraFilter += ` AND cc.symbol_type = $${params.length}`;
  }
  if (opts?.afterDate) {
    params.push(opts.afterDate);
    extraFilter += ` AND COALESCE(p.effective_date, p.updated_at, p.created_at) > $${params.length}::timestamptz`;
  }
  if (opts?.beforeDate) {
    params.push(opts.beforeDate);
    extraFilter += ` AND COALESCE(p.effective_date, p.updated_at, p.created_at) < $${params.length}::timestamptz`;
  }
  // v0.34.1 (#861 — P0 leak seal): source-isolation on the CJK fallback path.
  if (opts?.sourceIds && opts.sourceIds.length > 0) {
    params.push(opts.sourceIds);
    extraFilter += ` AND p.source_id = ANY($${params.length}::text[])`;
  } else if (opts?.sourceId) {
    params.push(opts.sourceId);
    extraFilter += ` AND p.source_id = $${params.length}`;
  }

  const whereLikeClause = likeParamIndices
    .map(idx => `cc.chunk_text ILIKE $${idx} ESCAPE '\\'`)
    .join(' AND ');

  const termFreqExpr = rawTermIndices
    .map(idx => `((LENGTH(cc.chunk_text) - LENGTH(REPLACE(cc.chunk_text, $${idx}, ''))) / NULLIF(LENGTH($${idx}), 0)::real)`)
    .join(' + ');

  const qRawBonusExpr = terms.length > 1
    ? ` + ((LENGTH(cc.chunk_text) - LENGTH(REPLACE(cc.chunk_text, $${qRawIndex}, ''))) / NULLIF(LENGTH($${qRawIndex}), 0)::real)`
    : '';

  const positionExpr = `COALESCE(1.0 / NULLIF(POSITION($${qRawIndex} IN cc.chunk_text), 0)::real, 0.0)`;

  // Term-frequency count: count occurrences of each term in chunk_text via
  // (length(chunk) - length(replace(chunk, term, ''))) / length(term),
  // plus bonus for contiguous raw query occurrences when multi-term, and
  // position()-tiebreaker so earlier-in-chunk hits outrank later ones.
  const scoreExpr = `
      ((${termFreqExpr}${qRawBonusExpr}
        + ${positionExpr})
      * ${sourceFactorCase})
    `;

  if (dedup) {
    return {
      sql: `WITH ranked AS (
           SELECT
             p.slug, p.id as page_id, p.title, p.type, p.source_id,
             p.effective_date, p.effective_date_source,
             CASE WHEN NULLIF(regexp_replace(p.frontmatter->>'message_id', '^[[:space:]]+|[[:space:]]+$', '', 'g'), '') IS NOT NULL
               THEN p.frontmatter->>'message_id' END AS message_id, p.frontmatter->>'thread_id' AS thread_id,
             CASE WHEN NULLIF(regexp_replace(p.frontmatter->>'message_id', '^[[:space:]]+|[[:space:]]+$', '', 'g'), '') IS NOT NULL
               THEN NULLIF(p.frontmatter->>'subject', '') END AS source_subject,
             cc.id as chunk_id, cc.chunk_index, cc.chunk_text, cc.chunk_source,
             ${scoreExpr} AS score,
             CASE WHEN p.updated_at < (
               SELECT MAX(te.created_at) FROM timeline_entries te WHERE te.page_id = p.id
             ) THEN true ELSE false END AS stale
           FROM content_chunks cc
           JOIN pages p ON p.id = cc.page_id
           JOIN sources s ON s.id = p.source_id
           WHERE ${whereLikeClause} ${detailFilter}${extraFilter} ${hardExcludeClause} ${visibilityClause}
             AND cc.modality = 'text'
           ORDER BY score DESC
           LIMIT $${innerLimitIndex}
         ),
         ${buildBestPerPagePoolCte('ranked')}
         SELECT * FROM best_per_page
         ORDER BY score DESC, page_id ASC, chunk_id ASC
         LIMIT $${limitIndex} OFFSET $${offsetIndex}`,
      params,
    };
  }
  return {
    sql: `SELECT
           p.slug, p.id as page_id, p.title, p.type, p.source_id,
           p.effective_date, p.effective_date_source,
           CASE WHEN NULLIF(regexp_replace(p.frontmatter->>'message_id', '^[[:space:]]+|[[:space:]]+$', '', 'g'), '') IS NOT NULL
             THEN p.frontmatter->>'message_id' END AS message_id, p.frontmatter->>'thread_id' AS thread_id,
           CASE WHEN NULLIF(regexp_replace(p.frontmatter->>'message_id', '^[[:space:]]+|[[:space:]]+$', '', 'g'), '') IS NOT NULL
             THEN NULLIF(p.frontmatter->>'subject', '') END AS source_subject,
           cc.id as chunk_id, cc.chunk_index, cc.chunk_text, cc.chunk_source,
           ${scoreExpr} AS score,
           CASE WHEN p.updated_at < (
             SELECT MAX(te.created_at) FROM timeline_entries te WHERE te.page_id = p.id
           ) THEN true ELSE false END AS stale
         FROM content_chunks cc
         JOIN pages p ON p.id = cc.page_id
         JOIN sources s ON s.id = p.source_id
         WHERE ${whereLikeClause} ${detailFilter}${extraFilter} ${hardExcludeClause} ${visibilityClause}
         ORDER BY score DESC
         LIMIT $${limitIndex} OFFSET $${offsetIndex}`,
    params,
  };
}
