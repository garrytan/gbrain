/**
 * The applied-watermark reads persistence/applied-watermark.ts readWriteWatermark, readCheckoutRoot and
 * readAppliedWatermark ran through `executeRaw` (Rust engine lane 11): `gbrain sync --json`, `gbrain sources status`,
 * MCP `sources_status` and `get_write_request` carry them.
 * The statement text is the caller's, byte for byte (test/engine-sql-caller-raw-sql-pins.test.ts), so PGLite and
 * Postgres answer exactly as before. A Rust brain answers from its source row and its stale-chunk list
 * (src/core/rust-engine/store-members/persistence.ts).
 */
import { chunkGenerationFilter } from '../search/safe-chunks.ts';
import { quoteIdentifier } from '../search/embedding-column.ts';
import { budgetRowAppliesFilter } from '../page-size-policy.ts';
import type { HoldRead } from './sync-hold-reads.ts';
import { renderFragment, sqlFragment, trustedSql, type SqlFragment } from './fragment.ts';

/** The source row's sync point and its pending write requests; `newest_sequence` is read only when none is pending. */
export interface WriteWatermarkRow {
  last_commit: string | null; last_sync_at: unknown; pending_min: number | string | null;
  pending_count: number | string; pending_since: unknown; newest_sequence: number | string | null;
}

/** A source's incarnation and its checkout on this host. */
export interface SourceCheckoutRoot { incarnation: string | null; root: string | null }

/** Pages of a source still waiting for an embedding in the active column: how many, the oldest edit, how many a budget holds. */
export interface UnembeddedPageSummary { pages: number | string; oldest: unknown; held: number | string }

/** $1 the source id. */
export const WRITE_WATERMARK_SQL = `SELECT s.last_commit, s.last_sync_at, p.pending_min, p.pending_count, p.pending_since
    FROM sources s LEFT JOIN LATERAL (SELECT min(r.sequence) AS pending_min, count(*) AS pending_count, min(r.created_at) AS pending_since FROM persistence_requests r
      WHERE r.source_id=s.id AND r.source_incarnation=s.incarnation AND r.state IN ('queued','deferred','running','recovering')) p ON true WHERE s.id=$1`;
export const NEWEST_REQUEST_SEQUENCE_SQL = 'SELECT max(sequence) AS sequence FROM persistence_requests';

/** $1 the source id, $2 this host's id. */
export const SOURCE_CHECKOUT_ROOT_SQL = `SELECT s.incarnation::text AS incarnation,
      COALESCE((SELECT h.local_path FROM persistence_host_bindings h JOIN persistence_source_bindings b ON b.worktree_id=h.worktree_id
        WHERE b.source_id=s.id AND h.host_id::text=$2 LIMIT 1), s.local_path) AS root FROM sources s WHERE s.id=$1`;

/** The unembedded-pages read for `sourceId` (bound as $1); `column` is the active embedding column. */
export function unembeddedPageSummaryFragment(sourceId: string, column: string): SqlFragment {
  return sqlFragment`WITH w AS (SELECT DISTINCT p.id, p.updated_at FROM content_chunks cc
        JOIN pages p ON p.id=cc.page_id WHERE cc.${trustedSql(quoteIdentifier(column))} IS NULL AND p.source_id=${sourceId} AND p.deleted_at IS NULL AND ${trustedSql(chunkGenerationFilter('p', 'cc'))}
          AND NOT (COALESCE(p.frontmatter, '{}'::jsonb) ? 'embed_skip'))
      SELECT count(*) AS pages, min(w.updated_at) AS oldest,
        (SELECT count(*) FROM w JOIN page_embedding_budget b ON b.page_id=w.id JOIN pages p ON p.id=w.id WHERE ${trustedSql(budgetRowAppliesFilter('b', 'p'))}) AS held FROM w`;
}

const NO_WATERMARK: Omit<WriteWatermarkRow, 'newest_sequence'> = { last_commit: null, last_sync_at: null, pending_min: null, pending_count: 0, pending_since: null };

/** The source's sync point and pending requests (nulls and 0 when the source is absent); the newest request sequence when none is pending. */
export async function readWriteWatermarkRow(exec: HoldRead, sourceId: string): Promise<WriteWatermarkRow> {
  const [row] = await exec.executeRaw<Omit<WriteWatermarkRow, 'newest_sequence'>>(WRITE_WATERMARK_SQL, [sourceId]);
  const [newest] = row?.pending_min == null ? await exec.executeRaw<{ sequence: number | string | null }>(NEWEST_REQUEST_SEQUENCE_SQL) : [];
  return { ...NO_WATERMARK, ...row, newest_sequence: newest?.sequence ?? null };
}

/** The source's incarnation and its checkout (this host's binding, else the source's path); null when the source is absent. */
export async function readSourceCheckoutRoot(exec: HoldRead, sourceId: string, hostId: string | null): Promise<SourceCheckoutRoot | null> {
  const [row] = await exec.executeRaw<SourceCheckoutRoot>(SOURCE_CHECKOUT_ROOT_SQL, [sourceId, hostId]);
  return row ?? null;
}

/** The source's pages still waiting for an embedding in `column`. */
export async function readUnembeddedPageSummary(exec: HoldRead, sourceId: string, column: string): Promise<UnembeddedPageSummary> {
  const { text, params } = renderFragment(unembeddedPageSummaryFragment(sourceId, column));
  const [row] = await exec.executeRaw<UnembeddedPageSummary>(text, params);
  return row ?? { pages: 0, oldest: null, held: 0 };
}
