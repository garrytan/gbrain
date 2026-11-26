/**
 * The managed source topology statements (BrainEngine topologyStore; SQL in engine-sql/topology-store.ts), served from
 * the store's source, worktree, binding, request, effect, counter and topology-change records (gbrain-store
 * `persistence::topology_store`).
 *
 * Each read is one `topologyRows({ kind, ... })` call and each write one `topologyWrite({ kind, ... })` call, with the
 * answers of the SQL they replace. The row locks the SQL takes (`lockBrain`, `shareBrain`, `lockSources`,
 * `sharePrincipal`, `shareLocalWriter`, `lockWorktrees`, `lockChange`) are skipped while explicit transactions hold the
 * writer (`serialized_transactions`), and each asserts that first (site `topologyStore.<member>`):
 * - `lockBrain`, `shareBrain`, `lockSources`, `sharePrincipal` and `shareLocalWriter` take no lock here. In multi-user mode
 *   each reads the rows the SQL locks, through the transaction's handle, so a row changed before the commit refuses it
 *   (`write_conflict`) and the transaction runs again. Single-user mode reads nothing, as before.
 * - `lockWorktrees` and `lockChange` are plain reads, which put the rows in that read set; the callers' compare-and-set
 *   checks (owner epoch, topology generation, incarnation, state) stay as they are.
 * - `bound`, `synchronousCommit` and `markTopologyChange` change nothing and skip no lock: the store commits durably, has
 *   no lock wait to bound and no trigger that a topology change must pass.
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
import { assertStoreSerializedTransactions, storeCall } from './common.ts';
import { heldStore } from './managed-hold.ts';
import { readAccessTokenWriteGrant, readLocalWriterRow, readOAuthClientWriteGrant } from './persistence.ts';
import { readBrainMode } from './writer-release.ts';

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
    async lockBrain() {
      assertStoreSerializedTransactions(brain, 'topologyStore.lockBrain');
      // Multi-user mode: the brain row's lock becomes a read of the brain's stored mode, so a mode change committed before the
      // commit refuses it and the transaction runs again. Single-user mode reads nothing.
      if (brain.multiuser === true) await readBrainMode(brain, MEMBER);
    },
    async shareBrain() {
      assertStoreSerializedTransactions(brain, 'topologyStore.shareBrain');
      if (brain.multiuser === true) await readBrainMode(brain, MEMBER);
    },
    async lockSources(ids) {
      assertStoreSerializedTransactions(brain, 'topologyStore.lockSources');
      // Multi-user mode: each source row the SQL locks is read, so a source written before the commit refuses it.
      if (brain.multiuser === true) for (const id of new Set(ids)) await rows('source', { id });
    },
    async sharePrincipal(kind, id) {
      assertStoreSerializedTransactions(brain, 'topologyStore.sharePrincipal');
      // Multi-user mode: the share lock becomes a read of the principal's grant row (as shareLockWriteCredential reads it), so a
      // revocation committed before the commit refuses it. The SQL locks a local writer for any kind that is not a client or token.
      if (brain.multiuser === true) {
        if (kind === 'oauth_client') await readOAuthClientWriteGrant(brain, id);
        else if (kind === 'legacy_token') await readAccessTokenWriteGrant(brain, id);
        else await readLocalWriterRow(brain, id);
      }
    },
    async shareLocalWriter(id) {
      assertStoreSerializedTransactions(brain, 'topologyStore.shareLocalWriter');
      if (brain.multiuser === true) await readLocalWriterRow(brain, id);
    },
    lockWorktrees: async ids => {
      assertStoreSerializedTransactions(brain, 'topologyStore.lockWorktrees');
      return rows('worktrees', { ids: [...ids] });
    },
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
    lockChange: async id => {
      assertStoreSerializedTransactions(brain, 'topologyStore.lockChange');
      return change(rows('change', { id }));
    },
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
  };
}

/** `topologyStore()`: the store over this engine's store handle; called on a transaction, every call runs in it. */
export const topologyStore = async function topologyStore(this: RustEngine, brain: StoreBrain): Promise<TopologyStore> {
  return heldStore(this, rustTopologyStore(brain));
};
