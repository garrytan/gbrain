/**
 * The unmanaged writer claim (BrainEngine claimWorktreeBinding; SQL in engine-sql/worktree-claim.ts), served from the
 * store's binding records (gbrain-store `persistence::worktrees`). The body runs in one store transaction and gets a
 * claim store whose calls all run on the transaction's handle, so it reads its own inserts and a throw keeps none.
 *
 * Differences from the SQL engines, and why:
 * - No `synchronous_commit` and no row locks: the store commits durably and runs one write transaction at a time, so
 *   the brain-row and source-row locks change nothing.
 * - `assertAdminState(expected)` refuses `engine_capability_missing` when a reviewed `--expected-state` is passed. The
 *   state digest is the SHA-256 of Postgres `jsonb_build_object(...)::text` over tables this store does not keep (the
 *   cycle locks, the managed-mode columns), so the store cannot reproduce it; an automatic claim passes none.
 * - `assertAdminUnlocked()` reads the operator lock through the typed config read and refuses as the SQL engines do.
 *
 * What each member answers and why: rust/docs/store/persistence.md ("Worktree bindings").
 */
import type { BrainEngine } from '../../engine.ts';
import type {
  ClaimHostBindingRow, ClaimSourceRow, ClaimWorktreeRow, HostBindingInsert, HostWorktreeRow, SourceBindingInsert, WorktreeClaimBody,
  WorktreeClaimStore, WorktreeInsert,
} from '../../engine-sql/worktree-claim.ts';
import type { WorktreeBinding } from '../../engine-sql/write-misc.ts';
import { WRITER_ADMIN_LOCK_KEY } from '../../persistence/admin-contract.ts';
import { assertWriterAdminLockValue } from '../../persistence/admin-lock.ts';
import type { RustEngine } from '../../rust-engine.ts';
import type { StoreBrain } from '../store.ts';
import { refuseMember, storeCall } from './common.ts';
import { readPersistenceBrainId } from './persistence-identity.ts';

const MEMBER = 'claimWorktreeBinding';

/** The claim store over the transaction's store handle. */
function rustWorktreeClaimStore(brain: StoreBrain): WorktreeClaimStore {
  const call = <T>(run: () => Promise<T>, sourceId?: string): Promise<T> => storeCall({ member: MEMBER, sourceId }, run);
  return {
    async assertAdminState(expected) {
      if (expected !== undefined) refuseMember(MEMBER, 'a reviewed --expected-state writer admin state check');
    },
    async assertAdminUnlocked() {
      assertWriterAdminLockValue(await call<string | null>(() => brain.getConfig(WRITER_ADMIN_LOCK_KEY)));
    },
    lockSource: sourceId => call<ClaimSourceRow | null>(() => brain.readSourceMembership(sourceId), sourceId),
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

export const claimWorktreeBinding = async function claimWorktreeBinding<T>(this: RustEngine, _brain: StoreBrain, body: WorktreeClaimBody<T>): Promise<T> {
  return (this as unknown as BrainEngine).transaction(async tx => {
    const brain = (tx as unknown as RustEngine).openStore(MEMBER).brain;
    return body(rustWorktreeClaimStore(brain), tx);
  });
};
