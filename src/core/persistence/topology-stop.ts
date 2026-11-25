/**
 * The named Rust stop for source topology changes (docs/ENGINES.md, "Topology recovery on the Rust engine"). Two
 * managed-checkout steps run on the typed topology store (engine-sql/topology-store.ts) once the engine holds managed
 * worktrees: the owner's topology recovery (topology-recovery.ts `recoverSourceTopologies`, which finishes an
 * interrupted clone, reclone or retire under topology-locks.ts `withTopologyLocks`) and the managed clone itself
 * (topology-clone.ts `runManagedSourceClone`, used by `sources add --url` and `sources reclone`). While the engine serves
 * neither raw SQL nor managed worktrees (a user's Rust brain: `managed_persistence` is held back), each step refuses by
 * its own name before any principal, lock, filesystem write, git clone or row change, so a recovering change stays
 * exactly as recorded and no partial clone directory exists. PGLite, Postgres, a Rust engine with the hold lifted and
 * transaction handles (no capability set) pass.
 *
 * Doctor (`topology_recovery_stopped`) and `gbrain sources writer status` (`topology_recoveries`) name the stop for
 * each recovering change on this host through `readTopologyRecoveryStops`, a typed read only.
 */
import type { BrainEngine } from '../engine.ts';
import { capabilityMissing, managesWorktrees, servesRawSql } from '../rust-engine/errors.ts';

/** Each named step, with why it needs raw SQL (the text the refusal names after the step). */
export const TOPOLOGY_STOPS = {
  source_topology_recovery: 'it finishes an interrupted source lifecycle change under topology locks that need raw SQL',
  managed_source_clone: 'a managed clone or reclone reserves, locks and publishes its checkout through raw SQL',
} as const;
export type TopologyStop = keyof typeof TOPOLOGY_STOPS;

/**
 * Whether `engine` runs the topology steps: it serves raw SQL (PGLite, Postgres), or it holds managed worktrees
 * (`managed_persistence`), where the steps run on the typed topology store (engine-sql/topology-store.ts). A user's Rust
 * brain does neither while managed mode is held back (store-capabilities.ts HELD_FOR_CALLERS), so it keeps the stops.
 */
export function servesTopologySteps(engine: object): boolean {
  return servesRawSql(engine) || managesWorktrees(engine);
}

/** Refuses `step` by name on an engine that serves neither raw SQL nor managed worktrees; nothing ran. */
export function requireTopologyRawSql(engine: object, step: TopologyStop): void {
  if (!servesTopologySteps(engine)) throw capabilityMissing('raw_sql', `${step} (${TOPOLOGY_STOPS[step]})`);
}

/** One recovering change on this host, and the named stop that keeps it from converging here (null when none does). */
export interface TopologyRecoveryStop {
  change_id: string;
  source_id: string;
  operation: string;
  stop: TopologyStop | null;
}

/** At most this many recovering changes are listed; `more` says whether others exist. */
export const TOPOLOGY_RECOVERY_LIST_LIMIT = 16;

/**
 * This host's recovering topology changes (in id order, at most TOPOLOGY_RECOVERY_LIST_LIMIT) and, on an engine
 * without `raw_sql`, the named stop of each. A typed read only; it never locks or changes a row.
 */
export async function readTopologyRecoveryStops(engine: BrainEngine, hostId: string | null):
  Promise<{ recovering: TopologyRecoveryStop[]; more: boolean; stop: TopologyStop | null }> {
  // A host with no identity yet owns no worktree, so no change can be recovering on it.
  if (hostId === null) return { recovering: [], more: false, stop: null };
  const rows = await engine.listTopologyRecoveries(hostId, null, TOPOLOGY_RECOVERY_LIST_LIMIT + 1);
  const stop: TopologyStop | null = servesTopologySteps(engine) ? null : 'source_topology_recovery';
  return {
    recovering: rows.slice(0, TOPOLOGY_RECOVERY_LIST_LIMIT).map(row => ({ change_id: row.id, source_id: row.source_id, operation: row.operation, stop })),
    more: rows.length > TOPOLOGY_RECOVERY_LIST_LIMIT,
    stop: rows.length ? stop : null,
  };
}
