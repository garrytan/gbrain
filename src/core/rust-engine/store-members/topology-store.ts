/**
 * The managed source topology statements (BrainEngine topologyStore; SQL in engine-sql/topology-store.ts), served from
 * the store's source, worktree, binding, request, effect, counter and topology-change records (gbrain-store
 * `persistence::topology_store`).
 *
 * Each read is one `topologyRows({ kind, ... })` call and each write one `topologyWrite({ kind, ... })` call, with the
 * answers of the SQL they replace. The row locks the SQL takes become stated guarantees (no lock is taken here):
 * - `lockBrain`, `shareBrain`, `lockSources`, `sharePrincipal` and `shareLocalWriter` change nothing. An explicit
 *   transaction is Serialized: it holds the store's writer, so no other commit interleaves with what it read. Under
 *   optimistic transactions the rows read are in the transaction's read set, so a racing change aborts the commit with
 *   `write_conflict` instead.
 * - `lockWorktrees` and `lockChange` are plain reads for the same reason; the callers' compare-and-set checks (owner
 *   epoch, topology generation, incarnation, state) stay as they are.
 * - `bound`, `synchronousCommit` and `markTopologyChange` change nothing: the store commits durably, has no lock wait
 *   to bound and no trigger that a topology change must pass.
 *
 * While the managed_persistence hold is on (every user's Rust brain), each call refuses exactly as the executeRaw it
 * replaced did (managed-hold.ts).
 */
import type { TopologyStore } from '../../engine-sql/topology-store.ts';
import type { ContentReceiptRow } from '../../engine-sql/writer-admin.ts';
import type { WriteRequest } from '../../persistence/model.ts';
import type { TopologyChange } from '../../engine-sql/persistence-claims.ts';
import type { RustEngine } from '../../rust-engine.ts';
import type { StoreBrain } from '../store.ts';
import { requestRow, topologyRow } from '../store-codec.ts';
import { storeCall } from './common.ts';
import { heldStore } from './managed-hold.ts';

const MEMBER = 'topologyStore';

function rustTopologyStore(brain: StoreBrain): TopologyStore {
  const call = <T>(run: () => Promise<T>): Promise<T> => storeCall({ member: MEMBER }, run);
  const rows = <T>(kind: string, args: Record<string, unknown>): Promise<T> => call<T>(() => brain.topologyRows({ kind, ...args }));
  const write = <T>(kind: string, args: Record<string, unknown>): Promise<T> => call<T>(() => brain.topologyWrite({ kind, ...args }));
  const none = async () => {};
  const change = async (p: Promise<unknown>) => topologyRow<TopologyChange>(await p);
  return {
    contentReceiptRows: (worktreeIds, hostId, sourceIds) => call<ContentReceiptRow[]>(() => brain.contentReceiptRows(worktreeIds, hostId, sourceIds ?? null)),
    async swapConfigValue(key, value, expected) { await call(() => brain.swapConfigValue(key, value, expected)); },
    bound: none, synchronousCommit: none, markTopologyChange: none,
    lockBrain: none, shareBrain: none, lockSources: none,
    async sharePrincipal() {}, async shareLocalWriter() {},
    lockWorktrees: ids => rows('worktrees', { ids: [...ids] }),
    activeRefresh: (ids, refreshId) => rows('active_refresh', { ids: [...ids], refreshId }),
    memberSources: ids => rows('member_sources', { ids: [...ids] }),
    worktreeHasMember: worktreeId => rows('worktree_has_member', { worktreeId }),
    hostBinding: (worktreeId, hostId) => rows('host_binding', { worktreeId, hostId }),
    canonicalStamp: worktreeId => rows('canonical_stamp', { worktreeId }),
    unsettledRequests: async (sources, worktrees) => (await rows<unknown[]>('unsettled_requests', { sources: [...sources], worktrees: [...worktrees] }))
      .map(row => requestRow<WriteRequest>(row)!),
    blockingEffect: (sources, worktrees) => rows('blocking_effect', { sources: [...sources], worktrees: [...worktrees] }),
    async advanceGeneration(worktrees) { await write('advance_generation', { worktrees: [...worktrees] }); },
    hostBindingPaths: hostId => rows('host_binding_paths', { hostId }),
    async chargeReceipt(key, bytes) { await write('charge_receipt', { key, bytes }); },
    settleRetire: (id, state, outcome, terminalBytes) => change(write('settle_retire', { id, state, outcome, terminalBytes })),
    async addTerminalBytes(key, delta) { await write('add_terminal_bytes', { key, delta }); },
    supersedableRetires: async (sourceId, incarnation, principal, requestId) =>
      (await rows<unknown[]>('supersedable_retires', { sourceId, incarnation, principal, requestId })).map(row => topologyRow<TopologyChange>(row)!),
    lockChange: id => change(rows('change', { id })),
    async releaseIntent(key, intentBytes) { await write('release_intent', { key, intentBytes }); },
    async releaseRecoveryBytes(key, bytes) { await write('release_recovery_bytes', { key, bytes }); },
    async clearChangeRecovery(id) { await write('clear_change_recovery', { id }); },
    readSource: id => rows('source', { id }),
    supersededRetire: (requestId, sourceId, principal, incarnation) => change(rows('superseded_retire', { requestId, sourceId, principal, incarnation })),
    bindingDigests: sourceId => rows('binding_digests', { sourceId }),
    retireState: (sourceId, expiredOnly) => rows('retire_state', { sourceId, expiredOnly }),
    oauthClientOf: sourceId => rows('oauth_client_of', { sourceId }),
    deletePageBatch: (sourceId, limit) => write('delete_page_batch', { sourceId, limit }),
    isExpiredArchive: sourceId => rows('is_expired_archive', { sourceId }),
    async updateSourceRoot(id, localPath, name, config) { await write('update_source_root', { id, localPath, name, config }); },
    async insertSource(id, name, localPath, config, incarnation) { await write('insert_source', { id, name, localPath, config, incarnation }); },
    async archiveSource(id, config) { await write('archive_source', { id, config }); },
    async restoreSource(id, config) { await write('restore_source', { id, config }); },
    async setSourceLocalPath(id, localPath) { await write('set_source_local_path', { id, localPath }); },
    async setHostBindingPath(worktreeId, hostId, localPath) { await write('set_host_binding_path', { worktreeId, hostId, localPath }); },
    async setBindingRelativePath(sourceId, relativePath) { await write('set_binding_relative_path', { sourceId, relativePath }); },
    countSourcePages: sourceId => rows('count_source_pages', { sourceId }),
    async deleteSourceIncarnation(sourceId, incarnation) { await write('delete_source_incarnation', { sourceId, incarnation }); },
    async rescrubRemovedSource(sourceId) { await write('rescrub_removed_source', { sourceId }); },
    async deleteSourceBinding(sourceId, incarnation) { await write('delete_source_binding', { sourceId, incarnation }); },
    async deleteManagedSyncCursors(sourceId) { await write('delete_managed_sync_cursors', { sourceId }); },
    async setWorktreeManifest(id, manifest) { await write('set_worktree_manifest', { id, manifest }); },
    async mergeCanonicalStamp(id, stamp) { await write('merge_canonical_stamp', { id, stamp }); },
    otherHostBindings: (hostId, sourceId) => rows('other_host_bindings', { hostId, sourceId }),
    worktreeExists: id => rows('worktree_exists', { id }),
    async insertWorktree(id, hostId) { await write('insert_worktree', { id, hostId }); },
    async insertHostBinding(worktreeId, hostId, localPath, coordinationPath) { await write('insert_host_binding', { worktreeId, hostId, localPath, coordinationPath }); },
    async upsertSourceBinding(sourceId, incarnation, worktreeId, relativePath) { await write('upsert_source_binding', { sourceId, incarnation, worktreeId, relativePath }); },
    retirableState: sourceId => rows('retirable_state', { sourceId }),
    movedRootRow: (worktreeId, hostId) => rows('moved_root', { worktreeId, hostId }),
    worktreeMembers: worktreeId => rows('worktree_members', { worktreeId }),
    brainId: () => rows('brain_id', {}),
    worktreeOwner: id => rows('worktree_owner', { id }),
    worktreeManifest: id => rows('worktree_manifest', { id }),
    lockWorktreeManifest: id => rows('worktree_manifest_owner', { id }),
    readChange: id => change(rows('change', { id })),
    lockRecoveringChanges: worktreeId => rows('recovering_changes_of', { worktreeId }),
    async insertRecoveringWorktree(id, hostId) { await write('insert_recovering_worktree', { id, hostId }); },
    async markWorktreeRecovering(id) { await write('set_worktree_state', { id, state: 'recovering' }); },
    async markWorktreeActive(id) { await write('set_worktree_state', { id, state: 'active' }); },
    async recoverWorktreeWithManifest(id, manifest) { await write('recover_worktree_with_manifest', { id, manifest }); },
    async insertCloneBinding(sourceId, incarnation, worktreeId) { await write('insert_clone_binding', { sourceId, incarnation, worktreeId }); },
    async setChangeRecovery(id, recovery) { await write('set_change_recovery', { id, recovery, onlyRecovering: true }); },
    async restampChangeRecovery(id, recovery) { await write('set_change_recovery', { id, recovery, onlyRecovering: false }); },
    async closeChange(id, state, outcome) { await write('close_change', { id, state, outcome }); },
    async commitChange(id, outcome) { await write('commit_change', { id, outcome }); },
    async resetSourceSync(id, incarnation) { await write('reset_source_sync', { id, incarnation }); },
    readCloneSource: id => rows('source', { id }),
    readSourceHead: id => rows('source', { id }),
    cloneHostBindingPath: (worktreeId, hostId) => rows('host_binding', { worktreeId, hostId }),
    lockCloneWorktree: async id => (await rows<Array<{ owner_host_id: string; owner_epoch: string; state: string }>>('worktrees', { ids: [id] }))[0] ?? null,
    boundSourceIds: worktreeId => rows('member_sources', { ids: [worktreeId] }),
    async insertCloneHostBinding(worktreeId, hostId, localPath, coordinationPath) { await write('insert_host_binding', { worktreeId, hostId, localPath, coordinationPath }); },
    // This engine keeps no consumer row, so `live` is false and the heartbeat of a consumer adds no evidence, as on PGLite.
    ownerActivity: (ids) => rows('owner_activity', { ids: [...ids] }),
    openWrites: () => rows('open_writes', {}),
  };
}

/** `topologyStore()`: the store over this engine's store handle; called on a transaction, every call runs in it. */
export const topologyStore = async function topologyStore(this: RustEngine, brain: StoreBrain): Promise<TopologyStore> {
  return heldStore(this, rustTopologyStore(brain));
};
