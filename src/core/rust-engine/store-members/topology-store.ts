/**
 * The reads a source lifecycle change makes before its first write, and the writes of a managed clone and its receipts
 * (BrainEngine topologyStore; SQL in engine-sql/topology-store.ts), served from the store's source and persistence
 * records (gbrain-store `persistence::worktrees::{topology_reads,topology_writes}` and `persistence::topology`). Called
 * on a transaction, every call runs on the transaction's handle, so a clone transaction's writes commit together.
 *
 * Differences from the SQL engines, and why:
 * - `durable`, `syncCommit`, `lockBrain`, `lockSources` and `sharePrincipal` do nothing, and `lockChange` is `change`:
 *   the store commits durably and runs one write transaction at a time, so the commit setting, the wait bounds and the
 *   row locks change nothing.
 * - `markTopologyChange` does nothing: no trigger guards this engine's source records.
 * - `bindCloneHost` keeps an existing binding, as ON CONFLICT DO NOTHING does, by reading it first.
 * - `activeRefresh` is always null: this engine keeps no worktree refreshes (`gbrain sources refresh` refuses by name
 *   before it writes one, persistence/worktree-refresh.ts).
 * - `owner_epoch` and `topology_generation` are text, as `getWorktreeBinding` returns them; callers compare with String().
 *
 * What each member answers and why: rust/docs/store/persistence.md ("Topology store").
 */
import type { TopologyChange } from '../../engine-sql/persistence-claims.ts';
import type {
  LockedTopologySourceRow, TopologyLifecycleSourceRow, TopologyBlockingEffectRow, TopologyHostBindingRow, TopologyHostWorktreeRow, TopologyOwnerRow,
  TopologySourceRow, TopologyStore, TopologyWorktreeRow,
} from '../../engine-sql/topology-store.ts';
import type { WriteRequest } from '../../persistence/model.ts';
import type { StoreBrain } from '../store.ts';
import { topologyRow } from '../store-codec.ts';
import { storeCall } from './common.ts';
import { readPersistenceBrainId } from './persistence-identity.ts';

const MEMBER = 'topologyStore';

/** The topology store over a store handle. */
function rustTopologyStore(brain: StoreBrain): TopologyStore {
  const call = <T>(run: () => Promise<T>, sourceId?: string): Promise<T> => storeCall({ member: MEMBER, sourceId }, run);
  const nothing = async (): Promise<void> => {};
  // A jsonb value as the SQL engines store it: JSON.stringify's text read back (undefined members dropped, Dates as text).
  const jsonb = (value: unknown): unknown => value === undefined ? null : JSON.parse(JSON.stringify(value));
  const source = (sourceId: string) => call<TopologySourceRow | null>(() => brain.topologySource(sourceId), sourceId);
  const members = (worktreeIds: string[]) => call<string[]>(() => brain.topologyMembers(worktreeIds));
  const owners = (worktreeIds: string[]) => call<TopologyOwnerRow[]>(() => brain.topologyOwners(worktreeIds));
  const hostBinding = (worktreeId: string, hostId: string) => call<TopologyHostBindingRow | null>(() => brain.readHostBinding(worktreeId, hostId));
  const change = async (changeId: string) => topologyRow<TopologyChange>(await call(() => brain.topologyChange(changeId)));
  const worktree = (worktreeId: string, update: Record<string, unknown>) => call<void>(() => brain.topologyUpdateWorktree(worktreeId, update));
  const updateChange = async (changeId: string, update: Record<string, unknown>) =>
    topologyRow<TopologyChange>(await call(() => brain.topologyUpdateChange(changeId, update)));
  return {
    durable: nothing,
    syncCommit: nothing,
    lockBrain: nothing,
    source,
    lifecycleSource: sourceId => call<TopologyLifecycleSourceRow | null>(() => brain.topologyLifecycleSource(sourceId), sourceId),
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
    hostBinding,
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

    brainId: () => readPersistenceBrainId(brain),
    worktree: worktreeId => call<TopologyWorktreeRow | null>(() => brain.readWorktree(worktreeId)),
    change,
    lockChange: change,
    retireAdmissions: async (sourceId, incarnation, principalId, requestId) =>
      ((await call(() => brain.topologyRetireAdmissions(sourceId, incarnation, principalId, requestId), sourceId)) as unknown[]).map(row => topologyRow<TopologyChange>(row)!),

    recoverWorktree: worktreeId => worktree(worktreeId, { kind: 'recover' }),
    recoverWorktreeWithManifest: (worktreeId, manifest) => worktree(worktreeId, { kind: 'recover_with_manifest', manifest: jsonb(manifest) }),
    setWorktreeManifest: (worktreeId, manifest) => worktree(worktreeId, { kind: 'manifest', manifest: jsonb(manifest) }),
    activateWorktree: worktreeId => worktree(worktreeId, { kind: 'activate' }),
    insertCloneWorktree: (worktreeId, hostId) =>
      call<void>(() => brain.insertWorktree({ id: worktreeId, ownerHostId: hostId, ownerEpoch: 1, state: 'recovering' })),
    async bindCloneHost(worktreeId, hostId, localPath, coordinationPath) {
      if (await hostBinding(worktreeId, hostId)) return;
      await call(() => brain.insertHostBinding({ worktreeId, hostId, localPath, coordinationPath }));
    },
    bindCloneSource: (sourceId, incarnation, worktreeId) => call<void>(() => brain.insertSourceBinding({ sourceId, incarnation, worktreeId }), sourceId),
    unbindSource: (sourceId, incarnation) => call<void>(() => brain.topologyUnbindSource(sourceId, incarnation), sourceId),
    advanceGeneration: worktreeIds => call<void>(() => brain.topologyAdvanceGeneration([...worktreeIds])),
    markTopologyChange: nothing,
    insertCloneSource: source => call<void>(() => brain.topologyInsertSource({ ...source, config: jsonb(source.config) }), source.id),
    resetSourceCheckpoint: (sourceId, incarnation) => call<void>(() => brain.topologyResetSourceCheckpoint(sourceId, incarnation), sourceId),

    async saveCloneRecovery(changeId, recovery) { await updateChange(changeId, { kind: 'save_recovery', recovery: jsonb(recovery) }); },
    async commitChange(changeId, outcome) { await updateChange(changeId, { kind: 'commit', outcome: jsonb(outcome) }); },
    async releaseChange(changeId, state, outcome) { await updateChange(changeId, { kind: 'release', state, outcome: jsonb(outcome) }); },
    async clearChangeRecovery(changeId) { await updateChange(changeId, { kind: 'clear_recovery' }); },
    settleRetire: (changeId, state, outcome, terminalBytes) =>
      updateChange(changeId, { kind: 'settle_retire', state, outcome: jsonb(outcome), terminal_bytes: terminalBytes }),
  };
}

/** `topologyStore()`: the topology store over this engine's store handle; on a transaction, every call runs in it. */
export const topologyStore = async function topologyStore(brain: StoreBrain): Promise<TopologyStore> {
  return rustTopologyStore(brain);
};
