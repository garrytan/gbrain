/**
 * The managed sync checkpoint's validation statements (#5762, #6643, #6712), as the text `src/core/engine-sql/checkpoint-validation.ts` runs.
 * They carry hand-numbered `$n` placeholders the caller binds, so they live here, outside the engine-sql guard's tree, and move byte for byte:
 * `INCOMPLETE_SYNC_RECEIPT_SQL` and `OPEN_PASS_WORK_SQL` are read by the request-index EXPLAIN test and the fold-hook trace, and
 * `incompleteSyncReceiptSql` builds the status list's statement. No imports: the engine module imports this one, never the other way.
 */

const SYNC_PAGE_KINDS = "r.intent->>'kind' IN ('managed_sync_import','managed_sync_delete')";
/**
 * #6643: clause 3 skips a terminal, recovery-free receipt the cursor settled another way: one the run converted in place
 * ($3, #5988) and one at an index the cursor passed without a commit (waived or held: the settled ranges $4..$5).
 * #6712 retired the knock-on exemption ($6): no page is cancelled for another page's failure any more, and the cursor
 * converts a legacy knock-on it meets in place (sync-run.ts `refreezeInPlace`).
 */
export const incompleteSyncReceiptSql = (limit: number) => `(SELECT r.request_id::text AS request_id FROM persistence_requests r
    WHERE r.worktree_id=$1::uuid AND r.recovery IS NOT NULL LIMIT ${limit})
  UNION ALL (SELECT r.request_id::text FROM persistence_requests r
    WHERE r.worktree_id=$1::uuid AND r.intent->>'runId'=$2 AND r.state<>'committed' AND ${SYNC_PAGE_KINDS}
      AND r.state IN ('queued','running','recovering') LIMIT ${limit})
  UNION ALL (SELECT r.request_id::text FROM persistence_requests r
    LEFT JOIN LATERAL (SELECT true AS found FROM persistence_requests committed WHERE committed.source_id=r.source_id
        AND committed.intent->>'runId'=$2 AND committed.intent->>'index'=r.intent->>'index'
        AND committed.state='committed' AND committed.intent ? 'runId' LIMIT 1) sibling ON true
    WHERE r.worktree_id=$1::uuid AND r.intent->>'runId'=$2 AND r.state<>'committed' AND ${SYNC_PAGE_KINDS}
      AND sibling.found IS NULL
      AND NOT (r.request_id::text=ANY($3::text[]))
      AND NOT (r.state IN ('failed','cancelled','conflict') AND r.recovery IS NULL
        AND EXISTS (SELECT 1 FROM unnest($4::int[], $5::int[]) AS settled(lo, hi) WHERE (r.intent->>'index')::int BETWEEN settled.lo AND settled.hi)) LIMIT ${limit})
  LIMIT ${limit}`;
export const INCOMPLETE_SYNC_RECEIPT_SQL = incompleteSyncReceiptSql(1);

/** The pass stamp's validation statement (`readOpenPassWork`): `$1` the worktree, `$2` the stamp's own request id. */
export const OPEN_PASS_WORK_SQL = `(SELECT r.request_id::text AS request_id FROM persistence_requests r
    WHERE r.worktree_id=$1::uuid AND r.recovery IS NOT NULL LIMIT 1)
  UNION ALL (SELECT r.request_id::text FROM persistence_requests r
    WHERE r.worktree_id=$1::uuid AND r.state IN ('queued','running','recovering') AND r.request_id<>$2::uuid
      AND r.intent->>'kind' IN ('managed_sync_import','managed_sync_delete','managed_sync_checkpoint') LIMIT 1)
  LIMIT 1`;

/** The pass stamp's statement with the stamp's own recovery record exempt (a folded writeback stamp). */
export const OPEN_PASS_WORK_OWN_RECOVERY_SQL = OPEN_PASS_WORK_SQL.replace('r.recovery IS NOT NULL LIMIT 1', 'r.recovery IS NOT NULL AND r.request_id<>$2::uuid LIMIT 1');

/** The statement `listIncompleteSyncReceipts` runs: the blockers of `incompleteSyncReceiptSql(20)`, in sequence order, with what `sync status` shows. */
export const INCOMPLETE_SYNC_RECEIPTS_SQL = `SELECT r.request_id::text AS request_id, r.slug, r.state, r.error_code AS code, (r.intent->>'index')::int AS index, r.recovery IS NOT NULL AS recovery
      FROM persistence_requests r WHERE r.request_id::text IN (SELECT request_id FROM (${incompleteSyncReceiptSql(20)}) blockers) ORDER BY r.sequence LIMIT 20`;
