import type { BrainEngine } from '../engine.ts';
import type { PageReadScope } from '../types.ts';
import { projectionClassSql } from '../page-state/projection-class.ts';
import { coverageScopeFilters } from './retrieval-coverage.ts';

export interface ProjectionReadinessScope extends PageReadScope {
  pageKind?: string;
  types?: string[];
  excludeSlugPrefixes?: string[];
}

/**
 * `by_design` (#6803): the only unsealed pages in scope are protected-OCR images,
 * which no repair seals (archived sources are already outside every live read).
 */
export interface ProjectionReadiness {
  status: 'ready' | 'projection_pending' | 'by_design' | 'unknown';
  ready: boolean;
  hint?: string;
}

export const PROJECTION_READINESS_CACHE_ENV = 'GBRAIN_PROJECTION_READINESS_CACHE';
const MAX_ENTRIES_PER_ENGINE = 256;
let readinessCache = new WeakMap<object, Map<string, { generation: string; value: ProjectionReadiness }>>();

/** Test seam: forget every cached answer. */
export function __resetProjectionReadinessCacheForTests(): void { readinessCache = new WeakMap(); }

/** Every input the probe's SQL reads from the caller, normalized so equal scopes share one key. */
function scopeKey(scope: ProjectionReadinessScope): string {
  const sorted = (values?: string[]) => values === undefined ? null : [...new Set(values)].sort();
  return JSON.stringify([scope.sourceId ?? null, sorted(scope.sourceIds), scope.excludePrivate === true, scope.requireSafeChunks === true,
    scope.pageKind ?? null, sorted(scope.types), sorted(scope.excludeSlugPrefixes)]);
}

/**
 * The database-visible generation the probe's answer depends on: the page
 * clock (every page insert, update or delete advances it), the pages relation
 * file (TRUNCATE replaces it) and the archived flag of every source. Null
 * when a transaction is in flight: a page write that already advanced the
 * clock but has not committed would otherwise be cached as ready under the
 * clock it moved.
 */
async function readinessGeneration(engine: Pick<BrainEngine, 'executeRaw'>): Promise<string | null> {
  try {
    const [row] = await engine.executeRaw<{ generation: string | null; quiescent: boolean }>(
      `SELECT (SELECT last_value FROM page_generation_clock_seq)::text || '/' || pg_relation_filenode('pages')::text || '/'
          || md5(COALESCE((SELECT string_agg(id || ':' || archived::text, ',' ORDER BY id) FROM sources), '')) AS generation,
        pg_snapshot_xmin(pg_current_snapshot()) = pg_snapshot_xmax(pg_current_snapshot()) AS quiescent`);
    return row?.quiescent === true && typeof row.generation === 'string' ? row.generation : null;
  } catch {
    return null;
  }
}

/**
 * Whether the current text projections cover the visible scope. A repeat
 * call for the same scope reuses the last answer while the generation it was
 * computed under still holds; `GBRAIN_PROJECTION_READINESS_CACHE=0` always
 * probes. An `unknown` answer (the probe failed) is never reused.
 */
export async function probeProjectionReadiness(
  engine: Pick<BrainEngine, 'executeRaw'>,
  scope: ProjectionReadinessScope = {},
): Promise<ProjectionReadiness> {
  if (process.env[PROJECTION_READINESS_CACHE_ENV] === '0') return probeUncached(engine, scope);
  const generation = await readinessGeneration(engine);
  if (generation === null) return probeUncached(engine, scope);
  const key = scopeKey(scope);
  let entries = readinessCache.get(engine);
  const hit = entries?.get(key);
  if (hit?.generation === generation) return hit.value;
  const value = await probeUncached(engine, scope);
  if (value.status === 'unknown') return value;
  if (!entries) readinessCache.set(engine, entries = new Map());
  if (entries.size >= MAX_ENTRIES_PER_ENGINE) entries.clear();
  entries.set(key, { generation, value });
  return value;
}

async function probeUncached(
  engine: Pick<BrainEngine, 'executeRaw'>,
  scope: ProjectionReadinessScope,
): Promise<ProjectionReadiness> {
  const params: unknown[] = [];
  const filters = coverageScopeFilters(scope, params);
  try {
    // One bound statement: unsealed pages that need work, then those unsealed by design (the class fragment doctor counts).
    // The planner has no statistics for a column-to-column comparison, so it believes most pages are unsealed and an
    // EXISTS chose a sequential scan of pages that expected to stop at once; on a sealed brain it read every page
    // (~600 ms at 600k pages, on every cold call). Ordering by idx_pages_projection_pending's columns under LIMIT 1
    // makes that partial index the cheap first row, so the probe reads only the unsealed pages.
    const unsealed = (cond: string) => `(SELECT true FROM pages p JOIN sources s ON s.id = p.source_id
        WHERE p.deleted_at IS NULL
          AND p.text_projection_revision IS DISTINCT FROM p.knowledge_revision
          AND ${filters.join(' AND ')} AND ${cond}
        ORDER BY p.source_id, p.page_kind, p.slug LIMIT 1) IS NOT NULL`;
    const cls = projectionClassSql('p', 's');
    const rows = await engine.executeRaw<{ pending: boolean; by_design: boolean }>(
      `SELECT ${unsealed(`${cls} NOT IN ('protected','archived')`)} AS pending,
        ${unsealed(`${cls} IN ('protected','archived')`)} AS by_design`,
      params,
    );
    if (typeof rows[0]?.pending !== 'boolean') throw new Error('Invalid readiness result');
    if (rows[0].pending) {
      return {
        status: 'projection_pending', ready: false,
        hint: 'Current text projections are pending in the visible scope; results may be incomplete. Run `gbrain doctor` locally to inspect recovery. This read does not repair or embed content.',
      };
    }
    return { status: rows[0].by_design ? 'by_design' : 'ready', ready: true };
  } catch {
    return {
      status: 'unknown', ready: false,
      hint: 'Projection readiness could not be checked; do not treat these results as proof of a complete index. Run `gbrain doctor` locally to diagnose.',
    };
  }
}

