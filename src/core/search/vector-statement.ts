/**
 * The vector-search statement, built once for both engines, the doctor
 * `vector_plan` check and the plan-proof E2E so the SQL they run or EXPLAIN
 * can never drift (#5824).
 *
 * Content freshness (`embedded_text_hash = md5(chunk_text)`) is an expression
 * Postgres has no statistics for. Inside the HNSW candidate CTE the planner
 * estimates it at 0.5% selectivity, expects to walk most of the index for
 * `ORDER BY embedding <=> $q LIMIT n`, and picks a sequential scan that hits
 * the vector deadline on large brains. On an HNSW-indexed column the
 * candidate CTE therefore carries only the well-estimated model check
 * (relaxed variant); freshness is projected as `hash_current` and filtered in
 * `scored`, so a stale-text chunk still never reaches results. The guarded
 * variant (freshness inside the CTE) serves non-indexed columns, the legacy
 * guard rollback, the exact fallback and the `hasMore` exhaustion witness.
 *
 * `candidate_pool` counts raw candidate rows (a full raw window escalates, a
 * short one means the index ran dry); `eligible_pool` counts the fresh ones
 * and is what `hasMore` compares against its guarded count.
 *
 * `indexWalkSql` (relaxed variant only) runs first. Even with freshness out
 * of the CTE, the joined statement's plan sits on a cost knife edge: TOASTed
 * vectors make a sequential scan look cheap, the HNSW estimate grows with
 * `hnsw.ef_search` (the window), and the private-page rule's correlated
 * subplans price every page lookup so high that the planner filters all
 * pages up front. A 25k-chunk brain flips to a full scan, sort and
 * nested-loop join at a 50-row limit or on any remote read. The index walk
 * orders `content_chunks` alone (`ann`, chunk-level filters only, twice the
 * window, scaled by 1/share for a source scope), then joins pages and
 * sources by key and applies every page filter to those rows, keeping the
 * nearest `innerLimit` eligible ones: the same set the joined statement
 * selects whenever that many survive. Callers run it with sorting disabled so
 * the HNSW scan is the only ordered path, accept it when its window is full,
 * and otherwise run the joined statement as before, whose plans stay with the
 * planner for selective filters. A type or date filter skips the walk: it is
 * an explicit narrowing that usually leaves the window short, so the walk
 * would only add its cost. So does a source scope whose share of pages
 * (`pages.source_id` planner statistics, `scope.share`) is below
 * INDEX_WALK_MIN_SCOPE_SHARE: the nearest chunks overall rarely fill its
 * window.
 *
 * `scopeScanSql` serves a source scope under SCOPE_SCAN_MAX_SHARE of pages
 * whose estimated chunk count (`scope.chunks`, SCOPE_CHUNKS_SQL's sampled
 * count) is at most SCOPE_SCAN_MAX_CHUNKS: an exact
 * distance scan over the scope's chunks with every filter applied, ordering
 * only chunk ids (`+ 0` keeps the index out), then the window joins back for
 * its columns. The eligible page ids come first as `= ANY(ARRAY(...))`, so
 * chunks are always reached through `idx_chunks_page`: joined inline, the
 * private-page rule's estimate flipped the scan to a sequential scan of every
 * chunk with a nested-loop join filter and ran the rule once per chunk
 * (1.1 s for a 40k-chunk scope at 50k pages, 9-22 s for a 74k-chunk one). It is complete by construction, where a filtered HNSW scan of
 * a mid-share scope returned a fraction of the true neighbours, and it costs
 * a few microseconds per scope chunk. Up to SCOPE_SCAN_FIRST_MAX_CHUNKS it
 * replaces the walk; above that the walk runs first (fast when the scope's
 * chunks spread through the space) and the scan answers when the walk comes
 * back short, as it does for a scope clustered away from the query. Callers
 * accept the scan when it fills the limit or its window is short (the scope
 * ran out of eligible chunks).
 */
import type { SearchOpts } from '../types.ts';
import { hnswIndexExpected } from '../vector-index.ts';
import { unverifiedExtractionFragment } from '../extraction-review.ts';
import { buildVectorCastFragment, normalizeEngineColumn } from './embedding-column.ts';
import { resolveBoostMap, resolveHardExcludes } from './source-boost.ts';
import { buildBestPerPagePoolCte, buildHardExcludeClause, buildSourceFactorCase, buildVisibilityClause } from './sql-ranking.ts';

export const VECTOR_EXTENSION_VERSION_SQL = `SELECT extversion FROM pg_extension WHERE extname = 'vector'`;
export const SET_STATEMENT_TIMEOUT_SQL = `SELECT set_config('statement_timeout', $1, true)`;

export interface VectorSearchStatementInput {
  dialect: 'postgres' | 'pglite';
  embedding: Float32Array;
  limit: number;
  offset: number;
  opts?: SearchOpts;
  /**
   * Estimated share of pages and chunks the source scope holds
   * (`vectorScopeLoader`): below INDEX_WALK_MIN_SCOPE_SHARE the walk is
   * omitted; at most SCOPE_SCAN_MAX_CHUNKS adds the scope scan.
   */
  scope?: VectorScope;
}

export interface VectorSearchStatement {
  /** ANN statement; `params[innerLimitIdx]` is the candidate window. */
  sql: string;
  /** Exact scan with the full guard (`+ 0` disables the index); bind `null` at innerLimitIdx. */
  exactSql: string;
  /** Guarded eligibility witness; bind `[...params.slice(0, innerLimitIdx), pool + 1]`. */
  hasMoreSql: string;
  params: unknown[];
  innerLimitIdx: number;
  innerLimit: number;
  indexed: boolean;
  /** True when freshness moved out of the candidate CTE (indexed `embedding`, legacy guard off). */
  relaxed: boolean;
  /** Index-walk statement (relaxed variant without a type or date filter), same parameters as `sql`; trusted when `candidate_pool` reaches the window. */
  indexWalkSql?: string;
  /** Raw rows the walk orders per window slot: INDEX_WALK_OVERFETCH, scaled by 1/share for a source scope. */
  indexWalkOverfetch: number;
  /** Exact scan over a small source scope's chunks (relaxed variant), same parameters as `sql`; runs after the walk when both exist. */
  scopeScanSql?: string;
}

/** Raw rows the index walk orders per window slot, so page filters can drop some and still fill the window. */
export const INDEX_WALK_OVERFETCH = 2;

/**
 * Session settings for the index-walk attempt: with sorting disabled, the
 * HNSW scan is the only path that delivers `ann` in distance order.
 */
export const INDEX_WALK_SETTINGS: Readonly<Record<string, string>> = { enable_sort: 'off' };

/** Source scopes holding a smaller share of pages skip the index walk. */
export const INDEX_WALK_MIN_SCOPE_SHARE = 0.04;

/**
 * Source scopes under SCOPE_SCAN_MAX_SHARE of pages get the exact scope scan
 * up to SCOPE_SCAN_MAX_CHUNKS (counted, SCOPE_CHUNKS_SQL): first when at most
 * SCOPE_SCAN_FIRST_MAX_CHUNKS, otherwise after the walk comes back short.
 * The scan costs about 5 µs per scope chunk (75k chunks: 340 ms, 157k:
 * 760 ms on a 50k-page brain), so the 120k cap keeps the fallback near
 * 600 ms, under the joined statement's 820 ms on a clustered 75k-chunk scope
 * and well inside the attempt's 2 s budget. The cap was 60k when the count
 * was the page share of chunk reltuples, which put that 75k-chunk scope at
 * 39k.
 */
export const SCOPE_SCAN_MAX_SHARE = 0.3;
export const SCOPE_SCAN_FIRST_MAX_CHUNKS = 25_000;
export const SCOPE_SCAN_MAX_CHUNKS = 120_000;

/** Walk overfetch for a scope holding `share` of pages: the window keeps about INDEX_WALK_OVERFETCH in-scope rows per slot. */
export function indexWalkOverfetch(share: number | undefined): number {
  return share === undefined || share >= 1 ? INDEX_WALK_OVERFETCH : Math.ceil(INDEX_WALK_OVERFETCH / Math.max(share, INDEX_WALK_MIN_SCOPE_SHARE));
}

/** Planner statistics for `pages.source_id`; PGLite analyzes `pages` itself (planner-stats.ts), Postgres through autovacuum. */
export const PAGE_SOURCE_STATS_SQL = `SELECT most_common_vals::text::text[] AS sources, most_common_freqs AS freqs, n_distinct, null_frac,
    (SELECT reltuples FROM pg_class WHERE oid = 'pages'::regclass) AS reltuples,
    (SELECT reltuples FROM pg_class WHERE oid = 'content_chunks'::regclass) AS chunk_reltuples
  FROM pg_stats WHERE schemaname = current_schema() AND tablename = 'pages' AND attname = 'source_id'`;

export interface PageSourceStats {
  sources: string[] | null;
  freqs: number[] | null;
  n_distinct: number;
  null_frac: number;
  reltuples: number;
  /** `content_chunks` reltuples; -1 or absent when never analyzed. */
  chunk_reltuples?: number;
}

export interface VectorScope {
  share: number;
  /**
   * Estimated chunks in the scope: SCOPE_CHUNKS_SQL's count for a scope under
   * SCOPE_SCAN_MAX_SHARE, else the share times `content_chunks` reltuples;
   * absent without either.
   */
  chunks?: number;
}

/** Pages of a source scope whose chunks SCOPE_CHUNKS_SQL counts; a smaller scope has every page counted. */
export const SCOPE_CHUNK_SAMPLE_PAGES = 400;

/**
 * Chunks in a source scope (`$1`, source ids): its live pages, and the chunks
 * of a hash-stride sample of about SCOPE_CHUNK_SAMPLE_PAGES of them through
 * `idx_chunks_page`. Page share alone undercounts a source of long pages (a
 * sessions-like source holds 9.4 chunks per page against a brain average of
 * 5), which sent a 74k-chunk scope down the path sized for 39k. The sample is
 * deterministic (`hashint4`, so interleaved page ids do not alias a stride)
 * and costs one pass over the scope's page ids plus ~400 index probes.
 */
export const SCOPE_CHUNKS_SQL = `WITH scope_pages AS MATERIALIZED (
    SELECT id FROM pages WHERE source_id = ANY($1::text[]) AND deleted_at IS NULL),
  total AS (SELECT count(*)::int AS pages FROM scope_pages),
  sample AS (SELECT id FROM scope_pages, total WHERE hashint4(id) % GREATEST(1, total.pages / ${SCOPE_CHUNK_SAMPLE_PAGES}) = 0)
  SELECT (SELECT pages FROM total) AS pages, (SELECT count(*)::int FROM sample) AS sampled,
    (SELECT count(*)::int FROM content_chunks WHERE page_id = ANY(ARRAY(SELECT id FROM sample))) AS sample_chunks`;

export interface ScopeChunkCount {
  pages: number;
  sampled: number;
  sample_chunks: number;
}

/** Share of pages the source scope holds, or undefined without a scope or statistics. */
export function sourceScopeShare(stats: PageSourceStats | undefined, opts?: SearchOpts): number | undefined {
  const scope = scopeSourceIds(opts);
  if (!scope || !stats) return undefined;
  const sources = stats.sources ?? [];
  const freqs = (stats.freqs ?? []).map(Number);
  const distinct = Number(stats.n_distinct) < 0 ? -Number(stats.n_distinct) * Number(stats.reltuples) : Number(stats.n_distinct);
  const unlisted = Math.max(0, 1 - Number(stats.null_frac) - freqs.reduce((sum, freq) => sum + freq, 0)) / Math.max(1, distinct - sources.length);
  return scope.reduce((sum, id) => sum + (sources.includes(id) ? freqs[sources.indexOf(id)]! : unlisted), 0);
}

function scopeSourceIds(opts?: SearchOpts): string[] | undefined {
  const scope = opts?.sourceIds?.length ? opts.sourceIds : opts?.sourceId ? [opts.sourceId] : undefined;
  return scope && [...new Set(scope)];
}

/**
 * Share of pages and estimated chunks the source scope holds, or undefined
 * without a scope or statistics. A SCOPE_CHUNKS_SQL count, when given and
 * sampled, replaces the share-of-reltuples chunk estimate.
 */
export function sourceScope(stats: PageSourceStats | undefined, opts?: SearchOpts, counted?: ScopeChunkCount): VectorScope | undefined {
  const share = sourceScopeShare(stats, opts);
  if (share === undefined) return undefined;
  const sampled = Number(counted?.sampled ?? 0);
  if (sampled > 0) return { share, chunks: Math.round((Number(counted!.pages) * Number(counted!.sample_chunks)) / sampled) };
  const chunks = Number(stats?.chunk_reltuples ?? -1);
  return chunks > 0 ? { share, chunks: share * chunks } : { share };
}

/**
 * The engines' scope lookup, only for source-scoped searches:
 * PAGE_SOURCE_STATS_SQL through `load` at most once a minute, and for a scope
 * under SCOPE_SCAN_MAX_SHARE of pages (the only scopes whose chunk count picks
 * a path) SCOPE_CHUNKS_SQL through `count`, refreshed at most once a minute
 * per scope. The count never blocks a search: until a scope's first count
 * lands, and while a refresh runs, the search routes on the last count or the
 * share estimate. (`count` runs on the engine's own pool, so a search inside
 * a caller's transaction on a one-connection pool would otherwise wait on
 * itself.) The estimate only picks the walk, the scope scan or the joined
 * statement, each of which falls back to the joined statement when it comes
 * back short, so stale or missing statistics, or a failed count, cost speed
 * at most.
 */
export function vectorScopeLoader(
  load: () => Promise<PageSourceStats[]>,
  count?: (sourceIds: string[]) => Promise<ScopeChunkCount[]>,
): (opts?: SearchOpts) => Promise<VectorScope | undefined> {
  let cached: { at: number; stats: Promise<PageSourceStats | undefined> } | undefined;
  const counts = new Map<string, { at: number; value?: ScopeChunkCount }>();
  return async opts => {
    const ids = scopeSourceIds(opts);
    if (!ids) return undefined;
    if (!cached || performance.now() - cached.at > 60_000) cached = { at: performance.now(), stats: load().then(rows => rows[0], () => undefined) };
    const stats = await cached.stats;
    const share = sourceScopeShare(stats, opts);
    if (!count || share === undefined || share >= SCOPE_SCAN_MAX_SHARE) return sourceScope(stats, opts);
    const key = [...ids].sort().join('\u0000');
    const entry = counts.get(key);
    if (!entry || performance.now() - entry.at > 60_000) {
      const next: { at: number; value?: ScopeChunkCount } = { at: performance.now(), value: entry?.value };
      counts.set(key, next);
      count(ids).then(rows => { if (rows[0]) next.value = rows[0]; }, () => { /* keep the last count or the share estimate */ });
    }
    return sourceScope(stats, opts, counts.get(key)!.value);
  };
}

export function buildVectorSearchStatement(input: VectorSearchStatementInput): VectorSearchStatement {
  const { dialect, limit, offset, opts } = input;
  const resolvedCol = normalizeEngineColumn(opts?.embeddingColumn);
  const indexed = hnswIndexExpected(resolvedCol.type, resolvedCol.dimensions);
  // innerLimit scales with offset to preserve the pagination contract.
  const innerLimit = offset + Math.max(limit * 5, 100);
  // issue #160: the guard predicate is projected as `unverified_stub` so
  // unverified auto-extracted stubs get factor 1.0 inside the re-rank.
  const sourceFactorCaseOnSlug = buildSourceFactorCase('slug', opts?.source_boosts ?? resolveBoostMap(), opts?.detail, 'unverified_stub');
  const hardExcludeClause = buildHardExcludeClause('p.slug', resolveHardExcludes(opts?.exclude_slug_prefixes, opts?.include_slug_prefixes));

  const params: unknown[] = ['[' + Array.from(input.embedding).join(',') + ']'];
  const bind = (value: unknown) => { params.push(value); return `$${params.length}`; };
  const filters: string[] = [];
  if (opts?.detail === 'low') filters.push(`AND cc.chunk_source = 'compiled_truth'`);
  if (opts?.type) filters.push(`AND p.type = ${bind(opts.type)}`);
  // v0.33: multi-type filter for whoknows, AND-applied with `type`.
  if (opts?.types && opts.types.length > 0) filters.push(`AND p.type = ANY(${bind(opts.types)}::text[])`);
  if (opts?.exclude_slugs?.length) filters.push(`AND p.slug != ALL(${bind(opts.exclude_slugs)}::text[])`);
  if (opts?.language) filters.push(`AND cc.language = ${bind(opts.language)}`);
  if (opts?.symbolKind) filters.push(`AND cc.symbol_type = ${bind(opts.symbolKind)}`);
  // v0.29.1: since/until filter by effective date, with import-time fallback.
  // Spelled per column rather than as COALESCE(effective_date, updated_at,
  // created_at) <op> $n: same rows, but each arm has column statistics. The
  // planner estimates a since+until pair on the COALESCE at 0.5% and drops
  // the HNSW index exactly as it did for the freshness guard (#5824).
  const dateBound = (op: string, value: string) => {
    const bound = `${bind(value)}::text::timestamptz`;
    return `AND (p.effective_date ${op} ${bound} OR (p.effective_date IS NULL AND (p.updated_at ${op} ${bound} OR (p.updated_at IS NULL AND p.created_at ${op} ${bound}))))`;
  };
  if (opts?.afterDate) filters.push(dateBound(opts.afterDateInclusive ? '>=' : '>', opts.afterDate));
  if (opts?.beforeDate) filters.push(dateBound(opts.beforeDateInclusive ? '<=' : '<', opts.beforeDate));
  // v0.34.1 (#861): source isolation in the INNER CTE narrows the HNSW
  // candidate set before re-rank. Array form wins over scalar.
  if (opts?.sourceIds && opts.sourceIds.length > 0) filters.push(`AND p.source_id = ANY(${bind(opts.sourceIds)}::text[])`);
  else if (opts?.sourceId) filters.push(`AND p.source_id = ${bind(opts.sourceId)}`);
  // The index walk applies chunk-level filters while it orders the index and page-level ones after the key joins.
  const chunkFilters = filters.filter(sql => sql.startsWith('AND cc.'));
  const pageFilters = filters.filter(sql => !sql.startsWith('AND cc.'));

  let modelParam: string | undefined;
  if (resolvedCol.name === 'embedding') modelParam = bind(resolvedCol.embeddingModel || null);
  const relaxed = indexed && modelParam !== undefined && opts?.vectorLegacyGuard !== true;
  // A type or date filter, or a source scope with a small share of pages, is
  // the caller narrowing the search; the walk would usually come back short,
  // so those keep the joined statement alone.
  const share = input.scope?.share, chunks = input.scope?.chunks;
  const narrowed = !!(opts?.type || opts?.types?.length || opts?.afterDate || opts?.beforeDate)
    || (share !== undefined && share < INDEX_WALK_MIN_SCOPE_SHARE);
  const scopeScan = relaxed && share !== undefined && share < SCOPE_SCAN_MAX_SHARE && chunks !== undefined && chunks <= SCOPE_SCAN_MAX_CHUNKS;
  const walk = relaxed && !narrowed && !(scopeScan && chunks! <= SCOPE_SCAN_FIRST_MAX_CHUNKS);
  const overfetch = indexWalkOverfetch(share);
  const preMigration = modelParam ? `(${modelParam}::text IS NULL AND NOT EXISTS(SELECT 1 FROM config WHERE key='embedding_migration.state'))` : '';
  const hashCurrent = `(cc.embedded_text_hash=md5(cc.chunk_text) OR cc.embedded_text_hash IS NULL)`;
  const guardedGeneration = modelParam ? `AND ((cc.model=${modelParam} AND ${hashCurrent})
        OR ${preMigration})` : '';
  const relaxedGeneration = modelParam ? `AND (cc.model=${modelParam} OR ${preMigration})` : '';

  const innerLimitParam = bind(innerLimit);
  const innerLimitIdx = params.length - 1;
  const limitParam = bind(limit);
  const offsetParam = bind(offset);

  // v0.36 Phase 3: 'embedding_multimodal' carries text and image content, so
  // the column itself is the discriminator; the others filter by modality.
  const { col, castSql } = buildVectorCastFragment(resolvedCol);
  const modalityFilter = resolvedCol.name === 'embedding_image' ? `AND cc.modality = 'image'`
    : resolvedCol.name === 'embedding_multimodal' ? '' : `AND cc.modality = 'text'`;
  // v0.26.5: visibility in the inner CTE so hidden rows never take candidate slots.
  const visibilityClause = buildVisibilityClause('p', 's', opts);
  const candidateFrom = (generation: string) => `FROM content_chunks cc
        JOIN pages p ON p.id = cc.page_id
        JOIN sources s ON s.id = p.source_id
        WHERE cc.${col} IS NOT NULL ${modalityFilter}
          ${filters.join('\n          ')}
          ${generation}
          ${hardExcludeClause}
          ${visibilityClause}`;
  const freshFilter = `${modelParam}::text IS NULL OR hash_current`;

  const candidateColumns = `p.slug, p.id as page_id, p.title, p.type, p.source_id,${dialect === 'pglite' ? ' p.updated_at,' : ''}
          p.effective_date, p.effective_date_source,
          CASE WHEN NULLIF(regexp_replace(p.frontmatter->>'message_id', '^[[:space:]]+|[[:space:]]+$', '', 'g'), '') IS NOT NULL
            THEN p.frontmatter->>'message_id' END AS message_id, p.frontmatter->>'thread_id' AS thread_id,
          CASE WHEN NULLIF(regexp_replace(p.frontmatter->>'message_id', '^[[:space:]]+|[[:space:]]+$', '', 'g'), '') IS NOT NULL
            THEN NULLIF(p.frontmatter->>'subject', '') END AS source_subject,
          cc.id as chunk_id, cc.chunk_index, cc.chunk_text, cc.chunk_source,
          (${unverifiedExtractionFragment('p')}) AS unverified_stub,`;

  const joinedCandidates = (exact: boolean) => {
    const relax = relaxed && !exact;
    return `
      WITH hnsw_candidates AS (
        SELECT
          ${candidateColumns}${relax ? `
          ${hashCurrent} AS hash_current,` : ''}
          1 - (cc.${col} <=> ${castSql}) AS raw_score
        ${candidateFrom(relax ? relaxedGeneration : guardedGeneration)}
        ORDER BY ${exact ? '(' : ''}cc.${col} <=> ${castSql}${exact ? ') + 0' : ''}
        LIMIT ${innerLimitParam}
      ),`;
  };

  const indexWalkCandidates = `
      WITH ann AS MATERIALIZED (
        SELECT cc.id, cc.${col} <=> ${castSql} AS distance
        FROM content_chunks cc
        WHERE cc.${col} IS NOT NULL ${modalityFilter}
          ${chunkFilters.join('\n          ')}
          ${relaxedGeneration}
        ORDER BY cc.${col} <=> ${castSql}
        LIMIT ${innerLimitParam}::int * ${overfetch}
      ),
      hnsw_candidates AS (
        SELECT
          ${candidateColumns}
          ${hashCurrent} AS hash_current,
          1 - ann.distance AS raw_score
        FROM ann
        JOIN content_chunks cc ON cc.id = ann.id
        JOIN pages p ON p.id = cc.page_id
        CROSS JOIN LATERAL (SELECT src.archived FROM sources src WHERE src.id = p.source_id OFFSET 0) s
        WHERE true
          ${pageFilters.join('\n          ')}
          ${hardExcludeClause}
          ${visibilityClause}
        ORDER BY ann.distance, ann.id
        LIMIT ${innerLimitParam}::int
      ),`;

  const scopeScanCandidates = `
      WITH scope_scan AS MATERIALIZED (
        SELECT cc.id
        FROM content_chunks cc
        WHERE cc.page_id = ANY(ARRAY(
            SELECT p.id
            FROM pages p
            JOIN sources s ON s.id = p.source_id
            WHERE true
              ${pageFilters.join('\n              ')}
              ${hardExcludeClause}
              ${visibilityClause}
          ))
          AND cc.${col} IS NOT NULL ${modalityFilter}
          ${chunkFilters.join('\n          ')}
          ${relaxedGeneration}
        ORDER BY (cc.${col} <=> ${castSql}) + 0, cc.id
        LIMIT ${innerLimitParam}
      ),
      hnsw_candidates AS (
        SELECT
          ${candidateColumns}
          ${hashCurrent} AS hash_current,
          1 - (cc.${col} <=> ${castSql}) AS raw_score
        FROM scope_scan
        JOIN content_chunks cc ON cc.id = scope_scan.id
        JOIN pages p ON p.id = cc.page_id
      ),`;

  const statement = (candidates: string, relax: boolean) => `${candidates}
      -- score computed as a select-list expr (NOT in the inner ORDER BY, which
      -- must stay pure-distance so the HNSW index is usable).
      scored AS (
        SELECT *, raw_score * ${sourceFactorCaseOnSlug} AS score
        FROM hnsw_candidates${relax ? `
        WHERE ${freshFilter}` : ''}
      ),
      -- Collapse to the best chunk PER PAGE over the full candidate set before
      -- the user LIMIT (shared with the keyword arm in both engines).
      ${buildBestPerPagePoolCte('scored')},
      page_results AS (
      SELECT
        bpp.slug, bpp.page_id, bpp.title, bpp.type, bpp.source_id,
        bpp.effective_date, bpp.effective_date_source,
        bpp.message_id, bpp.thread_id, bpp.source_subject,
        bpp.chunk_id, bpp.chunk_index, bpp.chunk_text, bpp.chunk_source,
        bpp.score,
        ${dialect === 'pglite' ? `CASE WHEN bpp.updated_at < (
          SELECT MAX(te.created_at) FROM timeline_entries te WHERE te.page_id = bpp.page_id
        ) THEN true ELSE false END` : 'false'} AS stale
      FROM best_per_page bpp
      -- v0.41.13: stable tiebreaker for tied scores (planner-independent order).
      ORDER BY bpp.score DESC, bpp.page_id ASC, bpp.chunk_id ASC
      LIMIT ${limitParam}
      OFFSET ${offsetParam}
      )
      SELECT page_results.*, pool.candidate_pool, pool.eligible_pool
      FROM (SELECT count(*)::int AS candidate_pool, ${relax ? `(count(*) FILTER (WHERE ${freshFilter}))::int` : 'count(*)::int'} AS eligible_pool
        FROM hnsw_candidates) pool
      LEFT JOIN page_results ON true
      ORDER BY score DESC NULLS LAST, page_id ASC, chunk_id ASC
    `;

  return {
    sql: statement(joinedCandidates(false), relaxed),
    exactSql: statement(joinedCandidates(true), false),
    hasMoreSql: `SELECT count(*)::int AS eligible FROM (
            SELECT 1 ${candidateFrom(guardedGeneration)} AND $1::text IS NOT NULL LIMIT $${innerLimitIdx + 1}
          ) eligible`,
    params,
    innerLimitIdx,
    innerLimit,
    indexed,
    relaxed,
    indexWalkOverfetch: overfetch,
    ...(walk ? { indexWalkSql: statement(indexWalkCandidates, true) } : {}),
    ...(scopeScan ? { scopeScanSql: statement(scopeScanCandidates, true) } : {}),
  };
}
