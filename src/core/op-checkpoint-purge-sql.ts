/**
 * The text of the seven-day purge of stale op checkpoints (engine-sql/op-checkpoint.ts `purgeStaleCheckpoints`).
 * It is built once from module constants (the op names), so it takes no input; `$1` binds the age in days. Each
 * exemption keeps a row another module still reads: the ops never purged, a sync delete tombstone or identity
 * downgrade while its page keeps the recorded `deleted_at`, the rows kept while their source incarnation lives, the
 * managed sync run and manifest rules, and a checkpoint an incomplete ingestion receipt names. The Rust store keeps
 * the same rules in rust/crates/gbrain-store/src/persistence/op_checkpoint.rs.
 */
import { FENCE_REPAIR_ATTEMPT_OP } from './fence-repair/attempts.ts';
import { FENCE_CANDIDATE_OP, FENCE_SCAN_OP } from './fence-repair/census-store.ts';
import { FENCE_UNCOMMITTED_OP } from './fence-repair/uncommitted-op.ts';
import { SYNC_PASS_ROW_OPS } from './persistence/sync-pass-row.ts';
import { SYNC_DELETE_TOMBSTONE_OP } from './persistence/sync-delete-tombstones.ts';

// Delete stale parents; the op_checkpoint_paths FK (ON DELETE CASCADE)
// drops their child rows automatically. The FK also guarantees no child
// can exist without a parent, so there are no orphans to sweep separately.
export const PURGE_STALE_CHECKPOINTS_SQL = `WITH deleted AS (
         DELETE FROM op_checkpoints
         WHERE updated_at < now() - ($1 || ' days')::interval
           AND op NOT IN ('managed-atoms','managed-atoms-generation','managed-connector','managed-connector-retry','managed-connector-state','managed-connector-migration')
           AND op<>'connector-hold-retry'
           AND op<>'connector-db-cursor'
           AND op<>'stuck-recovery-resolution'
           AND op<>'sync-admission'
           AND NOT (op='${SYNC_DELETE_TOMBSTONE_OP}' AND EXISTS (
             SELECT 1 FROM pages p WHERE p.id::text=op_checkpoints.fingerprint AND p.deleted_at=(op_checkpoints.completed_keys->0->>'deleted_at')::timestamptz))
           AND op<>'purge-deleted-park'
           AND op<>'derived-origin-park'
           AND op<>'owed-page-purge'
           AND NOT (op='sync-identity-downgrade' AND completed_keys->0->>'disposition' IS NULL AND EXISTS (
             SELECT 1 FROM pages p WHERE p.id::text=op_checkpoints.fingerprint AND p.deleted_at=(op_checkpoints.completed_keys->0->>'old_deleted_at')::timestamptz))
           AND NOT (op IN ('sync-hold','sync-hold-retry','sync-import-provenance','plain-directory-agreed','sync-hold-summary','sync-conversions','${FENCE_CANDIDATE_OP}','${FENCE_SCAN_OP}','${FENCE_REPAIR_ATTEMPT_OP}','${FENCE_UNCOMMITTED_OP}',${SYNC_PASS_ROW_OPS.map(op => `'${op}'`).join(',')})
             AND NOT (op='sync-hold-summary' AND COALESCE((completed_keys->0->>'count')::int,0)=0)
             AND EXISTS (SELECT 1 FROM sources s WHERE s.id=op_checkpoints.completed_keys->0->>'source_id'
               AND s.incarnation::text=op_checkpoints.completed_keys->0->>'incarnation'))
           AND NOT (op='managed-sync' AND (COALESCE(completed_keys->0->>'done','false')<>'true' OR EXISTS (
             SELECT 1 FROM op_checkpoints f WHERE f.op='managed-sync-failure' AND f.fingerprint=op_checkpoints.fingerprint)))
           AND op<>'managed-sync-failure'
           AND NOT (op='managed-sync-manifest' AND EXISTS (
             SELECT 1 FROM op_checkpoints c WHERE c.op='managed-sync'
               AND c.completed_keys->0->>'runId'=op_checkpoints.fingerprint
               AND COALESCE(c.completed_keys->0->>'done','false')<>'true'))
           AND NOT EXISTS (
             SELECT 1 FROM source_ingestion_receipts r,
               LATERAL jsonb_array_elements(r.checkpoint_refs) ref
             WHERE r.outcome = 'incomplete'
               AND ref->>'op' = op_checkpoints.op
               AND ref->>'fingerprint' = op_checkpoints.fingerprint
           )
         RETURNING 1
       )
       SELECT count(*)::text AS count FROM deleted`;
