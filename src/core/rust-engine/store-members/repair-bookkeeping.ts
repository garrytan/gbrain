/**
 * Repair bookkeeping (BrainEngine listSourceIncarnations through deleteOrphanConnectorCheckpoint, the statements of
 * engine-sql/repair-bookkeeping.ts). What the store keeps for each and what a member answers for what it does not keep:
 * rust/docs/store/repair-bookkeeping.md.
 */
import type { SourceIncarnationListRow } from '../../engine-sql/sources.ts';
import type {
  ConnectorSourceRow, LoopFactState, OrphanBinding, OrphanCheckpointBounds, OrphanCheckpointRow,
} from '../../engine-sql/repair-bookkeeping.ts';
import { isConnectorSourceKind } from '../../persistence/connector-kinds.ts';
import { refuseMember, storeCall, type StoreMember } from './common.ts';

/** Each named source's incarnation, in id order (`ORDER BY id COLLATE "C"`); a missing source is left out. */
export const listSourceIncarnations: StoreMember<[sourceIds: readonly string[]], SourceIncarnationListRow[]> =
  async (brain, sourceIds) => {
    const out: SourceIncarnationListRow[] = [];
    for (const id of [...new Set(sourceIds)].sort()) {
      const row: { incarnation: unknown } | null =
        await storeCall({ member: 'listSourceIncarnations', sourceId: id }, () => brain.readSourceIncarnation(id));
      if (row) out.push({ id, incarnation: String(row.incarnation) });
    }
    return out;
  };

/**
 * The orphan source bindings (engine-sql/repair-bookkeeping.ts ORPHANS), by source id. The store's source delete removes
 * the binding of the deleted incarnation in the same write (`persistence::remove_source_binding_in`), so an orphan comes
 * from a binding written for a source that is gone or holds another incarnation (persistence/worktrees.rs).
 */
export const listOrphanBindings: StoreMember<[opts?: { limit?: number }], OrphanBinding[]> = (brain, opts) =>
  storeCall({ member: 'listOrphanBindings' }, () => brain.listOrphanBindings(opts?.limit ? Math.floor(opts.limit) : null)) as Promise<OrphanBinding[]>;

/** Deletes one orphan binding when it is still orphaned and has no pending request, as the SQL statement rechecks. */
export const deleteOrphanBinding: StoreMember<[binding: Pick<OrphanBinding, 'source_id' | 'source_incarnation'>], boolean> =
  (brain, binding) => storeCall({ member: 'deleteOrphanBinding', sourceId: binding.source_id },
    () => brain.deleteOrphanBinding(binding.source_id, binding.source_incarnation)) as Promise<boolean>;

/** A loop, its fact and whether another open loop shares it. `lock` is moot: the store serializes its writes. */
export const readLoopFactState: StoreMember<[loopId: number, opts?: { lock?: boolean }], LoopFactState> =
  async (brain, loopId) => {
    if (!Number.isSafeInteger(loopId)) refuseMember('readLoopFactState', 'a loop id that is not a safe integer');
    const state: LoopFactState = await storeCall({ member: 'readLoopFactState' }, () => brain.readLoopFactState(loopId));
    const loop = state.loop
      ? { ...state.loop, id: Number(state.loop.id), fact_id: state.loop.fact_id == null ? null : Number(state.loop.fact_id) }
      : null;
    const fact = state.fact
      ? {
          ...state.fact,
          id: Number(state.fact.id),
          row_num: state.fact.row_num == null ? null : Number(state.fact.row_num),
          expired_at: state.fact.expired_at == null ? null : new Date(state.fact.expired_at).toISOString(),
        }
      : null;
    return { loop, fact, shared: state.shared === true };
  };

/** Expires one unexpired fact of the source now; true when that row changed. */
export const expireSourceFactNow: StoreMember<[factId: number, sourceId: string], boolean> = async (brain, factId, sourceId) => {
  if (!Number.isSafeInteger(factId)) refuseMember('expireSourceFactNow', 'a fact id that is not a safe integer');
  return storeCall({ member: 'expireSourceFactNow', sourceId }, () => brain.expireSourceFactNow(factId, sourceId)) as Promise<boolean>;
};

/**
 * Every source whose config kind is a connector kind, archived ones included. `lock` returns them in id order, as the
 * share-locking read does; the store serializes its writes, so there is no lock to take.
 */
export const listConnectorSources: StoreMember<[opts?: { lock?: boolean }], ConnectorSourceRow[]> = async (brain, opts) => {
  const records: Array<{ id: string; local_path: string | null; config: unknown; archived?: boolean }> =
    await storeCall({ member: 'listConnectorSources' }, () => brain.listSourceRecords());
  const out: ConnectorSourceRow[] = [];
  for (const record of records) {
    const config = typeof record.config === 'string' ? JSON.parse(record.config) : record.config;
    if (!config || typeof config !== 'object' || !isConnectorSourceKind((config as Record<string, unknown>).kind)) continue;
    const row: { incarnation: unknown } | null =
      await storeCall({ member: 'listConnectorSources', sourceId: record.id }, () => brain.readSourceIncarnation(record.id));
    if (!row) continue;
    out.push({
      id: record.id, incarnation: String(row.incarnation), local_path: record.local_path ?? null,
      config: config as Record<string, unknown>, archived: record.archived === true,
    });
  }
  if (opts?.lock) out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
};

/** The connector checkpoints no loadable source and no pending request names, in (op, fingerprint) order. */
export const listOrphanConnectorCheckpoints: StoreMember<[loadable: readonly string[], bounds: OrphanCheckpointBounds, limit: number], OrphanCheckpointRow[]> =
  (brain, loadable, bounds, limit) => storeCall({ member: 'listOrphanConnectorCheckpoints' }, () =>
    brain.listOrphanConnectorCheckpoints([...loadable], bounds.before ?? null, bounds.minAgeDays ?? null, bounds.stateOp, limit));

/** How many connector checkpoints carry one of the keys. */
export const countConnectorCheckpointsKeyed: StoreMember<[keys: readonly string[]], number> = (brain, keys) =>
  storeCall({ member: 'countConnectorCheckpointsKeyed' }, () => brain.countConnectorCheckpointsKeyed([...keys]));

/** Deletes the checkpoint when its stamp is unchanged and it is still an orphan; true when deleted. */
export const deleteOrphanConnectorCheckpoint: StoreMember<[row: OrphanCheckpointRow, loadable: readonly string[], bounds: OrphanCheckpointBounds], boolean> =
  (brain, row, loadable, bounds) => storeCall({ member: 'deleteOrphanConnectorCheckpoint' }, () =>
    brain.deleteOrphanConnectorCheckpoint(row.op, row.fingerprint, row.updated_at, [...loadable],
      bounds.before ?? null, bounds.minAgeDays ?? null, bounds.stateOp));
