/**
 * Retrieval coverage counts (search/retrieval-coverage.ts): the pending text
 * projections, the pages held from embedding and the upgrade's index rebuild
 * progress in a read scope, once for both engines. A failed count is null
 * (unknown, never zero), as on master.
 *
 * Every statement here ran on master from the caller named on its function.
 * They keep master's text, composed with `sqlFragment` (bound values, no
 * hand-numbered placeholders), and run on master's raw path (`exec.executeRaw`)
 * unscoped, as before. A caller that swallowed a database error still does;
 * a refused capability is never swallowed (engine-capability-refusal.ts).
 */
import { budgetRowAppliesFilter } from '../page-size-policy.ts';
import { projectionClassSql } from '../page-state/projection-class.ts';
import { servedTextProjectionFilter } from '../search/safe-chunks.ts';
import {
  COVERAGE_COUNT_CAP, type CoverageRelevance, type ProjectionRebuildProgress, type ScopedCount,
} from '../search/retrieval-coverage.ts';
import type { ProjectionReadinessScope } from '../search/projection-readiness.ts';
import type { SqlExecutor } from './executor.ts';
import { joinFragments, renderFragment, sqlFragment, trustedSql, type SqlFragment } from './fragment.ts';
import { readFilter } from './search-reads.ts';

type Exec = Pick<SqlExecutor, 'executeRaw'>;

/** The read scope over `pages p` (coverageScopeFilters in search/retrieval-coverage.ts, as one fragment). */
function scopeFilter(scope: ProjectionReadinessScope): SqlFragment {
  const filters = [readFilter('p', scope, true)];
  if (scope.sourceIds?.length === 0) filters.push(sqlFragment`FALSE`);
  if (scope.pageKind) filters.push(sqlFragment`p.page_kind = ${scope.pageKind}`);
  if (scope.types) filters.push(sqlFragment`p.type = ANY(${scope.types}::text[])`);
  for (const prefix of scope.excludeSlugPrefixes ?? []) filters.push(sqlFragment`LEFT(p.slug, LENGTH(${prefix}::text)) <> ${prefix}`);
  return joinFragments(filters, ' AND ');
}

/** Render `fragment` and run it on the unscoped raw path, as master did. */
async function rows<R>(exec: Exec, fragment: SqlFragment): Promise<R[]> {
  const { text, params } = renderFragment(fragment);
  return exec.executeRaw<R>(text, params);
}

/**
 * Pages in scope matching `where` (over `pages p` joined to `sources s` and `join`), up to the cap, and how many could affect the query.
 * `classed` also counts the could-affect images in the `sealable` or `reimport` class. Null when the count fails: unknown, never zero.
 */
async function countInScope(exec: Exec, scope: ProjectionReadinessScope, relevance: CoverageRelevance,
  join: SqlFragment, where: SqlFragment, classed = false): Promise<ScopedCount | null> {
  const could = sqlFragment`((${relevance.all}::boolean OR x.type = ANY(${relevance.types}::text[]) OR x.haystack ~ ANY(${relevance.patterns}::text[]) OR x.id = ANY(${relevance.pageIds}::int[]))
    AND (${relevance.imageArm}::boolean OR x.page_kind IS DISTINCT FROM 'image' OR x.id = ANY(${relevance.pageIds}::int[])))`;
  const top = relevance.exactTopPageId;
  const images = classed ? sqlFragment`,
        count(*) FILTER (WHERE ${could} AND x.class IN ('sealable','reimport'))::int AS could_affect_images` : sqlFragment``;
  const topCounted = top === null ? sqlFragment`` : sqlFragment`,
        EXISTS (SELECT 1 FROM pages p JOIN sources s ON s.id = p.source_id ${join} WHERE p.id = ${top}::int AND p.deleted_at IS NULL AND ${where}) AS top_counted`;
  const classColumn = classed ? sqlFragment`, ${trustedSql(projectionClassSql('p', 's'))} AS class` : sqlFragment``;
  try {
    const [row] = await rows<{ total: number | string; could_affect: number | string; could_affect_images?: number | string; top_counted?: boolean | null }>(exec, sqlFragment`SELECT count(*)::int AS total,
        count(*) FILTER (WHERE ${could})::int AS could_affect${images}${topCounted}
      FROM (SELECT p.id, p.type, p.page_kind, lower(COALESCE(p.title, '') || ' ' || p.slug) AS haystack${classColumn}
        FROM pages p JOIN sources s ON s.id = p.source_id ${join}
        WHERE p.deleted_at IS NULL AND ${where} AND ${scopeFilter(scope)}
        LIMIT ${COVERAGE_COUNT_CAP}) x`);
    const total = Number(row?.total), couldAffect = Number(row?.could_affect);
    if (!Number.isFinite(total) || !Number.isFinite(couldAffect)) return null;
    return { total, could_affect: couldAffect, capped: total >= COVERAGE_COUNT_CAP, ...(top === null ? {} : { top_counted: row?.top_counted === true }),
      ...(classed ? { could_affect_images: Number(row?.could_affect_images ?? 0) } : {}) };
  } catch {
    return null;
  }
}

/** The pending pages the readiness probe found (unsealed, needing work) in the same scope. */
export function countPendingProjectionPages(exec: Exec, scope: ProjectionReadinessScope, relevance: CoverageRelevance): Promise<ScopedCount | null> {
  return countInScope(exec, scope, relevance, sqlFragment``,
    sqlFragment`NOT ${trustedSql(servedTextProjectionFilter('p'))} AND ${trustedSql(projectionClassSql('p', 's'))} NOT IN ('protected','archived')`, true);
}

/** Pages in scope held from embedding: a held or capped budget row that still applies, on a page no `embed_skip` marker keeps out of embedding for good. */
export function countEmbeddingHeldPages(exec: Exec, scope: ProjectionReadinessScope, relevance: CoverageRelevance): Promise<ScopedCount | null> {
  return countInScope(exec, scope, relevance, sqlFragment`JOIN page_embedding_budget b ON b.page_id = p.id`,
    sqlFragment`${trustedSql(budgetRowAppliesFilter('b', 'p'))} AND NOT (COALESCE(p.frontmatter, '{}'::jsonb) ? 'embed_skip')`);
}

/**
 * #9192: progress of the index rebuild an upgrade's activation queued (rows still queued with reason
 * `protocol_activation`), over the pages in scope: how many are done of the total, and the rate measured from the
 * start of the rebuild. Null when no such rebuild is running or the count fails.
 */
export async function projectionRebuildProgress(exec: Exec, scope: ProjectionReadinessScope): Promise<ProjectionRebuildProgress | null> {
  try {
    const [row] = await rows<{ seconds: number | null; total: number; done: number }>(exec, sqlFragment`WITH started AS (SELECT EXTRACT(EPOCH FROM now() - min(updated_at))::float8 AS seconds FROM page_projection_jobs WHERE reason = 'protocol_activation')
      SELECT started.seconds, count(p.id)::int AS total,
        count(p.id) FILTER (WHERE p.text_projection_revision IS NOT DISTINCT FROM p.knowledge_revision)::int AS done
      FROM started LEFT JOIN (pages p JOIN sources s ON s.id = p.source_id) ON started.seconds IS NOT NULL AND p.deleted_at IS NULL
        AND ${trustedSql(projectionClassSql('p', 's'))} NOT IN ('protected','archived') AND ${scopeFilter(scope)}
      GROUP BY started.seconds`);
    if (row?.seconds === null || row?.seconds === undefined) return null;
    const done = Number(row.done), total = Number(row.total), seconds = Number(row.seconds);
    return { done, total, pages_per_second: seconds > 0 && done > 0 ? done / seconds : null };
  } catch {
    return null;
  }
}
