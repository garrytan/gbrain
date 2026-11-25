/**
 * The request-row work of a bound (worktree) publication (BrainEngine publicationJournalStore; SQL in
 * engine-sql/publication-journal.ts), served from the store's request, effect, counter, worktree, host-binding and
 * source records.
 *
 * - `publicationJournalStore` returns the same narrow store the SQL engines return. Each read is one
 *   `publicationJournalRows({ kind, ... })` call and each write one `publicationJournalWrite({ kind, ... })` call
 *   (gbrain-store `persistence::PublicationRead` / `PublicationWrite`), with the answers of the SQL they replace.
 * - `lockSource`, `shareWorktree`, `shareWorktreeOwner` (the worktree owner read, `readWorktreeOwner`) and `recoveryStaging`
 *   skip their row locks (FOR UPDATE / FOR SHARE) while explicit transactions hold the writer (`serialized_transactions`),
 *   and assert it. `stagingDurability` changes nothing: the store commits durably.
 * - A counter release below zero refuses as the CHECK (>= 0) does; a missing counter row changes nothing.
 *
 * What each member answers and why: rust/docs/store/persistence.md ("Publication journal").
 */
import type { PublicationJournalStore, WorktreeOwnerRow } from '../../engine-sql/publication-journal.ts';
import type { WriteRequest } from '../../persistence/model.ts';
import type { RustEngine } from '../../rust-engine.ts';
import type { StoreBrain } from '../store.ts';
import { assertStoreSerializedTransactions, storeCall } from './common.ts';

const MEMBER = 'publicationJournalStore';

function rustPublicationJournalStore(brain: StoreBrain): PublicationJournalStore {
  const call = <T>(run: () => Promise<T>): Promise<T> => storeCall({ member: MEMBER }, run);
  const rows = <T>(kind: string, args: Record<string, unknown>): Promise<T> => call<T>(() => brain.publicationJournalRows({ kind, ...args }));
  const write = <T>(kind: string, args: Record<string, unknown>): Promise<T> => call<T>(() => brain.publicationJournalWrite({ kind, ...args }));
  const none = async () => {};
  return {
    heldBehindImport: (sourceId, slug, sequence) => rows('held_behind_import', { sourceId, slug, sequence: String(sequence) }),
    recoveryBlocker: (worktreeId, excludeId) => rows('recovery_blocker', { worktreeId, excludeId }),
    ownerPath: worktreeId => rows('owner_path', { worktreeId }),
    async shareWorktreeOwner(worktreeId) {
      assertStoreSerializedTransactions(brain, 'publicationJournal.shareWorktreeOwner');
      const owner = await call<WorktreeOwnerRow | null>(() => brain.readWorktreeOwner(worktreeId));
      return owner ? { owner_host_id: owner.owner_host_id, owner_epoch: owner.owner_epoch, state: owner.state } : null;
    },
    async shareWorktree() {
      assertStoreSerializedTransactions(brain, 'publicationJournal.shareWorktree');
    },
    async lockSource() {
      assertStoreSerializedTransactions(brain, 'publicationJournal.lockSource');
    },
    recordRecovery: ({ id, executionToken, recovery, bytes, keys, fence }, checked) =>
      write('record_recovery', { id, executionToken, recovery, bytes, keys, checked, ...(fence ? { fence } : {}) }),
    clearKnownRecovery: (id, keys, recovery) => write('clear_known_recovery', { id, keys, recovery }),
    async clearRecovery(id, keys, bytes) { await write('clear_recovery', { id, keys, bytes }); },
    async markRecovering(id, executionToken, reason, failure, opts) {
      await write('mark_recovering', { id, executionToken, reason, errorCode: failure?.code ?? null,
        errorMessage: failure?.message ?? null, errorDetail: failure?.detail ? failure.detail : null, ...(opts?.fence ? { fence: opts.fence } : {}) });
    },
    markPublicationStarted: (id, opts) => write<WriteRequest | null>('publication_started', { id, ...(opts?.fence ? { fence: opts.fence } : {}) }),
    blockCapacity: id => write<WriteRequest | null>('block_capacity', { id }),
    blockRecovery: (id, reason) => write<WriteRequest | null>('block_recovery', { id, reason }),
    requeueRecovered: (id, kept, clearError) => write<WriteRequest | null>('requeue_recovered', { id, kept, clearError }),
    stagingDurability: none,
    recoveryStaging: async (table, id) => {
      assertStoreSerializedTransactions(brain, 'publicationJournal.recoveryStaging');
      return rows('recovery_staging', { table, id });
    },
    async growRecoveryStaging(table, id, recovery, extra) { await write('grow_recovery_staging', { table, id, recovery, extra }); },
  };
}

/** `publicationJournalStore()`: the store over this engine's store handle; called on a transaction, every call runs in it. */
export const publicationJournalStore = async function publicationJournalStore(this: RustEngine, brain: StoreBrain): Promise<PublicationJournalStore> {
  return rustPublicationJournalStore(brain);
};
