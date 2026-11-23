import type { BrainEngine } from '../engine.ts';
import type { OrphanBinding } from '../engine-sql/repair-bookkeeping.ts';

/**
 * Persistence source bindings whose source or source incarnation no longer
 * exists (#5732). `persistence_source_bindings` has PRIMARY KEY(source_id) and
 * no FK to `sources`, so a source removed by an older release left its binding
 * behind, and a source re-added under the same id could never be claimed.
 * Enumerated brain-wide, independent of active-source scope. A binding still
 * referenced by a non-terminal request of its incarnation is kept. The SQL is
 * engine-sql/repair-bookkeeping.ts; the Rust engine keeps no writer bindings.
 */
export type { OrphanBinding };

export async function listOrphanBindings(engine: Pick<BrainEngine, 'listOrphanBindings'>, opts: { limit?: number } = {}): Promise<OrphanBinding[]> {
  return engine.listOrphanBindings(opts);
}

/**
 * Delete one orphan binding, rechecking in the same statement that it is
 * still orphaned and has no pending request. Returns whether it was deleted.
 */
export async function deleteOrphanBinding(engine: Pick<BrainEngine, 'deleteOrphanBinding'>, binding: Pick<OrphanBinding, 'source_id' | 'source_incarnation'>): Promise<boolean> {
  return engine.deleteOrphanBinding(binding);
}

export const ORPHANS = `SELECT b.source_id, b.source_incarnation::text AS source_incarnation, b.worktree_id::text AS worktree_id,
    CASE WHEN s.id IS NULL THEN 'source_removed' ELSE 'incarnation_replaced' END AS reason,
    (SELECT COUNT(*)::int FROM persistence_requests r
      WHERE r.source_id = b.source_id AND r.source_incarnation = b.source_incarnation
        AND r.state IN ('queued','deferred','running','recovering')) AS pending_requests
  FROM persistence_source_bindings b
  LEFT JOIN sources s ON s.id = b.source_id
  WHERE s.id IS NULL OR s.incarnation <> b.source_incarnation`;
