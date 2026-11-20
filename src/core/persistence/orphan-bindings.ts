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
