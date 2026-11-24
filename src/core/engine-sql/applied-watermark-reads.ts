/**
 * The applied-watermark reads persistence/applied-watermark.ts readWriteWatermark, readCheckoutRoot and
 * readAppliedWatermark ran through `executeRaw` (Rust engine lane 11): `gbrain sync --json`, `gbrain sources status`,
 * MCP `sources_status` and `get_write_request` carry them.
 * The statement text is the caller's, byte for byte (test/engine-sql-caller-raw-sql-pins.test.ts), so PGLite and
 * Postgres answer exactly as before. A Rust brain answers from its source row and its stale-chunk list
 * (src/core/rust-engine/store-members/persistence.ts).
 * `readSourceMovementRows` holds the three per-binding statements of persistence/sync-movement.ts readSourceMovement
 * (the managed-sync watermark, the head request and the hold summary), also byte for byte; a Rust brain answers them
 * from its request and op-checkpoint records (store-members/source-movement.ts).
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

/** $1 worktree, $2 source incarnation. The kind test matches the `persistence_requests_sync_watermark` predicate text, so the planner can prove the partial index applies. */
export const MOVEMENT_WATERMARK_SQL = `SELECT
        (SELECT r.completed_at FROM persistence_requests r WHERE r.worktree_id=$1::uuid AND r.state='committed' AND r.source_incarnation=$2::uuid
           AND COALESCE(r.intent->>'kind','') LIKE 'managed_sync_%' ORDER BY r.completed_at DESC LIMIT 1) AS last_commit_at,
        (SELECT count(*) FROM persistence_requests r WHERE r.worktree_id=$1::uuid AND r.state IN ('queued','running') AND COALESCE(r.intent->>'kind','') LIKE 'managed_sync_%') AS admitted,
        (SELECT min(r.created_at) FROM persistence_requests r WHERE r.worktree_id=$1::uuid AND r.state IN ('queued','running') AND COALESCE(r.intent->>'kind','') LIKE 'managed_sync_%') AS admitted_since`;
/** $1 worktree: its head unfinished request, the running one first, then by sequence. */
export const MOVEMENT_HEAD_SQL = `SELECT request_id::text AS request_id, state, claim_phase, execution_token::text AS execution_token,
        (claim_expires_at IS NOT NULL AND claim_expires_at < now()) AS claim_lapsed, publication_started
      FROM persistence_requests WHERE worktree_id=$1::uuid AND state IN ('queued','running','recovering') ORDER BY (state <> 'running'), sequence LIMIT 1`;
/** $1 source, $2 incarnation: the git hold summary's counters. */
export const MOVEMENT_HOLD_SQL = `SELECT (completed_keys->0->>'count')::int AS count, (completed_keys->0->>'stalled')::int AS stalled,
        (completed_keys->0->>'fences')::int AS fences, (completed_keys->0->>'concurrent')::int AS concurrent, updated_at
      FROM op_checkpoints WHERE op='sync-hold-summary' AND completed_keys->0->>'source_id'=$1 AND completed_keys->0->>'incarnation'=$2 LIMIT 1`;

export interface MovementWatermarkRow { last_commit_at: unknown; admitted: number | string; admitted_since?: unknown }
export interface MovementHeadRow { request_id: string; state: string; claim_phase: unknown; execution_token: string | null; claim_lapsed: boolean | null; publication_started: boolean | null }
export interface MovementHoldRow { count: number | string | null; stalled: number | string | null; fences: number | string | null; concurrent: number | string | null; updated_at: unknown }
/** One source binding's movement rows: the managed-sync watermark, the head request (or null) and the hold summary (or null). */
export interface SourceMovementRows { watermark: MovementWatermarkRow | null; head: MovementHeadRow | null; hold: MovementHoldRow | null }
export interface SourceMovementBinding { source_id: string; worktree_id: string; source_incarnation: string }

/** The three movement statements of one source binding, in the order readSourceMovement ran them. */
export async function readSourceMovementRows(exec: HoldRead, binding: SourceMovementBinding): Promise<SourceMovementRows> {
  const [watermark] = await exec.executeRaw<MovementWatermarkRow>(MOVEMENT_WATERMARK_SQL, [binding.worktree_id, binding.source_incarnation]);
  const [head] = await exec.executeRaw<MovementHeadRow>(MOVEMENT_HEAD_SQL, [binding.worktree_id]);
  const [hold] = await exec.executeRaw<MovementHoldRow>(MOVEMENT_HOLD_SQL, [binding.source_id, binding.source_incarnation]);
  return { watermark: watermark ?? null, head: head ?? null, hold: hold ?? null };
}

/** $1 source: the active `sync` job with a live lock that drains it (by its source id, or by its checkout for a job that names none), oldest first. */
export const LIVE_SYNC_JOB_SQL = `SELECT id FROM minion_jobs WHERE name='sync' AND status='active' AND lock_until > now() AND queue <> 'gbrain-drain-lease'
    AND (COALESCE(data->>'sourceId', data->>'source_id')=$1 OR (COALESCE(data->>'sourceId', data->>'source_id') IS NULL
      AND (data->>'repoPath' IS NULL AND $1='default' OR data->>'repoPath'=(SELECT local_path FROM sources WHERE id=$1)))) ORDER BY started_at, id LIMIT 1`;

/** The id of the active `sync` job with a live lock that drains `sourceId`, or null (persistence/sync-movement.ts liveSyncJob). */
export async function readLiveSyncJobId(exec: HoldRead, sourceId: string): Promise<number | null> {
  const [row] = await exec.executeRaw<{ id: number | string }>(LIVE_SYNC_JOB_SQL, [sourceId]);
  return row ? Number(row.id) : null;
}
