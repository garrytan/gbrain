/**
 * The fence generation statements (engine-sql/fence-holds.ts) on a Rust brain.
 *
 * A fence result is held by a facts or takes fence publish (generations/publish.ts `recordHeld`), which the store keeps
 * in its `derived_generations` family (rust/crates/gbrain-store/src/generations.rs). The held list reads those rows and
 * clearing a hold deletes the key's held row when it waits for a readable fence (`fence_absent`, `no_proof`).
 *
 * The generation key lock is the store's write: a `transaction` holds the store's writer gate from open to commit or
 * rollback, so two writers of one key already run one after the other, and the lock adds nothing.
 *
 * The two page reads answer from the store's pages by exact slug (no alias), as the SQL reads `pages`.
 */
import type { FenceHoldFileRow, FenceHoldKey, FenceHoldRow } from '../../engine-sql/fence-holds.ts';
import { storeCall, type StoreMember } from './common.ts';

/** The held rows of `kinds` in `sourceIds` (one owner with `ownerKey`), oldest first; `created_at` is `timestamptz::text`. */

/** The held rows of `kinds` in `sourceIds` (one owner with `ownerKey`), oldest first; `created_at` is `timestamptz::text`. */
export const listFenceHoldRows: StoreMember<[sourceIds: readonly string[], kinds: readonly string[], ownerKey?: string], FenceHoldRow[]> =
  async (brain, sourceIds, kinds, ownerKey) => storeCall({ member: 'listFenceHoldRows' },
    () => brain.listFenceHoldRows([...sourceIds], [...kinds], ownerKey ?? null));
