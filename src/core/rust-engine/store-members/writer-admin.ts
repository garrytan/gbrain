/**
 * Writer administration (BrainEngine readWriterAdminState, readWorktreeManifest and writerAdminStore; SQL in
 * engine-sql/writer-admin.ts), served from the store's binding, source, config and cycle-lock records.
 *
 * - `readWriterAdminState` returns the same jsonb document as the SQL engines, built from one store snapshot
 *   (gbrain-store `persistence::worktrees::writer_admin_state_text`). The digest of a Rust brain is its own: each brain
 *   has its own id, so a state reviewed on one brain never matches another. `lock` skips the table lock while explicit
 *   transactions hold the writer (`serialized_transactions`), and asserts that.
 * - `writerAdminStore` is the store `writerAdminTransaction` (engine-sql/writer-admin.ts) asks its transaction for:
 *   every call runs on the transaction's handle. There is no `synchronous_commit`: the store commits durably. The brain and
 *   worktree row locks (`lockBrain`, `lockWorktree`) are skipped while explicit transactions hold the writer (`serialized_transactions`), and asserts it. `now()` is this process's clock in the SQL engines' format.
 *
 * What each member answers and why: rust/docs/store/persistence.md ("Worktree bindings").
 */
import type { BrainEngine } from '../../engine.ts';
import type { ContentReceiptRow, WriterAdminStateOptions, WriterAdminStore, WriterAdminWorktreeRow } from '../../engine-sql/writer-admin.ts';
import type { StoredWorktreeManifest } from '../../persistence/worktree-manifest.ts';
import { WRITER_ADMIN_LOCK_KEY } from '../../persistence/admin-contract.ts';
import { assertWriterAdminState } from '../../persistence/admin-intent.ts';
import { assertWriterAdminLockValue } from '../../persistence/admin-lock.ts';
import type { RustEngine } from '../../rust-engine.ts';
import type { StoreBrain } from '../store.ts';
import { assertStoreSerializedTransactions, storeCall, takeOptions } from './common.ts';
import { readPersistenceBrainId } from './persistence-identity.ts';

const STATE = 'readWriterAdminState';
const MEMBER = 'writerAdminStore';
const MANIFEST = 'readWorktreeManifest';

export const readWriterAdminState = async function readWriterAdminState(brain: StoreBrain, opts?: WriterAdminStateOptions): Promise<string> {
  if (opts?.lock) assertStoreSerializedTransactions(brain, 'readWriterAdminState');
  takeOptions(STATE, opts, [], ['lock']);
  return storeCall({ member: STATE }, () => brain.writerAdminStateText());
};

/** `readWorktreeManifest(worktreeId)`: the worktree's manifest, or null. */
export const readWorktreeManifest = async function readWorktreeManifest(brain: StoreBrain, worktreeId: string): Promise<StoredWorktreeManifest | null> {
  return storeCall({ member: MANIFEST }, () => brain.readWorktreeManifest(worktreeId));
};

/** The writer-admin store over the transaction's store handle; `tx` answers the reviewed-state check. */
function rustWriterAdminStore(brain: StoreBrain, tx: BrainEngine): WriterAdminStore {
  const call = <T>(run: () => Promise<T>): Promise<T> => storeCall({ member: MEMBER }, run);
  return {
    async lockBrain() {
      assertStoreSerializedTransactions(brain, 'writerAdmin.lockBrain');
    },
    assertAdminState: expected => assertWriterAdminState(tx, expected),
    async assertAdminUnlocked() { assertStoreSerializedTransactions(brain, 'writerAdmin.assertAdminUnlocked'); assertWriterAdminLockValue(await call<string | null>(() => brain.getConfig(WRITER_ADMIN_LOCK_KEY))); },
    adminLockValue: () => call<string | null>(() => brain.getConfig(WRITER_ADMIN_LOCK_KEY)),
    async setAdminLockValue(value) { await call(() => brain.setConfig(WRITER_ADMIN_LOCK_KEY, value)); },
    preparedTransferWorktree: () => call<string | null>(() => brain.preparedTransferWorktree()),
    async now() { return new Date().toISOString(); },
    lockWorktree: async id => {
      assertStoreSerializedTransactions(brain, 'writerAdmin.lockWorktree');
      return call<WriterAdminWorktreeRow | null>(() => brain.readWorktreeOwner(id));
    },
    publicationPending: worktreeId => call<boolean>(() => brain.worktreePublicationPending(worktreeId)),
    brainId: () => readPersistenceBrainId(brain),
    async markWorktreeDraining(id, manifest) { await call(() => brain.markWorktreeDraining(id, manifest)); },
    async reactivateWorktree(id) { await call(() => brain.reactivateWorktree(id)); },
    async upsertHostBinding(row) { await call(() => brain.upsertHostBinding(row)); },
    async acceptWorktreeOwner(id, hostId) { await call(() => brain.acceptWorktreeOwner(id, hostId)); },
    contentReceiptRows: (worktreeIds, hostId, sourceIds) => call<ContentReceiptRow[]>(() => brain.contentReceiptRows(worktreeIds, hostId, sourceIds ?? null)),
    async swapConfigValue(key, value, expected) { await call(() => brain.swapConfigValue(key, value, expected)); },
  };
}

/** `writerAdminStore()`: the writer-admin store over this engine's store handle; called on a transaction, every call runs in it. */
export const writerAdminStore = async function writerAdminStore(this: RustEngine, brain: StoreBrain): Promise<WriterAdminStore> {
  return rustWriterAdminStore(brain, this as unknown as BrainEngine);
};
