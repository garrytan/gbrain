/**
 * The drift-conflict audit reads (`auditDriftConflicts` in `persistence/drift-conflicts.ts`, the list_write_conflicts
 * tool and `gbrain sources reconcile --audit --conflicts`): one SQL implementation for both engines.
 *
 * The statements are the audit's own, byte for byte. The totals and groups text comes from the hand-numbered builders
 * of `persistence/drift-conflict-sql.ts` (the groups read binds its cursor, limit and message out of text order, which
 * renderFragment cannot number), and each member binds its parameters in the order the audit always did. The caller
 * keeps every decision: the window, the cursor, the trusted path's file checks and the report.
 */
import type { LegacyUnscopedRead } from './brands.ts';
import {
  driftConflictGroupsSql, driftConflictTotalsSql, FILE_DRIFT_MESSAGE, likeEscape,
  type DriftConflictVisibility, type DriftPrefixShape,
} from '../persistence/drift-conflict-sql.ts';

export type { DriftConflictVisibility } from '../persistence/drift-conflict-sql.ts';

export interface DriftConflictBounds { incarnation: string; top: string | null; bottom: string | null }

/**
 * The conflict rows one audit page reads: `source_changed` conflicts of the source's current incarnation with a
 * sequence in (floor, through]. `slugPrefixes` (already normalized, at least one) keeps the slugs one ending in `/`
 * holds under it or any other equals or holds under it; `visibility` asks that the slug's page be live (`live`) and
 * past the remote read floor (`floor`).
 */
export interface DriftConflictFilter {
  sourceId: string;
  incarnation: string;
  floor: string;
  through: string;
  slugPrefixes?: readonly string[];
  visibility: DriftConflictVisibility;
}

export interface DriftConflictTotals { slugs: number; receipts: number }

export interface DriftConflictGroupRow {
  slug: string;
  receipts: number;
  drift_receipts: number;
  first_seen: string;
  last_seen: string;
  producers: string[];
  last_request_id: string;
}

export interface CommittedReceiptRow { slug: string; request_id: string; completed_at: string }

export interface PageSourcePathRow { slug: string; source_path: string | null; source_uri: string | null }

const BOUNDS_SQL = `SELECT s.incarnation::text AS incarnation,
        (SELECT max(r.sequence) FROM persistence_requests r WHERE r.source_incarnation=s.incarnation)::text AS top,
        (SELECT min(r.sequence) FROM persistence_requests r WHERE r.source_incarnation=s.incarnation)::text AS bottom
       FROM sources s WHERE s.id=$1`;

const COMMITTED_SQL = `SELECT DISTINCT ON (r.slug) r.slug, r.request_id::text, to_char(r.completed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS completed_at
       FROM persistence_requests r WHERE r.source_id=$1 AND r.slug=ANY($2::text[]) AND r.intent IS NOT NULL AND NOT r.compacted AND r.state='committed'
      ORDER BY r.slug, r.sequence DESC`;

const RECORDED_SQL = 'SELECT slug, source_path, source_uri FROM pages WHERE source_id=$1 AND slug=ANY($2::text[]) AND deleted_at IS NULL';

/** The source's incarnation and the top and bottom request sequences of that incarnation, or null for no source. */
export async function readDriftConflictBounds(exec: LegacyUnscopedRead, sourceId: string): Promise<DriftConflictBounds | null> {
  const [row] = await exec.executeRaw<DriftConflictBounds>(BOUNDS_SQL, [sourceId]);
  return row ?? null;
}

function filterParts(filter: DriftConflictFilter): { shapes: DriftPrefixShape[] | undefined; params: unknown[] } {
  const params: unknown[] = [filter.sourceId, filter.floor, filter.through, filter.incarnation];
  if (!filter.slugPrefixes) return { shapes: undefined, params };
  const shapes = filter.slugPrefixes.map((base): DriftPrefixShape => {
    params.push(base.endsWith('/') ? `${likeEscape(base)}%` : likeEscape(base));
    return base.endsWith('/') ? 'folder' : 'slug';
  });
  return { shapes, params };
}

/** Distinct slugs and receipts under the filter. */
export async function countDriftConflicts(exec: LegacyUnscopedRead, filter: DriftConflictFilter): Promise<DriftConflictTotals> {
  const { shapes, params } = filterParts(filter);
  const [row] = await exec.executeRaw<DriftConflictTotals>(driftConflictTotalsSql(shapes, filter.visibility), params);
  return { slugs: Number(row?.slugs ?? 0), receipts: Number(row?.receipts ?? 0) };
}

/** Up to `page.fetch` slug groups after `page.after`, in slug order. */
export async function listDriftConflictGroups(exec: LegacyUnscopedRead, filter: DriftConflictFilter,
  page: { after: string; fetch: number }): Promise<DriftConflictGroupRow[]> {
  const { shapes, params } = filterParts(filter);
  params.push(page.after, page.fetch, FILE_DRIFT_MESSAGE);
  return exec.executeRaw<DriftConflictGroupRow>(driftConflictGroupsSql(shapes, filter.visibility), params);
}

/** The newest committed, uncompacted receipt with an intent per slug, in slug order. */
export async function readNewestCommittedReceipts(exec: LegacyUnscopedRead, sourceId: string, slugs: readonly string[]): Promise<CommittedReceiptRow[]> {
  if (slugs.length === 0) return [];
  return exec.executeRaw<CommittedReceiptRow>(COMMITTED_SQL, [sourceId, [...slugs]]);
}

/** The recorded source path and URI of each live page at `slugs` (no stated order). */
export async function readPageSourcePaths(exec: LegacyUnscopedRead, sourceId: string, slugs: readonly string[]): Promise<PageSourcePathRow[]> {
  if (slugs.length === 0) return [];
  return exec.executeRaw<PageSourcePathRow>(RECORDED_SQL, [sourceId, [...slugs]]);
}
