/**
 * The managed Git durability statements (BrainEngine gitDurabilityStore; SQL in engine-sql/git-durability.ts), served
 * from the store's effect and host-binding records (gbrain-store `persistence::git_durability`).
 *
 * - Each read is one `gitDurabilityRows({ kind, ... })` call and each write one `gitDurabilityWrite({ kind, ... })` call,
 *   with the answers of the SQL they replace.
 * - `bound()` changes nothing: the store commits durably and an explicit transaction holds the store's writer, so no
 *   row lock wait exists to bound.
 *
 * While the managed_persistence hold is on (every user's Rust brain), each call refuses exactly as the executeRaw it
 * replaced did (managed-hold.ts).
 */
import type { GitDurabilityStore } from '../../engine-sql/git-durability.ts';
import type { RustEngine } from '../../rust-engine.ts';
import type { StoreBrain } from '../store.ts';
import { storeCall } from './common.ts';
import { heldStore } from './managed-hold.ts';

const MEMBER = 'gitDurabilityStore';

function rustGitDurabilityStore(brain: StoreBrain): GitDurabilityStore {
  const call = <T>(run: () => Promise<T>): Promise<T> => storeCall({ member: MEMBER }, run);
  const rows = <T>(kind: string, args: Record<string, unknown>): Promise<T> => call<T>(() => brain.gitDurabilityRows({ kind, ...args }));
  const write = <T>(kind: string, args: Record<string, unknown>): Promise<T> => call<T>(() => brain.gitDurabilityWrite({ kind, ...args }));
  return {
    async bound() {},
    planCatchUp: key => rows('plan_catch_up', { ...key }),
    requeueCatchUp: (key, ids) => write('requeue_catch_up', { worktreeId: key.worktreeId, sourceIncarnation: key.sourceIncarnation, reason: key.reason, ids: [...ids] }),
    setHostBindingDurability: (worktreeId, hostId, setting) => write('set_host_binding', { worktreeId, hostId, setting }),
    parkedPushRequests: (worktreeId, codes) => rows('parked_push_requests', { worktreeId, codes: [...codes] }),
    formerWorktreeHolds: (sourceId, worktreeId, codes) => rows('former_worktree_holds', { sourceId, worktreeId, codes: [...codes] }),
    requeueParkedEffect: (id, data, errorCode) => write('requeue_parked_effect', { id, data, errorCode }),
  };
}

/** `gitDurabilityStore()`: the store over this engine's store handle; called on a transaction, every call runs in it. */
export const gitDurabilityStore = async function gitDurabilityStore(this: RustEngine, brain: StoreBrain): Promise<GitDurabilityStore> {
  return heldStore(this, rustGitDurabilityStore(brain));
};
