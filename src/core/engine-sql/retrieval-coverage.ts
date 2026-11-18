/**
 * Retrieval coverage counts (search/retrieval-coverage.ts): the pending text
 * projections, the pages held from embedding and the upgrade's index rebuild
 * progress in a read scope, once for both engines. A failed count is null
 * (unknown, never zero), as on master.
 *
 * Every statement here ran on master from the caller named on its function.
 * They keep master's text and run on master's raw path (`exec.executeRaw`)
 * unscoped, as before. A caller that swallowed a database error still does;
 * a refused capability is never swallowed (engine-capability-refusal.ts).
 */
import { budgetRowAppliesFilter } from '../page-size-policy.ts';
import { projectionClassSql } from '../page-state/projection-class.ts';
import { servedTextProjectionFilter } from '../search/safe-chunks.ts';
import {
  COVERAGE_COUNT_CAP, coverageScopeFilters, type CoverageRelevance, type ProjectionRebuildProgress, type ScopedCount,
} from '../search/retrieval-coverage.ts';
import type { ProjectionReadinessScope } from '../search/projection-readiness.ts';
import type { SqlExecutor } from './executor.ts';

type Exec = Pick<SqlExecutor, 'executeRaw'>;

/**
 * Pages in scope matching `where` (over `pages p` joined to `sources s` and `join`), up to the cap, and how many could affect the query.
 * `classed` also counts the could-affect images in the `sealable` or `reimport` class. Null when the count fails: unknown, never zero.
 */
async function countInScope(exec: Exec, scope: ProjectionReadinessScope, relevance: CoverageRelevance,
  join: string, where: string, classed = false): Promise<ScopedCount | null> {
  const params: unknown[] = [];
  const filters = coverageScopeFilters(scope, params);
  params.push(relevance.imageArm, relevance.all, relevance.types, relevance.patterns, relevance.pageIds);
  const n = params.length;
  const could = `(($${n - 3}::boolean OR x.type = ANY($${n - 2}::text[]) OR x.haystack ~ ANY($${n - 1}::text[]) OR x.id = ANY($${n}::int[]))
    AND ($${n - 4}::boolean OR x.page_kind IS DISTINCT FROM 'image' OR x.id = ANY($${n}::int[])))`;
  const top = relevance.exactTopPageId;
  if (top !== null) params.push(top);
  try {
    const [row] = await exec.executeRaw<{ total: number | string; could_affect: number | string; could_affect_images?: number | string; top_counted?: boolean | null }>(
      `SELECT count(*)::int AS total,
        count(*) FILTER (WHERE ${could})::int AS could_affect${classed ? `,
        count(*) FILTER (WHERE ${could} AND x.class IN ('sealable','reimport'))::int AS could_affect_images` : ''}${top === null ? '' : `,
        EXISTS (SELECT 1 FROM pages p JOIN sources s ON s.id = p.source_id ${join} WHERE p.id = $${n + 1}::int AND p.deleted_at IS NULL AND ${where}) AS top_counted`}
      FROM (SELECT p.id, p.type, p.page_kind, lower(COALESCE(p.title, '') || ' ' || p.slug) AS haystack${classed ? `, ${projectionClassSql('p', 's')} AS class` : ''}
        FROM pages p JOIN sources s ON s.id = p.source_id ${join}
        WHERE p.deleted_at IS NULL AND ${where} AND ${filters.join(' AND ')}
        LIMIT ${COVERAGE_COUNT_CAP}) x`,
      params,
    );
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
  return countInScope(exec, scope, relevance, '',
    `NOT ${servedTextProjectionFilter('p')} AND ${projectionClassSql('p', 's')} NOT IN ('protected','archived')`, true);
}

/** Pages in scope held from embedding: a held or capped budget row that still applies, on a page no `embed_skip` marker keeps out of embedding for good. */
export function countEmbeddingHeldPages(exec: Exec, scope: ProjectionReadinessScope, relevance: CoverageRelevance): Promise<ScopedCount | null> {
  return countInScope(exec, scope, relevance, 'JOIN page_embedding_budget b ON b.page_id = p.id',
    `${budgetRowAppliesFilter('b', 'p')} AND NOT (COALESCE(p.frontmatter, '{}'::jsonb) ? 'embed_skip')`);
}

/**
 * #9192: progress of the index rebuild an upgrade's activation queued (rows still queued with reason
 * `protocol_activation`), over the pages in scope: how many are done of the total, and the rate measured from the
 * start of the rebuild. Null when no such rebuild is running or the count fails.
 */
export async function projectionRebuildProgress(exec: Exec, scope: ProjectionReadinessScope): Promise<ProjectionRebuildProgress | null> {
  const params: unknown[] = [];
  const filters = coverageScopeFilters(scope, params);
  try {
    const [row] = await exec.executeRaw<{ seconds: number | null; total: number; done: number }>(
      `WITH started AS (SELECT EXTRACT(EPOCH FROM now() - min(updated_at))::float8 AS seconds FROM page_projection_jobs WHERE reason = 'protocol_activation')
      SELECT started.seconds, count(p.id)::int AS total,
        count(p.id) FILTER (WHERE p.text_projection_revision IS NOT DISTINCT FROM p.knowledge_revision)::int AS done
      FROM started LEFT JOIN (pages p JOIN sources s ON s.id = p.source_id) ON started.seconds IS NOT NULL AND p.deleted_at IS NULL
        AND ${projectionClassSql('p', 's')} NOT IN ('protected','archived') AND ${filters.join(' AND ')}
      GROUP BY started.seconds`, params);
    if (row?.seconds === null || row?.seconds === undefined) return null;
    const done = Number(row.done), total = Number(row.total), seconds = Number(row.seconds);
    return { done, total, pages_per_second: seconds > 0 && done > 0 ? done / seconds : null };
  } catch {
    return null;
  }
}
