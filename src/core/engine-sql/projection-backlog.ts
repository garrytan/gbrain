/**
 * The projection backlog read (`projectionBacklog`, page-state/projections.ts): doctor's text_projection_readiness, the upgrade
 * notice, the resident's projection status and the drain preview read the queue by class through it. Its statement is composed
 * with `sqlFragment` (the scope's source clause is bound), so it lives apart from the constant statements of doctor-search.ts,
 * whose member list statement-deadline.ts imports early. The Rust engine answers it from the queue and page records
 * (rust/crates/gbrain-store/src/link_queries/projection_backlog.rs, rust/docs/store/cli-reads-doctor-search.md).
 */
import type { PageReadScope } from '../types.ts';
import type { ProjectionBacklog } from '../page-state/projections.ts';
import { projectionClassSql } from '../page-state/projection-class.ts';
import { chunkGenerationFilter } from '../search/safe-chunks.ts';
import type { EngineRawRead } from './cli-reads-ops.ts';
import { renderFragment, sqlFragment, trustedSql } from './fragment.ts';
import { readFilter } from './search-reads.ts';
import { PROJECTION_POLICY_ADMITS_SQL } from '../page-state/projection-policy-sql.ts';

/** `projectionBacklog`'s answer: every class of the projection queue, with the keys the wire of an older resident omits filled in. */
export type ProjectionBacklogCounts = Required<ProjectionBacklog>;
type ProjectionBacklogClass = 'pending' | 'failed' | 'sealable' | 'sealable_with_visual' | 'reimport' | 'ocr_required' | 'protected' | 'archived' | 'held' | 'actionable_pending' | 'actionable_sealable';

/**
 * Every class of the projection queue in one aggregate, moved from page-state/projections.ts `projectionBacklog` with its text
 * unchanged: `scope` narrows to the pages a caller may read (`pageReadFilter` with live = false: archived sources and
 * quarantined pages count, as their own class). `oldest_age_seconds` covers the classes that need work.
 */
export async function readProjectionBacklog(raw: EngineRawRead, scope: PageReadScope = {}): Promise<ProjectionBacklogCounts> {
  const { text, params } = renderFragment(sqlFragment`SELECT COUNT(*) FILTER (WHERE k.cls='text')::int AS pending,
      COUNT(*) FILTER (WHERE k.cls='text' AND j.reason IN ('rebuild_failed','canonical_change_rebuild_failed'))::int AS failed,
      COUNT(*) FILTER (WHERE k.cls IN ('text','sealable') AND NOT ${trustedSql(PROJECTION_POLICY_ADMITS_SQL)})::int AS held,
      COUNT(*) FILTER (WHERE k.cls='text' AND ${trustedSql(PROJECTION_POLICY_ADMITS_SQL)})::int AS actionable_pending,
      COUNT(*) FILTER (WHERE k.cls='sealable' AND ${trustedSql(PROJECTION_POLICY_ADMITS_SQL)})::int AS actionable_sealable,
      COUNT(*) FILTER (WHERE k.cls='sealable')::int AS sealable,
      COUNT(*) FILTER (WHERE k.cls='sealable' AND EXISTS (SELECT 1 FROM content_chunks c WHERE c.page_id=p.id AND c.embedding_image IS NOT NULL
        AND ${trustedSql(chunkGenerationFilter('p', 'c'))}))::int AS sealable_with_visual,
      COUNT(*) FILTER (WHERE k.cls='reimport')::int AS reimport,
      COUNT(*) FILTER (WHERE k.cls='reimport' AND p.chunker_version < 0)::int AS ocr_required,
      COUNT(*) FILTER (WHERE k.cls='protected')::int AS protected,
      COUNT(*) FILTER (WHERE k.cls='archived')::int AS archived,
      EXTRACT(EPOCH FROM now()-MIN(j.updated_at) FILTER (WHERE k.cls IN ('text','sealable','reimport')))::float8 AS oldest,
      now()::text AS as_of
    FROM page_projection_jobs j JOIN sources s ON s.incarnation=j.source_incarnation
    JOIN pages p ON p.source_id=s.id AND p.slug=j.slug AND p.deleted_at IS NULL
    CROSS JOIN LATERAL (SELECT ${trustedSql(projectionClassSql('p', 's'))} AS cls) k
    WHERE ${readFilter('p', scope, false)}`);
  const [row] = await raw<Record<ProjectionBacklogClass, number> & { oldest: number | null; as_of: string }>(text, params);
  const oldest = row?.oldest === null || row?.oldest === undefined ? null : Math.max(0, Math.floor(Number(row.oldest)));
  const n = (key: ProjectionBacklogClass) => Number(row?.[key] ?? 0);
  return { pending: n('pending'), failed: n('failed'), oldest_age_seconds: oldest, sealable: n('sealable'), sealable_with_visual: n('sealable_with_visual'),
    reimport: n('reimport'), ocr_required: n('ocr_required'), protected: n('protected'), archived: n('archived'), held: n('held'),
    actionable_pending: n('actionable_pending'), actionable_sealable: n('actionable_sealable'), as_of: String(row?.as_of ?? '') };
}
