/**
 * The unmanaged writer claim (BrainEngine worktreeClaimStore; SQL in engine-sql/worktree-claim.ts), served from the
 * store's binding records (gbrain-store `persistence::worktrees`). `claimWorktreeBinding` runs the body in one store
 * transaction and asks the transaction for the store, so every call runs on the transaction's handle: the body reads
 * its own inserts and a throw keeps none.
 *
 * Differences from the SQL engines, and why:
 * - No `synchronous_commit` and no row locks: the store commits durably, and the brain-row and source-row locks are
 *   skipped while explicit transactions hold the writer (`serialized_transactions`); `lockSource` asserts it.
 * - `assertAdminState(expected)` compares a reviewed `--expected-state` with the digest of the transaction's own
 *   readWriterAdminState (store-members/writer-admin.ts), as the SQL engines do.
 * - `assertAdminUnlocked()` reads the operator lock through the typed config read and refuses as the SQL engines do.
 *
 * What each member answers and why: rust/docs/store/persistence.md ("Worktree bindings").
 */
import type { BrainEngine } from '../../engine.ts';
import type {
  ClaimHostBindingRow, ClaimSourceRow, ClaimWorktreeRow, HostBindingInsert, HostWorktreeRow, SourceBindingInsert, WorktreeClaimStore,
  WorktreeInsert,
} from '../../engine-sql/worktree-claim.ts';
import type { WorktreeBinding } from '../../engine-sql/write-misc.ts';
import { WRITER_ADMIN_LOCK_KEY } from '../../persistence/admin-contract.ts';
import { assertWriterAdminState } from '../../persistence/admin-intent.ts';
import { assertWriterAdminLockValue } from '../../persistence/admin-lock.ts';
import type { RustEngine } from '../../rust-engine.ts';
import type { StoreBrain } from '../store.ts';
import { assertStoreSerializedTransactions, storeCall } from './common.ts';
import { readPersistenceBrainId } from './persistence-identity.ts';
import { readBrainMode } from './writer-release.ts';

const MEMBER = 'worktreeClaimStore';

/** The claim store over the transaction's store handle. */
function rustWorktreeClaimStore(brain: StoreBrain, tx: BrainEngine): WorktreeClaimStore {
  const call = <T>(run: () => Promise<T>, sourceId?: string): Promise<T> => storeCall({ member: MEMBER, sourceId }, run);
  return {
    assertAdminState: expected => assertWriterAdminState(tx, expected),
    async assertAdminUnlocked() {
      assertStoreSerializedTransactions(brain, 'worktreeClaim.assertAdminUnlocked');
      assertWriterAdminLockValue(await call<string | null>(() => brain.getConfig(WRITER_ADMIN_LOCK_KEY)));
    },
    async lockSource(sourceId) {
      assertStoreSerializedTransactions(brain, 'worktreeClaim.lockSource');
      return call<ClaimSourceRow | null>(() => brain.readSourceMembership(sourceId), sourceId);
    },
    binding: (sourceId, hostId) => call<WorktreeBinding | null>(() => brain.getWorktreeBinding(sourceId, hostId), sourceId),
    hostWorktrees: hostId => call<HostWorktreeRow[]>(() => brain.listHostWorktrees(hostId)),
    brainId: () => readPersistenceBrainId(brain),
    worktree: id => call<ClaimWorktreeRow | null>(() => brain.readWorktree(id)),
    hostBinding: (worktreeId, hostId) => call<ClaimHostBindingRow | null>(() => brain.readHostBinding(worktreeId, hostId)),
    async insertWorktree(row: WorktreeInsert) { await call(() => brain.insertWorktree(row)); },
    async insertHostBinding(row: HostBindingInsert) { await call(() => brain.insertHostBinding(row)); },
    async insertSourceBinding(row: SourceBindingInsert) { await call(() => brain.insertSourceBinding(row), row.sourceId); },
  };
}

/** `worktreeClaimStore()`: the claim store over this engine's store handle; called on a transaction, every call runs in it. */
export const worktreeClaimStore = async function worktreeClaimStore(this: RustEngine, brain: StoreBrain): Promise<WorktreeClaimStore> {
  // The SQL store locks the brain row FOR UPDATE first; skipped while explicit transactions hold the writer.
  assertStoreSerializedTransactions(brain, 'worktreeClaimStore');
  // Multi-user mode: the brain row's lock becomes a read of the brain's stored mode, so a mode change committed before the
  // commit refuses it and the transaction runs again. Single-user mode reads nothing, as before.
  if (brain.multiuser === true) await readBrainMode(brain, MEMBER);
  return rustWorktreeClaimStore(brain, this as unknown as BrainEngine);
};
