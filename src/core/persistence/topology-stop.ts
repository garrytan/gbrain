/**
 * The recovering source topology changes of this host, for doctor (`topology_recovery_stopped`) and `gbrain sources
 * writer status` (`topology_recoveries`).
 *
 * The Rust engine used to stop two managed-checkout steps by name (`source_topology_recovery`, `managed_source_clone`)
 * because they locked and read through raw SQL. Both now run on typed members of the topology store
 * (engine-sql/topology-store.ts), so no step refuses by name: `stop` is always null, and a change recovering on this
 * host is finished by the owner's recovery scan (topology-recovery.ts `recoverSourceTopologies`) on every engine that
 * holds a managed worktree. The field stays so the status JSON keeps its shape.
 */
import type { BrainEngine } from '../engine.ts';

/** One recovering change on this host. `stop` is always null: no topology step refuses by name any more. */
export interface TopologyRecoveryStop {
  change_id: string;
  source_id: string;
  operation: string;
  stop: null;
}

/** At most this many recovering changes are listed; `more` says whether others exist. */
export const TOPOLOGY_RECOVERY_LIST_LIMIT = 16;

/**
 * This host's recovering topology changes (in id order, at most TOPOLOGY_RECOVERY_LIST_LIMIT). A typed read only; it
 * never locks or changes a row.
 */
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
