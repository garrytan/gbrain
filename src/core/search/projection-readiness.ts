import type { BrainEngine } from '../engine.ts';
import type { PageReadScope } from '../types.ts';
import { pageReadFilter } from './read-policy-sql.ts';

export interface ProjectionReadinessScope extends PageReadScope {
  pageKind?: string;
  types?: string[];
  excludeSlugPrefixes?: string[];
}

export interface ProjectionReadiness {
  status: 'ready' | 'projection_pending' | 'unknown';
  ready: boolean;
  hint?: string;
}

export async function probeProjectionReadiness(
  engine: Pick<BrainEngine, 'executeRaw'>,
  scope: ProjectionReadinessScope = {},
): Promise<ProjectionReadiness> {
  const params: unknown[] = [];
  const filters = [pageReadFilter('p', scope, params, true)];
  if (scope.sourceIds?.length === 0) filters.push('FALSE');
  if (scope.pageKind) {
    params.push(scope.pageKind);
    filters.push(`p.page_kind = $${params.length}`);
  }
  if (scope.types) {
    params.push(scope.types);
    filters.push(`p.type = ANY($${params.length}::text[])`);
  }
  for (const prefix of scope.excludeSlugPrefixes ?? []) {
    params.push(prefix);
    filters.push(`LEFT(p.slug, LENGTH($${params.length}::text)) <> $${params.length}`);
  }
  try {
    const rows = await engine.executeRaw<{ pending: boolean }>(
      `SELECT EXISTS (
        SELECT 1 FROM pages p
        WHERE p.deleted_at IS NULL
          AND p.text_projection_revision IS DISTINCT FROM p.knowledge_revision
          AND ${filters.join(' AND ')}
      ) AS pending`,
      params,
    );
    if (typeof rows[0]?.pending !== 'boolean') throw new Error('Invalid readiness result');
    return rows[0].pending
      ? {
        status: 'projection_pending', ready: false,
        hint: 'Current text projections are pending in the visible scope; results may be incomplete. Run `gbrain doctor` locally to inspect recovery. This read does not repair or embed content.',
      }
      : { status: 'ready', ready: true };
  } catch {
    return {
      status: 'unknown', ready: false,
      hint: 'Projection readiness could not be checked; do not treat these results as proof of a complete index. Run `gbrain doctor` locally to diagnose.',
    };
  }
}
