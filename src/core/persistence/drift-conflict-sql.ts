/**
 * The statement text of the drift-conflict audit (`auditDriftConflicts` in `drift-conflicts.ts`), kept here so the
 * typed engine members in `engine-sql/drift-conflicts.ts` run it without importing the audit's large module closure.
 *
 * The placeholders are hand-numbered and must stay that way: `$1` source id, `$2` floor, `$3` through and `$4`
 * incarnation are fixed, `$5..` are one per slug prefix (the builders take a count of shapes, never a value), and the
 * groups read then binds the cursor, the row limit and FILE_DRIFT_MESSAGE in that order while its text names the
 * message first. The only spliced text is remoteReadFloorSql over the constant page alias `p`.
 */
import { remoteReadFloorSql } from '../search/private-visibility.ts';

export const FILE_DRIFT_MESSAGE = 'The canonical file contains an uncoordinated local edit.';

/** LIKE-escape a slug prefix (backslash, `%` and `_`), as the audit binds it. */
export const likeEscape = (value: string) => value.replace(/[\\%_]/g, char => `\\${char}`);

/** How a conflict row's page must exist: not at all (`none`), live (`live`), or live and past the remote read floor (`floor`). */
export type DriftConflictVisibility = 'none' | 'live' | 'floor';

/** A slug prefix shape: `folder` (ends in `/`, matches under it) or `slug` (matches the slug or under it). */
export type DriftPrefixShape = 'folder' | 'slug';

function driftConflictFilterSql(shapes: readonly DriftPrefixShape[] | undefined, visibility: DriftConflictVisibility): string {
  const where = [`r.source_id=$1`, `r.source_incarnation=$4::uuid`, `r.sequence > $2::bigint`, `r.sequence <= $3::bigint`, `r.state='conflict'`, `r.error_code='source_changed'`];
  if (shapes) {
    const alternatives = shapes.map((shape, i) => {
      const at = 5 + i;
      return shape === 'folder' ? `lower(r.slug) LIKE $${at}` : `(lower(r.slug) = $${at} OR lower(r.slug) LIKE $${at} || '/%')`;
    });
    where.push(`(${alternatives.join(' OR ')})`);
  }
  if (visibility !== 'none') {
    where.push(`EXISTS (SELECT 1 FROM pages p WHERE p.source_id=r.source_id AND p.slug=r.slug AND p.deleted_at IS NULL${visibility === 'floor' ? ` AND ${remoteReadFloorSql('p')}` : ''})`);
  }
  return where.join(' AND ');
}

/** The totals read: distinct slugs and receipts under the filter. */
export function driftConflictTotalsSql(shapes: readonly DriftPrefixShape[] | undefined, visibility: DriftConflictVisibility): string {
  return `SELECT count(DISTINCT r.slug)::int AS slugs, count(*)::int AS receipts FROM persistence_requests r WHERE ${driftConflictFilterSql(shapes, visibility)}`;
}

/** The groups read: one row per slug after the cursor, in slug order, with the cursor, limit and message bound last. */
export function driftConflictGroupsSql(shapes: readonly DriftPrefixShape[] | undefined, visibility: DriftConflictVisibility): string {
  const count = 4 + (shapes?.length ?? 0) + 3;
  return `SELECT r.slug, count(*)::int AS receipts, count(*) FILTER (WHERE r.error_message=$${count})::int AS drift_receipts,
        to_char(min(r.created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS first_seen,
        to_char(max(r.created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS last_seen,
        array_agg(DISTINCT r.operation || COALESCE(':' || (r.intent->>'kind'), '') ORDER BY r.operation || COALESCE(':' || (r.intent->>'kind'), '')) AS producers,
        (array_agg(r.request_id::text ORDER BY r.sequence DESC))[1] AS last_request_id
      FROM persistence_requests r WHERE ${driftConflictFilterSql(shapes, visibility)} AND r.slug > $${count - 2}
      GROUP BY r.slug ORDER BY r.slug LIMIT $${count - 1}`;
}
