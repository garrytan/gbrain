/**
 * The row reads `gbrain sync status` makes: the statements persistence/sync-status.ts, persistence/sync-failures.ts,
 * persistence/sync-drain.ts (the drain head probe) and sync-identity-downgrades.ts ran through `executeRaw` (Rust
 * engine lane 9, step 3). The statement text is the caller's, byte for byte, so PGLite and Postgres answer exactly as
 * before; each engine runs them through its own `executeRaw`, so a statement fault a test injects on the engine reaches
 * them. What the rows mean (the status verdicts, the failure projection, the downgrade remedies) stays with the
 * callers. A Rust brain answers them from its op checkpoint store (src/core/rust-engine/store-members/sync-status-reads.ts).
 */
import {
  IDENTITY_DOWNGRADE_OP, SYNC_STATUS_COMMITTED_SQL, SYNC_STATUS_SOURCE_SQL, syncStatusSourceParams,
} from '../persistence/sync-status-sql.ts';

/** The engine's own executeRaw (see the module comment); the bounded probes pass their timeout and signal through. */
export interface SyncStatusExec {
  executeRaw<R = Record<string, unknown>>(sql: string, params?: unknown[], opts?: { signal?: AbortSignal; timeoutMs?: number }): Promise<R[]>;
}

/** A bounded probe's statement timeout and abort signal. */
export interface SyncStatusProbeOptions { timeoutMs?: number; signal?: AbortSignal }

/**
 * `sync status`'s source read: the live source row with the drain-lock probe, its pass row (`P`) and withheld-delete
 * record (`W`), the admission setting with its probes, the failed writeback of the pass and the open worktree refresh
 * (`F`; Postgres hands back an object, PGLite may hand back JSON text), and the apple-contacts review rows.
 */
export interface SyncStatusSourceRow<P = Record<string, unknown>, W = Record<string, unknown>, F = Record<string, unknown>> {
  incarnation: string; last_commit: string | null; last_sync_at: Date | string | null; drain_lock: boolean;
  pass_value: P | null; pass_updated_at: Date | string | null; pass_read_at: Date | string; withheld: W | null;
  admission_stored: string | null; admission_row_value: string | null; admission_set_at: string | null; admission_pinned: boolean | null; admission_destructive: boolean | null;
  writeback_failed: string | null; refresh: F | string | null;
  /** The apple-contacts identity reviews and held deletes of the source (`completed_keys` of each row), null when none. */
  identity_reviews: unknown; held_deletes: unknown;
}

/** The source read of one live (not archived) source, or null. */
export async function readSyncStatusSourceRow<P = Record<string, unknown>, W = Record<string, unknown>, F = Record<string, unknown>>(
  exec: SyncStatusExec, sourceId: string,
): Promise<SyncStatusSourceRow<P, W, F> | null> {
  const [row] = await exec.executeRaw<SyncStatusSourceRow<P, W, F>>(SYNC_STATUS_SOURCE_SQL, syncStatusSourceParams(sourceId));
  return row ?? null;
}

/** Managed-sync pages committed in the last ten minutes, the push and fence hold probes and the newest managed-sync commit. */
export interface SyncStatusCommittedRow { n: number | string; git_push_held: boolean; fence_held: boolean; last_committed_at: Date | string | null }

export async function readSyncStatusCommittedRow(exec: SyncStatusExec, sourceId: string): Promise<SyncStatusCommittedRow> {
  const [row] = await exec.executeRaw<SyncStatusCommittedRow>(SYNC_STATUS_COMMITTED_SQL, [sourceId]);
  return row!;
}

/**
 * The newest managed-sync cursor of the source incarnation, the one keyed `failedKey` first (`''` prefers none), with
 * its key; null when none.
 */
export async function readManagedSyncCursorHeader<H = Record<string, unknown>>(
  exec: SyncStatusExec, sourceId: string, incarnation: string, failedKey: string,
): Promise<{ header: H; key: string } | null> {
  const rows = await exec.executeRaw<{ header: H; key: string }>(
    `SELECT completed_keys->0 AS header, fingerprint AS key FROM op_checkpoints WHERE op='managed-sync' AND completed_keys->0->>'sourceId'=$1 AND completed_keys->0->>'incarnation'=$2
      ORDER BY (fingerprint=$3) DESC, updated_at DESC LIMIT 1`, [sourceId, incarnation, failedKey]);
  return rows[0] ?? null;
}

/** The oldest unfinished managed-sync cursor of the source under another incarnation, with when it was last written (UTC, ms); null when none. */
export async function readRetiredManagedSyncCursor(exec: SyncStatusExec, sourceId: string, incarnation: string): Promise<{ first_seen: string } | null> {
  const [row] = await exec.executeRaw<{ first_seen: string }>(`SELECT to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS first_seen FROM op_checkpoints
    WHERE op='managed-sync' AND completed_keys->0->>'sourceId'=$1 AND completed_keys->0->>'incarnation'<>$2 AND COALESCE(completed_keys->0->>'done','false')<>'true' ORDER BY updated_at LIMIT 1`, [sourceId, incarnation]);
  return row ?? null;
}

/**
 * One unfinished managed-sync cursor of a live source incarnation: its key, its header projection (`V`), the pending
 * request's receipt (`R`, null when no receipt of the writer matches), the recorded failure (`F`), the manifest path at
 * the cursor's index and when the cursor was last written.
 */
export interface ManagedSyncFailureRow<V = Record<string, unknown>, R = Record<string, unknown>, F = Record<string, unknown>> {
  cursor_key: string; value: V; receipt: R | null; failure: F | null; path: string | null; updated_at: string;
}

/** The unfinished managed-sync cursors of the listed sources (null: every source), in no set order. */
export function readManagedSyncFailureRows<V = Record<string, unknown>, R = Record<string, unknown>, F = Record<string, unknown>>(
  exec: SyncStatusExec, sourceIds: readonly string[] | null,
): Promise<Array<ManagedSyncFailureRow<V, R, F>>> {
  return exec.executeRaw<ManagedSyncFailureRow<V, R, F>>(`
    SELECT c.fingerprint AS cursor_key,jsonb_build_object('sourceId',s.id,'incarnation',s.incarnation,'runId',c.completed_keys->0->>'runId',
      'index',c.completed_keys->0->'index','target',c.completed_keys->0->>'target',
      'syncOptions',c.completed_keys->0->'syncOptions','processingOptions',c.completed_keys->0->'processingOptions',
      'pending',jsonb_build_object('requestId',c.completed_keys->0->'pending'->>'requestId')) AS value,
      CASE WHEN r.id IS NULL THEN NULL ELSE jsonb_build_object('state',r.state,'request_id',r.request_id,'error_code',r.error_code,'error_message',r.error_message,'error_detail',r.error_detail) END AS receipt,
      f.completed_keys->0 AS failure,m.completed_keys->((c.completed_keys->0->>'index')::int)->>'path' AS path,c.updated_at
    FROM op_checkpoints c
    JOIN sources s ON s.id=c.completed_keys->0->>'sourceId' AND s.incarnation::text=c.completed_keys->0->>'incarnation'
    LEFT JOIN persistence_requests r ON r.source_id=s.id AND r.source_incarnation=s.incarnation AND r.request_id=(c.completed_keys->0->'pending'->>'requestId')::uuid
      AND r.principal_id=c.completed_keys->0->'authority'->'writer'->'principal'->>'id'
      AND r.principal_kind=c.completed_keys->0->'authority'->'writer'->'principal'->>'kind'
    LEFT JOIN op_checkpoints f ON f.op='managed-sync-failure' AND f.fingerprint=c.fingerprint
    LEFT JOIN op_checkpoints m ON m.op='managed-sync-manifest' AND m.fingerprint=c.completed_keys->0->>'runId'
    WHERE c.op='managed-sync' AND COALESCE(c.completed_keys->0->>'done','false')<>'true'
      AND ($1::text[] IS NULL OR s.id=ANY($1::text[]))`, [sourceIds ? [...sourceIds] : null]);
}

/** The recorded managed-sync failures of live source incarnations (null: every source) whose cursor row is gone, in no set order. */
export function readOrphanedManagedSyncFailureRows<F = Record<string, unknown>>(exec: SyncStatusExec, sourceIds: readonly string[] | null): Promise<Array<{ failure: F }>> {
  return exec.executeRaw<{ failure: F }>(`
    SELECT f.completed_keys->0 AS failure FROM op_checkpoints f
    JOIN sources s ON s.id=f.completed_keys->0->>'source_id' AND s.incarnation::text=f.completed_keys->0->>'source_incarnation'
    WHERE f.op='managed-sync-failure' AND ($1::text[] IS NULL OR s.id=ANY($1::text[]))
      AND NOT EXISTS(SELECT 1 FROM op_checkpoints c WHERE c.op='managed-sync' AND c.fingerprint=f.fingerprint)`, [sourceIds ? [...sourceIds] : null]);
}

/** The head of a source binding's unfinished write requests (running first, then by sequence). */
export interface SyncHeadRequestRow {
  head_state: string; head_claim_phase: unknown; head_token: string | null; head_lapsed: boolean | null; head_kind: string | null; head_request_id: string | null;
  head_write_request_id: string | null;
}

/** The drain's head probe: the source's bound worktree's head request, or null when the source has no binding or nothing unfinished. */
export async function readSyncHeadRequestRow(exec: SyncStatusExec, sourceId: string, opts?: SyncStatusProbeOptions): Promise<SyncHeadRequestRow | null> {
  const [row] = await exec.executeRaw<SyncHeadRequestRow>(
    `SELECT h.state AS head_state, h.id::text AS head_request_id, h.request_id::text AS head_write_request_id, h.claim_phase AS head_claim_phase, h.execution_token::text AS head_token,
           (h.claim_expires_at IS NOT NULL AND h.claim_expires_at < now()) AS head_lapsed, h.intent->>'kind' AS head_kind
         FROM persistence_source_bindings b
         JOIN sources s ON s.id = b.source_id AND s.incarnation = b.source_incarnation
         JOIN LATERAL (SELECT e.id, e.request_id, e.state, e.claim_phase, e.execution_token, e.claim_expires_at, e.intent FROM persistence_requests e
           WHERE e.worktree_id = b.worktree_id AND e.state IN ('queued','running','recovering') ORDER BY (e.state <> 'running'), e.sequence LIMIT 1) h ON true
         WHERE b.source_id = $1`, [sourceId], opts);
  return row ?? null;
}

/** How many of the source's requests hold a publication recovery record, and the first by sequence. */
export interface SyncRecoveryProbeRow { n: number | string; request_id: string | null; slug: string | null; blocked: boolean | null }

export async function readSyncRecoveryProbeRow(exec: SyncStatusExec, sourceId: string, opts?: SyncStatusProbeOptions): Promise<SyncRecoveryProbeRow> {
  const [row] = await exec.executeRaw<SyncRecoveryProbeRow>(
    `SELECT (SELECT count(*) FROM persistence_requests WHERE source_id=$1 AND recovery IS NOT NULL) AS n, f.request_id::text AS request_id, f.slug,
         f.blocked_reason IN ('unexpected_staging_bytes','unexpected_file_bytes') AS blocked
       FROM (SELECT 1) one LEFT JOIN LATERAL (SELECT request_id, slug, blocked_reason FROM persistence_requests WHERE source_id=$1 AND recovery IS NOT NULL ORDER BY sequence LIMIT 1) f ON true`, [sourceId], opts);
  return row!;
}

/**
 * The open identity-downgrade records (no disposition, old page still soft-deleted by that sync) of the listed sources
 * (null: every source), oldest first, each with the live slugs at its new path (null when none).
 */
export function readIdentityDowngradeRows<D = Record<string, unknown>>(exec: SyncStatusExec, sourceIds: readonly string[] | null): Promise<Array<{ record: D | string; new_slugs: string[] | null }>> {
  return exec.executeRaw<{ record: D | string; new_slugs: string[] | null }>(
    `SELECT dg.completed_keys->0 AS record, np.slugs AS new_slugs FROM op_checkpoints dg JOIN pages p ON p.id::text = dg.fingerprint
      LEFT JOIN LATERAL (SELECT array_agg(slug ORDER BY slug) AS slugs FROM pages WHERE source_id = p.source_id AND deleted_at IS NULL AND source_path = dg.completed_keys->0->>'to') np ON true
      WHERE dg.op = $1 AND p.deleted_at IS NOT NULL AND dg.completed_keys->0->>'disposition' IS NULL AND p.deleted_at = (dg.completed_keys->0->>'old_deleted_at')::timestamptz
        AND p.source_id = dg.completed_keys->0->>'source_id' AND ($2::text[] IS NULL OR p.source_id = ANY($2::text[]))
      ORDER BY dg.completed_keys->0->>'recorded_at', dg.fingerprint`, [IDENTITY_DOWNGRADE_OP, sourceIds ? [...sourceIds] : null]);
}
