/**
 * The reads a source lifecycle change makes before its first write (BrainEngine topologyStore; SQL in
 * engine-sql/topology-store.ts), served from the store's source and persistence records (gbrain-store
 * `persistence::worktrees::topology_reads`). Called on a transaction, every call runs on the transaction's handle.
 *
 * Differences from the SQL engines, and why:
 * - `durable`, `syncCommit`, `lockBrain`, `lockSources` and `sharePrincipal` do nothing: the store commits durably
 *   and runs one write transaction at a time, so the commit setting, the wait bounds and the row locks change nothing.
 * - `activeRefresh` is always null: this engine keeps no worktree refreshes (`gbrain sources refresh` refuses by name
 *   before it writes one, persistence/worktree-refresh.ts).
 * - `owner_epoch` and `topology_generation` are text, as `getWorktreeBinding` returns them; callers compare with String().
 *
 * What each member answers and why: rust/docs/store/persistence.md ("Topology store").
 */
import type {
  LockedTopologySourceRow, TopologyBlockingEffectRow, TopologyHostBindingRow, TopologyHostWorktreeRow, TopologyOwnerRow,
  TopologySourceRow, TopologyStore,
} from '../../engine-sql/topology-store.ts';
import type { WriteRequest } from '../../persistence/model.ts';
import type { StoreBrain } from '../store.ts';
import { storeCall } from './common.ts';

const MEMBER = 'topologyStore';

/** The topology store over a store handle. */
function rustTopologyStore(brain: StoreBrain): TopologyStore {
  const call = <T>(run: () => Promise<T>, sourceId?: string): Promise<T> => storeCall({ member: MEMBER, sourceId }, run);
  const nothing = async (): Promise<void> => {};
  const source = (sourceId: string) => call<TopologySourceRow | null>(() => brain.topologySource(sourceId), sourceId);
  const members = (worktreeIds: string[]) => call<string[]>(() => brain.topologyMembers(worktreeIds));
  const owners = (worktreeIds: string[]) => call<TopologyOwnerRow[]>(() => brain.topologyOwners(worktreeIds));
  return {
    durable: nothing,
    syncCommit: nothing,
    lockBrain: nothing,
    source,
    async lockedSource(sourceId) {
      const row = await source(sourceId);
      return row ? { incarnation: row.incarnation, last_commit: row.last_commit, config: row.config } satisfies LockedTopologySourceRow : null;
    },
    hostWorktrees: hostId => call<TopologyHostWorktreeRow[]>(() => brain.topologyHostWorktrees(hostId)),
    async hostLocalPaths(hostId) {
      const rows = await call<Array<{ local_path: string | null }>>(() => brain.listHostWorktrees(hostId));
      return rows.map(row => ({ local_path: row.local_path }));
    },
    firstMember: async worktreeId => (await members([worktreeId]))[0] ?? null,
    anyMember: async worktreeId => (await members([worktreeId]))[0] ?? null,
    hostBinding: (worktreeId, hostId) => call<TopologyHostBindingRow | null>(() => brain.readHostBinding(worktreeId, hostId)),
    async lockOwner(worktreeId) {
      const [row] = await owners([worktreeId]);
      return row ? { owner_host_id: row.owner_host_id, owner_epoch: row.owner_epoch, state: row.state } : null;
    },
    lockOwners: owners,
    activeRefresh: async () => null,
    members,
    lockSources: nothing,
    canonicalStamp: worktreeId => call<string>(() => brain.topologyCanonicalStamp(worktreeId)),
    unsettledRequests: (sourceIds, worktreeIds) => call<WriteRequest[]>(() => brain.topologyUnsettledRequests(sourceIds, worktreeIds)),
    blockingEffect: (sourceIds, worktreeIds) => call<TopologyBlockingEffectRow | null>(() => brain.topologyBlockingEffect(sourceIds, worktreeIds)),
    sharePrincipal: nothing,
  };
}

/** `topologyStore()`: the topology store over this engine's store handle; on a transaction, every call runs in it. */
export const topologyStore = async function topologyStore(brain: StoreBrain): Promise<TopologyStore> {
  return rustTopologyStore(brain);
};
