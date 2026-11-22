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
 *
 * The readiness probe's two statements (search/projection-readiness.ts) run on
 * the engine's own `executeRaw` (an `EngineRawRead`), so the probe keeps its
 * JIT-off option; the probe keeps its cache and its hints.
 */
import { budgetRowAppliesFilter } from '../page-size-policy.ts';
import { projectionClassSql, textClassSql } from '../page-state/projection-class.ts';
import { servedTextProjectionFilter, waitingTextProjectionFilter } from '../search/safe-chunks.ts';
import {
  COVERAGE_COUNT_CAP, type CoverageRelevance, type ProjectionRebuildProgress, type ScopedCount,
} from '../search/retrieval-coverage.ts';
import type { ProjectionReadinessRow, ProjectionReadinessScope } from '../search/projection-readiness.ts';
import type { EngineRawRead } from './cli-reads-ops.ts';
import type { QueryOpts, Row, SqlExecutor } from './executor.ts';
import { joinFragments, renderFragment, sqlFragment, trustedSql, type SqlFragment } from './fragment.ts';
import { readFilter } from './search-reads.ts';

/** The raw path of `SqlExecutor`, plus the engine's `jitOff` option (`EngineRawRead`): the engines hand the two JIT-off counts their own `executeRaw`. */
type Exec = { executeRaw<R = Row>(sql: string, params?: unknown[], opts?: QueryOpts & { jitOff?: boolean }): Promise<R[]> };

/** The read scope over `pages p`: sources, visibility, live pages, kind, types and excluded slug prefixes. */
function scopeFilter(scope: ProjectionReadinessScope): SqlFragment {
  const filters = [readFilter('p', scope, true)];
  if (scope.sourceIds?.length === 0) filters.push(sqlFragment`FALSE`);
  if (scope.pageKind) filters.push(sqlFragment`p.page_kind = ${scope.pageKind}`);
  if (scope.types) filters.push(sqlFragment`p.type = ANY(${scope.types}::text[])`);
  for (const prefix of scope.excludeSlugPrefixes ?? []) filters.push(sqlFragment`LEFT(p.slug, LENGTH(${prefix}::text)) <> ${prefix}`);
  return joinFragments(filters, ' AND ');
}

/** Render `fragment` and run it on the unscoped raw path, as master did. `jitOff` runs it with JIT off on Postgres (PGLite ignores it). */
async function rows<R>(exec: Exec, fragment: SqlFragment, jitOff = false): Promise<R[]> {
  const { text, params } = renderFragment(fragment);
  return exec.executeRaw<R>(text, params, jitOff ? { jitOff: true } : undefined);
}

/**
 * Pages in scope matching `where` (over `pages p` joined to `sources s` and `join`), up to the cap, and how many could affect the query.
 * `classed` also counts the could-affect images in the `sealable` or `reimport` class. Null when the count fails: unknown, never zero.
 * The classed count runs JIT off, as the readiness probe does (#8033): the class's per-page subplans and a remote caller's
 * visibility subplans lift its estimate past `jit_above_cost`, and on a large brain compiling them cost more than a second
 * on every search while the read itself took a fraction of that. The unclassed count stays a plain statement.
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
        LIMIT ${COVERAGE_COUNT_CAP}) x`, classed);
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
 * start of the rebuild. Null when no such rebuild is running or the count fails. JIT off for the same reason as the
 * classed `countInScope`: the never-run count still prices into the estimate.
 */
export async function projectionRebuildProgress(exec: Exec, scope: ProjectionReadinessScope): Promise<ProjectionRebuildProgress | null> {
  try {
    const filter = scopeFilter(scope);
    const [row] = await rows<{ seconds: number | null; total: number; done: number }>(exec, sqlFragment`WITH started AS (SELECT EXTRACT(EPOCH FROM now() - min(j.updated_at))::float8 AS seconds
        FROM page_projection_jobs j JOIN sources s ON s.incarnation = j.source_incarnation JOIN pages p ON p.source_id = s.id AND p.slug = j.slug
        WHERE j.reason = 'protocol_activation' AND p.deleted_at IS NULL AND ${trustedSql(textClassSql('p', 's'))} AND ${filter})
      SELECT started.seconds, c.total, c.done FROM started, LATERAL (SELECT count(p.id)::int AS total,
          count(p.id) FILTER (WHERE p.text_projection_revision IS NOT DISTINCT FROM p.knowledge_revision)::int AS done
        FROM pages p JOIN sources s ON s.id = p.source_id
        WHERE started.seconds IS NOT NULL AND p.deleted_at IS NULL AND ${trustedSql(projectionClassSql('p', 's'))} NOT IN ('protected','archived') AND ${filter}) c`, true);
    if (row?.seconds === null || row?.seconds === undefined) return null;
    const done = Number(row.done), total = Number(row.total), seconds = Number(row.seconds);
    return { done, total, pages_per_second: seconds > 0 && done > 0 ? done / seconds : null };
  } catch {
    return null;
  }
}

/**
 * The generation the probe's cached answer depends on: the page clock (every page insert, update or delete advances
 * it), the pages relation file (TRUNCATE replaces it) and the archived flag of every source. Null when a transaction
 * is in flight (a page write that advanced the clock but has not committed would otherwise be cached as ready under
 * the clock it moved) or the read fails.
 */
export async function readProjectionReadinessGeneration(raw: EngineRawRead): Promise<string | null> {
  try {
    const [row] = await raw<{ generation: string | null; quiescent: boolean }>(
      `SELECT (SELECT last_value FROM page_generation_clock_seq)::text || '/' || pg_relation_filenode('pages')::text || '/'
          || md5(COALESCE((SELECT string_agg(id || ':' || archived::text, ',' ORDER BY id) FROM sources), '')) AS generation,
        pg_snapshot_xmin(pg_current_snapshot()) = pg_snapshot_xmax(pg_current_snapshot()) AS quiescent`);
    return row?.quiescent === true && typeof row.generation === 'string' ? row.generation : null;
  } catch {
    return null;
  }
}

/**
 * Whether the scope has unsealed pages that need work (`pending`), and when none, whether it has unsealed pages
 * protected by design (`by_design`). Throws when the read fails or returns no boolean.
 */
export async function readProjectionReadiness(raw: EngineRawRead, scope: ProjectionReadinessScope): Promise<ProjectionReadinessRow> {
  // One bound statement: unsealed pages that need work, then those unsealed by design (the class fragment doctor counts).
  // by_design is read only when nothing is pending, and an InitPlan runs only when the CASE reaches it: while pages are
  // pending its LIMIT 1 finds no protected page to stop at, so evaluating it anyway read every unsealed page (#8000).
  // The planner has no statistics for a column-to-column comparison, so it believes most pages are unsealed and an
  // EXISTS chose a sequential scan of pages that expected to stop at once; on a sealed brain it read every page
  // (~600 ms at 600k pages, on every cold call). Ordering by the partial index's columns under LIMIT 1 makes it the
  // cheap first row. The index is idx_pages_projection_waiting (v317, #9192): its predicate is this one, so pages v153
  // left serving their pre-upgrade index are not in it and the probe no longer steps over each of them.
  // JIT off (#8033): a remote caller's private-visibility subplans lift the estimate past jit_above_cost, and compiling
  // them cost ~66 of ~67 ms at 20k pages while the probe itself reads one index row.
  const cls = trustedSql(projectionClassSql('p', 's'));
  const filters = scopeFilter(scope);
  const unsealed = (cond: SqlFragment) => sqlFragment`(SELECT true FROM pages p JOIN sources s ON s.id = p.source_id
        WHERE p.deleted_at IS NULL
          AND ${trustedSql(waitingTextProjectionFilter('p'))}
          AND ${filters} AND ${cond}
        ORDER BY p.source_id, p.page_kind, p.slug LIMIT 1) IS NOT NULL`;
  const { text, params } = renderFragment(sqlFragment`WITH r AS MATERIALIZED (SELECT ${unsealed(sqlFragment`${cls} NOT IN ('protected','archived')`)} AS pending)
      SELECT r.pending, CASE WHEN r.pending THEN false ELSE ${unsealed(sqlFragment`${cls} IN ('protected','archived')`)} END AS by_design FROM r`);
  const [row] = await raw<{ pending: unknown; by_design: unknown }>(text, params, { jitOff: true });
  if (typeof row?.pending !== 'boolean') throw new Error('Invalid readiness result');
  return { pending: row.pending, by_design: row.by_design === true };
}
