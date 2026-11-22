/**
 * Doctor sync reads: the statements `gbrain doctor`'s sync checks (and the readers they share) ran through `executeRaw`
 * over `op_checkpoints`, `sources` and `persistence_requests`, each with the same text and parameters, on the engine's
 * own `executeRaw`; only their home moved. PGLite and Postgres run these exact statements. Nothing here is composed:
 * the fragments `managed-sync-orphans.ts` splices into its retirement re-check (`checkpointMovedSql`,
 * `slugModeRefusedSql`, `passSlugModeRefusedSql`, `passStampSql`) are inlined, and test/doctor-sync-sql.test.ts pins
 * each inlined text against the text that module composes.
 *
 * The Rust engine answers each member in one of two ways (rust/docs/store/cli-reads-doctor-sync.md):
 *  - served from its store: the members that read pages, sources and facts the store keeps;
 *  - empty, no writer: managed-sync cursors, failure rows and pass rows are written only through `executeRaw`, which a
 *    Rust brain refuses, so no such row exists there. The Rust member answers the empty value (`[]`) in TypeScript
 *    without a store call, which is what the same read finds on a brain nothing has written to.
 */
import type { EngineRawRead } from './cli-reads-ops.ts';
import type { ManagedSyncFailure } from '../persistence/sync-failures.ts';
import type { SyncCursorOptions } from '../persistence/sync-prepare.ts';
import type { SyncProcessingOptions } from '../persistence/sync-authority.ts';
import type { WriteRequest } from '../persistence/model.ts';

export type { EngineRawRead } from './cli-reads-ops.ts';

/**
 * The members of this file. Each replaced a statement doctor ran through its deadline-bound executeRaw, so
 * src/core/statement-deadline.ts keeps that bound on them (BOUNDED_TYPED_READS).
 */
export const DOCTOR_SYNC_MEMBERS: readonly string[] = [
  'listManagedSyncCursorFailureRows', 'listManagedSyncOrphanRowsets', 'listDurableManagedSyncFailureKeys',
];

/** An unfinished managed-sync cursor of a live source incarnation, with its pending receipt, its failure row and its manifest path. */
export interface ManagedSyncCursorFailureRow {
  cursor_key: string;
  value: { sourceId: string; incarnation: string; runId: string; index: number; target: string; pending?: { requestId: string };
    syncOptions: SyncCursorOptions | null; processingOptions: Partial<SyncProcessingOptions> | null };
  receipt: Pick<WriteRequest, 'state' | 'request_id' | 'error_code' | 'error_message' | 'error_detail'> | null;
  failure: ManagedSyncFailure | null;
  path: string | null;
  updated_at: string;
}

/** An unfinished cursor of an active source, with what classifies it as an orphan. */
export interface ManagedSyncOrphanCursorRow {
  cursor_key: string; source_id: string; source_incarnation: string; run_id: string | null;
  principal_kind: string | null; principal_id: string | null; has_sync_options: boolean;
  pending_request_id: string | null; pending_state: string | null;
  principal_live: boolean; superseded: boolean; checkpoint_moved: boolean; slug_mode_refused: boolean; updated_at: string;
}
/** A failure row of an active source, under a key no cursor or pass row holds. */
export interface ManagedSyncOrphanFailureRow {
  cursor_key: string; source_id: string; source_incarnation: string; run_id: string | null; request_id: string | null; updated_at: string;
}
/** A pass row whose newest stamp was refused for the slug-root mode. */
export interface ManagedSyncOrphanPassRow {
  cursor_key: string; source_id: string; source_incarnation: string; run_id: string; request_id: string; state: string; updated_at: string;
}
/** The five rowsets the orphan classification reads, in the order it reads them. */
export interface ManagedSyncOrphanRowsets {
  cursors: ManagedSyncOrphanCursorRow[];
  failures: ManagedSyncOrphanFailureRow[];
  passes: ManagedSyncOrphanPassRow[];
  retiredCursors: Array<Pick<ManagedSyncOrphanCursorRow, 'cursor_key' | 'source_id' | 'source_incarnation' | 'run_id' | 'principal_kind' | 'principal_id' | 'pending_request_id' | 'pending_state' | 'updated_at'>>;
  retiredFailures: ManagedSyncOrphanFailureRow[];
}

const LIST_MANAGED_SYNC_CURSOR_FAILURE_ROWS_SQL = `
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
      AND ($1::text[] IS NULL OR s.id=ANY($1::text[]))`;

const ORPHAN_CURSORS_SQL = `
    SELECT c.fingerprint AS cursor_key,s.id AS source_id,s.incarnation::text AS source_incarnation,c.completed_keys->0->>'runId' AS run_id,
      c.completed_keys->0->'authority'->'writer'->'principal'->>'kind' AS principal_kind,
      c.completed_keys->0->'authority'->'writer'->'principal'->>'id' AS principal_id,
      (c.completed_keys->0 ? 'syncOptions') AS has_sync_options,
      c.completed_keys->0->'pending'->>'requestId' AS pending_request_id,r.state AS pending_state,
      EXISTS(SELECT 1 FROM persistence_local_writers w WHERE w.revoked_at IS NULL
        AND w.id::text=c.completed_keys->0->'authority'->'writer'->'principal'->>'id'
        AND c.completed_keys->0->'authority'->'writer'->'principal'->>'kind' IN ('local_cli','local_stdio')) AS principal_live,
      EXISTS(SELECT 1 FROM op_checkpoints n WHERE n.op='managed-sync' AND n.fingerprint<>c.fingerprint
        AND n.completed_keys->0->>'sourceId'=s.id AND n.completed_keys->0->>'incarnation'=s.incarnation::text
        AND COALESCE(n.completed_keys->0->>'done','false')='true' AND n.updated_at>c.updated_at) AS superseded,
      (c.completed_keys->0->'pending'->'intent'->>'kind'='managed_sync_checkpoint' AND c.completed_keys->0->>'companyReceiptId' IS NULL
  AND (c.completed_keys->0->>'index')::int>=(c.completed_keys->0->>'total')::int
  AND s.last_commit IS DISTINCT FROM c.completed_keys->0->>'from'
  AND (c.completed_keys->0->'pending'->'intent'->'slice'->>'done'='false' OR s.last_commit IS DISTINCT FROM c.completed_keys->0->>'target')
  AND EXISTS(SELECT 1 FROM persistence_requests m WHERE m.source_id=s.id AND m.request_id=(c.completed_keys->0->'pending'->>'requestId')::uuid
    AND m.state IN ('failed','conflict') AND m.recovery IS NULL AND m.error_code='revision_conflict' AND m.error_message=$2)
  AND NOT EXISTS(SELECT 1 FROM persistence_requests o WHERE o.source_id=s.id AND o.intent->>'cursorKey'=c.fingerprint
    AND (o.state IN ('queued','running','recovering') OR o.recovery IS NOT NULL))) AS checkpoint_moved,
      (c.completed_keys->0->'pending'->'intent'->>'kind'='managed_sync_checkpoint' AND c.completed_keys->0->>'companyReceiptId' IS NULL
  AND (c.completed_keys->0->>'index')::int>=(c.completed_keys->0->>'total')::int
  AND s.config->>'slug_root_mode' IS NOT NULL AND s.config->>'slug_root_mode' IS DISTINCT FROM c.completed_keys->0->>'slugMode'
  AND EXISTS(SELECT 1 FROM persistence_requests m WHERE m.source_id=s.id AND m.request_id=(c.completed_keys->0->'pending'->>'requestId')::uuid
    AND m.state IN ('failed','conflict') AND m.recovery IS NULL AND m.error_code='slug_root_mode_mismatch')
  AND NOT EXISTS(SELECT 1 FROM persistence_requests o WHERE o.source_id=s.id AND o.intent->>'cursorKey'=c.fingerprint
    AND (o.state IN ('queued','running','recovering') OR o.recovery IS NOT NULL))) AS slug_mode_refused,
      to_char(c.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at
    FROM op_checkpoints c
    JOIN sources s ON s.id=c.completed_keys->0->>'sourceId' AND s.incarnation::text=c.completed_keys->0->>'incarnation' AND NOT COALESCE(s.archived,false)
    LEFT JOIN persistence_requests r ON r.source_id=s.id AND r.source_incarnation=s.incarnation
      AND r.request_id=(c.completed_keys->0->'pending'->>'requestId')::uuid
      AND r.principal_id=c.completed_keys->0->'authority'->'writer'->'principal'->>'id'
      AND r.principal_kind=c.completed_keys->0->'authority'->'writer'->'principal'->>'kind'
    WHERE c.op='managed-sync' AND COALESCE(c.completed_keys->0->>'done','false')<>'true'
      AND ($1::text[] IS NULL OR s.id=ANY($1::text[]))
    ORDER BY s.id COLLATE "C",c.updated_at,c.fingerprint COLLATE "C"`;

const ORPHAN_FAILURES_SQL = `
    SELECT f.fingerprint AS cursor_key,s.id AS source_id,s.incarnation::text AS source_incarnation,f.completed_keys->0->>'run_id' AS run_id,
      f.completed_keys->0->>'request_id' AS request_id,to_char(f.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at
    FROM op_checkpoints f
    JOIN sources s ON s.id=f.completed_keys->0->>'source_id' AND s.incarnation::text=f.completed_keys->0->>'source_incarnation' AND NOT COALESCE(s.archived,false)
    WHERE f.op='managed-sync-failure' AND ($1::text[] IS NULL OR s.id=ANY($1::text[]))
      AND NOT EXISTS(SELECT 1 FROM op_checkpoints c WHERE c.op IN ('managed-sync','managed-sync-pass') AND c.fingerprint=f.fingerprint)
    ORDER BY s.id COLLATE "C",f.fingerprint COLLATE "C"`;

const ORPHAN_PASSES_SQL = `
    SELECT p.fingerprint AS cursor_key,s.id AS source_id,s.incarnation::text AS source_incarnation,p.completed_keys->0->'telemetry'->>'pass_id' AS run_id,
      (SELECT n.request_id FROM persistence_requests n WHERE n.source_id=s.id AND n.intent->>'kind'='managed_sync_checkpoint'
  AND n.intent->>'passId'=p.completed_keys->0->'telemetry'->>'pass_id' ORDER BY n.sequence DESC LIMIT 1)::text AS request_id,(SELECT m.state FROM persistence_requests m WHERE m.source_id=s.id AND m.request_id=(SELECT n.request_id FROM persistence_requests n WHERE n.source_id=s.id AND n.intent->>'kind'='managed_sync_checkpoint'
  AND n.intent->>'passId'=p.completed_keys->0->'telemetry'->>'pass_id' ORDER BY n.sequence DESC LIMIT 1)) AS state,
      to_char(p.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at
    FROM op_checkpoints p
    JOIN sources s ON p.fingerprint=s.id||':'||s.incarnation::text AND NOT COALESCE(s.archived,false)
    WHERE p.op='managed-sync-pass' AND ($1::text[] IS NULL OR s.id=ANY($1::text[])) AND (p.completed_keys->0->'obligations'->>'slug_mode' IS NOT NULL
  AND s.config->>'slug_root_mode' IS NOT NULL AND s.config->>'slug_root_mode' IS DISTINCT FROM p.completed_keys->0->'obligations'->>'slug_mode'
  AND EXISTS(SELECT 1 FROM persistence_requests m WHERE m.source_id=s.id AND m.request_id=(SELECT n.request_id FROM persistence_requests n WHERE n.source_id=s.id AND n.intent->>'kind'='managed_sync_checkpoint'
  AND n.intent->>'passId'=p.completed_keys->0->'telemetry'->>'pass_id' ORDER BY n.sequence DESC LIMIT 1) AND m.intent->>'kind'='managed_sync_checkpoint'
    AND m.intent->>'passId'=p.completed_keys->0->'telemetry'->>'pass_id' AND m.state IN ('failed','conflict') AND m.recovery IS NULL AND m.error_code='slug_root_mode_mismatch')
  AND NOT EXISTS(SELECT 1 FROM persistence_requests o WHERE o.source_id=s.id AND o.intent->>'passId'=p.completed_keys->0->'telemetry'->>'pass_id'
    AND (o.state IN ('queued','running','recovering') OR o.recovery IS NOT NULL)))
    ORDER BY s.id COLLATE "C"`;

const ORPHAN_RETIRED_CURSORS_SQL = `
    SELECT c.fingerprint AS cursor_key,s.id AS source_id,c.completed_keys->0->>'incarnation' AS source_incarnation,c.completed_keys->0->>'runId' AS run_id,
      c.completed_keys->0->'authority'->'writer'->'principal'->>'kind' AS principal_kind,
      c.completed_keys->0->'authority'->'writer'->'principal'->>'id' AS principal_id,
      c.completed_keys->0->'pending'->>'requestId' AS pending_request_id,r.state AS pending_state,
      to_char(c.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at
    FROM op_checkpoints c
    JOIN sources s ON s.id=c.completed_keys->0->>'sourceId' AND s.incarnation::text<>c.completed_keys->0->>'incarnation' AND NOT COALESCE(s.archived,false)
    LEFT JOIN persistence_requests r ON r.source_id=s.id AND r.request_id=(c.completed_keys->0->'pending'->>'requestId')::uuid
    WHERE c.op='managed-sync' AND COALESCE(c.completed_keys->0->>'done','false')<>'true'
      AND ($1::text[] IS NULL OR s.id=ANY($1::text[]))
    ORDER BY s.id COLLATE "C",c.updated_at,c.fingerprint COLLATE "C"`;

const ORPHAN_RETIRED_FAILURES_SQL = `
    SELECT f.fingerprint AS cursor_key,s.id AS source_id,f.completed_keys->0->>'source_incarnation' AS source_incarnation,f.completed_keys->0->>'run_id' AS run_id,
      f.completed_keys->0->>'request_id' AS request_id,to_char(f.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at
    FROM op_checkpoints f
    JOIN sources s ON s.id=f.completed_keys->0->>'source_id' AND s.incarnation::text<>f.completed_keys->0->>'source_incarnation' AND NOT COALESCE(s.archived,false)
    WHERE f.op='managed-sync-failure' AND ($1::text[] IS NULL OR s.id=ANY($1::text[]))
      AND NOT EXISTS(SELECT 1 FROM op_checkpoints c WHERE c.op='managed-sync' AND c.fingerprint=f.fingerprint AND COALESCE(c.completed_keys->0->>'done','false')<>'true')
    ORDER BY s.id COLLATE "C",f.fingerprint COLLATE "C"`;

/** The unfinished managed-sync cursors of live source incarnations (`sourceIds` narrows; null reads every source). */
export async function listManagedSyncCursorFailureRows(raw: EngineRawRead, sourceIds: readonly string[] | null): Promise<ManagedSyncCursorFailureRow[]> {
  return raw<ManagedSyncCursorFailureRow>(LIST_MANAGED_SYNC_CURSOR_FAILURE_ROWS_SQL, [sourceIds ? [...sourceIds] : null]);
}

/**
 * The rowsets `classifyManagedSyncOrphans` reads, one statement each, in this order. `movedMessage` is the refusal
 * message of a checkpoint that lost the `last_commit` race (the `$2` of the cursor statement).
 */
export async function listManagedSyncOrphanRowsets(raw: EngineRawRead, sourceIds: readonly string[] | null, movedMessage: string): Promise<ManagedSyncOrphanRowsets> {
  const ids = sourceIds ? [...sourceIds] : null;
  const cursors = await raw<ManagedSyncOrphanCursorRow>(ORPHAN_CURSORS_SQL, [ids, movedMessage]);
  const failures = await raw<ManagedSyncOrphanFailureRow>(ORPHAN_FAILURES_SQL, [ids]);
  const passes = await raw<ManagedSyncOrphanPassRow>(ORPHAN_PASSES_SQL, [ids]);
  const retiredCursors = await raw<ManagedSyncOrphanRowsets['retiredCursors'][number]>(ORPHAN_RETIRED_CURSORS_SQL, [ids]);
  const retiredFailures = await raw<ManagedSyncOrphanFailureRow>(ORPHAN_RETIRED_FAILURES_SQL, [ids]);
  return { cursors, failures, passes, retiredCursors, retiredFailures };
}

const LIST_DURABLE_MANAGED_SYNC_FAILURE_KEYS_SQL = "SELECT fingerprint FROM op_checkpoints WHERE op='managed-sync-failure' AND fingerprint=ANY($1::text[])";

/** Which of these cursor keys still have a durable `managed-sync-failure` row, under any incarnation. */
export async function listDurableManagedSyncFailureKeys(raw: EngineRawRead, keys: readonly string[]): Promise<string[]> {
  return (await raw<{ fingerprint: string }>(LIST_DURABLE_MANAGED_SYNC_FAILURE_KEYS_SQL, [[...keys]])).map(row => row.fingerprint);
}

/** The statements, for the test that pins them to the text `managed-sync-orphans.ts` and `sync-failures.ts` composed. */
export const DOCTOR_SYNC_STATEMENTS = {
  cursorFailureRows: LIST_MANAGED_SYNC_CURSOR_FAILURE_ROWS_SQL, orphanCursors: ORPHAN_CURSORS_SQL, orphanFailures: ORPHAN_FAILURES_SQL,
  orphanPasses: ORPHAN_PASSES_SQL, orphanRetiredCursors: ORPHAN_RETIRED_CURSORS_SQL, orphanRetiredFailures: ORPHAN_RETIRED_FAILURES_SQL,
} as const;
