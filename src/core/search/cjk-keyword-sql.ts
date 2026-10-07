/**
 * Shared CJK keyword-fallback SQL builder (#3986).
 *
 * `websearch_to_tsquery` with an ASCII-stemming FTS config ('english', …)
 * can't tokenize CJK, so FTS keyword recall is zero for Chinese / Japanese /
 * Korean queries. Both engines fall back to a term-by-term LIKE/ILIKE match with
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
 *   - Explicit `ESCAPE '\'` on LIKE/ILIKE clauses; caseless terms use LIKE.
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

/**
 * `match: 'all'` (default) is today's strict AND; `'any'` is the OR fallback
 * (#6043): a chunk matching any term qualifies and ranks by how many terms it
 * matches, then by the usual term-frequency score, so all-term chunks always
 * outrank partial ones. `candidateIds` restricts scoring to a candidate set
 * from `buildCJKCandidateSql` (the capped retry, #5989).
 */
export interface CjkKeywordVariant {
  match?: 'all' | 'any';
  candidateIds?: number[];
}

/** Bound for the matched-term count inside the OR score, above any realistic per-chunk TF sum. */
const MATCHED_TERM_WEIGHT = 1000;

export function buildCJKKeywordSql(query: string, ctx: CjkKeywordCtx, variant: CjkKeywordVariant = {}): CjkKeywordSql | null {
  const { limit, offset, innerLimit, sourceFactorCase, hardExcludeClause, visibilityClause, detailFilter, opts, dedup } = ctx;
  const qRaw = query;
  if (qRaw.length === 0) return null;
  const terms = splitCJKQueryTerms(qRaw);
  if (terms.length === 0) return null;
  const any = variant.match === 'any' && terms.length > 1;

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

  const extraFilter = shapeFilters(opts, params);
  let fromClause = 'content_chunks cc';
  if (variant.candidateIds) {
    params.push(variant.candidateIds);
    fromClause = `unnest($${params.length}::bigint[]) AS cand(id) JOIN content_chunks cc ON cc.id = cand.id`;
  }
  const { whereLikeClause, matchedExpr } = likeClauses(terms, likeParamIndices, any);

  const termFreqExpr = rawTermIndices
    .map(idx => `((LENGTH(cc.chunk_text) - LENGTH(REPLACE(cc.chunk_text, $${idx}, ''))) / NULLIF(LENGTH($${idx}), 0)::real)`)
    .join(' + ');

  const qRawBonusExpr = terms.length > 1
    ? ` + ((LENGTH(cc.chunk_text) - LENGTH(REPLACE(cc.chunk_text, $${qRawIndex}, ''))) / NULLIF(LENGTH($${qRawIndex}), 0)::real)`
    : '';

  const positionExpr = `COALESCE(1.0 / NULLIF(POSITION($${qRawIndex} IN cc.chunk_text), 0)::real, 0.0)`;
  const orderExpr = any ? `(${matchedExpr}) DESC, score DESC` : 'score DESC';

  // Term-frequency count: count occurrences of each term in chunk_text via
  // (length(chunk) - length(replace(chunk, term, ''))) / length(term),
  // plus bonus for contiguous raw query occurrences when multi-term, and
  // position()-tiebreaker so earlier-in-chunk hits outrank later ones.
  // The OR fallback adds the matched-term count outside the source factor,
  // so a boosted partial match never outscores an all-term chunk.
  const tfScoreExpr = `
      ((${termFreqExpr}${qRawBonusExpr}
        + ${positionExpr})
      * ${sourceFactorCase})
    `;
  const scoreExpr = any ? `(${MATCHED_TERM_WEIGHT} * (${matchedExpr}) + ${tfScoreExpr})` : tfScoreExpr;
  return assemble({ dedup, fromClause, scoreExpr, orderExpr, whereLikeClause, detailFilter, extraFilter, hardExcludeClause, visibilityClause, innerLimitIndex, limitIndex, offsetIndex, params });
}

/**
 * The capped candidate stage (#5989): up to `cap` chunk ids matching every
 * term (`match: 'all'`) or any term (`'any'`, excluding `excludeIds`), by an
 * unordered LIKE scan with the same shape, source and visibility filters as
 * the scoring query. Ids only, so the scan stops at the cap instead of
 * scoring every match.
 */
export function buildCJKCandidateSql(
  query: string,
  ctx: CjkKeywordCtx,
  stage: { match: 'all' | 'any'; cap: number; excludeIds?: number[] },
): CjkKeywordSql | null {
  const terms = splitCJKQueryTerms(query);
  if (query.length === 0 || terms.length === 0) return null;
  const params: unknown[] = [];
  const likeParamIndices = terms.map(term => { params.push(`%${escapeLikePattern(term)}%`); return params.length; });
  let extraFilter = shapeFilters(ctx.opts, params);
  if (stage.excludeIds?.length) {
    params.push(stage.excludeIds);
    extraFilter += ` AND cc.id != ALL($${params.length}::bigint[])`;
  }
  params.push(stage.cap);
  const capIndex = params.length;
  const { whereLikeClause } = likeClauses(terms, likeParamIndices, stage.match === 'any' && terms.length > 1);
  return {
    sql: `SELECT cc.id AS chunk_id
          FROM content_chunks cc
          JOIN pages p ON p.id = cc.page_id
          JOIN sources s ON s.id = p.source_id
          WHERE ${whereLikeClause} ${ctx.detailFilter}${extraFilter} ${ctx.hardExcludeClause} ${ctx.visibilityClause}${ctx.dedup ? `
            AND cc.modality = 'text'` : ''}
          LIMIT $${capIndex}`,
    params,
  };
}

function likeClauses(terms: string[], likeParamIndices: number[], any: boolean): { whereLikeClause: string; matchedExpr: string } {
  const likes = likeParamIndices.map((idx, termIndex) => {
    const term = terms[termIndex];
    const operator = term.toLowerCase() === term.toUpperCase() ? 'LIKE' : 'ILIKE';
    return `cc.chunk_text ${operator} $${idx} ESCAPE '\\'`;
  });
  return {
    whereLikeClause: any ? `(${likes.join(' OR ')})` : likes.join(' AND '),
    matchedExpr: likes.map(l => `(${l})::int`).join(' + '),
  };
}

function shapeFilters(opts: SearchOpts | undefined, params: unknown[]): string {
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
    extraFilter += ` AND COALESCE(p.effective_date, p.updated_at, p.created_at) ${opts?.afterDateInclusive ? '>=' : '>'} $${params.length}::text::timestamptz`;
  }
  if (opts?.beforeDate) {
    params.push(opts.beforeDate);
    extraFilter += ` AND COALESCE(p.effective_date, p.updated_at, p.created_at) ${opts?.beforeDateInclusive ? '<=' : '<'} $${params.length}::text::timestamptz`;
  }
  // v0.34.1 (#861 — P0 leak seal): source-isolation on the CJK fallback path.
  if (opts?.sourceIds && opts.sourceIds.length > 0) {
    params.push(opts.sourceIds);
    extraFilter += ` AND p.source_id = ANY($${params.length}::text[])`;
  } else if (opts?.sourceId) {
    params.push(opts.sourceId);
    extraFilter += ` AND p.source_id = $${params.length}`;
  }
  return extraFilter;
}

function assemble(a: {
  dedup: boolean; fromClause: string; scoreExpr: string; orderExpr: string; whereLikeClause: string; detailFilter: string; extraFilter: string;
  hardExcludeClause: string; visibilityClause: string; innerLimitIndex: number; limitIndex: number; offsetIndex: number; params: unknown[];
}): CjkKeywordSql {
  const { dedup, fromClause, scoreExpr, orderExpr, whereLikeClause, detailFilter, extraFilter, hardExcludeClause, visibilityClause, innerLimitIndex, limitIndex, offsetIndex, params } = a;
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
           FROM ${fromClause}
           JOIN pages p ON p.id = cc.page_id
           JOIN sources s ON s.id = p.source_id
           WHERE ${whereLikeClause} ${detailFilter}${extraFilter} ${hardExcludeClause} ${visibilityClause}
             AND cc.modality = 'text'
           ORDER BY ${orderExpr}, page_id ASC, chunk_id ASC
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
         FROM ${fromClause}
         JOIN pages p ON p.id = cc.page_id
         JOIN sources s ON s.id = p.source_id
         WHERE ${whereLikeClause} ${detailFilter}${extraFilter} ${hardExcludeClause} ${visibilityClause}
         ORDER BY ${orderExpr}, page_id ASC, chunk_id ASC
         LIMIT $${limitIndex} OFFSET $${offsetIndex}`,
    params,
  };
}
