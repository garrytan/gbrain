import type { BrainEngine } from '../engine.ts';

/**
 * Persistence source bindings whose source or source incarnation no longer
 * exists (#5732). `persistence_source_bindings` has PRIMARY KEY(source_id) and
 * no FK to `sources`, so a source removed by an older release left its binding
 * behind, and a source re-added under the same id could never be claimed.
 * Enumerated brain-wide, independent of active-source scope. A binding still
 * referenced by a non-terminal request of its incarnation is kept.
 */
export interface OrphanBinding {
  source_id: string;
  source_incarnation: string;
  worktree_id: string;
  reason: 'source_removed' | 'incarnation_replaced';
  pending_requests: number;
}

const ORPHANS = `SELECT b.source_id, b.source_incarnation::text AS source_incarnation, b.worktree_id::text AS worktree_id,
    CASE WHEN s.id IS NULL THEN 'source_removed' ELSE 'incarnation_replaced' END AS reason,
    (SELECT COUNT(*)::int FROM persistence_requests r
      WHERE r.source_id = b.source_id AND r.source_incarnation = b.source_incarnation
        AND r.state IN ('queued','running','recovering')) AS pending_requests
  FROM persistence_source_bindings b
  LEFT JOIN sources s ON s.id = b.source_id
  WHERE s.id IS NULL OR s.incarnation <> b.source_incarnation`;

export async function listOrphanBindings(engine: Pick<BrainEngine, 'executeRaw'>, opts: { limit?: number } = {}): Promise<OrphanBinding[]> {
  return engine.executeRaw<OrphanBinding>(`${ORPHANS} ORDER BY b.source_id${opts.limit ? ` LIMIT ${Math.floor(opts.limit)}` : ''}`);
}

/**
 * Delete one orphan binding, rechecking in the same statement that it is
 * still orphaned and has no pending request. Returns whether it was deleted.
 */
export async function deleteOrphanBinding(engine: Pick<BrainEngine, 'executeRaw'>, binding: Pick<OrphanBinding, 'source_id' | 'source_incarnation'>): Promise<boolean> {
  const rows = await engine.executeRaw(
    `DELETE FROM persistence_source_bindings b
      WHERE b.source_id = $1 AND b.source_incarnation = $2::uuid
        AND NOT EXISTS (SELECT 1 FROM sources s WHERE s.id = b.source_id AND s.incarnation = b.source_incarnation)
        AND NOT EXISTS (SELECT 1 FROM persistence_requests r WHERE r.source_id = b.source_id
          AND r.source_incarnation = b.source_incarnation AND r.state IN ('queued','running','recovering'))
      RETURNING b.source_id`,
    [binding.source_id, binding.source_incarnation],
  );
  return rows.length > 0;
}
