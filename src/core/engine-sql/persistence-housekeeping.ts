/**
 * Housekeeping statements: one SQL implementation for both engines (Rust engine persistence, write journal lane).
 *
 * The statements the consumer's housekeeping sent through `executeRaw` after a write: the host's housekeeping turn
 * (`housekeeping-turn.ts`), the receipt budget and compaction listing (`compaction-pass.ts`, `journal.ts`), the
 * `repair receipt-compaction` window, candidates and kept-failure count (`repair/receipt-compaction.ts`), the
 * true-up reads (`receipt-true-up.ts`), the capacity forecast reads (`capacity-forecast.ts`) and the projection queue
 * reads (`page-body/projection.ts`, `page-state/projections.ts`). As in `persistence-journal.ts`, the text is written out
 * in full so this module imports no persistence code; `test/persistence-journal-statements.test.ts` checks each copy
 * against the fragments the callers build it from. Decisions and arithmetic stay with the callers.
 */
import type { LegacyUnscopedRead } from './brands.ts';
import type { SqlExecutor } from './executor.ts';

/**
 * `compactWriteReceiptsDetailed`'s listing (`UNRESOLVED_CALLER_REFUSAL_SQL('r')`, `OPEN_SYNC_CURSOR_EXCLUSION('r')` and
 * `NEWEST_SYNC_RECEIPT_EXCLUSION('r')` written out): $1 retention days. At most 100 rows, oldest first.
 */
export const COMPACTABLE_RECEIPTS_SQL = `SELECT * FROM persistence_requests r
    WHERE state IN ('committed','conflict','failed','cancelled') AND recovery IS NULL AND NOT compacted
    AND completed_at < now()-($1::double precision*interval '1 day')
    AND NOT EXISTS (SELECT 1 FROM persistence_effects e WHERE e.request_id=r.id AND e.state<>'committed')
    AND NOT COALESCE((((r.state='failed' AND (r.error_code='writer_coordinator_required'
  OR (r.error_code='storage_error' AND r.error_message LIKE 'Publication failed (P0001)%'))) OR (r.state='conflict' AND r.error_code='source_changed'))
  AND r.operation IN ('put_page','add_timeline_entry','remember') AND NOT (r.operation='put_page' AND r.intent ? 'kind')
  AND NOT EXISTS (SELECT 1 FROM persistence_requests c WHERE (c.source_id=r.source_id AND c.slug=r.slug AND c.sequence>r.sequence AND (
    (c.digest=r.digest AND c.state IN ('committed','failed','queued','running','recovering'))
    OR (c.state IN ('committed','queued','running','recovering') AND (c.operation IN ('delete_page','purge_page') OR r.operation='put_page'))
    OR (r.slug='__managed_sync_checkpoint__' AND r.operation='submit_job' AND c.state='committed' AND c.operation='submit_job'
      AND COALESCE((SELECT k.intent->>'kind' FROM persistence_requests k WHERE k.id=r.id),'managed_sync_checkpoint')='managed_sync_checkpoint'
      AND COALESCE(c.intent->>'kind','managed_sync_checkpoint')='managed_sync_checkpoint')
    OR (r.operation='put_page' AND c.state='failed' AND c.operation='put_page' AND COALESCE(NOT (c.intent ? 'kind'), false))
    OR (r.operation='submit_job' AND c.operation='submit_job' AND c.state='committed' AND COALESCE(c.intent ? 'retryOf', false)
      AND EXISTS (SELECT 1 FROM persistence_requests k, persistence_requests cc WHERE k.id=r.id AND cc.sequence=c.sequence
        AND k.intent->>'kind' IN ('connector_v2_import','connector_v2_delete','connector_v2_checkpoint')
        AND cc.intent->>'kind'=k.intent->>'kind' AND cc.principal_kind=k.principal_kind AND cc.principal_id=k.principal_id
        AND cc.source_incarnation=k.source_incarnation
        AND EXISTS (WITH RECURSIVE lineage(request_id, sequence, intent, depth) AS (
            SELECT cc.request_id, cc.sequence, cc.intent, 0
            UNION ALL
            SELECT p.request_id, p.sequence, p.intent, l.depth+1 FROM lineage l JOIN persistence_requests p
              ON p.principal_kind=k.principal_kind AND p.principal_id=k.principal_id
              AND p.request_id=CASE WHEN l.intent->>'retryOf' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN (l.intent->>'retryOf')::uuid END
            WHERE l.depth<32 AND p.sequence<l.sequence AND p.source_id=k.source_id
              AND p.source_incarnation=k.source_incarnation AND p.operation=k.operation AND p.slug=k.slug AND p.intent->>'kind'=k.intent->>'kind')
          SELECT 1 FROM lineage WHERE request_id=k.request_id))))))), false)
    AND NOT (r.intent ? 'runId' AND EXISTS (SELECT 1 FROM op_checkpoints c
      WHERE c.op='managed-sync' AND c.completed_keys->0->>'runId'=r.intent->>'runId' AND COALESCE(c.completed_keys->0->>'done','false')<>'true'))
    AND NOT (r.intent ? 'passId' AND EXISTS (SELECT 1 FROM op_checkpoints p
      WHERE p.op='managed-sync-pass' AND p.completed_keys->0->'telemetry'->>'pass_id'=r.intent->>'passId' AND p.completed_keys->0->'telemetry'->>'outcome'='open'))
    AND NOT (r.state='committed' AND r.worktree_id IS NOT NULL AND (r.intent ? 'runId' OR r.intent ? 'passId')
      AND COALESCE(r.intent->>'kind','') LIKE 'managed_sync_%' AND r.id=(SELECT n.id FROM persistence_requests n WHERE n.worktree_id=r.worktree_id
        AND n.state='committed' AND COALESCE(n.intent->>'kind','') LIKE 'managed_sync_%' ORDER BY n.completed_at DESC, n.sequence DESC LIMIT 1))
    ORDER BY sequence LIMIT 100`;

export function listCompactableReceipts<R = Record<string, unknown>>(exec: LegacyUnscopedRead, retentionDays: number): Promise<R[]> {
  return exec.executeRaw<R>(COMPACTABLE_RECEIPTS_SQL, [retentionDays]);
}

/** `deleteProjectionJob`: $1 source incarnation, $2 slug, $3 revision. */
export const DELETE_PROJECTION_JOB_SQL = 'DELETE FROM page_projection_jobs WHERE source_incarnation=$1::uuid AND slug=$2 AND revision=$3::uuid';
/** A queued job by its key and the revision it was queued at. */
export interface ProjectionJobRef { sourceIncarnation: string; slug: string; revision: string }

/** Deletes the job when it is still queued at `job.revision`. */
export async function deleteProjectionJob(exec: SqlExecutor, job: ProjectionJobRef): Promise<void> {
  await exec.executeRaw(DELETE_PROJECTION_JOB_SQL, [job.sourceIncarnation, job.slug, job.revision]);
}
