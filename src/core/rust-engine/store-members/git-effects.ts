/**
 * The managed Git effect runner's statements (BrainEngine gitEffectStore; SQL in engine-sql/git-effects.ts), served from
 * the store's request and effect records (gbrain-store `persistence::git_effects`).
 *
 * Each read is one `gitEffectRows({ kind, ... })` call and each write one `gitEffectWrite({ kind, ... })` call, with the
 * answers of the SQL they replace. Every write names its effects by id and claim token, so a moved claim changes nothing.
 *
 * While the managed_persistence hold is on (every user's Rust brain), each call refuses exactly as the executeRaw it
 * replaced did (managed-hold.ts).
 */
import type { GitEffectStore } from '../../engine-sql/git-effects.ts';
import type { RustEngine } from '../../rust-engine.ts';
import type { StoreBrain } from '../store.ts';
import type { FenceOpts } from '../../engine-sql/lease-token.ts';
import { storeCall } from './common.ts';
import { heldStore } from './managed-hold.ts';

const MEMBER = 'gitEffectStore';
/** `{ fence }` when the call carries one, else nothing: an unfenced call sends what it always sent. */
const fenceOf = (opts?: FenceOpts): FenceOpts => opts?.fence ? { fence: opts.fence } : {};

function rustGitEffectStore(brain: StoreBrain): GitEffectStore {
  const call = <T>(run: () => Promise<T>): Promise<T> => storeCall({ member: MEMBER }, run);
  const rows = <T>(kind: string, args: Record<string, unknown>): Promise<T> => call<T>(() => brain.gitEffectRows({ kind, ...args }));
  const write = <T>(kind: string, args: Record<string, unknown>): Promise<T> => call<T>(() => brain.gitEffectWrite({ kind, ...args }));
  const claims = (list: readonly { id: string; token: string | null }[]) => list.map(c => ({ id: String(c.id), token: c.token }));
  return {
    publicationsPending: worktreeId => rows('publications_pending', { worktreeId }),
    async yieldToPublications(list, delayMs, opts) { await write('yield_to_publications', { claims: claims(list), delayMs, ...fenceOf(opts) }); },
    recoveringPublications: worktreeId => rows('recovering_publications', { worktreeId }),
    worktreeRecovering: worktreeId => rows('worktree_recovering', { worktreeId }),
    async recordPlainOutcome(list, outcomeJson, opts) { await write('record_plain_outcome', { claims: claims(list), outcomeJson, ...fenceOf(opts) }); },
  };
}

/** `gitEffectStore()`: the store over this engine's store handle; called on a transaction, every call runs in it. */
export const gitEffectStore = async function gitEffectStore(this: RustEngine, brain: StoreBrain): Promise<GitEffectStore> {
  return heldStore(this, rustGitEffectStore(brain));
};
