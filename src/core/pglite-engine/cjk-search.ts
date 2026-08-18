/**
 * v0.32.7: CJK keyword fallback search, peeled out of PGLiteEngine
 * (containment sprint C15). Free functions over a NARROW deps surface — the
 * live PGLite handle only. Never the whole engine class.
 */
import type { PGlite } from '@electric-sql/pglite';
import type { SearchOpts, SearchResult } from '../types.ts';
import { rowToSearchResult } from '../utils.ts';
import { buildBestPerPagePoolCte } from '../search/sql-ranking.ts';
import { escapeLikePattern, splitCJKQueryTerms } from '../cjk.ts';

/** Narrow slice of PGLiteEngine the CJK search operations use. */
export interface PgliteCjkSearchDeps {
  /** Live PGLite handle. Getter-backed at the call site so the
   *  connect() check fires exactly when the original engine `db` read did. */
  readonly db: PGlite;
}

export async function searchKeywordCJK(
  deps: PgliteCjkSearchDeps,
  query: string,
  ctx: {
    limit: number;
    offset: number;
    innerLimit: number;
    sourceFactorCase: string;
    hardExcludeClause: string;
    visibilityClause: string;
    detailFilter: string;
    opts: SearchOpts | undefined;
    dedup: boolean;
  },
): Promise<SearchResult[]> {
  const { limit, offset, innerLimit, sourceFactorCase, hardExcludeClause, visibilityClause, detailFilter, opts, dedup } = ctx;
  const qRaw = query;
  if (qRaw.length === 0) return [];
  const terms = splitCJKQueryTerms(qRaw);
  if (terms.length === 0) return [];

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
    const { rows } = await deps.db.query(
      `WITH ranked AS (
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
    );
    return (rows as Record<string, unknown>[]).map(rowToSearchResult);
  } else {
    const { rows } = await deps.db.query(
      `SELECT
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
    );
    return (rows as Record<string, unknown>[]).map(rowToSearchResult);
  }
}
