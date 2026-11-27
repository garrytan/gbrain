/**
 * The constant statements `gbrain sync status` reads through typed engine members (engine-sql/sync-status-reads.ts).
 * Each statement is composed once, at load, from code constants only (the admission setting and probe builders of
 * sync-admission.ts, the active worktree-refresh states and the Git push codes), with the op names engine-sql needs
 * without importing their heavier home modules; the members bind every value.
 * They live outside engine-sql because they splice those builders' hand-numbered placeholders
 * (docs/ci-guards.md#engine-sql-dynamic-sql, CONSTANT_ALLOWLIST).
 */
import { APPLE_CONTACTS_PENDING_DELETES_OP, APPLE_CONTACTS_REVIEW_OP } from '../apple-contacts/review-status.ts';
import { MANAGED_SYNC_PASS_OP } from '../engine-sql/sync-hold-store.ts';
import { SYNC_DELETES_WITHHELD_OP } from './sync-pass-row.ts';
import { SYNC_ADMISSION_SETTING_PARAMS, syncAdmissionEffectParams, syncAdmissionEffectSql, syncAdmissionSettingSql } from './sync-admission.ts';
import { ACTIVE_REFRESH_STATES_SQL } from './worktree-refresh-schema.ts';

/** The error codes of a Git effect whose commit is local but whose push did not land (git-push-holds.ts re-exports it). */
export const GIT_PUSH_CODES = ['git_push_unavailable', 'push_unconfirmed', 'integrate_conflict', 'publish_secret_found', 'publish_scan_unreadable', 'push_credential_refused'] as const;
/** The error codes of a Git effect whose commit was not made (a commit-phase git step failed; git-commit-holds.ts). */
export const GIT_COMMIT_CODES = ['git_unavailable'] as const;

/** The op of a sync identity-downgrade record, one row per old page id (sync-identity-downgrades.ts re-exports it). */
export const IDENTITY_DOWNGRADE_OP = 'sync-identity-downgrade';

const admissionSql = syncAdmissionSettingSql(4);

/**
 * `sync status`'s source read (#6712 PR 4b): the live source row with the drain-lock probe, the pass row and the
 * withheld-delete record (primary-key probes), the admission setting and its probes, the failed writeback of the pass,
 * the open worktree refresh and the apple-contacts identity reviews and held deletes (GST-3256). `$1` source id, `$2` pass op, `$3` withheld op, `$4`..`$6` the setting params,
 * `$7`..`$9` the probe params (`syncStatusSourceParams`).
 */
export const SYNC_STATUS_SOURCE_SQL = `SELECT s.incarnation::text AS incarnation, s.last_commit, s.last_sync_at, EXISTS (SELECT 1 FROM gbrain_cycle_locks l WHERE l.id=$7) AS drain_lock,
      p.completed_keys->0 AS pass_value, p.updated_at AS pass_updated_at, now() AS pass_read_at, w.completed_keys->0 AS withheld, ${admissionSql.columns}, ${syncAdmissionEffectSql(7, 's')},
      (SELECT r.request_id::text FROM persistence_effects e JOIN persistence_requests r ON r.id=e.request_id WHERE e.kind='git' AND e.state='failed' AND NOT (e.data ? 'settled')
        AND e.request_id IN (SELECT id::uuid FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(p.completed_keys->0->'obligations'->'converged'->'writeback')='array'
          THEN p.completed_keys->0->'obligations'->'converged'->'writeback' ELSE '[]'::jsonb END) AS w(id)) ORDER BY e.id LIMIT 1) AS writeback_failed,
      (SELECT row_to_json(f) FROM (SELECT r.id,r.worktree_id,r.state,r.source_ids,r.outcome,r.old_head,r.target_head,r.barrier_sequence,r.updated_at,w.owner_host_id FROM persistence_worktree_refreshes r
        LEFT JOIN persistence_worktrees w ON w.id=r.worktree_id WHERE s.id=ANY(r.source_ids) AND r.state IN ${ACTIVE_REFRESH_STATES_SQL} LIMIT 1) f) AS refresh,
      (SELECT ir.completed_keys FROM op_checkpoints ir WHERE ir.op='${APPLE_CONTACTS_REVIEW_OP}' AND ir.fingerprint=s.id) AS identity_reviews,
      (SELECT hd.completed_keys FROM op_checkpoints hd WHERE hd.op='${APPLE_CONTACTS_PENDING_DELETES_OP}' AND hd.fingerprint=s.id) AS held_deletes, s.config FROM sources s
      LEFT JOIN op_checkpoints p ON p.op=$2 AND p.fingerprint=s.id||':'||s.incarnation::text
      LEFT JOIN op_checkpoints w ON w.op=$3 AND w.fingerprint=s.id||':'||s.incarnation::text
      ${admissionSql.joins}
      WHERE s.id=$1 AND s.archived IS NOT TRUE`;

/** The binds of `SYNC_STATUS_SOURCE_SQL` for one source. */
export const syncStatusSourceParams = (sourceId: string): unknown[] =>
  [sourceId, MANAGED_SYNC_PASS_OP, SYNC_DELETES_WITHHELD_OP, ...SYNC_ADMISSION_SETTING_PARAMS, ...syncAdmissionEffectParams(sourceId)];

/**
 * `sync status`'s committed read (#7010, GBRA-161 PR 2): managed-sync pages committed in the last ten minutes, whether a
 * Git effect's push or commit is held (`git_push_held` covers both), whether a fact or take fence generation is held, and the newest managed-sync commit of the
 * source's bindings. `$1` source id.
 */
export const SYNC_STATUS_COMMITTED_SQL = `SELECT count(*) AS n, EXISTS (SELECT 1 FROM persistence_effects e
      WHERE e.source_id=$1 AND e.kind='git' AND e.state IN ('queued','running','failed') AND e.error_code IN ('targets_parked', ${[...GIT_PUSH_CODES, ...GIT_COMMIT_CODES].map(code => `'${code}'`).join(',')})
        AND NOT (e.data ? 'settled')) AS git_push_held,
      EXISTS (SELECT 1 FROM derived_generations g WHERE g.source_id=$1 AND g.kind IN ('fact_fence','take_fence') AND g.state='held') AS fence_held,
      (SELECT max(r.completed_at) FROM persistence_source_bindings b JOIN persistence_requests r ON r.worktree_id=b.worktree_id AND r.source_incarnation=b.source_incarnation
        WHERE b.source_id=$1 AND r.state='committed' AND COALESCE(r.intent->>'kind','') LIKE 'managed_sync_%') AS last_committed_at
    FROM persistence_requests WHERE source_id=$1 AND state='committed'
    AND intent->>'kind' IN ('managed_sync_import','managed_sync_delete') AND completed_at > now() - interval '10 minutes'`;

