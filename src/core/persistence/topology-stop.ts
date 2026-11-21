/**
 * This host's recovering source topology changes, as `gbrain sources writer status` (`topology_recoveries`) and doctor
 * (`topology_recovery_stopped`) list them. The owner's topology recovery (topology-recovery.ts
 * `recoverSourceTopologies`, which finishes or rolls back an interrupted clone or reclone under topology-locks.ts
 * `withTopologyLocks`) reads, locks and writes through the typed `topologyStore` member, so it converges on every
 * engine and no engine stops it (docs/ENGINES.md, "Topology recovery on the Rust engine"). `stop` stays in the
 * listing, always null, so JSON readers of an earlier release keep their shape.
 */
import type { BrainEngine } from '../engine.ts';

/** One recovering change on this host. `stop` is always null: no engine stops topology recovery. */
export interface TopologyRecoveryStop {
  change_id: string;
  source_id: string;
  operation: string;
  stop: null;
}

/** At most this many recovering changes are listed; `more` says whether others exist. */
export const TOPOLOGY_RECOVERY_LIST_LIMIT = 16;

/** This host's recovering topology changes (in id order, at most TOPOLOGY_RECOVERY_LIST_LIMIT). A typed read only; it never locks or changes a row. */
export async function readTopologyRecoveryStops(engine: BrainEngine, hostId: string | null):
  Promise<{ recovering: TopologyRecoveryStop[]; more: boolean; stop: null }> {
  // A host with no identity yet owns no worktree, so no change can be recovering on it.
  if (hostId === null) return { recovering: [], more: false, stop: null };
  const rows = await engine.listTopologyRecoveries(hostId, null, TOPOLOGY_RECOVERY_LIST_LIMIT + 1);
  return {
    recovering: rows.slice(0, TOPOLOGY_RECOVERY_LIST_LIMIT).map(row => ({ change_id: row.id, source_id: row.source_id, operation: row.operation, stop: null })),
    more: rows.length > TOPOLOGY_RECOVERY_LIST_LIMIT,
    stop: null,
  };
}
