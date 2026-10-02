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

  let modelParam: string | undefined;
  if (resolvedCol.name === 'embedding') modelParam = bind(resolvedCol.embeddingModel || null);
  const relaxed = indexed && modelParam !== undefined && opts?.vectorLegacyGuard !== true;
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

  const statement = (exact: boolean) => {
    const relax = relaxed && !exact;
    return `
      WITH hnsw_candidates AS (
        SELECT
          p.slug, p.id as page_id, p.title, p.type, p.source_id,${dialect === 'pglite' ? ' p.updated_at,' : ''}
          p.effective_date, p.effective_date_source,
          CASE WHEN NULLIF(regexp_replace(p.frontmatter->>'message_id', '^[[:space:]]+|[[:space:]]+$', '', 'g'), '') IS NOT NULL
            THEN p.frontmatter->>'message_id' END AS message_id, p.frontmatter->>'thread_id' AS thread_id,
          CASE WHEN NULLIF(regexp_replace(p.frontmatter->>'message_id', '^[[:space:]]+|[[:space:]]+$', '', 'g'), '') IS NOT NULL
            THEN NULLIF(p.frontmatter->>'subject', '') END AS source_subject,
          cc.id as chunk_id, cc.chunk_index, cc.chunk_text, cc.chunk_source,
          (${unverifiedExtractionFragment('p')}) AS unverified_stub,${relax ? `
          ${hashCurrent} AS hash_current,` : ''}
          1 - (cc.${col} <=> ${castSql}) AS raw_score
        ${candidateFrom(relax ? relaxedGeneration : guardedGeneration)}
        ORDER BY ${exact ? '(' : ''}cc.${col} <=> ${castSql}${exact ? ') + 0' : ''}
        LIMIT ${innerLimitParam}
      ),
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
  };

  return {
    sql: statement(false),
    exactSql: statement(true),
    hasMoreSql: `SELECT count(*)::int AS eligible FROM (
            SELECT 1 ${candidateFrom(guardedGeneration)} AND $1::text IS NOT NULL LIMIT $${innerLimitIdx + 1}
          ) eligible`,
    params,
    innerLimitIdx,
    innerLimit,
    indexed,
    relaxed,
  };
}
